import {
  SNAPSHOT_VERSION,
  type ActionEvent,
  type ActionPayload,
  type ChildCommand,
  type ChildHost,
  type Clock,
  type CoreInput,
  type CoreInputBody,
  type DeviceHandle,
  type Effect,
  type GameContext,
  type GameInstance,
  type GameView,
  type InputProfile,
  type Json,
  type Microgame,
  type Outcome,
  type PackageRef,
  type Params,
  type Phase,
  type ProtocolCommand,
  type RunConfig,
  type RuntimeSnapshot,
  type Surface,
} from "./contracts.js";
import { RealClock, VirtualClock } from "./clock.js";
import { EventLog, MemorySink, SeqCounter, type DurableSink } from "./events.js";
import {
  AdaptiveStaircase,
  DifficultyController,
  clampParams,
  isPinned,
  type Bounds,
  type DifficultyPolicy,
} from "./difficulty.js";
import { InputController, type SignalSource } from "./input.js";
import { freeAxes, presetParams } from "./presets.js";
import { MarkerDispatcher, NullMarkerSink } from "./markers.js";
import { GameRegistry } from "./registry.js";
import { preflight, preflightChildren, type ValidationReport } from "./validation.js";
import { SeededRng } from "./rng.js";

/** Поверхность-заглушка: запуск без представления (тесты, повтор, soak). */
function nullSurface(): Surface {
  return {
    stage: { replaceChildren() {}, appendChild() {} } as unknown as HTMLElement,
    setTask() {},
    setReminder() {},
    setHint() {},
    setStats() {},
    clear() {},
  };
}

export class PreflightError extends Error {
  constructor(readonly report: ValidationReport) {
    super(`Запуск отклонён до старта: ${report.issues.map((i) => i.message).join("; ")}`);
    this.name = "PreflightError";
  }
}

export interface MountOptions {
  surface: Surface;
  /** Свой runId у каждого запуска; дочерние задачи наследуют родительский. */
  runId?: string;
  seed?: number;
  policy?: DifficultyPolicy;
  overrides?: Params;
  /** Границы значений: диапазон, внутри которого политике разрешено двигать ось. */
  bounds?: Bounds;
  training?: boolean;
  /**
   * Закрепления для дочерних задач по идентификатору модуля. Протокол объявляет
   * «цветов строго три» про `stroop`, а запускается при этом батарея: без этого
   * пути закрепление до самой задачи не доходит.
   */
  childOverrides?: Record<string, Params>;
  /** Границы дочерних задач: тот же путь, что у закреплений, только диапазонами. */
  childBounds?: Record<string, Bounds>;
  /**
   * Политика сложности для дочерней задачи. Без неё оркестратор заводил детям
   * свою лестницу с нуля — и объявленная протоколом политика до них не доходила:
   * в батарее n-back так и оставался на стартовом уровне весь блок, потому что
   * его уровень считала не сессия, а сам оркестратор. Уровень принадлежит
   * задаче, поэтому фабрика приходит снаружи — оттуда, где он и живёт.
   */
  childPolicyFor?(gameId: string): DifficultyPolicy;
  locale?: string;
  requireResumable?: boolean;
  /** Запуск без представления: повтор журнала, soak-тесты, проверка ядра. */
  headless?: boolean;
  /** Место запуска в расписании: проставляет раннер участка, игра о нём не знает. */
  section?: { id: string; runIndex: number };
  /** Чем отвечает участник: объявлено протоколом, наследуется дочерними задачами. */
  input?: InputProfile;
  signalSource?: SignalSource;
  device?: DeviceHandle;
  onPhase?(phase: Phase): void;
  onDifficultyChanged?(level: number, params: Params): void;
  onComplete?(summary: Json): void;
  onOutcome?(outcome: Outcome): void;
  onRender?(view: Json): void;
}

export interface RuntimeOptions {
  registry: GameRegistry;
  capabilities?: string[];
  clock?: Clock;
  sink?: DurableSink;
  /** Счётчик событий сессии; по умолчанию свой у каждого runtime. */
  seq?: SeqCounter;
  markers?: MarkerDispatcher;
  /** Профиль ввода хоста: протокол задаёт его на всю сессию. */
  input?: InputProfile;
  /** Абсолютное время t0: связывает журнал с записью Artinis. */
  t0WallMs?: number;
  wallNow?(): number;
}

