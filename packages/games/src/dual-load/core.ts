import {
  createRngState,
  rngPick,
  type CoreInput,
  type Effect,
  type GameCore,
  type Json,
  type Params,
  type ReduceResult,
  type RngState,
} from "@gamespace/core";
import {
  NB_ISI,
  NB_STIM,
  isTargetTrial,
  nbackAccuracy,
  nbackCore,
  nbackView,
  type NBackParams,
  type NBackState,
  type NBackView,
} from "../n-back/index.js";

/**
 * Центральная задача — то же ядро n-back, но смонтировано не как дочерняя игра:
 * два одновременных потока ввода в одном поле требуют арбитража, которого у
 * оркестрации нет. Поэтому ядро вызывается напрямую, а его эффекты переписываются
 * на границе: таймеры получают префикс, render заворачивается в общий ViewModel,
 * emit получает канал, а outcome/complete/requestParams наружу не идут вовсе.
 */
export const PRIMARY_PREFIX = "primary:";
export const PERIPHERAL_ON = "dl.periph.on";
export const PERIPHERAL_DEADLINE = "dl.periph.deadline";

const SIDES = ["left", "right"] as const;
export type PeripheralSide = (typeof SIDES)[number];

export interface DualLoadParams extends Params {
  n: number;
  stimulusMs: number;
  isiMs: number;
  targetRate: number;
  blockLength: number;
  peripheralIsiMs: number;
  peripheralDeadlineMs: number;
}

export type PeripheralFeedback = "hit" | "miss" | "false-alarm" | null;

export interface DualSecondaryState {
  side: PeripheralSide | null;
  onsetMs: number;
  responded: boolean;
  cues: number;
  hits: number;
  misses: number;
  falseAlarms: number;
  rtSum: number;
  rtCount: number;
  feedback: PeripheralFeedback;
}

export interface DualLoadState {
  primary: NBackState;
  secondary: DualSecondaryState;
  rng: RngState;
  params: DualLoadParams | null;
  running: boolean;
  finished: boolean;
  /** RT центральной задачи раздельно: с меткой на периферии и без неё. */
  dualRtSum: number;
  dualRtCount: number;
  soloRtSum: number;
  soloRtCount: number;
}

export interface DualLoadView {
  primary: NBackView;
  secondary: { side: PeripheralSide | null; awaiting: boolean; feedback: PeripheralFeedback };
  stats: Array<[string, string | number]>;
}

export interface DualLoadSummary {
  trials: number;
  primaryAccuracy: number;
  peripheralHits: number;
  peripheralMisses: number;
  peripheralFalseAlarms: number;
  dualCostMs: number;
}

/** Отдельный поток случайности: стороны меток не должны коррелировать с потоком букв. */
const SECONDARY_SEED_MIX = 0x5f37_59df;

const num = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);

/** Срез параметров для центральной задачи: ядро n-back не должно видеть периферийных. */
export function toNBackParams(params: Params): NBackParams {
  return {
    n: num(params.n, 1),
    stimulusMs: num(params.stimulusMs, 1500),
    isiMs: num(params.isiMs, 500),
    targetRate: num(params.targetRate, 0.3),
    blockLength: num(params.blockLength, 20),
  };
}

function freshSecondary(): DualSecondaryState {
  return {
    side: null,
    onsetMs: 0,
    responded: false,
    cues: 0,
    hits: 0,
    misses: 0,
    falseAlarms: 0,
    rtSum: 0,
    rtCount: 0,
    feedback: null,
  };
}

function stats(state: DualLoadState): Array<[string, string | number]> {
  return [
    ["Проб", state.primary.trials],
    ["Центр", `${state.primary.hits}/${state.primary.targets}`],
    ["Периферия", `${state.secondary.hits}/${state.secondary.cues}`],
    ["Ошибок", state.primary.falseAlarms + state.primary.misses + state.secondary.misses + state.secondary.falseAlarms],
  ];
}

function secondaryView(state: DualLoadState): DualLoadView["secondary"] {
  return {
    side: state.secondary.side,
    awaiting: state.secondary.side !== null && !state.secondary.responded,
    feedback: state.secondary.feedback,
  };
}

export function dualLoadView(state: DualLoadState): DualLoadView {
  return { primary: nbackView(state.primary), secondary: secondaryView(state), stats: stats(state) };
}

function render(state: DualLoadState): Effect {
  return { kind: "render", view: dualLoadView(state) as unknown as Json };
}

/**
 * Точность блока по обеим задачам сразу: цена совмещения не делится на две
 * независимые оценки. Ложная тревога на периферии — отдельная ошибка, поэтому
 * она входит в знаменатель наравне с пробами.
 */
export function dualLoadAccuracy(state: DualLoadState): number {
  const primaryCorrect = state.primary.hits + state.primary.correctRejections;
  const attempts = state.primary.trials + state.secondary.cues + state.secondary.falseAlarms;
  return attempts > 0 ? (primaryCorrect + state.secondary.hits) / attempts : 0;
}

