import {
  HOLD_MS,
  createRngState,
  rngInt,
  rngNext,
  rngPick,
  type CoreInput,
  type Effect,
  type GameCore,
  type Params,
  type ReduceResult,
  type RngState,
  type TrialDebrief,
} from "@gamespace/core";

export type Rule = "parity" | "magnitude" | "prime";

export const RULES: Record<Rule, { cue: string; options: [string, string] }> = {
  parity: { cue: "Правило: ЧЁТ / НЕЧЁТ", options: ["Чётное", "Нечётное"] },
  magnitude: { cue: "Правило: меньше 5 / 5 и больше", options: ["Меньше 5", "5 и больше"] },
  prime: { cue: "Правило: ПРОСТОЕ / СОСТАВНОЕ", options: ["Простое", "Составное"] },
};

const PRIMES = new Set([2, 3, 5, 7]);

export interface RuleSwitchParams extends Params {
  ruleCount: number;
  switchRate: number;
  deadlineMs: number;
  cueLeadMs: number;
  blockLength: number;
}

interface Pending {
  rule: Rule;
  number: number;
  correctIndex: number;
  switched: boolean;
  onsetMs: number;
}

export interface RuleSwitchState {
  rng: RngState;
  trial: number;
  correct: number;
  rtSum: number;
  rtCount: number;
  switchRtSum: number;
  switchRtCount: number;
  repeatRtSum: number;
  repeatRtCount: number;
  lastRule: Rule | null;
  pending: Pending | null;
  /** Подсказка уже показана, стимул ещё нет: между ними живёт cueLeadMs. */
  cued: Pending | null;
  params: RuleSwitchParams | null;
  running: boolean;
  lastFeedback: "correct" | "wrong" | "timeout" | null;
  lastDebrief: TrialDebrief | null;
  training: boolean;
  /** Обучение стоит на разборе и ждёт участника: следующая проба сама не придёт. */
  holding: boolean;
}

export interface RuleSwitchView {
  cue: string;
  stimulus: string;
  options: string[];
  switched: boolean;
  feedback: "correct" | "wrong" | "timeout" | null;
  /** Разбор последней пробы: показывается только в обучении. */
  debrief: TrialDebrief | null;
  holding: boolean;
  running: boolean;
  stats: Array<[string, string | number]>;
}

const CUE = "rs.cue";
const DEADLINE = "rs.deadline";
const ITI = "rs.iti";

function classify(rule: Rule, value: number): number {
  if (rule === "parity") return value % 2 === 0 ? 0 : 1;
  if (rule === "magnitude") return value < 5 ? 0 : 1;
  return PRIMES.has(value) ? 0 : 1;
}

function view(state: RuleSwitchState): RuleSwitchView {
  const active = state.pending ?? state.cued;
  const rule = active?.rule ?? state.lastRule;
  return {
    cue: rule ? RULES[rule].cue : "—",
    stimulus: state.pending ? String(state.pending.number) : state.cued ? "•" : state.running ? "" : "—",
    options: rule ? [...RULES[rule].options] : [],
    switched: active?.switched ?? false,
    feedback: state.lastFeedback,
    debrief: state.lastDebrief,
    holding: state.holding,
    running: state.running,
    stats: [
      ["Проб", state.trial],
      ["Верно", state.correct],
      ["Средний RT", state.rtCount ? `${Math.round(state.rtSum / state.rtCount)} мс` : "—"],
    ],
  };
}

function summary(state: RuleSwitchState) {
  const meanRt = state.rtCount ? state.rtSum / state.rtCount : 0;
  const switchRt = state.switchRtCount ? state.switchRtSum / state.switchRtCount : 0;
  const repeatRt = state.repeatRtCount ? state.repeatRtSum / state.repeatRtCount : 0;
  return {
    trials: state.trial,
    correct: state.correct,
    meanRtMs: Math.round(meanRt),
    // Цена переключения: ради неё задача и существует.
    switchCostMs: Math.round(switchRt - repeatRt),
  };
}

