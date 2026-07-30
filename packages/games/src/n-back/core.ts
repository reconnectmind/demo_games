import {
  createRngState,
  rngNext,
  rngPick,
  type Effect,
  type GameCore,
  type Json,
  type Params,
  type ReduceResult,
  type RngState,
} from "@gamespace/core";

/** Буквы без похожих по звучанию пар: путаница на слух не должна попадать в ошибки памяти. */
export const NBACK_LETTERS: readonly string[] = ["C", "H", "K", "L", "Q", "R", "S", "T"];

export const NB_STIM = "nb.stim";
export const NB_ISI = "nb.isi";

export interface NBackParams extends Params {
  n: number;
  stimulusMs: number;
  isiMs: number;
  targetRate: number;
  blockLength: number;
}

export interface NBackStream {
  letters: string[];
  /** Целевая ли проба: совпадает ли буква с той, что была n шагов назад. */
  targets: boolean[];
}

export type NBackFeedback = "hit" | "false-alarm" | "miss" | null;

export interface NBackState {
  rng: RngState;
  params: NBackParams | null;
  running: boolean;
  finished: boolean;
  /** Поток на весь блок строится заранее: доля совпадений задаётся точно, а не в среднем. */
  stream: string[];
  targetFlags: boolean[];
  index: number;
  visible: boolean;
  onsetMs: number;
  responded: boolean;
  trials: number;
  targets: number;
  hits: number;
  falseAlarms: number;
  misses: number;
  correctRejections: number;
  rtSum: number;
  rtCount: number;
  feedback: NBackFeedback;
}

export interface NBackView {
  letter: string;
  n: number;
  visible: boolean;
  running: boolean;
  finished: boolean;
  feedback: NBackFeedback;
  stats: Array<[string, string | number]>;
}

export interface NBackSummary {
  trials: number;
  targets: number;
  hits: number;
  falseAlarms: number;
  misses: number;
  dPrimeApprox: number;
}

/**
 * Поток на весь блок. Непреднамеренное совпадение сделало бы нецелевую пробу
 * целевой, поэтому такая буква перевыбирается из остальных.
 */
export function buildNBackStream(rng: RngState, params: NBackParams): [NBackStream, RngState] {
  const letters: string[] = [];
  const targets: boolean[] = [];
  let state = rng;
  for (let i = 0; i < params.blockLength; i++) {
    const back = i >= params.n ? letters[i - params.n] : undefined;
    const [roll, afterRoll] = rngNext(state);
    state = afterRoll;
    if (back !== undefined && roll < params.targetRate) {
      letters.push(back);
      targets.push(true);
      continue;
    }
    const [picked, afterPick] = rngPick(state, NBACK_LETTERS);
    state = afterPick;
    let letter = picked;
    if (back !== undefined && letter === back) {
      const [replacement, afterReplace] = rngPick(
        state,
        NBACK_LETTERS.filter((candidate) => candidate !== back),
      );
      state = afterReplace;
      letter = replacement;
    }
    letters.push(letter);
    targets.push(false);
  }
  return [{ letters, targets }, state];
}

export function nbackAccuracy(state: NBackState): number {
  return state.trials > 0 ? (state.hits + state.correctRejections) / state.trials : 0;
}

/**
 * z-оценку берём логистическим приближением нормали (масштаб 1.702): полноценный
 * probit ради одного показателя тянуть незачем. Поправка +0.5 держит d' конечным
 * при нулевых hits или false alarms.
 */
function dPrime(hits: number, targets: number, falseAlarms: number, nonTargets: number): number {
  const z = (p: number) => Math.log(p / (1 - p)) / 1.702;
  const value = z((hits + 0.5) / (targets + 1)) - z((falseAlarms + 0.5) / (nonTargets + 1));
  return Math.round(value * 100) / 100;
}

export function nbackSummary(state: NBackState): NBackSummary {
  return {
    trials: state.trials,
    targets: state.targets,
    hits: state.hits,
    falseAlarms: state.falseAlarms,
    misses: state.misses,
    dPrimeApprox: dPrime(state.hits, state.targets, state.falseAlarms, state.trials - state.targets),
  };
}

export function nbackView(state: NBackState): NBackView {
  return {
    letter: state.visible ? (state.stream[state.index] ?? "") : "",
    n: state.params?.n ?? 1,
    visible: state.visible,
    running: state.running,
    finished: state.finished,
    feedback: state.feedback,
    stats: [
      ["Проб", state.trials],
      ["Совпадений", `${state.hits}/${state.targets}`],
      ["Ложных", state.falseAlarms],
      ["Пропусков", state.misses],
    ],
  };
}

export function isTargetTrial(state: NBackState): boolean {
  return state.targetFlags[state.index] === true;
}

function render(state: NBackState): Effect {
  return { kind: "render", view: nbackView(state) as unknown as Json };
}

