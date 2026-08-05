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
  type InputProfile,
  type Json,
  type Params,
  type Admission,
  type Outcome,
  type RuntimeSnapshot,
  type Surface,
} from "@gamespace/core";
import type { CoverageState, SeriesState, TerminationPolicy } from "./termination.js";

export interface Screen {
  title: string;
  body: string[];
  footer?: string;
}

export interface SectionSpec {
  id: string;
  /** Одна игра или ротация: раннер берёт следующую по кругу на каждый прогон. */
  games: string[];
  end: TerminationPolicy;
  /** Переопределения параметров по игре: поверх выданных политикой сложности. */
  overrides?: Record<string, Params>;
  training?: boolean;
  /**
   * Отбивки перед участком, по порядку. Их может быть больше одной: перед вторым
   * зачётным блоком сначала идёт пауза, потом описание самого блока.
   */
  screens?: Screen[];
  /**
   * Участок идёт по покрытию: задачи предъявляются по одной, пока каждая не
   * пройдёт критерий допуска или не исчерпает попытки. Критерии берутся из
   * манифестов — они свойство задачи, а не расписания.
   */
  coverage?: boolean;
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
  /** Итог попытки обучения: выполнен ли критерий допуска. Нет критерия — нет и поля. */
  admission?: AdmissionResult;
}