export const ruleSwitchCore: GameCore<RuleSwitchState> = {
  init: (config) => ({
    rng: createRngState(config.seed),
    trial: 0,
    correct: 0,
    rtSum: 0,
    rtCount: 0,
    switchRtSum: 0,
    switchRtCount: 0,
    repeatRtSum: 0,
    repeatRtCount: 0,
    lastRule: null,
    pending: null,
    cued: null,
    params: (config.initialParams as RuleSwitchParams) ?? null,
    running: false,
    lastFeedback: null,
    lastDebrief: null,
    training: Boolean(config.training),
    holding: false,
  }),

  reduce(state, input): ReduceResult<RuleSwitchState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action === "enter" && (input.phase === "main" || input.phase === "intro")) {
          const next = { ...state, running: true };
          return {
            state: next,
            effects: [{ kind: "emit", event: { type: "block.start" } }, { kind: "requestParams" }],
          };
        }
        return { state, effects: [] };
      }

      case "params":
        return presentCue({ ...state, params: input.effective as RuleSwitchParams }, input);

      case "deadline": {
        if (input.timerId === CUE) return presentStimulus(state, input);
        if (input.timerId === ITI) return release(state);
        if (input.timerId === DEADLINE && state.pending) return score(state, state.pending, null, null);
        return { state, effects: [] };
      }

      case "action": {
        // Разбор снимает сам участник — и любым из своих ответов, не только
        // кнопкой: третьей руки у него нет, а отдельная клавиша означала бы, что
        // в обучении раскладка другая, чем в зачёте.
        if (state.holding) return release(state);
        if (input.actionId !== "choose" || !state.pending) return { state, effects: [] };
        const index = input.payload.index ?? -1;
        if (index !== 0 && index !== 1) return { state, effects: [] };
        return score(state, state.pending, index, input.tMs - state.pending.onsetMs);
      }

      case "protocol":
        return input.command.type === "finish" ? finish(state) : { state, effects: [] };

      default:
        return { state, effects: [] };
    }
  },
};

function presentCue(state: RuleSwitchState, input: CoreInput): ReduceResult<RuleSwitchState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const pool: Rule[] = params.ruleCount >= 3 ? ["parity", "magnitude", "prime"] : ["parity", "magnitude"];

  const [roll, r1] = rngNext(state.rng);
  let rng = r1;
  let rule: Rule;
  let switched: boolean;
  if (state.lastRule && roll >= params.switchRate) {
    rule = state.lastRule;
    switched = false;
  } else {
    const [picked, r2] = rngPick(rng, pool.filter((r) => r !== state.lastRule));
    rng = r2;
    rule = picked;
    switched = state.lastRule !== null;
  }

  // Пятёрка исключена: по правилу величины она попадает на границу категорий.
  let value = 5;
  while (value === 5) {
    const [candidate, r3] = rngInt(rng, 1, 9);
    rng = r3;
    value = candidate;
  }

  const cued: Pending = { rule, number: value, correctIndex: classify(rule, value), switched, onsetMs: 0 };
  const next: RuleSwitchState = { ...state, rng, cued, pending: null, lastFeedback: null, lastDebrief: null };
  return {
    state: next,
    effects: [
      { kind: "render", view: view(next) as never },
      { kind: "emit", event: { type: "cue.presented", rule, switched } },
      { kind: "schedule", timerId: CUE, afterMs: params.cueLeadMs },
    ],
  };
}