interface QueueItem {
  input: CoreInput;
  priority: number;
  order: number;
}

const PRIORITY: Record<CoreInput["kind"], number> = {
  lifecycle: 0,
  protocol: 1,
  params: 2,
  deadline: 3,
  action: 4,
  child: 5,
  signal: 6,
};

/**
 * Хост одного запуска. Владеет очередью входов, журналом, автоматом фаз,
 * таймерами и снимками. Игра не владеет ничем из этого.
 */
export class GameInstanceImpl implements GameInstance {
  readonly ref: PackageRef;
  private readonly game: Microgame<Json, Json>;
  private readonly opts: MountOptions;
  private readonly runtime: GameRuntime;
  readonly clock: Clock;
  readonly log: EventLog;
  readonly rng: SeededRng;
  readonly difficulty: DifficultyController;
  readonly input: InputController;
  readonly ctx: GameContext;
  readonly runId: string;

  private view: GameView<Json> | null = null;
  private coreState: Json;
  private _phase: Phase = "loading";
  private queue: QueueItem[] = [];
  private draining = false;
  private orderCounter = 0;
  private timers = new Map<string, { dispose(): void; dueAt: number }>();
  private slotSurfaces = new Map<string, Surface>();
  private childInstances = new Map<string, GameInstanceImpl>();
  private childRefs = new Map<string, PackageRef>();
  private childSnapshots = new Map<string, RuntimeSnapshot>();
  private childPolicies = new Map<string, DifficultyPolicy>();
  private lastParams: Params;
  private disposed = false;

  constructor(runtime: GameRuntime, game: Microgame<Json, Json>, opts: MountOptions, parentLog?: EventLog, private readonly slotPath?: string) {
    this.runtime = runtime;
    this.game = game;
    this.opts = opts;
    this.ref = { id: game.manifest.id, version: game.manifest.version };
    this.runId = opts.runId ?? `run-${Date.now().toString(36)}`;
    this.clock = runtime.options.clock ?? new RealClock();
    this.rng = new SeededRng(opts.seed ?? 1);

    this.log =
      parentLog ??
      new EventLog({
        runId: this.runId,
        packageRef: this.ref,
        t0WallMs: runtime.options.t0WallMs ?? Date.now(),
        now: () => this.clock.now(),
        wallNow: runtime.options.wallNow,
        sink: runtime.options.sink ?? new MemorySink(),
        seq: runtime.seq,
        ...(opts.section ? { sectionId: opts.section.id, runIndex: opts.section.runIndex } : {}),
      });

    const policy = opts.policy ?? new AdaptiveStaircase({ max: game.manifest.levels.count });
    // Что протокол закрепил, то политике расти не даёт: рост уходит на свободные
    // оси по кривым из таблицы компенсаций, а не пропадает молча.
    // Сомкнутый диапазон закрепляет ось так же, как прямое переопределение:
    // расти по ней некуда, и политика обязана знать об этом одинаково в обоих
    // случаях, иначе рост уходит в затёртое значение.
    const pinned = Object.entries(opts.bounds ?? {})
      .filter(([, bound]) => isPinned(bound))
      .map(([axis]) => axis);
    const frozen = game.presets
      ? [...new Set([...Object.keys(opts.overrides ?? {}), ...pinned])].filter((axis) => game.presets!.axes[axis])
      : [];
    const free = game.presets ? freeAxes(game.presets, frozen) : [];
    this.difficulty = new DifficultyController({
      policy,
      paramsForLevel: (level) =>
        game.presets ? presetParams(game.presets, level, frozen) : game.paramsForLevel(level),
      overrides: opts.overrides,
      ...(opts.bounds ? { bounds: opts.bounds } : {}),
      frozen,
      free,
      training: opts.training,
      onOutcome: (outcome, before, after) => {
        // Канонический исход пишет runtime: игра утверждает факт один раз.
        this.emitRuntime("trial.outcome", { ...outcome, levelBefore: before, levelAfter: after } as unknown as Json);
        this.opts.onOutcome?.(outcome);
      },
      onChanged: (level, params) => {
        // Степени свободы идут рядом с уровнем: без них запись «уровень вырос»
        // не отличить от записи «уровень вырос, а расти было нечем».
        this.emitRuntime("difficulty.changed", { level, params, frozen, free } as unknown as Json);
        this.opts.onDifficultyChanged?.(level, params);
      },
    });

    this.lastParams = this.difficulty.params();

    this.input = new InputController({
      actions: game.manifest.interaction.actions,
      signals: game.manifest.interaction.signals,
      now: () => this.clock.now(),
      signalSource: opts.signalSource,
      // Ёмкость ответа приходит из протокола, а какая ось ею ограничена — из
      // манифеста: модуль не знает, на каком стенде его запустили.
      profile: opts.input ?? runtime.options.input,
      ...(game.manifest.responseAlternatives ? { alternatives: game.manifest.responseAlternatives } : {}),
      onAction: (e: ActionEvent) => {
        if (this._phase !== "main" && this._phase !== "intro") return;
        this.apply({ kind: "action", actionId: e.actionId, payload: e.payload });
        this.parentNotify({ type: "action", actionId: e.actionId });
      },
    });

    const childHost: ChildHost = {
      registerSlot: (slot, surface) => this.slotSurfaces.set(slot, surface),
      slots: () => [...this.slotSurfaces.keys()],
      instance: (slot) => this.childInstances.get(slot) ?? null,
    };

    this.ctx = {
      surface: opts.surface,
      clock: this.clock,
      rng: this.rng,
      difficulty: this.difficulty,
      input: this.input,
      events: { emit: (event) => this.log.domain(this.tagSlot(event), this.slotPath) },
      children: childHost,
      device: opts.device,
      locale: opts.locale ?? "ru",
      training: Boolean(opts.training),
    };

    const config: RunConfig = {
      runId: this.runId,
      seed: opts.seed ?? 1,
      initialParams: this.lastParams,
      training: Boolean(opts.training),
      locale: this.ctx.locale,
    };
    this.coreState = game.core.init(config);
    this.setPhase("ready");
  }

