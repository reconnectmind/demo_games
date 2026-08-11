import {
  childSet,
  createRngState,
  rngInt,
  type CoreInput,
  type GameCore,
  type Params,
  type ReduceResult,
  type RngState,
} from "@gamespace/core";
import manifest from "./manifest.json" with { type: "json" };

export const BACKGROUND_SLOT = "background";
export const INTERRUPT_SLOT = "interrupt";

const BACKGROUND_REF = manifest.children[0]!;
const INTERRUPTERS = manifest.children.slice(1);

export interface InterruptResumeParams extends Params {
  interruptions: number;
  backgroundRunMs: number;
  interruptionMs: number;
  /**
   * Состав прерывателей: имена через запятую. Пусто — все объявленные в
   * манифесте. Фоновая задача в состав не входит: она одна и обязана уметь
   * возобновляться, выбирать тут нечего.
   */
  tasks: string;
}

export type Stage = "idle" | "background" | "interruption" | "finished";

export interface InterruptResumeState {
  rng: RngState;
  params: InterruptResumeParams | null;
  stage: Stage;
  done: number;
  /** Момент возврата: от него отсчитывается лаг возобновления. */
  resumeAtMs: number | null;
  lags: number[];
  backgroundHits: number;
  backgroundTotal: number;
  interrupterHits: number;
  interrupterTotal: number;
  currentInterrupter: string | null;
  running: boolean;
}

export interface InterruptResumeView {
  stage: Stage;
  done: number;
  total: number;
  banner: string;
  currentInterrupter: string | null;
  stats: Array<[string, string | number]>;
}

const RUN = "ir.run";
const BACK = "ir.back";

function view(state: InterruptResumeState): InterruptResumeView {
  const banner =
    state.stage === "interruption"
      ? "Побочная задача"
      : state.stage === "background"
        ? "Основная задача"
        : state.stage === "finished"
          ? "Готово"
          : "";
  return {
    stage: state.stage,
    done: state.done,
    total: state.params?.interruptions ?? 0,
    banner,
    currentInterrupter: state.currentInterrupter,
    stats: [
      ["Прерываний", `${state.done}/${state.params?.interruptions ?? 0}`],
      ["Средний лаг", state.lags.length ? `${Math.round(state.lags.reduce((a, b) => a + b, 0) / state.lags.length)} мс` : "—"],
    ],
  };
}

function summary(state: InterruptResumeState) {
  return {
    interruptions: state.done,
    meanResumptionLagMs: state.lags.length
      ? Math.round(state.lags.reduce((a, b) => a + b, 0) / state.lags.length)
      : 0,
    backgroundAccuracy: state.backgroundTotal ? state.backgroundHits / state.backgroundTotal : 0,
    interrupterAccuracy: state.interrupterTotal ? state.interrupterHits / state.interrupterTotal : 0,
  };
}