export const nbackCore: GameCore<NBackState> = {
  init: (config) => ({
    rng: createRngState(config.seed),
    params: (config.initialParams as NBackParams) ?? null,
    running: false,
    finished: false,
    stream: [],
    targetFlags: [],
    index: 0,
    visible: false,
    onsetMs: 0,
    responded: false,
    trials: 0,
    targets: 0,
    hits: 0,
    falseAlarms: 0,
    misses: 0,
    correctRejections: 0,
    rtSum: 0,
    rtCount: 0,
    feedback: null,
  }),

  reduce(state, input): ReduceResult<NBackState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action === "enter" && (input.phase === "main" || input.phase === "intro")) {
          // Зачётная единица — блок, поэтому параметры запрашиваются один раз на блок:
          // поток строится сразу целиком, менять n посреди него нельзя.
          return {
            state: { ...state, running: true, finished: false },
            effects: [
              { kind: "emit", event: { type: "block.start", blockLength: state.params?.blockLength ?? 0 } },
              { kind: "requestParams" },
            ],
          };
        }
        if (input.action === "enter" && input.phase === "paused") {
          return {
            state,
            effects: [
              { kind: "cancel", timerId: NB_STIM },
              { kind: "cancel", timerId: NB_ISI },
            ],
          };
        }
        return { state, effects: [] };
      }

      case "params":
        return startBlock(state, input.effective as NBackParams, input.tMs);

      case "action": {
        if (input.actionId !== "match") return { state, effects: [] };
        return respond(state, input.tMs);
      }

      case "deadline": {
        if (input.timerId === NB_STIM) return hide(state);
        if (input.timerId === NB_ISI) return advance(state, input.tMs);
        return { state, effects: [] };
      }

      case "protocol": {
        // Оператор прервал блок: сложность по неполному блоку не отчитываем.
        if (input.command.type === "finish") return endBlock(state, false);
        return { state, effects: [] };
      }

      default:
        return { state, effects: [] };
    }
  },
};

function startBlock(state: NBackState, params: NBackParams, tMs: number): ReduceResult<NBackState> {
  const [stream, rng] = buildNBackStream(state.rng, params);
  const fresh: NBackState = {
    ...state,
    rng,
    params,
    running: true,
    finished: false,
    stream: stream.letters,
    targetFlags: stream.targets,
    index: 0,
    visible: false,
    onsetMs: tMs,
    responded: false,
    trials: 0,
    targets: 0,
    hits: 0,
    falseAlarms: 0,
    misses: 0,
    correctRejections: 0,
    rtSum: 0,
    rtCount: 0,
    feedback: null,
  };
  return present(fresh, tMs);
}

function present(state: NBackState, tMs: number): ReduceResult<NBackState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const target = state.targetFlags[state.index] === true;
  const next: NBackState = {
    ...state,
    visible: true,
    onsetMs: tMs,
    responded: false,
    feedback: null,
    trials: state.trials + 1,
    targets: state.targets + (target ? 1 : 0),
  };
  return {
    state: next,
    effects: [
      render(next),
      {
        kind: "emit",
        event: {
          type: "stimulus.presented",
          trial: next.trials,
          letter: state.stream[state.index] ?? "",
          target,
          n: params.n,
          plannedOnsetMs: tMs,
        },
      },
      { kind: "schedule", timerId: NB_STIM, afterMs: params.stimulusMs },
    ],
  };
}

function respond(state: NBackState, tMs: number): ReduceResult<NBackState> {
  // Второе нажатие в той же пробе игнорируется: ответ про пробу бывает один.
  if (!state.visible || state.responded || state.finished) return { state, effects: [] };
  const target = state.targetFlags[state.index] === true;
  const rtMs = tMs - state.onsetMs;
  const next: NBackState = {
    ...state,
    responded: true,
    hits: state.hits + (target ? 1 : 0),
    falseAlarms: state.falseAlarms + (target ? 0 : 1),
    rtSum: state.rtSum + (target ? rtMs : 0),
    rtCount: state.rtCount + (target ? 1 : 0),
    feedback: target ? "hit" : "false-alarm",
  };
  return {
    state: next,
    effects: [
      { kind: "emit", event: { type: "response", trial: next.trials, correct: target, rtMs, target } },
      render(next),
    ],
  };
}

function hide(state: NBackState): ReduceResult<NBackState> {
  const params = state.params;
  if (!params || !state.visible) return { state, effects: [] };
  const target = state.targetFlags[state.index] === true;
  const missed = target && !state.responded;
  const rejected = !target && !state.responded;
  const next: NBackState = {
    ...state,
    visible: false,
    misses: state.misses + (missed ? 1 : 0),
    correctRejections: state.correctRejections + (rejected ? 1 : 0),
    feedback: missed ? "miss" : state.feedback,
  };
  return {
    state: next,
    effects: [
      {
        kind: "emit",
        event: {
          type: "trial.end",
          trial: next.trials,
          target,
          responded: state.responded,
          correct: target === state.responded,
          rtMs: null,
        },
      },
      render(next),
      { kind: "schedule", timerId: NB_ISI, afterMs: params.isiMs },
    ],
  };
}

function advance(state: NBackState, tMs: number): ReduceResult<NBackState> {
  const params = state.params;
  if (!params || state.finished) return { state, effects: [] };
  if (state.index + 1 >= params.blockLength) return endBlock(state, true);
  return present({ ...state, index: state.index + 1 }, tMs);
}

/**
 * Зачётная единица — блок: одно совпадение о памяти ничего не говорит, поэтому
 * наружу уходит ровно один блочный outcome, а отдельные пробы в сложность не идут.
 */
function endBlock(state: NBackState, scored: boolean): ReduceResult<NBackState> {
  if (state.finished) return { state, effects: [] };
  const params = state.params;
  const next: NBackState = { ...state, running: false, finished: true, visible: false, feedback: null };
  const result = nbackSummary(next);
  const effects: Effect[] = [
    { kind: "cancel", timerId: NB_STIM },
    { kind: "cancel", timerId: NB_ISI },
  ];
  if (scored && params && next.trials > 0) {
    effects.push({
      kind: "outcome",
      outcome: {
        kind: "block",
        scored: true,
        accuracy: nbackAccuracy(next),
        trials: next.trials,
        paramsUsed: { ...params },
      },
    });
  }
  effects.push({ kind: "emit", event: { type: "block.end", ...result } });
  effects.push(render(next));
  effects.push({ kind: "complete", summary: result as unknown as Json });
  return { state: next, effects };
}
