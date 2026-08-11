import type { Admission, Manifest } from "./manifest.types.js";
import type { PresetTable } from "./presets.js";

export type { Admission, Manifest };
export type Params = Record<string, number | string | boolean>;
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Версия API runtime. Манифест объявляет диапазон, с которым он совместим. */
export const RUNTIME_API_VERSION = "1.0";

export interface PackageRef {
  id: string;
  version: string;
}

/** Фаза жизненного цикла. Владеет ею runtime, игра только узнаёт о переходах. */
export type Phase =
  | "loading"
  | "blocked"
  | "ready"
  | "intro"
  | "main"
  | "outro"
  | "paused"
  | "suspended"
  | "completed"
  | "aborted";

export interface RunConfig {
  runId: string;
  seed: number;
  /** Параметры первой пробы: политика уже выдала уровень. */
  initialParams: Params;
  /** Обучающий прогон: исходы не идут в политику. */
  training: boolean;
  locale: string;
}

export interface SignalSample {
  value: number;
  raw: number | null;
  quality: number;
  tMs: number;
}

export type SignalState = "absent" | "warmup" | "ok" | "degraded" | "lost";

/**
 * `phase` есть только у удерживаемых действий: нажатие и отпускание — два
 * разных события, а не одно, иначе ядро не сможет интегрировать удержание.
 */
export type ActionPayload = { index?: number; value?: Json; phase?: "down" | "up" };

export type ProtocolCommand =
  | { type: "finish" }
  | { type: "skip" }
  | { type: "probe"; on: boolean };

export type ChildEvent =
  | { type: "mounted" }
  /** Участник впервые тронул дочернюю задачу: по этому и меряется лаг возврата. */
  | { type: "action"; actionId: string }
  | { type: "started" }
  | { type: "stopped" }
  | { type: "suspended" }
  | { type: "completed"; summary: Json }
  | { type: "outcome"; outcome: Outcome };

/** Единственный способ повлиять на состояние игры. Всё остальное — уже следствие. */
export type CoreInputBody =
  | { kind: "lifecycle"; phase: Phase; action: "enter" | "leave" }
  | { kind: "deadline"; timerId: string }
  | { kind: "action"; actionId: string; payload: ActionPayload }
  | { kind: "signal"; signalId: string; sample: SignalSample }
  | { kind: "params"; effective: Params }
  | { kind: "protocol"; command: ProtocolCommand }
  | { kind: "child"; slot: string; event: ChildEvent };

/**
 * Время проставляет очередь, а не игра: иначе ядро не смогло бы вычислить RT,
 * не обратившись к часам, и перестало бы быть чистым.
 */
export type CoreInput = CoreInputBody & { tMs: number };

export interface DomainEvent {
  type: string;
  [key: string]: Json | undefined;
}

export type TrialOutcome = {
  kind: "trial";
  scored: boolean;
  correct: boolean;
  rtMs: number | null;
  paramsUsed: Params;
};

export type BlockOutcome = {
  kind: "block";
  scored: boolean;
  accuracy: number;
  trials: number;
  paramsUsed: Params;
};

export type Outcome = TrialOutcome | BlockOutcome;

/**
 * Разбор пробы для обучения: что требовалось и что пришло. Ядро отдаёт факты, а
 * фразу собирает представление — иначе «мимо» так и осталось бы пометкой, из
 * которой участник не узнаёт, в чём ошибся.
 *
 * `null` в поле значимо: пустое `expected` означает, что отвечать было не нужно,
 * пустое `got` — что ответа не было вовсе.
 */
export interface TrialDebrief {
  expected: string | null;
  got: string | null;
  /**
   * Готовая фраза для механик, где «вы выбрали X, а нужно было Y» не читается:
   * там, где участник не выбирает вариант, а ведёт площадку или машину, ошибка
   * описывается движением, а не выбором.
   */
  hint?: string;
}

