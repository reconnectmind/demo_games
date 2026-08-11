import {
  HOLD_MS,
  createRngState,
  rngInt,
  rngShuffle,
  type CoreInput,
  type GameCore,
  type Params,
  type ReduceResult,
  type RngState,
  type TrialDebrief,
} from "@gamespace/core";

export type ResponseMode = "selection" | "text-entry";

export interface ArithmeticParams extends Params {
  operandMax: number;
  /** Наибольший множитель. Умножение растёт своей осью: «32 × 9» и «32 + 17» — разная работа. */
  factorMax: number;
  operations: number;
  operationSteps: number;
  distractorDistance: number;
  optionCount: number;
  responseMode: ResponseMode;
  timeLimitMs: number;
}

export interface ArithmeticTrial {
  expr: string;
  answer: number;
  /** В text-entry вариантов нет: ответ вводится числом. */
  options: number[];
  onsetMs: number;
  responseMode: ResponseMode;
}

export interface ArithmeticState {
  rng: RngState;
  params: ArithmeticParams | null;
  running: boolean;
  startedAtMs: number | null;
  pending: ArithmeticTrial | null;
  trials: number;
  correct: number;
  rtSum: number;
  rtCount: number;
  lastFeedback: "correct" | "wrong" | null;
  lastDebrief: TrialDebrief | null;
  training: boolean;
  /** Обучение стоит на разборе и ждёт участника: следующая проба сама не придёт. */
  holding: boolean;
}

export interface ArithmeticView {
  expr: string;
  options: string[];
  responseMode: ResponseMode;
  feedback: "correct" | "wrong" | null;
  /** Разбор последней пробы: показывается только в обучении. */
  debrief: TrialDebrief | null;
  holding: boolean;
  stats: Array<[string, string | number]>;
  running: boolean;
}

const SPRINT_END = "sprint.end";
const ITI = "arithmetic.iti";
const ITI_MS = 300;
const DEFAULT_TIME_LIMIT_MS = 60_000;

const PLUS = "+";
const MINUS = "−";
const TIMES = "×";

/**
 * Полоса операндов уровня. Верхнюю границу объявляет таблица, нижняя — половина
 * от неё. Без нижней границы на одном уровне соседствуют «3 + 2» и «27 + 24»:
 * уровень тогда задаёт не нагрузку, а её потолок, и участник видит случайный
 * разброс вместо ступени. Пример должен быть трудным примерно настолько, на
 * сколько объявлен уровень, — иначе ни лестница, ни запись не сопоставимы.
 */
function band(operandMax: number): [number, number] {
  const max = Math.max(2, Math.round(operandMax));
  return [Math.max(1, Math.ceil(max / 2)), max];
}

/** Множители живут своей полосой: у умножения трудность растёт быстрее сложения. */
function factors(params: ArithmeticParams): [number, number] {
  const max = Math.max(2, Math.round(params.factorMax));
  return [2, max];
}

export function buildExpression(rng: RngState, params: ArithmeticParams): [{ expr: string; answer: number }, RngState] {
  const [low, high] = band(params.operandMax);
  const [fLow, fHigh] = factors(params);
  if (params.operationSteps >= 2) {
    const [a, r1] = rngInt(rng, fLow, fHigh);
    const [b, r2] = rngInt(r1, fLow, fHigh);
    const [c, r3] = rngInt(r2, low, high);
    return [{ expr: `${a} ${TIMES} ${b} ${PLUS} ${c}`, answer: a * b + c }, r3];
  }
  const ops = params.operations >= 3 ? [PLUS, MINUS, TIMES] : [PLUS, MINUS];
  const [opIndex, r1] = rngInt(rng, 0, ops.length - 1);
  const op = ops[opIndex] ?? PLUS;
  if (op === TIMES) {
    const [a, r2] = rngInt(r1, fLow, fHigh);
    const [b, r3] = rngInt(r2, fLow, fHigh);
    return [{ expr: `${a} ${TIMES} ${b}`, answer: a * b }, r3];
  }
  const [rawA, r2] = rngInt(r1, low, high);
  const [rawB, r3] = rngInt(r2, low, high);
  // Вычитание держим неотрицательным: отрицательный ответ — уже другая задача.
  const swap = op === MINUS && rawB > rawA;
  const a = swap ? rawB : rawA;
  const b = swap ? rawA : rawB;
  const answer = op === PLUS ? a + b : a - b;
  return [{ expr: `${a} ${op} ${b}`, answer }, r3];
}