  get phase(): Phase {
    return this._phase;
  }

  get state(): Json {
    return this.coreState;
  }

  private tagSlot<T extends Record<string, unknown>>(event: T): T {
    return this.slotPath ? ({ ...event, slot: this.slotPath } as T) : event;
  }

  private emitRuntime(type: string, payload: Json): void {
    const record = this.log.runtime(type, this.slotPath ? ({ slot: this.slotPath, ...(payload as object) } as Json) : payload, this.slotPath);
    this.runtime.options.markers?.consider(record);
  }

  private setPhase(next: Phase): void {
    const previous = this._phase;
    if (previous === next) return;
    if (previous !== "loading") this.apply({ kind: "lifecycle", phase: previous, action: "leave" });
    this._phase = next;
    this.emitRuntime("phase.enter", { phase: next, from: previous } as unknown as Json);
    this.opts.onPhase?.(next);
    if (next !== "completed" && next !== "aborted" && next !== "blocked") {
      this.apply({ kind: "lifecycle", phase: next, action: "enter" });
    }
  }

  mountView(): void {
    if (this.view || this.opts.headless) return;
    this.view = this.game.createView(this.ctx);
    this.view.mount(this.opts.surface);
  }

  start(): void {
    if (this.disposed) throw new Error("Экземпляр уже размонтирован");
    this.mountView();
    if (this._phase === "ready") {
      this.emitRuntime("run.start", { ref: this.ref, seed: this.opts.seed ?? 1, training: Boolean(this.opts.training) } as unknown as Json);
      this.setPhase(this.opts.training && this.game.manifest.training.available ? "intro" : "main");
    } else if (this._phase === "suspended" || this._phase === "paused") {
      this.setPhase("main");
    }
  }

  pause(): void {
    if (this._phase !== "main" && this._phase !== "intro") return;
    this.setPhase("paused");
  }

  resume(): void {
    if (this._phase !== "paused") return;
    this.setPhase("main");
  }

  stop(): void {
    this.clearTimers();
    for (const child of this.childInstances.values()) child.stop();
    this.view?.unmount();
    this.view = null;
    if (this._phase !== "completed") {
      this._phase = "aborted";
      this.emitRuntime("run.end", { reason: "stopped" } as unknown as Json);
    }
    this.disposed = true;
  }

  private clearTimers(): void {
    for (const t of this.timers.values()) t.dispose();
    this.timers.clear();
  }

  /** Единственная дверь в ядро: всё проходит через очередь и журнал. */
  apply(body: CoreInputBody): void {
    this.enqueue({ ...body, tMs: this.clock.now() } as CoreInput);
  }

