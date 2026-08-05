/**
 * Когда заканчивается участок расписания — не дело игры. Игра знает свою
 * зачётную единицу (проба, эпизод, последовательность) и закрывает блок по ней;
 * сколько таких блоков и сколько минут идёт участок, решает протокол.
 */
export interface SeriesState {
  /** Сколько прогонов уже завершилось в этом участке. */
  runs: number;
  /** Время от начала участка без учёта пауз, мс. */
  elapsedMs: number;
  /** Сколько длится текущий прогон, мс; ноль, если между прогонами. */
  runElapsedMs: number;
  /** Что из объявленного участком уже пройдено; пусто там, где покрытие не считается. */
  coverage?: CoverageState[];
}

export interface CoverageState {
  gameId: string;
  attempts: number;
  /** Критерий допуска выполнен хотя бы в одной попытке. */
  passed: boolean;
  /** Попытки исчерпаны: задача остаётся непройденной, но участок идёт дальше. */
  exhausted: boolean;
}

export interface TerminationPolicy {
  readonly id: string;
  /** Спрашивается перед каждым прогоном, включая первый. */
  next(state: SeriesState): "run" | "stop";
  /** Спрашивается тиком во время прогона: дать доиграть или закрыть блок. */
  during(state: SeriesState): "continue" | "finish";
}

/**
 * Участок с фиксированной длительностью: игра перезапускается, пока есть время,
 * а последний блок закрывается по команде протокола, а не обрывается.
 */
export function byTime(ms: number): TerminationPolicy {
  return {
    id: `by-time:${ms}`,
    next: (s) => (s.elapsedMs < ms ? "run" : "stop"),
    during: (s) => (s.elapsedMs >= ms ? "finish" : "continue"),
  };
}

/** Фиксированное число прогонов: каждый доигрывается до собственного конца. */
export function byRuns(count: number): TerminationPolicy {
  return {
    id: `by-runs:${count}`,
    next: (s) => (s.runs < count ? "run" : "stop"),
    during: () => "continue",
  };
}

/** Один прогон и всё: участок кончается вместе с игрой. */
export function once(): TerminationPolicy {
  return byRuns(1);
}

/** Что наступит раньше: любая из политик может закрыть участок или блок. */
export function firstOf(...policies: TerminationPolicy[]): TerminationPolicy {
  return {
    id: `first-of:${policies.map((p) => p.id).join("+")}`,
    next: (s) => (policies.every((p) => p.next(s) === "run") ? "run" : "stop"),
    during: (s) => (policies.some((p) => p.during(s) === "finish") ? "finish" : "continue"),
  };
}

/**
 * Участок по покрытию: он кончается, когда каждая объявленная задача либо прошла
 * критерий допуска, либо исчерпала попытки. Обучение задаётся именно так, а не
 * временем ротации: задача предъявляется потому, что она в списке, а не потому,
 * что до неё дошла очередь — иначе часть участников не увидит часть заданий, и
 * это будет видно только из расчёта времени, а не из журнала.
 */
export function byCoverage(): TerminationPolicy {
  const covered = (s: SeriesState): boolean =>
    (s.coverage ?? []).every((c) => c.passed || c.exhausted);
  return {
    id: "by-coverage",
    next: (s) => (covered(s) ? "stop" : "run"),
    during: () => "continue",
  };
}

/** Ограничение на длину одного прогона, не всего участка. */
export function runNoLongerThan(ms: number): TerminationPolicy {
  return {
    id: `run-limit:${ms}`,
    next: () => "run",
    during: (s) => (s.runElapsedMs >= ms ? "finish" : "continue"),
  };
}
