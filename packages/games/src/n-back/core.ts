import {
  HOLD_MS,
  createRngState,
  rngPick,
  rngShuffle,
  type Effect,
  type GameCore,
  type Json,
  type Params,
  type ReduceResult,
  type RngState,
  type TrialDebrief,
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
  training: boolean;
  /** Разбор ошибки: в нём названы буквы, иначе «нажимать было не нужно» ничего не объясняет. */
  lastDebrief: TrialDebrief | null;
  /** Обучение стоит на разборе и ждёт участника: следующая буква сама не придёт. */
  holding: boolean;
  /** Какая ступень обучения идёт: 0 — объявленный N, 1 — на шаг глубже. */
  stage: number;
  /** Ступень кончилась, и участник читает объявление следующей. */
  awaitingStage: boolean;
}

export interface NBackView {
  letter: string;
  n: number;
  visible: boolean;
  running: boolean;
  finished: boolean;
  feedback: NBackFeedback;
  debrief: TrialDebrief | null;
  holding: boolean;
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
 * Сколько раз подряд одна буква может повториться в цепочке шага N. Три — это
 * «ABCCC» при N = 1: столько повторов ещё читается как повтор. Четвёртое
 * вхождение превращает цепочку в залипание: участник перестаёт сравнивать буквы
 * и просто держит клавишу, а доля совпадений при этом набирается кусками, а не
 * распределяется по блоку.
 */
export const NBACK_MAX_RUN = 3;

/**
 * Где в блоке стоят совпадения. Позиции планируются заранее и целиком, а не
 * бросаются на каждой пробе: только так доля совпадений получается ровно
 * объявленной, а не средней по блоку, и только так видно цепочки, которые
 * ограничение обязано разорвать.
 *
 * Запрещённая цепочка — три подряд целевых пробы в одном шаге: они означают
 * четвёртое вхождение одной буквы. Проверяются все три положения новой пробы в
 * такой тройке, потому что позиции разбираются в случайном порядке и соседи
 * могут быть заняты как слева, так и справа.
 */
function planTargets(rng: RngState, length: number, n: number, rate: number): [boolean[], RngState] {
  const flags = new Array<boolean>(length).fill(false);
  const eligible: number[] = [];
  for (let i = n; i < length; i++) eligible.push(i);
  const wanted = Math.round(Math.min(1, Math.max(0, rate)) * eligible.length);
  const [order, state] = rngShuffle(rng, eligible);
  let placed = 0;
  for (const i of order) {
    if (placed >= wanted) break;
    const before2 = flags[i - 2 * n] === true;
    const before1 = flags[i - n] === true;
    const after1 = flags[i + n] === true;
    const after2 = flags[i + 2 * n] === true;
    if ((before2 && before1) || (before1 && after1) || (after1 && after2)) continue;
    flags[i] = true;
    placed++;
  }
  return [flags, state];
}

/** Сколько одинаковых букв стоит в хвосте потока: их тоже не должно быть много подряд. */
function trailingRun(letters: readonly string[]): number {
  const last = letters[letters.length - 1];
  if (last === undefined) return 0;
  let run = 0;
  for (let i = letters.length - 1; i >= 0 && letters[i] === last; i--) run++;
  return run;
}

/** Черновик потока: позиции совпадений уже расставлены, остаётся подобрать буквы. */
function draftStream(rng: RngState, params: NBackParams, n: number): [NBackStream, RngState] {
  const [targets, planned] = planTargets(rng, params.blockLength, n, params.targetRate);
  const letters: string[] = [];
  let state = planned;
  for (let i = 0; i < params.blockLength; i++) {
    const back = i >= n ? letters[i - n] : undefined;
    if (targets[i] === true && back !== undefined) {
      letters.push(back);
      continue;
    }
    const banned = new Set<string>();
    if (back !== undefined) banned.add(back);
    const last = letters[letters.length - 1];
    if (last !== undefined && trailingRun(letters) >= NBACK_MAX_RUN) banned.add(last);
    const [picked, afterPick] = rngPick(
      state,
      NBACK_LETTERS.filter((candidate) => !banned.has(candidate)),
    );
    state = afterPick;
    letters.push(picked);
  }
  return [{ letters, targets }, state];
}

/** Больше предела одинаковых букв подряд: при N больше единицы это даёт совпадение проб разных цепочек. */
function clumped(letters: readonly string[]): boolean {
  let run = 1;
  for (let i = 1; i < letters.length; i++) {
    run = letters[i] === letters[i - 1] ? run + 1 : 1;
    if (run > NBACK_MAX_RUN) return true;
  }
  return false;
}

/**
 * Сколько раз пересобирать блок, наткнувшись на залипание. Пересборка целиком, а
 * не правка одной буквы: буква целевой пробы задана предыдущей, и «починить» её
 * на месте нельзя, не сломав либо совпадение, либо долю совпадений.
 */
const REDRAFTS = 16;

/**
 * Поток на весь блок: сначала позиции совпадений, потом буквы под них.
 * Непреднамеренное совпадение сделало бы нецелевую пробу целевой, поэтому такая
 * буква перевыбирается из остальных. Блок с залипанием отбрасывается целиком —
 * доля совпадений от этого не страдает, потому что каждая пересборка планирует
 * ровно столько же совпадений.
 */
export function buildNBackStream(rng: RngState, params: NBackParams): [NBackStream, RngState] {
  const n = Math.max(1, Math.round(params.n));
  let state = rng;
  let stream: NBackStream | null = null;
  for (let attempt = 0; attempt < REDRAFTS; attempt++) {
    const [draft, next] = draftStream(state, params, n);
    state = next;
    stream = draft;
    if (!clumped(draft.letters)) break;
  }
  return [stream as NBackStream, state];
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
    debrief: state.lastDebrief,
    holding: state.holding,
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

/**
 * Разбор пробы называет буквы. «Здесь нажимать было не нужно» участник и сам
 * видит по кресту; понять, почему не нужно, можно только сравнив букву с той,
 * что была n шагов назад, — поэтому обе буквы в разборе названы.
 */
function trialDebrief(state: NBackState, missed: boolean): TrialDebrief {
  const n = state.params?.n ?? 1;
  const now = state.stream[state.index] ?? "";
  const back = state.stream[state.index - n];
  const ago = `${n} ${n === 1 ? "шаг" : "шага"} назад`;
  if (missed) {
    return {
      expected: "отметить совпадение",
      got: null,
      hint: `Это было совпадение: сейчас ${now} и ${ago} тоже ${now}. Здесь нужно было нажать.`,
    };
  }
  return {
    expected: null,
    got: "нажатие",
    hint:
      back === undefined
        ? `Совпадать было не с чем: ${ago} буквы ещё не было. Нажимают только на повтор.`
        : `Совпадения не было: сейчас ${now}, а ${ago} была ${back}. Нажимают только на повтор.`,
  };
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
    training: Boolean(config.training),
    lastDebrief: null,
    holding: false,
    stage: 0,
    awaitingStage: false,
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
        // Разбор снимает сам участник — и любым из своих ответов, не только
        // кнопкой: третьей руки у него нет, а отдельная клавиша означала бы, что
        // в обучении раскладка другая, чем в зачёте.
        if (state.holding) return release(state, input.tMs);
        if (input.actionId !== "match") return { state, effects: [] };
        return respond(state, input.tMs);
      }

      case "deadline": {
        if (input.timerId === NB_STIM) return hide(state);
        if (input.timerId === NB_ISI) return release(state, input.tMs);
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
  const [stream, rng] = buildNBackStream(state.rng, {
    ...params,
    blockLength: stageLength({ training: state.training, stage: 0 }, params),
  });
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
    lastDebrief: null,
    holding: false,
    stage: 0,
    awaitingStage: false,
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
  const wrong = missed || (!target && state.responded);
  // В обучении проба с ошибкой заканчивается разбором, а не следующей буквой:
  // пауза между стимулами — треть секунды, прочитать за неё нельзя ничего.
  const holding = state.training && wrong;
  const next: NBackState = {
    ...state,
    visible: false,
    misses: state.misses + (missed ? 1 : 0),
    correctRejections: state.correctRejections + (rejected ? 1 : 0),
    feedback: missed ? "miss" : state.feedback,
    holding,
    lastDebrief: holding ? trialDebrief(state, missed) : null,
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
      // Ожидание разбора всё равно ограничено: участник мог отвернуться, а блок
      // обязан кончиться сам.
      { kind: "schedule", timerId: NB_ISI, afterMs: holding ? HOLD_MS : params.isiMs },
    ],
  };
}

/** Участник прочитал разбор: дальше поток идёт как обычно, со следующей буквы. */
function release(state: NBackState, tMs: number): ReduceResult<NBackState> {
  const cleared = { ...state, holding: false, feedback: null, lastDebrief: null };
  const result = cleared.awaitingStage ? startStage(cleared, tMs) : advance(cleared, tMs);
  return { state: result.state, effects: [{ kind: "cancel", timerId: NB_ISI }, ...result.effects] };
}

function advance(state: NBackState, tMs: number): ReduceResult<NBackState> {
  const params = state.params;
  if (!params || state.finished) return { state, effects: [] };
  if (state.index + 1 >= stageLength(state, params)) return closeStage(state);
  return present({ ...state, index: state.index + 1 }, tMs);
}

/**
 * Первая ступень обучения короче зачётного блока: её дело — показать правило, а
 * не измерить точность, и измеряется участник на второй, полной. Длина здесь
 * важнее аккуратности: на полном блоке обе ступени вместе занимали больше
 * минуты, и до глубины N = 2 участник не доходил — попытка кончалась раньше.
 */
const INTRO_LENGTH = 10;

function stageLength(state: { training: boolean; stage: number }, params: NBackParams): number {
  if (!state.training || state.stage > 0) return params.blockLength;
  return Math.min(params.blockLength, INTRO_LENGTH);
}

/**
 * Сколько ступеней проходит участник в обучении. Одной мало: на 1-back правило
 * «та же буква, что N шагов назад» неотличимо от «две одинаковые подряд», и
 * участник выучивает не то. Вторая ступень на шаг глубже показывает, что
 * сравнивать нужно с буквой через одну, — и только после неё видно, понял он
 * принцип или запомнил частный случай.
 */
const TRAINING_STAGES = 2;
/** Глубже манифест не пускает: там же объявлен верхний предел N. */
const MAX_N = 4;

function deeperN(state: NBackState): number | null {
  const params = state.params;
  if (!params || !state.training) return null;
  if (state.stage + 1 >= TRAINING_STAGES) return null;
  const next = params.n + 1;
  return next <= MAX_N ? next : null;
}

/** Конец потока: в зачёте это конец блока, в обучении — ещё и переход к следующей ступени. */
function closeStage(state: NBackState): ReduceResult<NBackState> {
  const next = deeperN(state);
  if (next === null) return endBlock(state, true);
  const held: NBackState = {
    ...state,
    visible: false,
    holding: true,
    awaitingStage: true,
    feedback: null,
    lastDebrief: {
      expected: null,
      got: null,
      hint: `Ступень пройдена. Дальше N = ${next}: сравнивать нужно с буквой через ${next - 1}, а не с предыдущей.`,
    },
  };
  return {
    state: held,
    effects: [
      { kind: "emit", event: { type: "block.end", ...nbackSummary(state), stage: state.stage } },
      render(held),
      // Та же страховка, что у разбора ошибки: участник мог отвернуться, а блок
      // обязан кончиться сам.
      { kind: "schedule", timerId: NB_ISI, afterMs: HOLD_MS },
    ],
  };
}

/** Следующая ступень обучения: тот же блок, но на шаг глубже и со своим счётом. */
function startStage(state: NBackState, tMs: number): ReduceResult<NBackState> {
  const params = state.params;
  const n = deeperN(state);
  if (!params || n === null) return endBlock(state, true);
  const deeper: NBackParams = { ...params, n };
  const [stream, rng] = buildNBackStream(state.rng, deeper);
  const fresh: NBackState = {
    ...state,
    rng,
    params: deeper,
    stage: state.stage + 1,
    awaitingStage: false,
    stream: stream.letters,
    targetFlags: stream.targets,
    index: 0,
    visible: false,
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
    lastDebrief: null,
    holding: false,
  };
  const started = present(fresh, tMs);
  return {
    state: started.state,
    effects: [
      { kind: "emit", event: { type: "block.start", blockLength: deeper.blockLength, n: deeper.n } },
      ...started.effects,
    ],
  };
}

/**
 * Зачётная единица — блок: одно совпадение о памяти ничего не говорит, поэтому
 * наружу уходит ровно один блочный outcome, а отдельные пробы в сложность не идут.
 */
function endBlock(state: NBackState, scored: boolean): ReduceResult<NBackState> {
  if (state.finished) return { state, effects: [] };
  const params = state.params;
  const next: NBackState = {
    ...state,
    running: false,
    finished: true,
    visible: false,
    feedback: null,
    holding: false,
    awaitingStage: false,
    lastDebrief: null,
  };
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