  /** Повтор из журнала: время берётся из записи, а не с часов. */
  applyLogged(input: CoreInput): void {
    this.enqueue(input);
  }

  private enqueue(input: CoreInput): void {
    this.queue.push({ input, priority: PRIORITY[input.kind], order: this.orderCounter++ });
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        this.queue.sort((a, b) => a.priority - b.priority || a.order - b.order);
        const item = this.queue.shift();
        if (!item) break;
        // Запись входа ДО применения: после сбоя журнал заканчивается либо на
        // применённом входе, либо на том, который собирались применить.
        this.log.input(item.input, this.slotPath);
        const result = this.game.core.reduce(this.coreState, item.input);
        this.coreState = result.state;
        for (const effect of result.effects) this.execute(effect);
      }
    } finally {
      this.draining = false;
    }
  }

  private execute(effect: Effect): void {
    switch (effect.kind) {
      case "render": {
        this.view?.render(effect.view);
        this.opts.onRender?.(effect.view);
        break;
      }
      case "schedule": {
        this.timers.get(effect.timerId)?.dispose();
        const handle = this.clock.after(effect.afterMs, () => {
          this.timers.delete(effect.timerId);
          this.apply({ kind: "deadline", timerId: effect.timerId });
        });
        this.timers.set(effect.timerId, { dispose: handle.dispose, dueAt: this.clock.now() + effect.afterMs });
        break;
      }
      case "cancel": {
        this.timers.get(effect.timerId)?.dispose();
        this.timers.delete(effect.timerId);
        break;
      }
      case "emit": {
        const record = this.log.domain(this.tagSlot(effect.event), this.slotPath);
        this.runtime.options.markers?.consider(record);
        break;
      }
      case "outcome": {
        this.difficulty.report(effect.outcome);
        this.parentNotify({ type: "outcome", outcome: effect.outcome });
        break;
      }
      case "requestParams": {
        this.lastParams = this.difficulty.params();
        this.apply({ kind: "params", effective: this.lastParams });
        break;
      }
      case "complete": {
        this.clearTimers();
        this._phase = "completed";
        this.emitRuntime("run.end", { reason: "completed", summary: effect.summary } as unknown as Json);
        this.opts.onPhase?.("completed");
        this.opts.onComplete?.(effect.summary);
        this.parentNotify({ type: "completed", summary: effect.summary });
        break;
      }
      case "child": {
        this.runChildCommand(effect.command);
        break;
      }
      case "device": {
        this.ctx.device?.send(effect.command);
        break;
      }
    }
  }

  private parentCallback: ((slot: string, event: Parameters<typeof this.noop>[0]) => void) | null = null;
  private noop(_e: { type: string }): void {}

  /** Родитель подписывается на события ребёнка, чтобы дать их своему ядру. */
  attachParent(slot: string, cb: (slot: string, event: any) => void): void {
    this.parentCallback = cb as never;
    this.parentSlot = slot;
  }
  private parentSlot: string | null = null;

  private parentNotify(event: { type: string; [k: string]: unknown }): void {
    if (this.parentCallback && this.parentSlot) this.parentCallback(this.parentSlot, event);
  }

  private childKey(slot: string, ref: PackageRef): string {
    return `${slot}:${ref.id}`;
  }

  private runChildCommand(command: ChildCommand): void {
    switch (command.op) {
      case "mount": {
        this.mountChild(command.slot, command.ref);
        break;
      }
      case "start": {
        const child = this.childInstances.get(command.slot);
        child?.start();
        this.emitRuntime("child.started", { slot: command.slot } as unknown as Json);
        this.apply({ kind: "child", slot: command.slot, event: { type: "started" } });
        break;
      }
      case "stop": {
        const child = this.childInstances.get(command.slot);
        child?.stop();
        this.childInstances.delete(command.slot);
        this.apply({ kind: "child", slot: command.slot, event: { type: "stopped" } });
        break;
      }
      case "suspend": {
        const child = this.childInstances.get(command.slot);
        if (!child) break;
        this.childSnapshots.set(command.slot, child.snapshot());
        child.stop();
        this.childInstances.delete(command.slot);
        this.emitRuntime("child.suspended", { slot: command.slot } as unknown as Json);
        this.apply({ kind: "child", slot: command.slot, event: { type: "suspended" } });
        break;
      }
      case "resume": {
        const saved = this.childSnapshots.get(command.slot);
        const ref = this.childRefs.get(command.slot);
        if (!saved || !ref) break;
        const child = this.mountChild(command.slot, ref);
        child.restore(saved);
        child.start();
        this.emitRuntime("child.resumed", { slot: command.slot } as unknown as Json);
        this.apply({ kind: "child", slot: command.slot, event: { type: "started" } });
        break;
      }
      case "finish": {
        // Ребёнок закрывается своей же командой протокола: сводка и `block.end`
        // остаются на месте, а оркестратор узнаёт об этом обычным `completed`.
        this.childInstances.get(command.slot)?.protocol({ type: "finish" });
        break;
      }
      case "unmount": {
        this.childInstances.get(command.slot)?.stop();
        this.childInstances.delete(command.slot);
        this.childSnapshots.delete(command.slot);
        break;
      }
    }
  }

  private mountChild(slot: string, ref: PackageRef): GameInstanceImpl {
    const surface = this.slotSurfaces.get(slot) ?? (this.opts.headless ? nullSurface() : undefined);
    if (!surface) throw new Error(`Слот ${slot} не зарегистрирован представлением оркестратора`);
    const game = this.runtime.registry.resolve(ref);
    const overrides = this.opts.childOverrides?.[ref.id];
    const bounds = this.opts.childBounds?.[ref.id];
    const report = preflight({
      manifest: game.manifest,
      params: clampParams({ ...game.paramsForLevel(1), ...(overrides ?? {}) }, bounds),
      capabilities: this.runtime.capabilities,
    });
    if (!report.ok) throw new PreflightError(report);

    // Уровень задачи сохраняется между её появлениями. Политику даёт расписание,
    // если оно её объявило; своя лестница остаётся только для одиночного запуска
    // оркестратора, где расписания нет.
    const key = this.childKey(slot, ref);
    let policy = this.childPolicies.get(key);
    if (!policy) {
      policy =
        this.opts.childPolicyFor?.(ref.id) ?? new AdaptiveStaircase({ max: game.manifest.levels.count });
      this.childPolicies.set(key, policy);
    }

    const child = new GameInstanceImpl(
      this.runtime,
      game as Microgame<Json, Json>,
      {
        surface,
        runId: this.runId,
        seed: (this.opts.seed ?? 1) + slot.length * 7919,
        policy,
        ...(overrides ? { overrides } : {}),
        ...(bounds ? { bounds } : {}),
        ...(this.opts.childOverrides ? { childOverrides: this.opts.childOverrides } : {}),
        ...(this.opts.childBounds ? { childBounds: this.opts.childBounds } : {}),
        ...(this.opts.childPolicyFor ? { childPolicyFor: this.opts.childPolicyFor } : {}),
        training: this.opts.training,
        locale: this.ctx.locale,
        signalSource: this.opts.signalSource,
        headless: this.opts.headless,
        ...(this.opts.input ? { input: this.opts.input } : {}),
      },
      this.log,
      slot,
    );
    child.attachParent(slot, (s, event) => this.apply({ kind: "child", slot: s, event }));
    child.mountView();
    this.childInstances.set(slot, child);
    this.childRefs.set(slot, ref);
    this.emitRuntime("child.mounted", { slot, ref } as unknown as Json);
    this.apply({ kind: "child", slot, event: { type: "mounted" } });
    return child;
  }

  /**
   * Куда сейчас направлен ввод: у оркестратора это активная дочерняя задача,
   * иначе он сам. Хост не должен знать, что внутри — составная игра.
   */
  activeInstance(): GameInstanceImpl {
    for (const child of this.childInstances.values()) {
      if (child.phase === "main" || child.phase === "intro") return child.activeInstance();
    }
    return this;
  }

  snapshot(): RuntimeSnapshot {
    const now = this.clock.now();
    const children: Record<string, RuntimeSnapshot> = {};
    for (const [slot, child] of this.childInstances) children[slot] = child.snapshot();
    for (const [slot, saved] of this.childSnapshots) children[slot] ??= saved;
    return {
      snapshotVersion: SNAPSHOT_VERSION,
      runId: this.runId,
      packageRef: this.ref,
      phase: this._phase,
      coreState: structuredClone(this.coreState),
      eventCursor: this.log.cursor,
      rngState: this.rng.save(),
      pendingDeadlines: [...this.timers.entries()].map(([timerId, t]) => ({
        timerId,
        remainingMs: Math.max(0, t.dueAt - now),
      })),
      difficulty: { policyId: this.difficulty.policy.id, level: this.difficulty.level() },
      ...(Object.keys(children).length > 0 ? { children } : {}),
    };
  }

  restore(state: RuntimeSnapshot): void {
    if (state.snapshotVersion !== SNAPSHOT_VERSION) {
      throw new Error(`Снимок версии ${state.snapshotVersion}, runtime понимает ${SNAPSHOT_VERSION}`);
    }
    if (state.packageRef.id !== this.ref.id || state.packageRef.version !== this.ref.version) {
      throw new Error(`Снимок от ${state.packageRef.id}@${state.packageRef.version}, а восстанавливают в ${this.ref.id}@${this.ref.version}`);
    }
    this.clearTimers();
    this.coreState = structuredClone(state.coreState);
    this.rng.load(state.rngState);
    this._phase = state.phase === "completed" ? "completed" : "suspended";
    for (const deadline of state.pendingDeadlines) {
      const handle = this.clock.after(deadline.remainingMs, () => {
        this.timers.delete(deadline.timerId);
        this.apply({ kind: "deadline", timerId: deadline.timerId });
      });
      this.timers.set(deadline.timerId, { dispose: handle.dispose, dueAt: this.clock.now() + deadline.remainingMs });
    }
    for (const [slot, childState] of Object.entries(state.children ?? {})) {
      this.childSnapshots.set(slot, childState);
      this.childRefs.set(slot, childState.packageRef);
    }
    this.emitRuntime("run.restored", { cursor: state.eventCursor, phase: state.phase } as unknown as Json);
  }

  /** Ввод от представления и хоста: кнопки, клавиши, симулятор сигнала. */
  submitAction(actionId: string, payload: ActionPayload = {}, source: ActionEvent["source"] = "pointer"): void {
    this.input.submit(actionId, payload, source);
  }

  /**
   * Команда протокола: время секции вышло, оператор пропускает задачу, идёт
   * probe. Ядро закрывает блок само и отдаёт частичную сводку — это не то же
   * самое, что `stop()`, который обрывает прогон без результата.
   */
  protocol(command: ProtocolCommand): void {
    if (this._phase !== "main" && this._phase !== "intro") return;
    this.emitRuntime("protocol.command", command as unknown as Json);
    // У составной игры блок закрывает её оркестратор, а не активный ребёнок.
    this.apply({ kind: "protocol", command });
  }
}