export function buildOptions(rng: RngState, params: ArithmeticParams, answer: number): [number[], RngState] {
  if (params.responseMode === "text-entry") return [[], rng];
  const need = Math.max(0, params.optionCount - 1);
  // Внутри distractorDistance целых дистракторов может быть меньше, чем нужно
  // кнопок (полоса ±1 даёт всего два варианта), поэтому полосу расширяем до
  // минимально достаточной: различность вариантов важнее буквальной ширины.
  const distance = Math.max(params.distractorDistance, Math.ceil(need / 2));
  const deltas: number[] = [];
  for (let d = 1; d <= distance; d++) {
    deltas.push(d, -d);
  }
  const [picked, r1] = rngShuffle(rng, deltas);
  const values = [answer, ...picked.slice(0, need).map((d) => answer + d)];
  return rngShuffle(r1, values);
}

function view(state: ArithmeticState): ArithmeticView {
  const pending = state.pending;
  const mode: ResponseMode = pending?.responseMode ?? state.params?.responseMode ?? "selection";
  return {
    expr: pending ? pending.expr : state.running ? "" : "—",
    options: pending ? pending.options.map((v) => String(v)) : [],
    responseMode: mode,
    feedback: state.lastFeedback,
    debrief: state.lastDebrief,
    holding: state.holding,
    stats: [
      ["Проб", state.trials],
      ["Верно", state.correct],
      ["Средний RT", state.rtCount ? `${Math.round(state.rtSum / state.rtCount)} мс` : "—"],
    ],
    running: state.running,
  };
}

function summary(state: ArithmeticState, tMs: number) {
  const elapsedMs = state.startedAtMs === null ? 0 : Math.max(0, tMs - state.startedAtMs);
  const perMin = elapsedMs > 0 ? (state.correct * 60_000) / elapsedMs : 0;
  return {
    trials: state.trials,
    correct: state.correct,
    meanRtMs: state.rtCount ? Math.round(state.rtSum / state.rtCount) : 0,
    // Смысл спринта: сколько верных решений в минуту, а не сколько всего.
    throughputPerMin: Math.round(perMin * 100) / 100,
  };
}

/** Ответ из text-entry приходит строкой; мусор и пустая строка — не ответ. */
function parseEntered(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export const arithmeticCore: GameCore<ArithmeticState> = {
  init: (config) => ({
    rng: createRngState(config.seed),
    params: (config.initialParams as ArithmeticParams) ?? null,
    running: false,
    startedAtMs: null,
    pending: null,
    trials: 0,
    correct: 0,
    rtSum: 0,
    rtCount: 0,
    lastFeedback: null,
    lastDebrief: null,
    training: Boolean(config.training),
    holding: false,
  }),

  reduce(state, input): ReduceResult<ArithmeticState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action !== "enter" || (input.phase !== "main" && input.phase !== "intro")) {
          // Пауза не гасит таймер спринта: окно задано временем, а не числом проб.
          return { state, effects: [] };
        }
        if (state.running) {
          // Возврат после прерывания: спринт уже идёт, его таймер восстановил runtime.
          return { state, effects: [{ kind: "render", view: view(state) as never }] };
        }
        const timeLimitMs = state.params?.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
        const started: ArithmeticState = { ...state, running: true, startedAtMs: input.tMs };
        return {
          state: started,
          effects: [
            { kind: "emit", event: { type: "block.start", timeLimitMs } },
            { kind: "requestParams" },
            { kind: "schedule", timerId: SPRINT_END, afterMs: timeLimitMs },
          ],
        };
      }

      case "params": {
        const params = input.effective as ArithmeticParams;
        if (!state.running) return { state, effects: [] };
        return present({ ...state, params }, input);
      }

      case "action": {
        // Разбор снимает сам участник — и любым из своих ответов, не только
        // кнопкой: третьей руки у него нет, а отдельная клавиша означала бы, что
        // в обучении раскладка другая, чем в зачёте.
        if (state.holding) return release(state);
        const pending = state.pending;
        if (!pending || !state.running) return { state, effects: [] };
        if (input.actionId === "choose") {
          if (pending.responseMode !== "selection") return { state, effects: [] };
          const index = input.payload.index ?? -1;
          if (index < 0 || index >= pending.options.length) return { state, effects: [] };
          return score(state, pending, pending.options[index] as number, input.tMs - pending.onsetMs);
        }
        if (input.actionId === "submit") {
          if (pending.responseMode !== "text-entry") return { state, effects: [] };
          const entered = parseEntered(input.payload.value);
          if (entered === null) return { state, effects: [] };
          return score(state, pending, entered, input.tMs - pending.onsetMs);
        }
        return { state, effects: [] };
      }

      case "deadline": {
        if (input.timerId === SPRINT_END) return finish(state, input.tMs);
        if (input.timerId !== ITI) return { state, effects: [] };
        if (!state.running) return { state, effects: [] };
        // Параметры запрашиваются заново на каждую пробу: уровень мог измениться.
        return release(state);
      }

      case "protocol": {
        if (input.command.type === "finish") return finish(state, input.tMs);
        return { state, effects: [] };
      }

      default:
        return { state, effects: [] };
    }
  },
};

