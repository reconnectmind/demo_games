import type { DifficultyHandle, Outcome, Params } from "./contracts.js";

export interface DifficultyPolicy {
  readonly id: string;
  current(): number;
  report(outcome: Outcome): void;
  /** Ручной режим: оператор задаёт уровень напрямую. */
  set?(level: number): void;
}

export interface PolicyOptions {
  start?: number;
  min?: number;
  max?: number;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Нынешняя витринная 2-up/1-down. Уровень может как расти, так и падать. */
export class AdaptiveStaircase implements DifficultyPolicy {
  readonly id = "adaptive-staircase";
  private level: number;
  private streak = 0;
  private readonly min: number;
  private readonly max: number;

  constructor(opts: PolicyOptions = {}) {
    this.min = opts.min ?? 1;
    this.max = opts.max ?? 8;
    this.level = clamp(opts.start ?? 1, this.min, this.max);
  }

  current(): number {
    return this.level;
  }

  report(outcome: Outcome): void {
    if (!outcome.scored) return;
    const ok = outcome.kind === "trial" ? outcome.correct : outcome.accuracy >= 0.75;
    if (ok) {
      this.streak++;
      if (this.streak >= 2) {
        this.streak = 0;
        this.level = clamp(this.level + 1, this.min, this.max);
      }
    } else {
      this.streak = 0;
      this.level = clamp(this.level - 1, this.min, this.max);
    }
  }
}

/**
 * Монотонная политика из бэклога: сложность только растёт. Провал не понижает
 * уровень, а лишь откладывает следующий шаг — иначе кривая нагрузки перестаёт
 * быть монотонной и её нельзя сопоставить с гемодинамикой.
 */
export class Monotonic implements DifficultyPolicy {
  readonly id = "monotonic";
  private level: number;
  private streak = 0;
  private readonly min: number;
  private readonly max: number;
  private readonly needed: number;

  constructor(opts: PolicyOptions & { successesToAdvance?: number } = {}) {
    this.min = opts.min ?? 1;
    this.max = opts.max ?? 8;
    this.level = clamp(opts.start ?? 1, this.min, this.max);
    this.needed = opts.successesToAdvance ?? 2;
  }

  current(): number {
    return this.level;
  }

  report(outcome: Outcome): void {
    if (!outcome.scored) return;
    const ok = outcome.kind === "trial" ? outcome.correct : outcome.accuracy >= 0.75;
    if (!ok) {
      this.streak = 0;
      return;
    }
    if (++this.streak >= this.needed) {
      this.streak = 0;
      this.level = clamp(this.level + 1, this.min, this.max);
    }
  }
}

/** Ручной режим: уровень задаёт оператор, исходы на него не влияют. */
export class Manual implements DifficultyPolicy {
  readonly id = "manual";
  private level: number;
  private readonly min: number;
  private readonly max: number;

  constructor(opts: PolicyOptions = {}) {
    this.min = opts.min ?? 1;
    this.max = opts.max ?? 8;
    this.level = clamp(opts.start ?? 1, this.min, this.max);
  }

  current(): number {
    return this.level;
  }

  report(): void {}