export class GameRuntime {
  readonly registry: GameRegistry;
  readonly capabilities: string[];
  readonly options: RuntimeOptions;
  /** Один счётчик на все запуски хоста: номера событий не повторяются. */
  readonly seq: SeqCounter;

  constructor(options: RuntimeOptions) {
    this.seq = options.seq ?? new SeqCounter();
    this.options = options;
    this.registry = options.registry;
    this.capabilities = options.capabilities ?? ["keyboard", "pointer"];
  }

  preflight(ref: PackageRef, params?: Params, requireResumable = false): ValidationReport {
    const game = this.registry.resolve(ref);
    return preflight({
      manifest: game.manifest,
      params: params ?? game.paramsForLevel(1),
      capabilities: this.capabilities,
      requireResumable,
    });
  }

  /** Отказ происходит здесь, до первой отрисовки. */
  mount(ref: PackageRef | string, options: MountOptions): GameInstanceImpl {
    const game = this.registry.resolve(ref);
    const packageRef = { id: game.manifest.id, version: game.manifest.version };
    const initialParams = clampParams(
      { ...game.paramsForLevel(options.policy?.current() ?? 1), ...(options.overrides ?? {}) },
      options.bounds,
    );
    const report = preflight({
      manifest: game.manifest,
      params: initialParams,
      capabilities: this.capabilities,
      requireResumable: options.requireResumable,
    });
    const childReport = preflightChildren(game.manifest, (id, version) =>
      this.registry.has({ id, version }) ? this.registry.resolve({ id, version }).manifest : null,
    );
    if (!childReport.ok) throw new PreflightError(childReport);
    if (!report.ok) throw new PreflightError(report);
    return new GameInstanceImpl(this, game as Microgame<Json, Json>, { ...options, runId: options.runId }, undefined, undefined);
  }
}

export { VirtualClock, RealClock, MarkerDispatcher, NullMarkerSink };