/**
 * Цена совмещения внутри блока: средний RT центральной задачи в пробах, где
 * периферийная метка горела, минус RT в пробах без неё. Одиночного условия в
 * модуле нет, поэтому при пустой любой из групп сравнивать не с чем — тогда 0.
 */
function dualCostMs(state: DualLoadState): number {
  if (state.dualRtCount === 0 || state.soloRtCount === 0) return 0;
  return Math.round(state.dualRtSum / state.dualRtCount - state.soloRtSum / state.soloRtCount);
}

export function dualLoadSummary(state: DualLoadState): DualLoadSummary {
  return {
    trials: state.primary.trials,
    primaryAccuracy: Math.round(nbackAccuracy(state.primary) * 1000) / 1000,
    peripheralHits: state.secondary.hits,
    peripheralMisses: state.secondary.misses,
    peripheralFalseAlarms: state.secondary.falseAlarms,
    dualCostMs: dualCostMs(state),
  };
}

/** Переписывание эффектов центральной задачи на границе модуля. */
function lift(effects: Effect[], state: DualLoadState): Effect[] {
  const out: Effect[] = [];
  for (const effect of effects) {
    switch (effect.kind) {
      case "schedule":
        out.push({ ...effect, timerId: PRIMARY_PREFIX + effect.timerId });
        break;
      case "cancel":
        out.push({ ...effect, timerId: PRIMARY_PREFIX + effect.timerId });
        break;
      case "render":
        out.push({
          kind: "render",
          view: {
            primary: effect.view as unknown as NBackView,
            secondary: secondaryView(state),
            stats: stats(state),
          } as unknown as Json,
        });
        break;
      case "emit":
        out.push({ kind: "emit", event: { ...effect.event, channel: "primary" } });
        break;
      case "outcome":
      case "complete":
      case "requestParams":
        // Когда отчитываться и когда заканчиваться, решает dual-load, а не центральная задача.
        break;
      default:
        out.push(effect);
    }
  }
  return out;
}

function forwardToPrimary(state: DualLoadState, input: CoreInput): ReduceResult<DualLoadState> {
  const result = nbackCore.reduce(state.primary, input);
  const next: DualLoadState = { ...state, primary: result.state };
  const effects = lift(result.effects, next);
  if (result.state.finished && !state.primary.finished) {
    const ended = endBlock(next, true);
    return { state: ended.state, effects: [...effects, ...ended.effects] };
  }
  return { state: next, effects };
}

export const dualLoadCore: GameCore<DualLoadState> = {
  init: (config) => ({
    primary: nbackCore.init({ ...config, initialParams: toNBackParams(config.initialParams ?? {}) }),
    secondary: freshSecondary(),
    rng: createRngState(config.seed ^ SECONDARY_SEED_MIX),
    params: (config.initialParams as DualLoadParams) ?? null,
    running: false,
    finished: false,
    dualRtSum: 0,
    dualRtCount: 0,
    soloRtSum: 0,
    soloRtCount: 0,
  }),

  reduce(state, input): ReduceResult<DualLoadState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action === "enter" && (input.phase === "main" || input.phase === "intro")) {
          return {
            state: { ...state, running: true, finished: false },
            effects: [
              { kind: "emit", event: { type: "block.start", blockLength: state.params?.blockLength ?? 0 } },
              { kind: "requestParams" },
            ],
          };
        }
        if (input.action === "enter" && input.phase === "paused") {
          return { state, effects: allTimers().map((timerId): Effect => ({ kind: "cancel", timerId })) };
        }
        return { state, effects: [] };
      }

      case "params": {
        const params = input.effective as DualLoadParams;
        const fresh: DualLoadState = {
          ...state,
          params,
          running: true,
          finished: false,
          secondary: freshSecondary(),
          dualRtSum: 0,
          dualRtCount: 0,
          soloRtSum: 0,
          soloRtCount: 0,
        };
        const started = forwardToPrimary(fresh, { ...input, effective: toNBackParams(params) });
        return {
          state: started.state,
          effects: [
            ...started.effects,
            { kind: "schedule", timerId: PERIPHERAL_ON, afterMs: params.peripheralIsiMs },
          ],
        };
      }

      case "action": {
        if (input.actionId === "match") return matchPressed(state, input);
        if (input.actionId === "peripheral") return peripheralPressed(state, input);
        return { state, effects: [] };
      }

      case "deadline": {
        if (input.timerId.startsWith(PRIMARY_PREFIX)) {
          return forwardToPrimary(state, { ...input, timerId: input.timerId.slice(PRIMARY_PREFIX.length) });
        }
        if (input.timerId === PERIPHERAL_ON) return showPeripheral(state, input.tMs);
        if (input.timerId === PERIPHERAL_DEADLINE) return peripheralTimeout(state);
        return { state, effects: [] };
      }

      case "protocol": {
        if (input.command.type === "finish") return endBlock(state, false);
        return { state, effects: [] };
      }

      default:
        return { state, effects: [] };
    }
  },
};

function allTimers(): string[] {
  return [PRIMARY_PREFIX + NB_STIM, PRIMARY_PREFIX + NB_ISI, PERIPHERAL_ON, PERIPHERAL_DEADLINE];
}