function present(state: ArithmeticState, input: CoreInput): ReduceResult<ArithmeticState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const [expression, r1] = buildExpression(state.rng, params);
  const [options, r2] = buildOptions(r1, params, expression.answer);
  const pending: ArithmeticTrial = {
    expr: expression.expr,
    answer: expression.answer,
    options,
    onsetMs: input.tMs,
    responseMode: params.responseMode,
  };
  const next: ArithmeticState = {
    ...state,
    rng: r2,
    pending,
    lastFeedback: null,
    lastDebrief: null,
    trials: state.trials + 1,
  };
  return {
    state: next,
    effects: [
      { kind: "render", view: view(next) as never },
      {
        kind: "emit",
        event: {
          type: "stimulus.presented",
          trial: next.trials,
          expr: pending.expr,
          answer: pending.answer,
          options: [...pending.options],
          responseMode: pending.responseMode,
          plannedOnsetMs: input.tMs,
        },
      },
    ],
  };
}

function score(
  state: ArithmeticState,
  pending: ArithmeticTrial,
  answered: number,
  rtMs: number,
): ReduceResult<ArithmeticState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const correct = answered === pending.answer;
  // В обучении проба с ошибкой заканчивается разбором, а не следующим примером:
  // промежуток между пробами — треть секунды, прочитать за неё нельзя ничего.
  const holding = state.training && !correct;
  const next: ArithmeticState = {
    ...state,
    pending: null,
    correct: state.correct + (correct ? 1 : 0),
    rtSum: state.rtSum + rtMs,
    rtCount: state.rtCount + 1,
    lastFeedback: correct ? "correct" : "wrong",
    lastDebrief: correct ? null : { expected: String(pending.answer), got: String(answered) },
    holding,
  };
  return {
    state: next,
    effects: [
      { kind: "emit", event: { type: "response", answered, expected: pending.answer, correct, rtMs } },
      { kind: "outcome", outcome: { kind: "trial", scored: true, correct, rtMs, paramsUsed: { ...params } } },
      { kind: "render", view: view(next) as never },
      // Ожидание разбора всё равно ограничено: участник мог отвернуться, а спринт
      // обязан идти дальше сам.
      { kind: "schedule", timerId: ITI, afterMs: holding ? HOLD_MS : ITI_MS },
    ],
  };
}

/** Участник прочитал разбор: дальше спринт идёт как обычно, со следующей пробы. */
function release(state: ArithmeticState): ReduceResult<ArithmeticState> {
  const next: ArithmeticState = { ...state, holding: false, lastFeedback: null, lastDebrief: null };
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: ITI },
      { kind: "render", view: view(next) as never },
      ...(next.running ? [{ kind: "requestParams" as const }] : []),
    ],
  };
}

function finish(state: ArithmeticState, tMs: number): ReduceResult<ArithmeticState> {
  const result = summary(state, tMs);
  const next: ArithmeticState = { ...state, running: false, pending: null, holding: false };
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: ITI },
      { kind: "cancel", timerId: SPRINT_END },
      { kind: "emit", event: { type: "block.end", ...result } },
      { kind: "render", view: view(next) as never },
      { kind: "complete", summary: result as never },
    ],
  };
}