function presentStimulus(state: RuleSwitchState, input: CoreInput): ReduceResult<RuleSwitchState> {
  const params = state.params;
  const cued = state.cued;
  if (!params || !cued) return { state, effects: [] };
  const pending: Pending = { ...cued, onsetMs: input.tMs };
  const next: RuleSwitchState = {
    ...state,
    cued: null,
    pending,
    lastRule: pending.rule,
    trial: state.trial + 1,
  };
  return {
    state: next,
    effects: [
      { kind: "render", view: view(next) as never },
      {
        kind: "emit",
        event: {
          type: "stimulus.presented",
          trial: next.trial,
          rule: pending.rule,
          number: pending.number,
          switched: pending.switched,
        },
      },
      { kind: "schedule", timerId: DEADLINE, afterMs: params.deadlineMs },
    ],
  };
}

function score(
  state: RuleSwitchState,
  pending: Pending,
  chosen: number | null,
  rtMs: number | null,
): ReduceResult<RuleSwitchState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const correct = chosen === pending.correctIndex;
  const counted = rtMs !== null && correct;
  // В обучении проба с ошибкой заканчивается разбором, а не следующим числом:
  // промежуток между пробами — треть секунды, прочитать за неё нельзя ничего.
  const holding = state.training && !correct;
  const next: RuleSwitchState = {
    ...state,
    pending: null,
    holding,
    correct: state.correct + (correct ? 1 : 0),
    rtSum: state.rtSum + (rtMs ?? 0),
    rtCount: state.rtCount + (rtMs === null ? 0 : 1),
    // Цена переключения считается только по верным ответам: у ошибок RT другой природы.
    switchRtSum: state.switchRtSum + (counted && pending.switched ? rtMs : 0),
    switchRtCount: state.switchRtCount + (counted && pending.switched ? 1 : 0),
    repeatRtSum: state.repeatRtSum + (counted && !pending.switched ? rtMs : 0),
    repeatRtCount: state.repeatRtCount + (counted && !pending.switched ? 1 : 0),
    lastFeedback: rtMs === null ? "timeout" : correct ? "correct" : "wrong",
    // Разбор называет категорию правила, а не номер варианта: ошибка здесь почти
    // всегда в том, что ответ дан по прежнему правилу.
    lastDebrief: correct
      ? null
      : {
          expected: RULES[pending.rule].options[pending.correctIndex] ?? null,
          got: chosen === null ? null : RULES[pending.rule].options[chosen] ?? null,
        },
  };
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: DEADLINE },
      { kind: "emit", event: { type: "response", chosen, correct, rtMs, switched: pending.switched } },
      { kind: "outcome", outcome: { kind: "trial", scored: true, correct, rtMs, paramsUsed: { ...params } } },
      { kind: "render", view: view(next) as never },
      // Ожидание разбора всё равно ограничено: участник мог отвернуться, а блок
      // обязан кончиться сам.
      { kind: "schedule", timerId: ITI, afterMs: holding ? HOLD_MS : 320 },
    ],
  };
}

/** Участник прочитал разбор: дальше блок идёт как обычно, со следующей пробы. */
function release(state: RuleSwitchState): ReduceResult<RuleSwitchState> {
  const params = state.params;
  const next: RuleSwitchState = { ...state, holding: false, lastFeedback: null, lastDebrief: null };
  const cancel: Effect = { kind: "cancel", timerId: ITI };
  if (!params) return { state: next, effects: [cancel, { kind: "render", view: view(next) as never }] };
  if (next.trial >= params.blockLength) {
    const ended = finish(next);
    return { state: ended.state, effects: [cancel, ...ended.effects] };
  }
  return {
    state: next,
    effects: [cancel, { kind: "render", view: view(next) as never }, { kind: "requestParams" }],
  };
}

function finish(state: RuleSwitchState): ReduceResult<RuleSwitchState> {
  const result = summary(state);
  const next: RuleSwitchState = { ...state, running: false, pending: null, cued: null, holding: false };
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: DEADLINE },
      { kind: "cancel", timerId: CUE },
      { kind: "emit", event: { type: "block.end", ...result } },
      { kind: "render", view: view(next) as never },
      { kind: "complete", summary: result as never },
    ],
  };
}
