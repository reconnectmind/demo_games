import {
  createRngState,
  rngShuffle,
  type GameCore,
  type Params,
  type ReduceResult,
  type RngState,
} from "@gamespace/core";
import manifest from "./manifest.json" with { type: "json" };

export const TASK_SLOT = "task";

const POOL = manifest.children;

export interface AdaptiveBatteryParams extends Params {
  blocks: number;
  restMs: number;
  poolSize: number;
  /**
   * Через сколько батарея сама закрывает блок задачи. Ноль — как прежде: темп
   * задаёт ребёнок своей длиной блока, и регулировать частоту смен нечем.
   */
  switchEveryMs: number;
}

export interface AdaptiveBatteryState {
  rng: RngState;
  params: AdaptiveBatteryParams | null;
  order: string[];
  index: number;
  resting: boolean;
  accuracySum: number;
  accuracyCount: number;
  perTask: Record<string, { hits: number; trials: number }>;
  running: boolean;
}

export interface AdaptiveBatteryView {
  currentTask: string | null;
  index: number;
  total: number;
  resting: boolean;
  stats: Array<[string, string | number]>;
}

const REST = "battery.rest";
const SWITCH = "battery.switch";

function refFor(id: string) {
  const found = POOL.find((c) => c.id === id);
  if (!found) throw new Error(`Задача вне пула батареи: ${id}`);
  return found;
}

function view(state: AdaptiveBatteryState): AdaptiveBatteryView {
  const currentTask = state.order[state.index] ?? null;
  return {
    currentTask,
    index: state.index,
    total: state.order.length,
    resting: state.resting,
    stats: [
      ["Блок", `${Math.min(state.index + 1, state.order.length)}/${state.order.length}`],
      ["Точность", state.accuracyCount ? `${Math.round((state.accuracySum / state.accuracyCount) * 100)}%` : "—"],
    ],
  };
}

function summary(state: AdaptiveBatteryState) {
  return {
    blocks: state.index,
    meanAccuracy: state.accuracyCount ? state.accuracySum / state.accuracyCount : 0,
    tasks: [...state.order],
  };
}

export const adaptiveBatteryCore: GameCore<AdaptiveBatteryState> = {
  init: (config) => ({
    rng: createRngState(config.seed),
    params: (config.initialParams as AdaptiveBatteryParams) ?? null,
    order: [],
    index: 0,
    resting: false,
    accuracySum: 0,
    accuracyCount: 0,
    perTask: {},
    running: false,
  }),

  reduce(state, input): ReduceResult<AdaptiveBatteryState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action === "enter" && (input.phase === "main" || input.phase === "intro")) {
          return { state: { ...state, running: true }, effects: [{ kind: "requestParams" }] };
        }
        return { state, effects: [] };
      }

      case "params": {
        const params = input.effective as AdaptiveBatteryParams;
        if (state.order.length > 0) return { state: { ...state, params }, effects: [] };
        const [shuffled, rng] = rngShuffle(state.rng, POOL.slice(0, params.poolSize).map((c) => c.id));
        // Пул перемешивается один раз и затем повторяется циклом: так порядок
        // задач воспроизводится по seed, а блоков может быть больше, чем задач.
        const order = Array.from({ length: params.blocks }, (_, i) => shuffled[i % shuffled.length] as string);
        const next: AdaptiveBatteryState = { ...state, params, rng, order, index: 0 };
        return { state: next, effects: [...startBlock(next), { kind: "render", view: view(next) as never }] };
      }

      case "child": {
        if (input.event.type === "outcome") {
          const outcome = input.event.outcome;
          const hit = outcome.kind === "trial" ? (outcome.correct ? 1 : 0) : outcome.accuracy;
          const task = state.order[state.index] ?? "unknown";
          const previous = state.perTask[task] ?? { hits: 0, trials: 0 };
          return {
            state: {
              ...state,
              accuracySum: state.accuracySum + hit,
              accuracyCount: state.accuracyCount + 1,
              perTask: { ...state.perTask, [task]: { hits: previous.hits + hit, trials: previous.trials + 1 } },
            },
            effects: [],
          };
        }
        if (input.event.type === "completed") {
          const params = state.params;
          if (!params) return { state, effects: [] };
          const task = state.order[state.index] ?? "unknown";
          const next: AdaptiveBatteryState = { ...state, index: state.index + 1, resting: true };
          if (next.index >= state.order.length) return finish(next);
          return {
            state: next,
            effects: [
              // Ребёнок мог закончить сам, раньше шага смены: таймер снимается,
              // иначе он закрыл бы уже следующую задачу.
              { kind: "cancel", timerId: SWITCH },
              { kind: "emit", event: { type: "block.end", task, index: state.index + 1 } },
              { kind: "child", command: { op: "unmount", slot: TASK_SLOT } },
              { kind: "emit", event: { type: "rest.start", restMs: params.restMs } },
              { kind: "render", view: view(next) as never },
              { kind: "schedule", timerId: REST, afterMs: params.restMs },
            ],
          };
        }
        return { state, effects: [] };
      }

      case "deadline": {
        if (input.timerId === SWITCH) {
          // Смена по расписанию батареи: ребёнок закрывается своей же командой
          // протокола, поэтому блок в данных остаётся закрытым, а не оборванным.
          if (state.resting || !state.running) return { state, effects: [] };
          return {
            state,
            effects: [
              { kind: "emit", event: { type: "switch.forced", task: state.order[state.index] ?? "unknown" } },
              { kind: "child", command: { op: "finish", slot: TASK_SLOT } },
            ],
          };
        }
        if (input.timerId !== REST) return { state, effects: [] };
        const next: AdaptiveBatteryState = { ...state, resting: false };
        return { state: next, effects: [...startBlock(next), { kind: "render", view: view(next) as never }] };
      }

      case "protocol":
        return input.command.type === "finish" ? finish(state) : { state, effects: [] };

      default:
        return { state, effects: [] };
    }
  },
};

function startBlock(state: AdaptiveBatteryState): ReduceResult<AdaptiveBatteryState>["effects"] {
  const task = state.order[state.index];
  if (!task) return [];
  const switchEveryMs = state.params?.switchEveryMs ?? 0;
  return [
    { kind: "emit", event: { type: "block.start", task, index: state.index + 1 } },
    { kind: "child", command: { op: "mount", slot: TASK_SLOT, ref: refFor(task) } },
    { kind: "child", command: { op: "start", slot: TASK_SLOT } },
    ...(switchEveryMs > 0
      ? [{ kind: "schedule", timerId: SWITCH, afterMs: switchEveryMs } as const]
      : []),
  ];
}

function finish(state: AdaptiveBatteryState): ReduceResult<AdaptiveBatteryState> {
  const result = summary(state);
  const next: AdaptiveBatteryState = { ...state, running: false, resting: false };
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: REST },
      { kind: "cancel", timerId: SWITCH },
      { kind: "child", command: { op: "unmount", slot: TASK_SLOT } },
      {
        kind: "outcome",
        outcome: {
          kind: "block",
          scored: true,
          accuracy: result.meanAccuracy,
          trials: state.accuracyCount,
          paramsUsed: { ...(state.params as AdaptiveBatteryParams) },
        },
      },
      { kind: "emit", event: { type: "battery.end", ...result } },
      { kind: "render", view: view(next) as never },
      { kind: "complete", summary: result as never },
    ],
  };
}