function matchPressed(state: DualLoadState, input: CoreInput): ReduceResult<DualLoadState> {
  const primary = state.primary;
  const scored = primary.visible && !primary.responded && !primary.finished;
  const target = scored && isTargetTrial(primary);
  // RT считаем здесь: цена совмещения — это разница между пробами с меткой и без.
  const rtMs = input.tMs - primary.onsetMs;
  let withRt = state;
  if (target) {
    withRt =
      state.secondary.side !== null
        ? { ...state, dualRtSum: state.dualRtSum + rtMs, dualRtCount: state.dualRtCount + 1 }
        : { ...state, soloRtSum: state.soloRtSum + rtMs, soloRtCount: state.soloRtCount + 1 };
  }
  return forwardToPrimary(withRt, input);
}

function showPeripheral(state: DualLoadState, tMs: number): ReduceResult<DualLoadState> {
  const params = state.params;
  if (!params || state.finished) return { state, effects: [] };
  // Новая метка поверх незакрытой старой: старая уходит в промах.
  const overdue = state.secondary.side !== null && !state.secondary.responded;
  const [side, rng] = rngPick(state.rng, SIDES);
  const secondary: DualSecondaryState = {
    ...state.secondary,
    side,
    onsetMs: tMs,
    responded: false,
    cues: state.secondary.cues + 1,
    misses: state.secondary.misses + (overdue ? 1 : 0),
    feedback: overdue ? "miss" : null,
  };
  const next: DualLoadState = { ...state, rng, secondary };
  return {
    state: next,
    effects: [
      {
        kind: "emit",
        event: { type: "peripheral.presented", cue: secondary.cues, side, channel: "secondary", plannedOnsetMs: tMs },
      },
      render(next),
      { kind: "schedule", timerId: PERIPHERAL_DEADLINE, afterMs: params.peripheralDeadlineMs },
      { kind: "schedule", timerId: PERIPHERAL_ON, afterMs: params.peripheralIsiMs },
    ],
  };
}

function peripheralPressed(state: DualLoadState, input: CoreInput): ReduceResult<DualLoadState> {
  if (!state.running || state.finished) return { state, effects: [] };
  const active = state.secondary.side !== null;
  // Второе нажатие в том же окне игнорируется, нажатие без метки — ложная тревога.
  if (active && state.secondary.responded) return { state, effects: [] };
  const rtMs = active ? input.tMs - state.secondary.onsetMs : null;
  const secondary: DualSecondaryState = active
    ? {
        ...state.secondary,
        responded: true,
        hits: state.secondary.hits + 1,
        rtSum: state.secondary.rtSum + (rtMs ?? 0),
        rtCount: state.secondary.rtCount + 1,
        feedback: "hit",
      }
    : { ...state.secondary, falseAlarms: state.secondary.falseAlarms + 1, feedback: "false-alarm" };
  const next: DualLoadState = { ...state, secondary };
  return {
    state: next,
    effects: [
      { kind: "emit", event: { type: "response", channel: "secondary", correct: active, rtMs } },
      render(next),
    ],
  };
}

function peripheralTimeout(state: DualLoadState): ReduceResult<DualLoadState> {
  if (state.secondary.side === null) return { state, effects: [] };
  const missed = !state.secondary.responded;
  const secondary: DualSecondaryState = {
    ...state.secondary,
    side: null,
    responded: false,
    misses: state.secondary.misses + (missed ? 1 : 0),
    feedback: missed ? "miss" : state.secondary.feedback,
  };
  const next: DualLoadState = { ...state, secondary };
  return {
    state: next,
    effects: [
      {
        kind: "emit",
        event: { type: "peripheral.end", channel: "secondary", correct: !missed, responded: !missed, rtMs: null },
      },
      render(next),
    ],
  };
}

/**
 * Блок закрывает dual-load: ровно один блочный outcome по обеим задачам вместе
 * и один совокупный complete, в котором учтён и итог центральной задачи.
 */
function endBlock(state: DualLoadState, scored: boolean): ReduceResult<DualLoadState> {
  if (state.finished) return { state, effects: [] };
  const params = state.params;
  const overdue = state.secondary.side !== null && !state.secondary.responded;
  const secondary: DualSecondaryState = {
    ...state.secondary,
    side: null,
    misses: state.secondary.misses + (overdue ? 1 : 0),
    feedback: null,
  };
  const next: DualLoadState = { ...state, secondary, running: false, finished: true };
  const result = dualLoadSummary(next);
  const trials = next.primary.trials + secondary.cues;
  const effects: Effect[] = allTimers().map((timerId): Effect => ({ kind: "cancel", timerId }));
  if (scored && params && trials > 0) {
    effects.push({
      kind: "outcome",
      outcome: {
        kind: "block",
        scored: true,
        accuracy: dualLoadAccuracy(next),
        trials,
        paramsUsed: { ...params },
      },
    });
  }
  effects.push({ kind: "emit", event: { type: "block.end", channel: "dual", ...result } });
  effects.push(render(next));
  effects.push({ kind: "complete", summary: result as unknown as Json });
  return { state: next, effects };
}
