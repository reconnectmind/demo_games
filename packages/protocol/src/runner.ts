import {
  AdaptiveStaircase,
  EventLog,
  MemorySink,
  RealClock,
  type Clock,
  type DifficultyPolicy,
  type DurableSink,
  type GameInstanceImpl,
  type GameRuntime,
  type Json,
  type Params,
  type RuntimeSnapshot,
  type Surface,
} from "@gamespace/core";
import type { SeriesState, TerminationPolicy } from "./termination.js";

export interface SectionSpec {
  id: string;
  /** Одна игра или ротация: раннер берёт следующую по кругу на каждый прогон. */
  games: string[];
  end: TerminationPolicy;
  /** Переопределения параметров по игре: поверх выданных политикой сложности. */
  overrides?: Record<string, Params>;
  training?: boolean;
}

export interface RunRecord {
  index: number;
  gameId: string;
  startedMs: number;
  endedMs: number;
  /** Как завершился прогон: сам, по команде протокола или оборван. */
  reason: "completed" | "finished-by-protocol" | "aborted";
  level: number;
  summary: Json;
}

export interface SectionRunnerOptions {
  runtime: GameRuntime;
  section: SectionSpec;
  surface: Surface;
  seed?: number;
  sessionId?: string;
  /** Как часто спрашивать политику завершения во время прогона. */
  tickMs?: number;
  /** Сколько ждать закрытия блока после команды finish, прежде чем обрывать. */
  graceMs?: number;
  /** Фабрика политик сложности: по одной на игру, живёт весь участок. */
  policyFor?(gameId: string): DifficultyPolicy;
  sink?: DurableSink;
  headless?: boolean;
  onRunStart?(instance: GameInstanceImpl, index: number): void;
  onRunEnd?(record: RunRecord): void;
  onDone?(records: RunRecord[]): void;
}

export interface SectionSnapshot {
  sectionId: string;
  runs: number;
  elapsedMs: number;
  /** Уровень каждой задачи: он обязан пережить и перезапуск, и восстановление. */
  levels: Record<string, number>;
  rotation: number;
  current?: RuntimeSnapshot;
}

/**
 * Раннер участка расписания. Он владеет тем, чем не должен владеть инстанс:
 * сколько раз запускать игру, когда остановиться и что сохранять между
 * запусками. Инстанс по-прежнему знает только про свой блок.
 */
export class SectionRunner {
  readonly records: RunRecord[] = [];
  private readonly clock: Clock;
  private readonly log: EventLog;
  private readonly policies = new Map<string, DifficultyPolicy>();
  private instance: GameInstanceImpl | null = null;
  private ticker: { dispose(): void } | null = null;
  private startedAtMs = 0;
  private pausedAtMs: number | null = null;
  private pausedTotalMs = 0;
  private runStartedMs = 0;
  private rotation = 0;
  private finishSentMs: number | null = null;
  private done = false;
  private aborting = false;
  /** Прогоны, случившиеся до восстановления: их записей в этом объекте нет. */
  private runsBefore = 0;

  constructor(private readonly opts: SectionRunnerOptions) {
    this.clock = opts.runtime.options.clock ?? new RealClock();
    this.log = new EventLog({
      runId: opts.sessionId ?? "session",
      packageRef: { id: opts.section.id, version: "0.0.0" },
      t0WallMs: opts.runtime.options.t0WallMs ?? Date.now(),
      now: () => this.clock.now(),
      wallNow: opts.runtime.options.wallNow,
      sink: opts.sink ?? opts.runtime.options.sink ?? new MemorySink(),
      // Записи участка идут в общую нумерацию с событиями игр.
      seq: opts.runtime.seq,
    });
  }

  get state(): SeriesState {
    return {
      runs: this.runsBefore + this.records.length,
      elapsedMs: this.elapsed(),
      runElapsedMs: this.instance ? this.clock.now() - this.runStartedMs : 0,
    };
  }

  get finished(): boolean {
    return this.done;
  }

  current(): GameInstanceImpl | null {
    return this.instance;
  }

  /** Уровни задач наружу: их показывает оператору и сохраняет сессия. */
  levels(): Record<string, number> {
    return Object.fromEntries([...this.policies].map(([id, policy]) => [id, policy.current()]));
  }

  private elapsed(): number {
    const paused = this.pausedAtMs === null ? 0 : this.clock.now() - this.pausedAtMs;
    return this.clock.now() - this.startedAtMs - this.pausedTotalMs - paused;
  }

  start(): void {
    this.startedAtMs = this.clock.now();
    this.log.runtime("section.start", { section: this.opts.section.id, policy: this.opts.section.end.id });
    this.ticker = this.clock.every(this.opts.tickMs ?? 250, () => this.tick());
    this.next();
  }

  private policy(gameId: string): DifficultyPolicy {
    let policy = this.policies.get(gameId);
    if (policy) return policy;
    policy =
      this.opts.policyFor?.(gameId) ??
      new AdaptiveStaircase({ max: this.opts.runtime.registry.resolve(gameId).manifest.levels.count });
    this.policies.set(gameId, policy);
    return policy;
  }