export interface AdmissionResult {
  passed: boolean;
  /** Сколько верных в окне и какой порог: «прошёл» без чисел проверить нельзя. */
  correct: number;
  window: number;
  minCorrect: number;
  attempt: number;
  maxAttempts: number;
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
  /** Чем отвечает участник: приходит из документа протокола на все прогоны участка. */
  input?: InputProfile;
  /**
   * Показать отбивку и вызвать `proceed`, когда оператор её пролистает. Без этого
   * обработчика участок начинается сразу: у безголового прогона и у одиночного
   * запуска модуля читать инструкцию некому.
   */
  present?(screen: Screen, index: number, proceed: () => void): void;
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
  /** Попытки и допуск по задаче: живут весь участок, а не прогон. */
  private readonly attempts = new Map<string, { attempts: number; passed: boolean }>();
  /** Исходы текущего прогона: из них считается критерий допуска. */
  private outcomes: Outcome[] = [];
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
      ...(this.opts.section.coverage ? { coverage: this.coverage() } : {}),
    };
  }

  /** Что уже пройдено и что ещё нет: наружу — оператору, внутрь — политике участка. */
  coverage(): CoverageState[] {
    return this.opts.section.games.map((gameId) => {
      const progress = this.attempts.get(gameId) ?? { attempts: 0, passed: false };
      const limit = this.admissionOf(gameId)?.maxAttempts ?? 1;
      return {
        gameId,
        attempts: progress.attempts,
        passed: progress.passed,
        exhausted: !progress.passed && progress.attempts >= limit,
      };
    });
  }

  private admissionOf(gameId: string): Admission | undefined {
    if (!this.opts.runtime.registry.has(gameId)) return undefined;
    return this.opts.runtime.registry.resolve(gameId).manifest.training.admission;
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

  /**
   * Запись участка. Метки участка идут отсюда же: `markers.consider` вызывался
   * только из инстанса игры, поэтому границы фаз в поток LSL не попадали вовсе —
   * а именно по ним режут запись Артиниса.
   */
  private mark(type: string, payload: Json): void {
    const record = this.log.runtime(type, payload);
    this.opts.runtime.options.markers?.consider(record);
  }

  private elapsed(): number {
    const paused = this.pausedAtMs === null ? 0 : this.clock.now() - this.pausedAtMs;
    return this.clock.now() - this.startedAtMs - this.pausedTotalMs - paused;
  }

  /**
   * Участок начинается с отбивки. Отсчёт времени и метка границы идут после неё:
   * чтение инструкции и разговор с оператором не должны съедать сорок минут
   * блока, а `section.start` в потоке LSL обязан указывать на первый стимул, а не
   * на экран с текстом.
   */
  start(): void {
    this.showScreens(() => this.begin());
  }

  private showScreens(done: () => void): void {
    const screens = this.opts.section.screens ?? [];
    const present = this.opts.present;
    if (!present || screens.length === 0) return done();
    const step = (index: number): void => {
      const screen = screens[index];
      if (!screen || this.aborting) return done();
      const shownAtMs = this.clock.now();
      this.mark("interstitial.shown", { section: this.opts.section.id, index, title: screen.title });
      let advanced = false;
      present(screen, index, () => {
        // Оператор может нажать дважды: без защёлки второй щелчок пролистнул бы
        // ещё один экран мимо глаз участника.
        if (advanced) return;
        advanced = true;
        this.mark("interstitial.advanced", {
          section: this.opts.section.id,
          index,
          dwellMs: this.clock.now() - shownAtMs,
        });
        step(index + 1);
      });
    };
    step(0);
  }

  private begin(): void {
    if (this.done) return;
    this.startedAtMs = this.clock.now();
    this.mark("section.start", { section: this.opts.section.id, policy: this.opts.section.end.id });
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

    const gameId = this.pick();
    if (!gameId) return this.finish();
    this.rotation += 1;
    // Правило показывается до первого стимула, а не рядом с ним: читать инструкцию
    // под тикающим дедлайном нельзя, а «объяснили по ходу» — это не объяснили.
    const rule = this.ruleScreen(gameId);
    if (rule) return this.showRule(rule, () => this.launch(gameId));
    this.launch(gameId);
  }

  /**
   * Какую задачу запускать. По покрытию — первую непройденную, а не следующую по
   * кругу: круг оставил бы часть задач непредъявленными, если участок кончится
   * раньше полного оборота.
   */
  private pick(): string | null {
    if (!this.opts.section.coverage) {
      return this.opts.section.games[this.rotation % this.opts.section.games.length] ?? null;
    }
    const pending = this.coverage().filter((c) => !c.passed && !c.exhausted);
    // Меньше попыток — раньше очередь: сначала все задачи по одному разу, и лишь
    // потом повторы, иначе участник застрял бы на первой трудной задаче.
    pending.sort((a, b) => a.attempts - b.attempts);
    return pending[0]?.gameId ?? null;
  }

  /**
   * Экран правила перед обучающим прогоном. Текст правила принадлежит модулю, а
   * строка про клавиши — протоколу: модуль не знает, на каком стенде его запустили
   * и сколько клавиш там объявлено.
   */
  private ruleScreen(gameId: string): Screen | null {
    if (!this.opts.section.training || !this.opts.runtime.registry.has(gameId)) return null;
    const manifest = this.opts.runtime.registry.resolve(gameId).manifest;
    const rule = manifest.training.rule;
    if (!rule) return null;
    const body = [rule.summary, rule.example];
    if (rule.mistake) body.push(rule.mistake);
    const keys = this.opts.input?.keys ?? [];
    const pointer = manifest.responseAlternatives?.addressedBy === "pointer";
    if (pointer) body.push("Ответы здесь мышью: нажимайте прямо по числу на поле.");
    else if (keys.length > 0) {
      // Порядок клавиш совпадает с порядком вариантов на экране по построению:
      // набор раздаётся слева направо, поэтому объяснять соответствие не нужно.
      body.push(`Ответы клавишами ${keys.join(" ")} — по порядку вариантов на экране, слева направо.`);
    }
    const criterion = manifest.training.admission;
    if (criterion) {
      body.push(
        `Тренировка зачтётся, когда из последних ${criterion.window} попыток верными будут ${criterion.minCorrect}. Попыток даётся ${criterion.maxAttempts}.`,
      );
    }
    return { title: manifest.title.ru, body, footer: "Оператор начнёт, когда вы будете готовы." };
  }

  private showRule(screen: Screen, then: () => void): void {
    const present = this.opts.present;
    if (!present) return then();
    const shownAtMs = this.clock.now();
    this.mark("rule.shown", { section: this.opts.section.id, title: screen.title });
    let advanced = false;
    present(screen, 0, () => {
      if (advanced) return;
      advanced = true;
      this.mark("rule.advanced", { section: this.opts.section.id, dwellMs: this.clock.now() - shownAtMs });
      then();
    });
  }

  private launch(gameId: string): void {
    const index = this.state.runs;
    const overrides = this.opts.section.overrides?.[gameId];
    this.outcomes = [];

    const instance = this.opts.runtime.mount(gameId, {
      surface: this.opts.surface,
      seed: (this.opts.seed ?? 1) + index * 101,
      policy: this.policy(gameId),
      ...(overrides ? { overrides } : {}),
      // Закрепления дочерних задач идут целиком: их адресат — не эта игра, а её дети.
      ...(this.opts.section.overrides ? { childOverrides: this.opts.section.overrides } : {}),
      training: this.opts.section.training,
      headless: this.opts.headless,
      ...(this.opts.input ? { input: this.opts.input } : {}),
      section: { id: this.opts.section.id, runIndex: index },
      // Критерий допуска считается по исходам, а не по сводке: сводка у каждого
      // модуля своя, а окно «последние N попыток» из неё не восстановить.
      onOutcome: (outcome) => this.outcomes.push(outcome),
      onComplete: (summary) => this.endRun(summary),
    });
    this.instance = instance;
    this.runStartedMs = this.clock.now();
    this.finishSentMs = null;
    this.mark("section.run.start", { section: this.opts.section.id, game: gameId, index });
    instance.start();
    this.opts.onRunStart?.(instance, index);
  }

  private endRun(summary: Json, reason: RunRecord["reason"] = "completed"): void {
    const instance = this.instance;
    if (!instance) return;
    const gameId = instance.ref.id;
    const admission = this.judge(gameId);
    const record: RunRecord = {
      index: this.state.runs,
      gameId,
      startedMs: this.runStartedMs,
      endedMs: this.clock.now(),
      reason: this.finishSentMs === null ? reason : reason === "completed" ? "finished-by-protocol" : reason,
      level: this.policy(gameId).current(),
      summary,
      ...(admission ? { admission } : {}),
    };
    this.records.push(record);
    this.mark("section.run.end", record as unknown as Json);
    instance.stop();
    this.instance = null;
    this.opts.onRunEnd?.(record);
    this.next();
  }

  /**
   * Итог попытки обучения. Считается по последним `window` зачётным исходам
   * прогона: критерий прозой («8 из 10 верных») неисполним, пока не сказано, что
   * считается попыткой и сколько последних берётся в окно.
   */
  private judge(gameId: string): AdmissionResult | undefined {
    if (!this.opts.section.coverage) return undefined;
    const progress = this.attempts.get(gameId) ?? { attempts: 0, passed: false };
    const attempt = progress.attempts + 1;
    const criterion = this.admissionOf(gameId);
    if (!criterion) {
      // Без объявленного критерия задача считается покрытой самим предъявлением:
      // покой и оркестраторы проверять нечем, а держать участок открытым нельзя.
      this.attempts.set(gameId, { attempts: attempt, passed: true });
      return undefined;
    }
    // Попытка — то, что объявлено: проба или эпизод. Смешивать их нельзя, иначе
    // у механики с блочным исходом окно «десять последних» никогда не наберётся.
    const kind = criterion.counts === "episode" ? "block" : "trial";
    const window = this.outcomes.filter((o) => o.kind === kind).slice(-criterion.window);
    const correct = window.filter((o) =>
      o.kind === "trial" ? o.correct : o.accuracy >= (criterion.minAccuracy ?? 0.8),
    ).length;
    const passed = window.length >= criterion.window && correct >= criterion.minCorrect;
    this.attempts.set(gameId, { attempts: attempt, passed: progress.passed || passed });
    const result: AdmissionResult = {
      passed,
      correct,
      window: window.length,
      minCorrect: criterion.minCorrect,
      attempt,
      maxAttempts: criterion.maxAttempts,
    };
    this.mark("training.attempt", { section: this.opts.section.id, game: gameId, ...result });
    return result;
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
    this.mark("section.pause", { section: this.opts.section.id });
  }

  resume(): void {
    if (this.pausedAtMs === null) return;
    this.pausedTotalMs += this.clock.now() - this.pausedAtMs;
    this.pausedAtMs = null;
    this.instance?.resume();
    this.mark("section.resume", { section: this.opts.section.id });
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
    this.mark("section.end", {
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
    this.mark("section.restored", { section: saved.sectionId, elapsedMs: saved.elapsedMs, runs: saved.runs });
    this.ticker = this.clock.every(this.opts.tickMs ?? 250, () => this.tick());

    const pending = saved.current;
    if (!pending) return this.next();
    // Прерванный прогон продолжается, а не начинается заново: иначе участник
    // получил бы блок с нуля, а журнал — дыру между снимком и продолжением.
    const instance = this.opts.runtime.mount(pending.packageRef, {
      surface: this.opts.surface,
      seed: (this.opts.seed ?? 1) + saved.runs * 101,
      policy: this.policy(pending.packageRef.id),
      ...(this.opts.section.overrides?.[pending.packageRef.id]
        ? { overrides: this.opts.section.overrides[pending.packageRef.id]! }
        : {}),
      ...(this.opts.section.overrides ? { childOverrides: this.opts.section.overrides } : {}),
      training: this.opts.section.training,
      headless: this.opts.headless,
      ...(this.opts.input ? { input: this.opts.input } : {}),
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
