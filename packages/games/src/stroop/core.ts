import {
  createRngState,
  rngInt,
  rngNext,
  type CoreInput,
  type GameCore,
  type Params,
  type ReduceResult,
  type RngState,
  type TrialDebrief,
} from "@gamespace/core";

/**
 * Цвета задачи — имена, а не пиксели. Ядро решает, каким цветом написано слово и
 * какой цвет верен; каким именно пикселем этот цвет показать, решает тема, иначе
 * вторая тема до стимула не дотянулась бы, а ядро знало бы про экран.
 */
export const COLORS = ["красный", "синий", "зелёный", "жёлтый", "фиолетовый", "голубой"] as const;

export type ColorName = (typeof COLORS)[number];

export interface StroopParams extends Params {
  colorCount: number;
  incongruentRate: number;
  deadlineMs: number;
  blockLength: number;
}

export interface StroopTrial {
  inkIndex: number;
  wordIndex: number;
  congruent: boolean;
  onsetMs: number;
  optionCount: number;
}

export interface StroopState {
  rng: RngState;
  trial: number;
  correct: number;
  rtSum: number;
  rtCount: number;
  congruentRtSum: number;
  congruentCount: number;
  incongruentRtSum: number;
  incongruentCount: number;
  pending: StroopTrial | null;
  params: StroopParams | null;
  running: boolean;
  lastFeedback: "correct" | "wrong" | "timeout" | null;
  lastDebrief: TrialDebrief | null;
}

export interface StroopView {
  word: string;
  /** Имя цвета чернил: пиксель под это имя подбирает представление. */
  ink: ColorName | null;
  options: string[];
  feedback: "correct" | "wrong" | "timeout" | null;
  /** Разбор последней пробы: показывается только в обучении. */
  debrief: TrialDebrief | null;
  stats: Array<[string, string | number]>;
  running: boolean;
}

const DEADLINE = "stroop.deadline";
const ITI = "stroop.iti";

function view(state: StroopState): StroopView {
  const params = state.params;
  const optionCount = params?.colorCount ?? 3;
  const pending = state.pending;
  return {
    word: pending ? (COLORS[pending.wordIndex]?.toUpperCase() ?? "") : state.running ? "" : "—",
    ink: pending ? (COLORS[pending.inkIndex] ?? null) : null,
    options: COLORS.slice(0, optionCount).map((name) => name),
    feedback: state.lastFeedback,
    debrief: state.lastDebrief,
    stats: [
      ["Проб", state.trial],
      ["Верно", state.correct],
      ["Средний RT", state.rtCount ? `${Math.round(state.rtSum / state.rtCount)} мс` : "—"],
    ],
    running: state.running,
  };
}

function summary(state: StroopState) {
  const meanRt = state.rtCount ? state.rtSum / state.rtCount : 0;
  const congruentRt = state.congruentCount ? state.congruentRtSum / state.congruentCount : 0;
  const incongruentRt = state.incongruentCount ? state.incongruentRtSum / state.incongruentCount : 0;
  return {
    trials: state.trial,
    correct: state.correct,
    meanRtMs: Math.round(meanRt),
    // Смысл всей задачи: насколько конфликтная проба дороже согласованной.
    interferenceMs: Math.round(incongruentRt - congruentRt),
  };
}

export const stroopCore: GameCore<StroopState> = {
  init: (config) => ({
    rng: createRngState(config.seed),
    trial: 0,
    correct: 0,
    rtSum: 0,
    rtCount: 0,
    congruentRtSum: 0,
    congruentCount: 0,
    incongruentRtSum: 0,
    incongruentCount: 0,
    pending: null,
    params: (config.initialParams as StroopParams) ?? null,
    running: false,
    lastFeedback: null,
    lastDebrief: null,
  }),

  reduce(state, input): ReduceResult<StroopState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action === "enter" && (input.phase === "main" || input.phase === "intro")) {
          const started: StroopState = { ...state, running: true };
          return {
            state: started,
            effects: [
              { kind: "emit", event: { type: "block.start", blockLength: state.params?.blockLength ?? 0 } },
              { kind: "requestParams" },
            ],
          };
        }
        if (input.action === "enter" && input.phase === "paused") {
          return { state, effects: [{ kind: "cancel", timerId: DEADLINE }] };
        }
        return { state, effects: [] };
      }

      case "params": {
        const params = input.effective as StroopParams;
        return presentTrial({ ...state, params }, input);
      }

      case "action": {
        const pending = state.pending;
        if (!pending || input.actionId !== "choose") return { state, effects: [] };
        const index = input.payload.index ?? -1;
        if (index < 0 || index >= pending.optionCount) return { state, effects: [] };
        return score(state, pending, index, input.tMs - pending.onsetMs);
      }

      case "deadline": {
        if (input.timerId === ITI) return presentNext(state);
        if (input.timerId !== DEADLINE || !state.pending) return { state, effects: [] };
        return score(state, state.pending, null, null);
      }

      case "protocol": {
        if (input.command.type === "finish") return finish(state);
        return { state, effects: [] };
      }

      default:
        return { state, effects: [] };
    }
  },
};

