import {
  createRngState,
  type Effect,
  type GameCore,
  type Json,
  type Params,
  type ReduceResult,
  type RngState,
} from "@gamespace/core";
import {
  GEAR_NEUTRAL,
  GEAR_REVERSE,
  RPM_IDLE,
  RPM_MAX,
  drivelineInertia,
  engineStep,
  ratioFor,
} from "./drivetrain.js";
import { createSim, simReady, type Sim, type SimFrame, type SimSave } from "./sim.js";
import {
  SHOULDER_M,
  STAMP_LEAD_SEGMENTS,
  corridorHalfWidth,
  sectorIndexAt,
  segmentIndexAt,
  type ShapeStamp,
} from "./track.js";

/**
 * Правила заезда. Физику кузова считает Rapier (см. `sim.ts`), коробку — `drivetrain.ts`,
 * а здесь только то, что физике знать незачем: газ и его отклик, нагрев, зачёт по
 * секторам, длина блока, приборы и журнал.
 *
 * Мир физики не лежит в состоянии: состояние обязано быть сериализуемым, сравнимым
 * и воспроизводимым по журналу, а мир — это WASM. Поэтому симуляция висит на
 * состоянии скрытым (неперечислимым) полем, которого не видят ни `JSON.stringify`,
 * ни сравнение состояний, а в состоянии лежит её слепок из обычных чисел, по
 * которому мир пересобирается: после паузы, после снимка и после повтора.
 */
export const RACE_TICK = "race.tick";
export const SIM_STEP_MS = 16;
/** Больше 50 мс за тик не догоняем: после свёрнутой вкладки машина не телепортируется. */
export const MAX_STEP_MS = 50;

/** Педаль не мгновенная: у мотора есть отклик. Позже сюда придёт HbO с его задержкой. */
const THROTTLE_RISE_PER_S = 4.5;
const THROTTLE_FALL_PER_S = 2.9;
/**
 * Нагрев медленный: заезд длится сорок минут, и перегрев должен быть следствием
 * упорной работы не в той передаче, а не первых семи секунд газа.
 */
const K_HEAT = 0.1;
const K_COOL = 0.06;
/** Перегрев ограничивает мощность: напряжение приводит к вынужденному успокоению. */
export const LIMP_THROTTLE = 0.5;
const OVERHEAT_CLEAR = 0.6;
/** Сколько провисеть на крыше или на боку, прежде чем машину поставят на дорогу. */
const FLIPPED_LIMIT_MS = 1500;
const UPRIGHT_MIN = 0.25;
/**
 * Застрявшая машина. Уткнувшись в грунт боком или улёгшись днищем в траву, машина
 * остаётся без сцепления: колёса крутятся, тяга никуда не идёт, и участник давит
 * газ в пустоту — а на траве полный газ ещё и мгновенно перегревает мотор, то есть
 * тупик сам себя запирает. Поэтому неподвижная машина под газом — такой же повод
 * вернуть её на полосу, как кувырок: тупиков в сорокаминутном заезде быть не
 * должно, чем бы они ни были вызваны. Тормоз при этом не спрашивают: стоять вне
 * полосы, давя газ, — уже основание вернуть машину в игру.
 */
export const STUCK_LIMIT_MS = 2500;
const STUCK_SPEED_MS = 0.6;

/**
 * Признак тупика: вне полосы, под газом, в передаче и без движения. Условия именно
 * такие, а не «просто стоит»: на полосе остановка законна (светофора нет, но есть
 * свой темп), без газа участник и не пытается ехать, а на нейтрали газ вообще не
 * про движение — там мотор ревёт сам по себе, и вытаскивать некого.
 */
export function raceStuck(speedMs: number, offroad: boolean, throttleTarget: number, ratio = 1): boolean {
  return offroad && Math.abs(speedMs) < STUCK_SPEED_MS && throttleTarget > 0 && ratio !== 0;
}
/** Насколько ниже дороги надо оказаться, чтобы это считалось падением за коридор. */
const FALL_LIMIT_M = 6;