/**
 * Сколько разбор ошибки держится сам, если участник его не снял. Нормальный
 * выход — нажатие: кнопка «Дальше» или любая клавиша ответа. Но задача не имеет
 * права встать навсегда из-за того, что участник отвернулся, поэтому у ожидания
 * есть предел, и он выбран так, чтобы фразу можно было прочесть дважды.
 */
export const HOLD_MS = 8000;

export type ChildCommand =
  | { op: "mount"; slot: string; ref: PackageRef }
  | { op: "start"; slot: string }
  | { op: "stop"; slot: string }
  /** snapshot + stop: снимок остаётся у runtime, оркестратор его не видит. */
  | { op: "suspend"; slot: string }
  /** mount + restore + start из ранее снятого снимка. */
  | { op: "resume"; slot: string }
  /**
   * Закрыть блок ребёнка тем же путём, которым это делает протокол: ребёнок
   * доигрывает до собственного конца и отдаёт сводку. Отличается от `stop` тем,
   * что `stop` — обрыв: сводки не будет, и блок в данных окажется незакрытым.
   */
  | { op: "finish"; slot: string }
  | { op: "unmount"; slot: string };

export interface DeviceCommand {
  type: string;
  [key: string]: Json | undefined;
}

/** Намерение ядра. Исполняет его runtime; само ядро ничего не делает. */
export type Effect =
  | { kind: "render"; view: Json }
  | { kind: "schedule"; timerId: string; afterMs: number }
  | { kind: "cancel"; timerId: string }
  | { kind: "emit"; event: DomainEvent }
  | { kind: "outcome"; outcome: Outcome }
  /** Запрос параметров следующей пробы. Runtime ответит входом kind: "params". */
  | { kind: "requestParams" }
  | { kind: "complete"; summary: Json }
  | { kind: "child"; command: ChildCommand }
  | { kind: "device"; command: DeviceCommand };

export interface ReduceResult<S> {
  state: S;
  effects: Effect[];
}

/** Чистое ядро: ни DOM, ни таймеров, ни ввода-вывода. */
export interface GameCore<S = Json> {
  init(config: RunConfig): S;
  reduce(state: S, input: CoreInput): ReduceResult<S>;
}

export interface Surface {
  readonly stage: HTMLElement;
  setTask(text: string, label?: string): void;
  /**
   * Напоминание о задании над сценой. Отдельно от `setTask`, потому что адресаты
   * разные: подпись в шапке читает оператор, напоминание — участник. Покою с
   * крестиком напоминание вредно: на экране не должно быть ничего, кроме точки
   * фиксации, а подпись задания оператору при этом нужна.
   */
  setReminder(text: string): void;
  setHint(text: string): void;
  setStats(pairs: Array<[string, string | number]>): void;
  clear(): void;
}

/** Представление: получает ViewModel, не хранит состояния игры. */
export interface GameView<VM = Json> {
  mount(surface: Surface): void;
  render(view: VM): void;
  unmount(): void;
}

export interface Microgame<S = Json, VM = Json> {
  manifest: Manifest;
  core: GameCore<S>;
  paramsForLevel(level: number): Params;
  /**
   * Таблица уровней как данные. Пока её нет, уровни считает `paramsForLevel` в
   * коде — так живут модули вне протокола. С таблицей хост умеет большее: знать
   * роли осей и растить сложность по свободным, когда протокол закрепил ось.
   */
  presets?: PresetTable;
  createView(ctx: GameContext): GameView<VM>;
  /**
   * Разовая подготовка модуля перед первым запуском: догрузить то, без чего ядро
   * не может шагать. Появилось из-за заезда, где физику считает WASM: `init`
   * синхронный, а инстанцирование модуля WebAssembly — нет. Вызывать можно сколько
   * угодно раз, ждать необязательно: ядро, которому нечем шагать, обязано просто
   * ждать, не тратя время блока.
   */
  prepare?(): Promise<void>;
}

