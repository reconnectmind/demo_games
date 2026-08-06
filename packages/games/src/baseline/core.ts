import type { GameCore, Params, ReduceResult } from "@gamespace/core";

/**
 * Покой — такой же участок протокола, как задача: у него есть длительность,
 * маркеры начала и конца и сводка. Поэтому это обычный модуль, а не особый
 * режим приложения: расписание не должно знать про исключения.
 */
export interface BaselineParams extends Params {
  durationMs: number;
  showTimer: boolean;
  text: string;
  /**
   * Крестик фиксации. Покою он нужен: взгляд закреплён, движения глаз не гуляют
   * по экрану. Перерыву — мешает: там участнику как раз разрешено отвести глаза,
   * и точка фиксации превратила бы отдых в ещё одно задание.
   */
  fixation: boolean;
}

export interface BaselineState {
  params: BaselineParams | null;
  running: boolean;
  started: boolean;
  finished: boolean;
  startedMs: number;
  elapsedMs: number;
  /** Досрочное закрытие командой протокола: покой не «выполнен», а прерван. */
  completed: boolean;
}

export interface BaselineView {
  text: string;
  showTimer: boolean;
  fixation: boolean;
  remainingMs: number;
  elapsedMs: number;
  running: boolean;
  finished: boolean;
  stats: Array<[string, string | number]>;
}

export const BASELINE_TICK = "baseline.tick";
const TICK_MS = 500;

export interface BaselineSummary {
  plannedMs: number;
  actualMs: number;
  completed: boolean;
}

export function baselineSummary(state: BaselineState): BaselineSummary {
  return {
    plannedMs: state.params?.durationMs ?? 0,
    actualMs: Math.round(state.elapsedMs),
    completed: state.completed,
  };
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function baselineView(state: BaselineState): BaselineView {
  const planned = state.params?.durationMs ?? 0;
  const remaining = Math.max(0, planned - state.elapsedMs);
  return {
    text: state.params?.text ?? "",
    showTimer: state.params?.showTimer ?? false,
    // Крестик по умолчанию есть: покой — основное употребление модуля.
    fixation: state.params?.fixation ?? true,
    remainingMs: remaining,
    elapsedMs: state.elapsedMs,
    running: state.running,
    finished: state.finished,
    stats: [
      ["Осталось", state.params?.showTimer ? fmt(remaining) : "—"],
      ["Прошло", fmt(state.elapsedMs)],
    ],
  };
}

const render = (state: BaselineState) => ({ kind: "render" as const, view: baselineView(state) as never });

function end(state: BaselineState, completed: boolean): ReduceResult<BaselineState> {
  if (state.finished) return { state, effects: [] };
  const next = { ...state, finished: true, running: false, completed };
  const summary = baselineSummary(next);
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: BASELINE_TICK },
      { kind: "emit", event: { type: "block.end", ...summary } },
      render(next),
      { kind: "complete", summary: summary as never },
    ],
  };
}

export const baselineCore: GameCore<BaselineState> = {
  init: (config) => ({
    params: (config.initialParams as BaselineParams) ?? null,
    running: false,
    started: false,
    finished: false,
    startedMs: 0,
    elapsedMs: 0,
    completed: false,
  }),

  reduce(state, input): ReduceResult<BaselineState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action === "enter" && (input.phase === "main" || input.phase === "intro")) {
          if (state.finished) return { state, effects: [] };
          if (state.started) {
            // Возврат после паузы: часы покоя идут дальше, а не с нуля.
            const next = { ...state, running: true, startedMs: input.tMs - state.elapsedMs };
            return { state: next, effects: [render(next), { kind: "schedule", timerId: BASELINE_TICK, afterMs: TICK_MS }] };
          }
          const next = { ...state, running: true, started: true, startedMs: input.tMs };
          return {
            state: next,
            effects: [{ kind: "emit", event: { type: "block.start" } }, { kind: "requestParams" }],
          };
        }
        if (input.action === "enter" && (input.phase === "paused" || input.phase === "suspended")) {
          const next = { ...state, running: false };
          return { state: next, effects: [{ kind: "cancel", timerId: BASELINE_TICK }, render(next)] };
        }
        return { state, effects: [] };
      }

      case "params": {
        const params = input.effective as BaselineParams;
        const next = { ...state, params };
        if (!state.started || state.finished) return { state: next, effects: [] };
        return { state: next, effects: [render(next), { kind: "schedule", timerId: BASELINE_TICK, afterMs: TICK_MS }] };
      }

      case "deadline": {
        if (input.timerId !== BASELINE_TICK || !state.running || state.finished) return { state, effects: [] };
        const elapsed = input.tMs - state.startedMs;
        const next = { ...state, elapsedMs: elapsed };
        if (elapsed >= (state.params?.durationMs ?? 0)) return end(next, true);
        return { state: next, effects: [render(next), { kind: "schedule", timerId: BASELINE_TICK, afterMs: TICK_MS }] };
      }

      case "protocol": {
        if (input.command.type === "finish" || input.command.type === "skip") {
          const elapsed = state.running ? input.tMs - state.startedMs : state.elapsedMs;
          return end({ ...state, elapsedMs: elapsed }, false);
        }
        return { state, effects: [] };
      }

      default:
        return { state, effects: [] };
    }
  },
};