export interface RaceParams extends Params {
  blockMs: number;
  curveRate: number;
  gradeMax: number;
  roadHalfWidth: number;
  gears: number;
}

export interface RaceState {
  rng: RngState;
  /** Seed трассы: дорога — чистая функция от него и истории формы. */
  seed: number;
  params: RaceParams | null;
  /** История формы дороги: уровень дописывает её впереди, а не переписывает под машиной. */
  stamps: ShapeStamp[];
  running: boolean;
  started: boolean;
  finished: boolean;
  lastTickMs: number;
  /** Наигранное время блока: пауза и прерывание его не съедают. */
  playedMs: number;
  /** Слепок физики обычными числами: по нему мир пересобирается. */
  body: SimSave | null;
  /** Последний кадр физики: из него живут и приборы, и сцена. */
  frame: SimFrame | null;
  distance: number;
  lateral: number;
  throttle: number;
  throttleTarget: number;
  braking: boolean;
  /** Положение селектора: −1 — задний ход, 0 — нейтраль, 1..gears — вперёд. */
  gear: number;
  rpm: number;
  temp: number;
  overheat: boolean;
  offroad: boolean;
  holdLeft: boolean;
  holdRight: boolean;
  flippedMs: number;
  /** Сколько машина стоит под газом: по нему её вытаскивают из тупика. */
  stuckMs: number;
  respawns: number;
  /** ∫throttle dt, секунды полного газа. */
  throttleIntegral: number;
  /**
   * Расход: ∫ газ · обороты dt. Знаменатель КПД именно он, а не педаль. Иначе
   * низкая передача оказывалась «выгоднее»: она быстрее разгоняет, а педаль всё
   * равно одна. В машине наоборот — рёв на низкой жжёт топливо, и это ровно то,
   * что должна показывать метафора: напряжение обходится дороже.
   */
  effortIntegral: number;
  wasteIntegral: number;
  offroadMs: number;
  ratioSum: number;
  ratioTicks: number;
  speedSum: number;
  gearChanges: number;
  overheats: number;
  sector: number;
  sectors: number;
  sectorsClean: number;
  sectorOffroad: boolean;
  sectorStartDistance: number;
  sectorStartEffort: number;
}

export interface RaceView {
  running: boolean;
  finished: boolean;
  seed: number;
  stamps: ShapeStamp[];
  frame: SimFrame | null;
  distanceM: number;
  lateral: number;
  halfWidth: number;
  speedKmh: number;
  throttle: number;
  ratio: number;
  /** Положение селектора: −1 — задний ход, 0 — нейтраль, 1..gears — вперёд. */
  gear: number;
  gears: number;
  rpm: number;
  rpmMax: number;
  temp: number;
  overheat: boolean;
  offroad: boolean;
  braking: boolean;
  efficiency: number;
  steer: number;
  progress: { playedMs: number; blockMs: number };
  stats: Array<[string, string | number]>;
}