export interface Handle {
  dispose(): void;
}

export interface Clock {
  /** Монотонное время в миллисекундах от t0 запуска. */
  now(): number;
  after(ms: number, cb: () => void): Handle;
  every(ms: number, cb: () => void): Handle;
}

export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  save(): RngState;
  load(state: RngState): void;
}

export interface DifficultyHandle {
  params(): Params;
  level(): number;
  report(outcome: Outcome): void;
}

export interface ActionEvent {
  actionId: string;
  payload: ActionPayload;
  tMs: number;
  source: "keyboard" | "pointer" | "signal-trigger" | "replay";
}

/**
 * Чем участник отвечает в этом протоколе. Ёмкость ответа — свойство протокола,
 * а не модуля: на лабораторном стенде это три клавиши верхнего ряда, на
 * смартфоне палец по экрану, и модулю не положено знать, где его запустили.
 *
 * Пустой набор клавиш означает свободную сборку: действуют привязки из
 * манифеста, как в витрине и одиночных запусках.
 */
export interface InputProfile {
  /** Имя для журнала и операторского экрана. */
  id: string;
  /** Клавиши ответа слева направо. */
  keys: string[];
  /** `task-only`: мышь остаётся только там, где указание — существо задачи. */
  pointer: "free" | "task-only";
}

export interface InputHandle {
  on(actionId: string, cb: (e: ActionEvent) => void): Handle;
  /** Привязка пустая, если в этом профиле действие клавиши не получает. */
  bindings(): Array<{ id: string; label: string; binding: string }>;
  setProfile(profile: InputProfile): void;
  profile(): InputProfile;
  /** Клавиши indexed-действия по порядку вариантов: подпись берёт виджет. */
  indexKeys(actionId: string): string[];
  /** Сколько вариантов показано сейчас: столько клавиш и активно. */
  setOptionCount(count: number): void;
  /** Снять все удержания: окно потеряло фокус, «up» иначе не придёт. */
  releaseAll(): void;
  submit(actionId: string, payload?: ActionPayload, source?: ActionEvent["source"]): void;
  signal(id: string): SignalSample | null;
  onSignal(id: string, cb: (s: SignalSample) => void): Handle;
  signalState(id: string): SignalState;
}

export interface EventSink {
  emit(event: DomainEvent): void;
}

export interface ChildHost {
  /** Представление оркестратора отдаёт сюда контейнеры под дочерние задачи. */
  registerSlot(slot: string, surface: Surface): void;
  slots(): string[];
  instance(slot: string): GameInstance | null;
}

export interface DeviceHandle {
  send(command: DeviceCommand): void;
}

export interface GameContext {
  surface: Surface;
  clock: Clock;
  rng: Rng;
  difficulty: DifficultyHandle;
  input: InputHandle;
  events: EventSink;
  children?: ChildHost;
  device?: DeviceHandle;
  locale: string;
  /**
   * Обучающий прогон. Представлению это нужно затем, что разбор ошибки словами
   * идёт только в обучении: в зачёте он отнимал бы время у следующего стимула и
   * менял бы саму задачу.
   */
  training: boolean;
}

export interface RuntimeSnapshot {
  snapshotVersion: number;
  runId: string;
  packageRef: PackageRef;
  phase: Phase;
  coreState: Json;
  eventCursor: number;
  rngState: RngState;
  pendingDeadlines: Array<{ timerId: string; remainingMs: number }>;
  difficulty: { policyId: string; level: number };
  children?: Record<string, RuntimeSnapshot>;
}

export const SNAPSHOT_VERSION = 1;

export interface GameInstance {
  readonly ref: PackageRef;
  readonly phase: Phase;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  /** Команда сверху: закрыть блок, пропустить задачу, включить probe. */
  protocol(command: ProtocolCommand): void;
  snapshot(): RuntimeSnapshot;
  restore(state: RuntimeSnapshot): void;
}