function presentTrial(state: StroopState, input: CoreInput): ReduceResult<StroopState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const [inkIndex, r1] = rngInt(state.rng, 0, params.colorCount - 1);
  const [roll, r2] = rngNext(r1);
  let wordIndex = inkIndex;
  let rng = r2;
  if (roll < params.incongruentRate && params.colorCount > 1) {
    let candidate = inkIndex;
    while (candidate === inkIndex) {
      const [next, r3] = rngInt(rng, 0, params.colorCount - 1);
      candidate = next;
      rng = r3;
    }
    wordIndex = candidate;
  }
  const pending: StroopTrial = {
    inkIndex,
    wordIndex,
    congruent: inkIndex === wordIndex,
    onsetMs: input.tMs,
    optionCount: params.colorCount,
  };
  const next: StroopState = { ...state, rng, pending, lastFeedback: null, lastDebrief: null, trial: state.trial + 1 };
  return {
    state: next,
    effects: [
      { kind: "render", view: view(next) as never },
      {
        kind: "emit",
        event: {
          type: "stimulus.presented",
          trial: next.trial,
          ink: COLORS[inkIndex] ?? "",
          word: COLORS[wordIndex] ?? "",
          congruent: pending.congruent,
          plannedOnsetMs: input.tMs,
        },
      },
      { kind: "schedule", timerId: DEADLINE, afterMs: params.deadlineMs },
    ],
  };
}

function score(
  state: StroopState,
  pending: StroopTrial,
  chosen: number | null,
  rtMs: number | null,
): ReduceResult<StroopState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const correct = chosen === pending.inkIndex;
  const next: StroopState = {
    ...state,
    pending: null,
    correct: state.correct + (correct ? 1 : 0),
    rtSum: state.rtSum + (rtMs ?? 0),
    rtCount: state.rtCount + (rtMs === null ? 0 : 1),
    congruentRtSum: state.congruentRtSum + (pending.congruent && rtMs !== null ? rtMs : 0),
    congruentCount: state.congruentCount + (pending.congruent && rtMs !== null ? 1 : 0),
    incongruentRtSum: state.incongruentRtSum + (!pending.congruent && rtMs !== null ? rtMs : 0),
    incongruentCount: state.incongruentCount + (!pending.congruent && rtMs !== null ? 1 : 0),
    lastFeedback: rtMs === null ? "timeout" : correct ? "correct" : "wrong",
    // Разбор в терминах задачи: требовался цвет чернил, пришёл выбранный цвет.
    lastDebrief: correct
      ? null
      : { expected: COLORS[pending.inkIndex] ?? null, got: chosen === null ? null : COLORS[chosen] ?? null },
  };
  const done = next.trial >= params.blockLength;
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: DEADLINE },
      { kind: "emit", event: { type: "response", chosen, correct, rtMs, congruent: pending.congruent } },
      {
        kind: "outcome",
        outcome: { kind: "trial", scored: true, correct, rtMs, paramsUsed: { ...params } },
      },
      { kind: "render", view: view(next) as never },
      done
        ? { kind: "schedule", timerId: ITI, afterMs: 350 }
        : { kind: "schedule", timerId: ITI, afterMs: 350 },
    ],
  };
}

function presentNext(state: StroopState): ReduceResult<StroopState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  if (state.trial >= params.blockLength) return finish(state);
  // Параметры запрашиваются заново в начале каждой пробы: уровень мог измениться.
  return { state, effects: [{ kind: "requestParams" }] };
}

function finish(state: StroopState): ReduceResult<StroopState> {
  const result = summary(state);
  const next: StroopState = { ...state, running: false, pending: null };
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: DEADLINE },
      { kind: "emit", event: { type: "block.end", ...result } },
      { kind: "render", view: view(next) as never },
      { kind: "complete", summary: result as never },
    ],
  };
}