export interface RaceSummary {
  distanceM: number;
  meanSpeedKmh: number;
  meanEfficiency: number;
  wastedThrottleFrac: number;
  meanRatio: number;
  gearChanges: number;
  overheats: number;
  offroadFrac: number;
  accuracy: number;
  sectors: number;
  playedMs: number;
  respawns: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export { ratioFor, GEAR_NEUTRAL, GEAR_REVERSE, RPM_IDLE, RPM_MAX };

/** Как передача называется у человека: «задний», «нейтраль» или номер из скольких. */
export function gearLabel(gear: number, gears: number): string {
  if (gear <= GEAR_REVERSE) return "задний";
  if (gear === GEAR_NEUTRAL) return "нейтраль";
  return `${gear} из ${gears}`;
}

/**
 * Живая симуляция висит на состоянии неперечислимым полем. Так состояние остаётся
 * обычным JSON-объектом для журнала, снимка и сравнения, но при этом ядро не
 * пересобирает физический мир на каждом шаге.
 */
const LIVE = "__sim";

function liveOf(state: RaceState): Sim | null {
  return (state as unknown as Record<string, Sim | undefined>)[LIVE] ?? null;
}

function attach(state: RaceState, sim: Sim | null): RaceState {
  if (sim) Object.defineProperty(state, LIVE, { value: sim, enumerable: false, configurable: true });
  return state;
}

/** Новое состояние с сохранением живой симуляции: спред её теряет. */
function put(state: RaceState, patch: Partial<RaceState>): RaceState {
  return attach({ ...state, ...patch }, liveOf(state));
}

/**
 * Все созданные миры: `stop()` до ядра не доходит, поэтому в тестах и в витрине
 * миры иначе копились бы в куче WASM. Больше восьми не держим — старшие свободны
 * по построению, их состояние уже лежит слепком.
 */
const livingSims: Sim[] = [];

function remember(sim: Sim): void {
  livingSims.push(sim);
  while (livingSims.length > 8) livingSims.shift()?.dispose();
}

function release(state: RaceState): RaceState {
  const sim = liveOf(state);
  if (!sim) return state;
  const body = sim.save();
  const index = livingSims.indexOf(sim);
  if (index >= 0) livingSims.splice(index, 1);
  sim.dispose();
  const next = { ...state, body };
  Object.defineProperty(next, LIVE, { value: undefined, enumerable: false, configurable: true });
  return next;
}

/** Мир по требованию: из слепка, если он есть, иначе с нуля. */
function ensureSim(state: RaceState): Sim | null {
  const existing = liveOf(state);
  if (existing) return existing;
  if (!simReady()) return null;
  const sim = createSim(state.seed, state.stamps, state.body ?? undefined);
  remember(sim);
  attach(state, sim);
  return sim;
}

/** КПД: метры пути на единицу расхода. Единственное число, которое сравнивают между заездами. */
export function raceEfficiency(state: RaceState): number {
  return state.effortIntegral < 0.05 ? 0 : state.distance / state.effortIntegral;
}

export function raceAccuracy(state: RaceState): number {
  return state.sectors === 0 ? 0 : state.sectorsClean / state.sectors;
}

export function raceSummary(state: RaceState): RaceSummary {
  const ticks = Math.max(1, state.ratioTicks);
  return {
    distanceM: Math.round(state.distance),
    meanSpeedKmh: Number(((state.speedSum / ticks) * 3.6).toFixed(1)),
    meanEfficiency: Number(raceEfficiency(state).toFixed(2)),
    wastedThrottleFrac:
      state.throttleIntegral < 0.05 ? 0 : Number((state.wasteIntegral / state.throttleIntegral).toFixed(3)),
    meanRatio: Number((state.ratioSum / ticks).toFixed(3)),
    gearChanges: state.gearChanges,
    overheats: state.overheats,
    offroadFrac: state.playedMs < 1 ? 0 : Number((state.offroadMs / state.playedMs).toFixed(3)),
    accuracy: Number(raceAccuracy(state).toFixed(3)),
    sectors: state.sectors,
    playedMs: Math.round(state.playedMs),
    respawns: state.respawns,
  };
}

export function raceView(state: RaceState): RaceView {
  const params = state.params;
  const gears = params?.gears ?? 6;
  const efficiency = raceEfficiency(state);
  const speedMs = state.frame?.speedMs ?? 0;
  return {
    running: state.running,
    finished: state.finished,
    seed: state.seed,
    stamps: state.stamps,
    frame: state.frame,
    distanceM: state.distance,
    lateral: state.lateral,
    halfWidth: params?.roadHalfWidth ?? 6,
    speedKmh: Math.abs(speedMs) * 3.6,
    throttle: state.throttle,
    ratio: ratioFor(state.gear, gears),
    gear: state.gear,
    gears,
    rpm: state.rpm,
    rpmMax: RPM_MAX,
    temp: state.temp,
    overheat: state.overheat,
    offroad: state.offroad,
    braking: state.braking,
    efficiency,
    steer: (state.holdRight ? 1 : 0) - (state.holdLeft ? 1 : 0),
    progress: { playedMs: state.playedMs, blockMs: params?.blockMs ?? 0 },
    stats: [
      ["скорость", `${Math.round(Math.abs(speedMs) * 3.6)} км/ч`],
      ["путь", `${(state.distance / 1000).toFixed(2)} км`],
      ["передача", gearLabel(state.gear, gears)],
      ["обороты", `${Math.round(state.rpm)}`],
      ["КПД", efficiency === 0 ? "—" : efficiency.toFixed(1)],
      ["нагрев", `${Math.round(state.temp * 100)}%`],
      ["секторы", `${state.sectorsClean} из ${state.sectors}`],
    ],
  };
}

function render(state: RaceState): Effect {
  return { kind: "render", view: raceView(state) as unknown as Json };
}

function stampFor(params: RaceParams, fromSegment: number): ShapeStamp {
  return {
    fromSegment,
    curveRate: params.curveRate,
    gradeMax: params.gradeMax,
    halfWidth: params.roadHalfWidth,
  };
}

function sameShape(stamp: ShapeStamp | undefined, params: RaceParams): boolean {
  return (
    stamp !== undefined &&
    stamp.curveRate === params.curveRate &&
    stamp.gradeMax === params.gradeMax &&
    stamp.halfWidth === params.roadHalfWidth
  );
}

export const raceCore: GameCore<RaceState> = {
  init: (config) => {
    const params = (config.initialParams as RaceParams) ?? null;
    return {
      rng: createRngState(config.seed),
      seed: config.seed,
      params,
      stamps: params ? [stampFor(params, 0)] : [],
      running: false,
      started: false,
      finished: false,
      lastTickMs: 0,
      playedMs: 0,
      body: null,
      frame: null,
      distance: 0,
      lateral: 0,
      throttle: 0,
      throttleTarget: 0,
      braking: false,
      /**
       * Заезд начинается на нейтрали, как и всякая стоящая машина. Это не
       * придирка к достоверности: пока блок начинался сразу в передаче, машина
       * трогалась с первым же касанием газа, и первое, что делал участник, — не
       * выбирал, а догонял. Нейтраль отдаёт первый шаг ему: сначала передача,
       * потом газ.
       */
      gear: GEAR_NEUTRAL,
      rpm: RPM_IDLE,
      temp: 0,
      overheat: false,
      offroad: false,
      holdLeft: false,
      holdRight: false,
      flippedMs: 0,
      stuckMs: 0,
      respawns: 0,
      throttleIntegral: 0,
      effortIntegral: 0,
      wasteIntegral: 0,
      offroadMs: 0,
      ratioSum: 0,
      ratioTicks: 0,
      speedSum: 0,
      gearChanges: 0,
      overheats: 0,
      sector: 0,
      sectors: 0,
      sectorsClean: 0,
      sectorOffroad: false,
      sectorStartDistance: 0,
      sectorStartEffort: 0,
    };
  },

  reduce(state, input): ReduceResult<RaceState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action === "enter" && (input.phase === "main" || input.phase === "intro")) {
          // Возврат после прерывания продолжает заезд, а не начинает новый:
          // иначе снимок терял бы смысл, а пройденный путь пропадал.
          if (state.started && !state.finished) {
            const next = put(state, { running: true, lastTickMs: input.tMs });
            return {
              state: next,
              effects: [render(next), { kind: "schedule", timerId: RACE_TICK, afterMs: SIM_STEP_MS }],
            };
          }
          return {
            state: put(state, { running: true, started: true, lastTickMs: input.tMs }),
            effects: [{ kind: "emit", event: { type: "block.start" } }, { kind: "requestParams" }],
          };
        }
        if (input.action === "leave" && input.phase === "main") {
          // Мир физики отпускается на любом выходе из игры: пауза, прерывание,
          // конец блока. Обратно он собирается из слепка, поэтому путь этот один
          // и тот же и проверен каждым запуском, а не только снимком.
          const next = release(state);
          return { state: next, effects: [] };
        }
        if (input.action === "enter" && (input.phase === "paused" || input.phase === "suspended")) {
          // Пауза снимает удержания: клавишу отпустят вне игры, «up» не придёт.
          const next = put(state, {
            running: false,
            holdLeft: false,
            holdRight: false,
            throttleTarget: 0,
            braking: false,
          });
          return { state: next, effects: [{ kind: "cancel", timerId: RACE_TICK }, render(next)] };
        }
        return { state, effects: [] };
      }

      case "params": {
        const params = input.effective as RaceParams;
        if (!state.started || state.finished) {
          const stamps = sameShape(state.stamps[0], params) ? state.stamps : [stampFor(params, 0)];
          return { state: put(state, { params, stamps }), effects: [] };
        }
        return applyParams(state, params, input.tMs);
      }

      case "action": {
        if (!state.running || state.finished) return { state, effects: [] };
        return action(state, input.actionId, input.payload.phase !== "up");
      }

      case "deadline": {
        if (input.timerId !== RACE_TICK) return { state, effects: [] };
        if (!state.running || state.finished || !state.params) return { state, effects: [] };
        return step(state, input.tMs);
      }

      case "protocol": {
        if (input.command.type === "finish") return endBlock(state);
        return { state, effects: [] };
      }

      default:
        return { state, effects: [] };
    }
  },
};