  set(level: number): void {
    this.level = clamp(Math.round(level), this.min, this.max);
  }
}

/** Probe-trials: сложность заморожена, измеряем утомление при неизменной нагрузке. */
export class Fixed implements DifficultyPolicy {
  readonly id = "fixed";
  constructor(private readonly value: number) {}
  current(): number {
    return this.value;
  }
  report(): void {}
}

/**
 * Границы, в которых исследователь разрешил параметру ходить. Закрепление —
 * частный случай: совпавшие границы означают, что ось стоит.
 */
export interface Bound {
  min?: number;
  max?: number;
}

export type Bounds = Record<string, Bound>;

/** Ось стоит, если границы сомкнулись: расти по ней политике больше некуда. */
export function isPinned(bound: Bound | undefined): boolean {
  return bound?.min !== undefined && bound.max !== undefined && bound.min === bound.max;
}

/** За границы значение не выпускается; нечисловые параметры границам не подчиняются. */
export function clampParams(params: Params, bounds: Bounds | undefined): Params {
  if (!bounds) return params;
  const out: Params = { ...params };
  for (const [key, bound] of Object.entries(bounds)) {
    const value = out[key];
    if (typeof value !== "number") continue;
    out[key] = clamp(value, bound.min ?? -Infinity, bound.max ?? Infinity);
  }
  return out;
}

export interface DifficultyHandleOptions {
  policy: DifficultyPolicy;
  paramsForLevel(level: number): Params;
  /** Ручные переопределения оператора поверх выданных политикой параметров. */
  overrides?: Params;
  /**
   * Границы значений, объявленные протоколом. Уровень остаётся уровнем, но
   * значение за границу не выходит: исследователь ограничивает нагрузку по оси,
   * не переписывая таблицу пресетов.
   */
  bounds?: Bounds;
  /**
   * Оси, закреплённые протоколом. Знать их обязательно: иначе лестница
   * продолжает «тратить» рост на закреплённую ось, значение затирается
   * переопределением, и уровень растёт, а нагрузка стоит. Внешне всё исправно —
   * политика повышает уровень, журнал пишет `difficulty.changed`, — и потому
   * такое молчаливое затирание опаснее ошибки.
   */
  frozen?: string[];
  /** Оси, по которым этот протокол ещё может расти. */
  free?: string[];
  onOutcome(outcome: Outcome, levelBefore: number, levelAfter: number): void;
  onChanged?(level: number, params: Params): void;
  /** Обучение: исходы не идут в политику вообще. */
  training?: boolean;
}

/** Что осталось у политики после закреплений протокола. */
export interface DifficultyFreedom {
  frozen: string[];
  free: string[];
}

/**
 * Ручка для игры: только чтение параметров и отчёт об исходе. Игра не знает,
 * какая политика активна, и не может понизить себе уровень.
 */
export class DifficultyController implements DifficultyHandle {
  private readonly opts: DifficultyHandleOptions;
  private overrides: Params;
  private activePolicy: DifficultyPolicy;

  constructor(opts: DifficultyHandleOptions) {
    this.opts = opts;
    this.overrides = { ...(opts.overrides ?? {}) };
    this.activePolicy = opts.policy;
  }

  get policy(): DifficultyPolicy {
    return this.activePolicy;
  }

  /** Степени свободы наружу: оператору — показать, журналу — записать рядом с уровнем. */
  freedom(): DifficultyFreedom {
    return { frozen: [...(this.opts.frozen ?? [])], free: [...(this.opts.free ?? [])] };
  }

  /**
   * Смена политики посреди запуска: оператору нужно уметь перехватить
   * управление сложностью, не прерывая блок. Уровень при этом сохраняется —
   * иначе участник получил бы скачок нагрузки в момент вмешательства.
   */
  setPolicy(policy: DifficultyPolicy): void {
    const level = this.activePolicy.current();
    policy.set?.(level);
    this.activePolicy = policy;
    this.opts.onChanged?.(this.level(), this.params());
  }

  level(): number {
    return this.activePolicy.current();
  }

  params(): Params {
    // Порядок важен: границы применяются последними, поэтому ни таблица уровня,
    // ни ручка оператора не могут вывести значение за объявленный диапазон.
    return clampParams(
      { ...this.opts.paramsForLevel(this.activePolicy.current()), ...this.overrides },
      this.opts.bounds,
    );
  }

  setOverrides(overrides: Params): void {
    this.overrides = { ...overrides };
    this.opts.onChanged?.(this.level(), this.params());
  }

  clearOverrides(): void {
    this.overrides = {};
    this.opts.onChanged?.(this.level(), this.params());
  }

  /** Возвращает false, если активная политика не отдаёт уровень оператору. */
  setLevel(level: number): boolean {
    if (!this.activePolicy.set) return false;
    this.activePolicy.set(level);
    this.opts.onChanged?.(this.level(), this.params());
    return true;
  }

  report(outcome: Outcome): void {
    const before = this.activePolicy.current();
    const effective: Outcome = this.opts.training ? { ...outcome, scored: false } : outcome;
    this.activePolicy.report(effective);
    const after = this.activePolicy.current();
    this.opts.onOutcome(effective, before, after);
    if (after !== before) this.opts.onChanged?.(after, this.params());
  }
}