  /** Следующий прогон участка либо его завершение. */
  private next(): void {
    if (this.done) return;
    // Закрытие блока идёт через тот же путь, что и обычное завершение, поэтому
    // без флага аварийная остановка успела бы запустить следующий прогон.
    if (this.aborting || this.opts.section.end.next(this.state) === "stop") return this.finish();

    const gameId = this.opts.section.games[this.rotation % this.opts.section.games.length]!;
    this.rotation += 1;
    const index = this.state.runs;
    const overrides = this.opts.section.overrides?.[gameId];

    const instance = this.opts.runtime.mount(gameId, {
      surface: this.opts.surface,
      seed: (this.opts.seed ?? 1) + index * 101,
      policy: this.policy(gameId),
      ...(overrides ? { overrides } : {}),
      training: this.opts.section.training,
      headless: this.opts.headless,
      section: { id: this.opts.section.id, runIndex: index },
      onComplete: (summary) => this.endRun(summary),
    });
    this.instance = instance;
    this.runStartedMs = this.clock.now();
    this.finishSentMs = null;
    this.log.runtime("section.run.start", { section: this.opts.section.id, game: gameId, index });
    instance.start();
    this.opts.onRunStart?.(instance, index);
  }

  private endRun(summary: Json, reason: RunRecord["reason"] = "completed"): void {
    const instance = this.instance;
    if (!instance) return;
    const gameId = instance.ref.id;
    const record: RunRecord = {
      index: this.state.runs,
      gameId,
      startedMs: this.runStartedMs,
      endedMs: this.clock.now(),
      reason: this.finishSentMs === null ? reason : reason === "completed" ? "finished-by-protocol" : reason,
      level: this.policy(gameId).current(),
      summary,
    };
    this.records.push(record);
    this.log.runtime("section.run.end", record as unknown as Json);
    instance.stop();
    this.instance = null;
    this.opts.onRunEnd?.(record);
    this.next();
  }

  private tick(): void {
    if (this.done) return;
    const instance = this.instance;
    if (!instance) return;
    if (this.pausedAtMs !== null) return;

    if (this.finishSentMs !== null) {
      // Игра не закрыла блок по команде: обрываем, но записываем это как обрыв.
      if (this.clock.now() - this.finishSentMs > (this.opts.graceMs ?? 2000)) this.endRun(null, "aborted");
      return;
    }
    if (this.opts.section.end.during(this.state) === "finish") {
      this.finishSentMs = this.clock.now();
      instance.protocol({ type: "finish" });
    }
  }

  pause(): void {
    if (this.pausedAtMs !== null) return;
    this.pausedAtMs = this.clock.now();
    this.instance?.pause();
    this.log.runtime("section.pause", { section: this.opts.section.id });
  }

  resume(): void {
    if (this.pausedAtMs === null) return;
    this.pausedTotalMs += this.clock.now() - this.pausedAtMs;
    this.pausedAtMs = null;
    this.instance?.resume();
    this.log.runtime("section.resume", { section: this.opts.section.id });
  }

  /** Аварийная остановка оператором: текущий блок закрывается, участок кончается. */
  abort(): void {
    if (this.done) return;
    this.aborting = true;
    if (this.instance) {
      this.finishSentMs = this.clock.now();
      this.instance.protocol({ type: "finish" });
      // Игра не закрылась по команде — обрываем, но с честной пометкой.
      if (this.instance) this.endRun(null, "aborted");
    }
    this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.ticker?.dispose();
    this.ticker = null;
    this.log.runtime("section.end", {
      section: this.opts.section.id,
      runs: this.records.length,
      elapsedMs: this.elapsed(),
      levels: this.levels(),
    });
    this.opts.onDone?.(this.records);
  }

  snapshot(): SectionSnapshot {
    return {
      sectionId: this.opts.section.id,
      runs: this.records.length,
      elapsedMs: this.elapsed(),
      levels: this.levels(),
      rotation: this.rotation,
      ...(this.instance ? { current: this.instance.snapshot() } : {}),
    };
  }

  /**
   * Восстановление после падения: участок продолжается с того же времени, с теми
   * же уровнями и с тем же незавершённым прогоном. Вызывается вместо `start()`.
   */
  restore(saved: SectionSnapshot): void {
    this.rotation = saved.rotation;
    this.runsBefore = saved.runs;
    this.pausedTotalMs = 0;
    this.startedAtMs = this.clock.now() - saved.elapsedMs;
    for (const [gameId, level] of Object.entries(saved.levels)) this.policy(gameId).set?.(level);
    this.log.runtime("section.restored", { section: saved.sectionId, elapsedMs: saved.elapsedMs, runs: saved.runs });
    this.ticker = this.clock.every(this.opts.tickMs ?? 250, () => this.tick());

    const pending = saved.current;
    if (!pending) return this.next();
    // Прерванный прогон продолжается, а не начинается заново: иначе участник
    // получил бы блок с нуля, а журнал — дыру между снимком и продолжением.
    const instance = this.opts.runtime.mount(pending.packageRef, {
      surface: this.opts.surface,
      seed: (this.opts.seed ?? 1) + saved.runs * 101,
      policy: this.policy(pending.packageRef.id),
      training: this.opts.section.training,
      headless: this.opts.headless,
      section: { id: this.opts.section.id, runIndex: saved.runs },
      onComplete: (summary) => this.endRun(summary),
    });
    instance.restore(pending);
    this.instance = instance;
    this.runStartedMs = this.clock.now();
    this.finishSentMs = null;
    instance.start();
    this.opts.onRunStart?.(instance, saved.runs);
  }
}