/**
 * Управление сейчас ручное и прямое: заглушка, в которой человек сам двигает те
 * параметры, которыми потом будет двигать физиология. Когда появится сигнал,
 * `throttleTarget` и `gear` начнут приходить входом `kind: "signal"`, а физика,
 * приборы и журнал не изменятся.
 */
function action(state: RaceState, actionId: string, down: boolean): ReduceResult<RaceState> {
  if (actionId === "throttle") return { state: put(state, { throttleTarget: down ? 1 : 0 }), effects: [] };
  if (actionId === "brake") return { state: put(state, { braking: down }), effects: [] };
  if (actionId === "left") return { state: put(state, { holdLeft: down }), effects: [] };
  if (actionId === "right") return { state: put(state, { holdRight: down }), effects: [] };
  if (!down) return { state, effects: [] };
  if (actionId === "gearUp" || actionId === "gearDown") {
    const gears = state.params?.gears ?? 6;
    const gear = clamp(state.gear + (actionId === "gearUp" ? 1 : -1), GEAR_REVERSE, gears);
    if (gear === state.gear) return { state, effects: [] };
    const next = put(state, { gear, gearChanges: state.gearChanges + 1 });
    return {
      state: next,
      effects: [{ kind: "emit", event: { type: "gear.changed", gear, ratio: ratioFor(gear, gears) } }],
    };
  }
  return { state, effects: [] };
}