export const interruptResumeCore: GameCore<InterruptResumeState> = {
  init: (config) => ({
    rng: createRngState(config.seed),
    params: (config.initialParams as InterruptResumeParams) ?? null,
    stage: "idle",
    done: 0,
    resumeAtMs: null,
    lags: [],
    backgroundHits: 0,
    backgroundTotal: 0,
    interrupterHits: 0,
    interrupterTotal: 0,
    currentInterrupter: null,
    running: false,
  }),

  reduce(state, input): ReduceResult<InterruptResumeState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action === "enter" && (input.phase === "main" || input.phase === "intro")) {
          return { state: { ...state, running: true }, effects: [{ kind: "requestParams" }] };
        }
        return { state, effects: [] };
      }

      case "params": {
        // Состав прерывателей необязателен: без него работают все объявленные.
        const params = { tasks: "", ...input.effective } as InterruptResumeParams;
        if (state.stage !== "idle") return { state: { ...state, params }, effects: [] };
        const next: InterruptResumeState = { ...state, params, stage: "background" };
        return {
          state: next,
          effects: [
            { kind: "emit", event: { type: "block.start", interruptions: params.interruptions } },
            { kind: "child", command: { op: "mount", slot: BACKGROUND_SLOT, ref: BACKGROUND_REF } },
            { kind: "child", command: { op: "start", slot: BACKGROUND_SLOT } },
            { kind: "render", view: view(next) as never },
            { kind: "schedule", timerId: RUN, afterMs: params.backgroundRunMs },
          ],
        };
      }

      case "deadline": {
        const params = state.params;
        if (!params) return { state, effects: [] };
        if (input.timerId === RUN) {
          // Прерывание начинается без предупреждения: внезапность перехода — часть
          // задачи, а не грубость интерфейса. Предупреждать значило бы дать время
          // подготовиться, то есть измерять уже не то.
          if (state.done >= params.interruptions) return finish(state);
          return beginInterruption(state);
        }
        if (input.timerId === BACK) return returnToBackground(state, input);
        return { state, effects: [] };
      }

      case "child": {
        if (input.event.type === "action" && input.slot === BACKGROUND_SLOT && state.resumeAtMs !== null) {
          // Лаг возврата — время до первого действия участника в основной задаче,
          // а не до её зачётной единицы: та может завершиться много позже.
          const lag = input.tMs - state.resumeAtMs;
          return {
            state: { ...state, resumeAtMs: null, lags: [...state.lags, lag] },
            effects: [{ kind: "emit", event: { type: "resumption.lag", lagMs: lag, index: state.done } }],
          };
        }
        if (input.event.type === "outcome") {
          const outcome = input.event.outcome;
          const hit = outcome.kind === "trial" ? (outcome.correct ? 1 : 0) : outcome.accuracy;
          if (input.slot === BACKGROUND_SLOT) {
            return {
              state: {
                ...state,
                backgroundHits: state.backgroundHits + hit,
                backgroundTotal: state.backgroundTotal + 1,
              },
              effects: [],
            };
          }
          return {
            state: { ...state, interrupterHits: state.interrupterHits + hit, interrupterTotal: state.interrupterTotal + 1 },
            effects: [],
          };
        }
        if (input.event.type === "completed" && input.slot === BACKGROUND_SLOT && state.stage === "background") {
          return finish(state);
        }
        return { state, effects: [] };
      }

      case "protocol":
        return input.command.type === "finish" ? finish(state) : { state, effects: [] };

      default:
        return { state, effects: [] };
    }
  },
};

function beginInterruption(state: InterruptResumeState): ReduceResult<InterruptResumeState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const pool = childSet(INTERRUPTERS, params.tasks);
  const [index, rng] = rngInt(state.rng, 0, pool.length - 1);
  const ref = INTERRUPTERS.find((child) => child.id === pool[index])!;
  const next: InterruptResumeState = { ...state, rng, stage: "interruption", currentInterrupter: ref.id };
  return {
    state: next,
    effects: [
      // Снимок делает runtime: оркестратор не видит внутреннего состояния задачи.
      { kind: "child", command: { op: "suspend", slot: BACKGROUND_SLOT } },
      { kind: "emit", event: { type: "interruption.start", index: state.done + 1, task: ref.id } },
      { kind: "child", command: { op: "mount", slot: INTERRUPT_SLOT, ref } },
      { kind: "child", command: { op: "start", slot: INTERRUPT_SLOT } },
      { kind: "render", view: view(next) as never },
      { kind: "schedule", timerId: BACK, afterMs: params.interruptionMs },
    ],
  };
}

function returnToBackground(state: InterruptResumeState, input: CoreInput): ReduceResult<InterruptResumeState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const next: InterruptResumeState = {
    ...state,
    stage: "background",
    done: state.done + 1,
    currentInterrupter: null,
    resumeAtMs: input.tMs,
  };
  return {
    state: next,
    effects: [
      { kind: "child", command: { op: "unmount", slot: INTERRUPT_SLOT } },
      { kind: "emit", event: { type: "interruption.end", index: next.done } },
      { kind: "child", command: { op: "resume", slot: BACKGROUND_SLOT } },
      { kind: "emit", event: { type: "resume", index: next.done } },
      { kind: "render", view: view(next) as never },
      { kind: "schedule", timerId: RUN, afterMs: params.backgroundRunMs },
    ],
  };
}

function finish(state: InterruptResumeState): ReduceResult<InterruptResumeState> {
  const result = summary(state);
  const next: InterruptResumeState = { ...state, stage: "finished", running: false };
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: RUN },
      { kind: "cancel", timerId: BACK },
      { kind: "child", command: { op: "unmount", slot: INTERRUPT_SLOT } },
      { kind: "child", command: { op: "unmount", slot: BACKGROUND_SLOT } },
      {
        kind: "outcome",
        outcome: {
          kind: "block",
          scored: true,
          accuracy: result.backgroundAccuracy,
          trials: state.backgroundTotal,
          paramsUsed: { ...(state.params as InterruptResumeParams) },
        },
      },
      { kind: "emit", event: { type: "block.end", ...result } },
      { kind: "render", view: view(next) as never },
      { kind: "complete", summary: result as never },
    ],
  };
}
