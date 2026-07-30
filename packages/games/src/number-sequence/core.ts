import {
  createRngState,
  rngShuffle,
  type CoreInput,
  type Effect,
  type GameCore,
  type Params,
  type ReduceResult,
  type RngState,
} from "@gamespace/core";

export interface NumberSequenceParams extends Params {
  gridCells: number;
  sequenceLength: number;
  deadlineMs: number;
  reshuffleAfterEach: boolean;
}

export interface NumberSequenceState {
  rng: RngState;
  params: NumberSequenceParams | null;
  running: boolean;
  /** Раскладка поля: layout[ячейка] = число, 0 — пусто. Переживает снимок. */
  layout: number[];
  /** Ожидаемое число. Вместе с раскладкой это и есть точка возврата к задаче. */
  expected: number;
  /** Последнее число текущей последовательности; 0 — последовательности нет. */
  lastNumber: number;
  windowStartMs: number;
  sequence: number;
  sequencesDone: number;
  seqTrials: number;
  seqCorrect: number;
  presses: number;
  errors: number;
  rtSum: number;
  rtCount: number;
  lastCell: number;
  lastFeedback: "correct" | "wrong" | "timeout" | null;
}

export interface NumberSequenceCell {
  index: number;
  label: string;
  state: "idle" | "wrong";
}

/**
 * В ViewModel нет ожидаемого числа: если подсказать его на экране, возврат к
 * задаче перестанет чего-либо стоить, а именно эта цена здесь и измеряется.
 */
export interface NumberSequenceView {
  side: number;
  cells: NumberSequenceCell[];
  options: string[];
  feedback: "correct" | "wrong" | "timeout" | null;
  stats: Array<[string, string | number]>;
  running: boolean;
}

const PRESS = "sequence.press";
const SEQUENCES_PER_RUN = 3;
const DEFAULT_GRID_CELLS = 9;

function numbersFrom(first: number, last: number): number[] {
  const out: number[] = [];
  for (let n = first; n <= last; n++) out.push(n);
  return out;
}

export function placeNumbers(rng: RngState, cells: number, numbers: number[]): [number[], RngState] {
  const [order, next] = rngShuffle(rng, numbersFrom(0, cells - 1));
  const layout = new Array<number>(cells).fill(0);
  numbers.forEach((n, i) => {
    const cell = order[i];
    if (cell !== undefined) layout[cell] = n;
  });
  return [layout, next];
}

function view(state: NumberSequenceState): NumberSequenceView {
  const cellCount = state.layout.length > 0 ? state.layout.length : (state.params?.gridCells ?? DEFAULT_GRID_CELLS);
  const cells: NumberSequenceCell[] = [];
  for (let index = 0; index < cellCount; index++) {
    const number = state.layout[index] ?? 0;
    cells.push({
      index,
      label: number > 0 ? String(number) : "",
      state: index === state.lastCell && state.lastFeedback === "wrong" ? "wrong" : "idle",
    });
  }
  return {
    side: Math.max(1, Math.round(Math.sqrt(cellCount))),
    cells,
    options: cells.map((cell) => cell.label),
    feedback: state.lastFeedback,
    stats: [
      ["Последовательность", `${Math.min(state.sequencesDone + 1, SEQUENCES_PER_RUN)} из ${SEQUENCES_PER_RUN}`],
      ["Ошибок", state.errors],
      ["Средний RT", state.rtCount ? `${Math.round(state.rtSum / state.rtCount)} мс` : "—"],
    ],
    running: state.running,
  };
}

function summary(state: NumberSequenceState) {
  return {
    sequences: state.sequencesDone,
    presses: state.presses,
    errors: state.errors,
    meanPressRtMs: state.rtCount ? Math.round(state.rtSum / state.rtCount) : 0,
  };
}

function sequenceActive(state: NumberSequenceState): boolean {
  return state.lastNumber > 0 && state.expected >= 1 && state.expected <= state.lastNumber;
}