function applyParams(state: RaceState, params: RaceParams, tMs: number): ReduceResult<RaceState> {
  const gear = clamp(state.gear, GEAR_REVERSE, params.gears);
  // Новая форма дороги вступает в силу далеко впереди: под машиной трассу не
  // переписывают, иначе мир дёрнулся бы и колёса оказались бы в воздухе.
  const last = state.stamps[state.stamps.length - 1];
  const stamps = sameShape(last, params)
    ? state.stamps
    : [...state.stamps, stampFor(params, segmentIndexAt(state.distance) + STAMP_LEAD_SEGMENTS)];
  const next = put(state, { params, gear, stamps });
  if (stamps !== state.stamps) liveOf(next)?.setStamps(stamps);
  // Первый приход параметров запускает симуляцию; последующие только меняют дорогу.
  if (state.params && state.ratioTicks > 0) return { state: next, effects: [render(next)] };
  const started = put(next, { lastTickMs: tMs });
  return {
    state: started,
    effects: [render(started), { kind: "schedule", timerId: RACE_TICK, afterMs: SIM_STEP_MS }],
  };
}

/** Один шаг: газ, коробка, физика, нагрев, зачёт. Всё остальное — следствие. */
function step(state: RaceState, tMs: number): ReduceResult<RaceState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const dtMs = clamp(tMs - state.lastTickMs, 0, MAX_STEP_MS);
  const dt = dtMs / 1000;
  const effects: Effect[] = [];

  const sim = ensureSim(state);
  if (!sim) {
    // WASM ещё в пути: заезд ждёт, время блока не тратится.
    return { state: put(state, { lastTickMs: tMs }), effects: [{ kind: "schedule", timerId: RACE_TICK, afterMs: SIM_STEP_MS }] };
  }

  // Педаль подтягивается к цели: вверх быстрее, вниз медленнее.
  const rate = state.throttleTarget > state.throttle ? THROTTLE_RISE_PER_S : -THROTTLE_FALL_PER_S;
  const throttle = clamp(state.throttle + rate * dt, 0, 1);
  const power = state.overheat ? LIMP_THROTTLE : 1;
  // Обороты держит колесо, а не дорога: пока шина цепляется, это одно и то же, а
  // на буксующей машине обороты уходят вверх, и КПД за это платит.
  const ratio = ratioFor(state.gear, params.gears);
  const drive = engineStep(state.rpm, {
    wheelSpeedMs: state.frame?.driveSpeedMs ?? 0,
    ratio,
    throttle,
    powerCap: power,
    dtS: dt,
  });

  const beyond = Math.abs(state.lateral) - params.roadHalfWidth;
  const steer = (state.holdRight ? 1 : 0) - (state.holdLeft ? 1 : 0);
  sim.step(dt, {
    forceN: drive.forceN,
    // Маховик висит на колесе ровно настолько, насколько замкнут трансформатор.
    // На разомкнутом колесо лёгкое, и сорвать его с места легко — именно с этого
    // и начинается занос.
    driveInertia: drivelineInertia(ratio) * drive.lock,
    brake: state.braking ? 1 : 0,
    steer,
    offroad: clamp(beyond / SHOULDER_M, 0, 1),
  });
  const frame = sim.frame();

  const distance = frame.s;
  const offroad = Math.abs(frame.lateral) - params.roadHalfWidth > 0;
  const cooling = K_COOL * (0.5 + clamp(Math.abs(frame.speedMs) / 60, 0, 1));
  const temp = clamp(state.temp + (K_HEAT * drive.waste - cooling) * dt, 0, 1);

  let next = put(state, {
    lastTickMs: tMs,
    playedMs: state.playedMs + dtMs,
    body: sim.save(),
    frame,
    throttle,
    rpm: drive.rpm,
    temp,
    distance,
    lateral: frame.lateral,
    offroad,
    throttleIntegral: state.throttleIntegral + throttle * power * dt,
    effortIntegral: state.effortIntegral + throttle * power * (drive.rpm / RPM_MAX) * dt,
    wasteIntegral: state.wasteIntegral + drive.waste * dt,
    offroadMs: state.offroadMs + (offroad ? dtMs : 0),
    ratioSum: state.ratioSum + ratioFor(state.gear, params.gears),
    ratioTicks: state.ratioTicks + 1,
    speedSum: state.speedSum + Math.abs(frame.speedMs),
    sectorOffroad: state.sectorOffroad || offroad,
  });

  if (offroad !== state.offroad) {
    effects.push({
      kind: "emit",
      event: { type: offroad ? "offroad.enter" : "offroad.exit", lateral: Number(frame.lateral.toFixed(2)) },
    });
  }

  // Перевернулись или уехали за гребень вала: машину ставят обратно на полосу.
  // Заезд — это сорок минут физиологии, он не должен кончаться из-за одного
  // кувырка. Ни падения, ни кувырка при этом не ждут: за валом земли нет вовсе, и
  // машина там просто исчезает из кадра, а вместе с ней и смысл происходящего.
  const escaped =
    Math.abs(frame.lateral) > corridorHalfWidth(params.roadHalfWidth) ||
    frame.y < frame.groundY - FALL_LIMIT_M;
  // Стоит под газом вне полосы — значит уткнулась, и ждать тут нечего.
  const stuckMs = raceStuck(frame.speedMs, offroad, state.throttleTarget, ratio) ? next.stuckMs + dtMs : 0;
  next = put(next, { stuckMs });
  if (frame.upright < UPRIGHT_MIN || escaped || stuckMs >= STUCK_LIMIT_MS) {
    const flippedMs = escaped || stuckMs >= STUCK_LIMIT_MS ? FLIPPED_LIMIT_MS : next.flippedMs + dtMs;
    next = put(next, { flippedMs });
    if (flippedMs >= FLIPPED_LIMIT_MS) {
      sim.respawn();
      next = put(next, {
        flippedMs: 0,
        stuckMs: 0,
        respawns: next.respawns + 1,
        body: sim.save(),
        frame: sim.frame(),
      });
      effects.push({ kind: "emit", event: { type: "spin.out", distanceM: Math.round(distance) } });
    }
  } else if (next.flippedMs > 0) {
    next = put(next, { flippedMs: 0 });
  }

  // Перегрев не проигрыш, а разворот петли: мощность падает, пока не остынет.
  if (!state.overheat && temp >= 1) {
    next = put(next, { overheat: true, overheats: state.overheats + 1 });
    effects.push({ kind: "emit", event: { type: "overheat.start", distanceM: Math.round(distance) } });
  } else if (state.overheat && temp <= OVERHEAT_CLEAR) {
    next = put(next, { overheat: false });
    effects.push({ kind: "emit", event: { type: "overheat.end", distanceM: Math.round(distance) } });
  }

  // Зачётная единица — сектор трассы: исход и новые параметры идут по нему.
  const sector = sectorIndexAt(distance);
  let requestParams = false;
  if (sector > next.sector) {
    const clean = !next.sectorOffroad;
    const spent = next.effortIntegral - next.sectorStartEffort;
    const efficiency = spent < 0.05 ? 0 : (distance - next.sectorStartDistance) / spent;
    next = put(next, {
      sector,
      sectors: next.sectors + 1,
      sectorsClean: next.sectorsClean + (clean ? 1 : 0),
      sectorOffroad: false,
      sectorStartDistance: distance,
      sectorStartEffort: next.effortIntegral,
    });
    effects.push({
      kind: "emit",
      event: {
        type: "sector.passed",
        sector,
        clean,
        efficiency: Number(efficiency.toFixed(2)),
        meanRatio: Number(ratioFor(state.gear, params.gears).toFixed(3)),
      },
    });
    effects.push({
      kind: "outcome",
      outcome: { kind: "trial", scored: true, correct: clean, rtMs: null, paramsUsed: { ...params } },
    });
    requestParams = true;
  }

  // Заезд кончается по времени: сколько километров успел участник — это результат,
  // а не условие. Длина блока — расписание, а не сложность.
  if (next.playedMs >= params.blockMs) {
    const finish = endBlock(next);
    return { state: finish.state, effects: [...effects, ...finish.effects] };
  }

  effects.push(render(next));
  if (requestParams) effects.push({ kind: "requestParams" });
  effects.push({ kind: "schedule", timerId: RACE_TICK, afterMs: SIM_STEP_MS });
  return { state: next, effects };
}

function endBlock(state: RaceState): ReduceResult<RaceState> {
  if (state.finished) return { state, effects: [] };
  const stopped = put(state, { running: false, finished: true, throttle: 0, throttleTarget: 0, braking: false });
  const next = release(stopped);
  const summary = raceSummary(next);
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: RACE_TICK },
      { kind: "emit", event: { type: "block.end", ...summary } },
      render(next),
      { kind: "complete", summary: summary as unknown as Json },
    ],
  };
}