export const numberSequenceCore: GameCore<NumberSequenceState> = {
  init: (config) => ({
    rng: createRngState(config.seed),
    params: (config.initialParams as NumberSequenceParams) ?? null,
    running: false,
    layout: [],
    expected: 0,
    lastNumber: 0,
    windowStartMs: 0,
    sequence: 0,
    sequencesDone: 0,
    seqTrials: 0,
    seqCorrect: 0,
    presses: 0,
    errors: 0,
    rtSum: 0,
    rtCount: 0,
    lastCell: -1,
    lastFeedback: null,
  }),

  reduce(state, input): ReduceResult<NumberSequenceState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action !== "enter" || (input.phase !== "main" && input.phase !== "intro")) {
          return { state, effects: [] };
        }
        if (state.running) {
          const params = state.params;
          // Возврат после прерывания: раскладка и ожидаемое число пережили снимок,
          // а окно на нажатие открываем заново — участник только что вернулся.
          if (params && sequenceActive(state)) {
            return {
              state: { ...state, windowStartMs: input.tMs },
              effects: [
                { kind: "render", view: view(state) as never },
                { kind: "schedule", timerId: PRESS, afterMs: params.deadlineMs },
              ],
            };
          }
          return { state, effects: [{ kind: "requestParams" }] };
        }
        const started: NumberSequenceState = { ...state, running: true, sequence: 1 };
        return {
          state: started,
          effects: [
            { kind: "emit", event: { type: "block.start", sequence: 1 } },
            { kind: "requestParams" },
          ],
        };
      }

      case "params": {
        if (!state.running) return { state, effects: [] };
        return startSequence(state, input.effective as NumberSequenceParams, input);
      }

      case "action": {
        const params = state.params;
        if (!params || !state.running || input.actionId !== "choose") return { state, effects: [] };
        if (!sequenceActive(state)) return { state, effects: [] };
        const cell = input.payload.index ?? -1;
        if (cell < 0 || cell >= state.layout.length) return { state, effects: [] };
        const number = state.layout[cell] ?? 0;
        return number === state.expected
          ? acceptPress(state, params, cell, number, input.tMs)
          : rejectPress(state, params, cell, number, input.tMs);
      }

      case "deadline": {
        if (input.timerId !== PRESS || !state.running) return { state, effects: [] };
        const params = state.params;
        if (!params || !sequenceActive(state)) return { state, effects: [] };
        return missPress(state, params, input.tMs);
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

function startSequence(
  state: NumberSequenceState,
  params: NumberSequenceParams,
  input: CoreInput,
): ReduceResult<NumberSequenceState> {
  // Поле не может показать больше чисел, чем в нём ячеек.
  const count = Math.max(1, Math.min(params.sequenceLength, params.gridCells));
  const [layout, rng] = placeNumbers(state.rng, params.gridCells, numbersFrom(1, count));
  const next: NumberSequenceState = {
    ...state,
    params,
    rng,
    layout,
    expected: 1,
    lastNumber: count,
    windowStartMs: input.tMs,
    seqTrials: 0,
    seqCorrect: 0,
    lastCell: -1,
    lastFeedback: null,
  };
  return {
    state: next,
    effects: [
      { kind: "render", view: view(next) as never },
      {
        kind: "emit",
        event: {
          type: "stimulus.presented",
          sequence: next.sequence,
          cells: params.gridCells,
          numbers: count,
          plannedOnsetMs: input.tMs,
        },
      },
      { kind: "schedule", timerId: PRESS, afterMs: params.deadlineMs },
    ],
  };
}

function acceptPress(
  state: NumberSequenceState,
  params: NumberSequenceParams,
  cell: number,
  number: number,
  tMs: number,
): ReduceResult<NumberSequenceState> {
  const rtMs = Math.max(0, tMs - state.windowStartMs);
  const cleared = [...state.layout];
  cleared[cell] = 0;
  const expected = state.expected + 1;
  let rng = state.rng;
  let layout = cleared;
  if (params.reshuffleAfterEach && expected <= state.lastNumber) {
    const [reshuffled, nextRng] = placeNumbers(rng, params.gridCells, numbersFrom(expected, state.lastNumber));
    layout = reshuffled;
    rng = nextRng;
  }
  const next: NumberSequenceState = {
    ...state,
    rng,
    layout,
    expected,
    windowStartMs: tMs,
    seqTrials: state.seqTrials + 1,
    seqCorrect: state.seqCorrect + 1,
    presses: state.presses + 1,
    rtSum: state.rtSum + rtMs,
    rtCount: state.rtCount + 1,
    lastCell: cell,
    lastFeedback: "correct",
  };
  const response: Effect = {
    kind: "emit",
    event: { type: "response", cell, number, correct: true, rtMs },
  };
  if (expected <= state.lastNumber) {
    return {
      state: next,
      effects: [
        response,
        { kind: "render", view: view(next) as never },
        { kind: "schedule", timerId: PRESS, afterMs: params.deadlineMs },
      ],
    };
  }
  return closeSequence(next, params, response);
}

function rejectPress(
  state: NumberSequenceState,
  params: NumberSequenceParams,
  cell: number,
  number: number,
  tMs: number,
): ReduceResult<NumberSequenceState> {
  const next: NumberSequenceState = {
    ...state,
    windowStartMs: tMs,
    seqTrials: state.seqTrials + 1,
    presses: state.presses + 1,
    errors: state.errors + 1,
    lastCell: cell,
    lastFeedback: "wrong",
  };
  return {
    state: next,
    effects: [
      { kind: "emit", event: { type: "response", cell, number, correct: false, expected: state.expected, rtMs: null } },
      { kind: "render", view: view(next) as never },
      { kind: "schedule", timerId: PRESS, afterMs: params.deadlineMs },
    ],
  };
}

function missPress(
  state: NumberSequenceState,
  params: NumberSequenceParams,
  tMs: number,
): ReduceResult<NumberSequenceState> {
  // Промах по дедлайну — попытка, но не нажатие: presses считает только реальные
  // нажатия, а точность последовательности пропуск обязан ухудшать.
  const next: NumberSequenceState = {
    ...state,
    windowStartMs: tMs,
    seqTrials: state.seqTrials + 1,
    errors: state.errors + 1,
    lastCell: -1,
    lastFeedback: "timeout",
  };
  return {
    state: next,
    effects: [
      { kind: "emit", event: { type: "response", cell: null, correct: false, expected: state.expected, rtMs: null, timeout: true } },
      { kind: "render", view: view(next) as never },
      { kind: "schedule", timerId: PRESS, afterMs: params.deadlineMs },
    ],
  };
}

/**
 * Последовательность — целая зачётная единица: сложность двигает исход вида
 * block, а не отдельные нажатия внутри неё.
 */
function closeSequence(
  state: NumberSequenceState,
  params: NumberSequenceParams,
  response: Effect,
): ReduceResult<NumberSequenceState> {
  const accuracy = state.seqTrials > 0 ? state.seqCorrect / state.seqTrials : 0;
  const done = state.sequencesDone + 1;
  const last = done >= SEQUENCES_PER_RUN;
  const next: NumberSequenceState = {
    ...state,
    sequencesDone: done,
    sequence: last ? state.sequence : state.sequence + 1,
    expected: 0,
    lastNumber: 0,
    running: !last,
  };
  const tail: Effect[] = last
    ? [{ kind: "complete", summary: summary(next) as never }]
    : [{ kind: "emit", event: { type: "block.start", sequence: next.sequence } }, { kind: "requestParams" }];
  return {
    state: next,
    effects: [
      response,
      { kind: "cancel", timerId: PRESS },
      {
        kind: "emit",
        event: { type: "block.end", sequence: state.sequence, accuracy, trials: state.seqTrials },
      },
      {
        kind: "outcome",
        outcome: { kind: "block", scored: true, accuracy, trials: state.seqTrials, paramsUsed: { ...params } },
      },
      { kind: "render", view: view(next) as never },
      ...tail,
    ],
  };
}

function finish(state: NumberSequenceState): ReduceResult<NumberSequenceState> {
  const next: NumberSequenceState = { ...state, running: false, expected: 0, lastNumber: 0 };
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: PRESS },
      { kind: "emit", event: { type: "block.end", sequence: state.sequence, aborted: true } },
      { kind: "render", view: view(next) as never },
      { kind: "complete", summary: summary(next) as never },
    ],
  };
}
