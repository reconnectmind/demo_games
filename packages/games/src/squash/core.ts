import {
  createRngState,
  rngNext,
  type Effect,
  type GameCore,
  type Json,
  type Params,
  type ReduceResult,
  type RngState,
  type TrialDebrief,
} from "@gamespace/core";

/**
 * Симуляция идёт шагами таймера: непрерывное время в этой архитектуре
 * выражается обычным `schedule`/`deadline`, отдельного вида входа не нужно.
 * Шаг фиксирован, а фактический dt берётся из `tMs` входа — он есть в журнале,
 * поэтому повтор даёт ту же траекторию до последнего бита.
 */
export const SQ_TICK = "sq.tick";
export const SIM_STEP_MS = 16;
/** Больше 50 мс за шаг не интегрируем: после переключения вкладки шарик не должен телепортироваться. */
export const MAX_STEP_MS = 50;

/** Поле — единичный квадрат: у ядра нет пикселей, масштаб знает только сцена. */
export const BALL_R = 0.022;
export const PADDLE_Y = 0.94;
export const PADDLE_H = 0.028;
export const PADDLE_SPEED = 1.15;
/** Максимальный угол отклонения от вертикали при отскоке от края площадки. */
export const MAX_DEFLECT_RAD = 1.05;

export interface SquashParams extends Params {
  ballSpeed: number;
  ballCount: number;
  paddleWidth: number;
  blockMs: number;
  serveDelayMs: number;
}

export interface Ball {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type SquashFeedback = "return" | "loss" | null;

export interface SquashState {
  rng: RngState;
  params: SquashParams | null;
  running: boolean;
  started: boolean;
  finished: boolean;
  balls: Ball[];
  /** Отложенные запуски: время подачи в мс от начала прогона. */
  pendingServes: number[];
  nextBallId: number;
  paddleX: number;
  holdLeft: boolean;
  holdRight: boolean;
  /** Куда указывает курсор, если участник играет мышью. */
  aimX: number | null;
  lastTickMs: number;
  /**
   * Наигранное время блока. Считается по шагам симуляции, а не по часам:
   * пауза, прерывание и свёрнутая вкладка не должны съедать блок.
   */
  playedMs: number;
  resolved: number;
  returns: number;
  losses: number;
  rally: number;
  longestRally: number;
  contactErrorSum: number;
  /** Сумма шариков в поле по шагам: делённое внимание измеряется нагрузкой, а не намерением. */
  loadSum: number;
  loadTicks: number;
  /** Потери, у которых был живой конкурент в нижней половине поля. */
  crowdedLosses: number;
  feedback: SquashFeedback;
  feedbackUntilMs: number;
  /** Разбор промаха: в какую сторону надо было вести площадку. Только в обучении. */
  lastDebrief: TrialDebrief | null;
  /** Обучающий прогон: знак ошибки держится дольше, и к нему добавляется разбор. */
  training: boolean;
}

export interface SquashViewBall {
  x: number;
  y: number;
  r: number;
}

export interface SquashView {
  balls: SquashViewBall[];
  paddleX: number;
  paddleWidth: number;
  paddleY: number;
  paddleHeight: number;
  running: boolean;
  finished: boolean;
  feedback: SquashFeedback;
  debrief: TrialDebrief | null;
  ballSpeed: number;
  /** Сколько шариков требует текущий уровень: в поле их может быть меньше между подачами. */
  ballCount: number;
  /** Сколько блока уже наиграно и сколько он длится всего. */
  progress: { playedMs: number; blockMs: number };
  stats: Array<[string, string | number]>;
}

export interface SquashSummary {
  returns: number;
  losses: number;
  accuracy: number;
  longestRally: number;
  meanContactErrorFrac: number;
  meanBallsInPlay: number;
  crowdedLosses: number;
  /** Сколько блок реально шёл: блок могли закрыть досрочно командой протокола. */
  playedMs: number;
}

export function squashAccuracy(state: SquashState): number {
  return state.resolved === 0 ? 0 : state.returns / state.resolved;
}

export function squashSummary(state: SquashState): SquashSummary {
  return {
    returns: state.returns,
    losses: state.losses,
    accuracy: squashAccuracy(state),
    longestRally: state.longestRally,
    meanContactErrorFrac: state.returns === 0 ? 0 : state.contactErrorSum / state.returns,
    meanBallsInPlay: state.loadTicks === 0 ? 0 : state.loadSum / state.loadTicks,
    crowdedLosses: state.crowdedLosses,
    playedMs: Math.round(state.playedMs),
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Разбор промаха: где ушёл мяч и куда надо было вести площадку. Ошибка здесь —
 * не выбранный вариант, а недоведённое движение, поэтому фраза про сторону, а не
 * про «вы выбрали».
 */
function missDebrief(ballX: number, paddleX: number): TrialDebrief {
  const side = ballX < paddleX ? "слева" : "справа";
  const where = ballX < paddleX ? "влево" : "вправо";
  return {
    expected: where,
    got: null,
    hint: `Мяч ушёл ${side}. Площадку нужно было вести ${where} — держите клавишу, пока она не окажется под мячом.`,
  };
}

/** Подача сверху со случайным углом вниз: одинаковый заход подряд не повторяется. */
function serve(rng: RngState, params: SquashParams, id: number): [Ball, RngState] {
  const [rollX, afterX] = rngNext(rng);
  const [rollAngle, afterAngle] = rngNext(afterX);
  const [rollSide, afterSide] = rngNext(afterAngle);
  const angle = (rollAngle - 0.5) * 1.2;
  const direction = rollSide < 0.5 ? -1 : 1;
  return [
    {
      id,
      x: 0.2 + rollX * 0.6,
      y: 0.18,
      vx: Math.sin(angle) * params.ballSpeed * direction,
      vy: Math.cos(angle) * params.ballSpeed,
    },
    afterSide,
  ];
}

/** Скорость шарика — это параметр сложности, поэтому модуль всегда нормируется. */
function withSpeed(ball: Ball, speed: number): Ball {
  const magnitude = Math.hypot(ball.vx, ball.vy) || 1;
  return { ...ball, vx: (ball.vx / magnitude) * speed, vy: (ball.vy / magnitude) * speed };
}

function render(state: SquashState): Effect {
  return { kind: "render", view: squashView(state) as unknown as Json };
}

export function squashView(state: SquashState): SquashView {
  const params = state.params;
  return {
    balls: state.balls.map((ball) => ({ x: ball.x, y: ball.y, r: BALL_R })),
    paddleX: state.paddleX,
    paddleWidth: params?.paddleWidth ?? 0.2,
    paddleY: PADDLE_Y,
    paddleHeight: PADDLE_H,
    running: state.running,
    finished: state.finished,
    feedback: state.feedback,
    debrief: state.lastDebrief,
    ballSpeed: params?.ballSpeed ?? 0,
    ballCount: params?.ballCount ?? 1,
    progress: { playedMs: state.playedMs, blockMs: params?.blockMs ?? 0 },
    stats: [
      ["отбито", state.returns],
      ["пропущено", state.losses],
      ["в поле", `${state.balls.length} из ${params?.ballCount ?? 1}`],
      ["серия", state.rally],
      ["точность", state.resolved === 0 ? "—" : `${Math.round(squashAccuracy(state) * 100)}%`],
    ],
  };
}

export const squashCore: GameCore<SquashState> = {
  init: (config) => ({
    rng: createRngState(config.seed),
    params: (config.initialParams as SquashParams) ?? null,
    running: false,
    started: false,
    finished: false,
    balls: [],
    pendingServes: [],
    nextBallId: 1,
    paddleX: 0.5,
    holdLeft: false,
    holdRight: false,
    aimX: null,
    lastTickMs: 0,
    playedMs: 0,
    resolved: 0,
    returns: 0,
    losses: 0,
    rally: 0,
    longestRally: 0,
    contactErrorSum: 0,
    loadSum: 0,
    loadTicks: 0,
    crowdedLosses: 0,
    feedback: null,
    feedbackUntilMs: 0,
    lastDebrief: null,
    training: config.training,
  }),

  reduce(state, input): ReduceResult<SquashState> {
    switch (input.kind) {
      case "lifecycle": {
        if (input.action === "enter" && (input.phase === "main" || input.phase === "intro")) {
          // Возврат после прерывания продолжает блок, а не начинает новый:
          // иначе снимок терял бы смысл, а лаг возврата было бы не с чем сравнивать.
          if (state.started && !state.finished) {
            return {
              state: { ...state, running: true, lastTickMs: input.tMs },
              effects: [render({ ...state, running: true }), { kind: "schedule", timerId: SQ_TICK, afterMs: SIM_STEP_MS }],
            };
          }
          return {
            state: { ...state, running: true, started: true, lastTickMs: input.tMs },
            effects: [{ kind: "emit", event: { type: "block.start" } }, { kind: "requestParams" }],
          };
        }
        if (input.action === "enter" && (input.phase === "paused" || input.phase === "suspended")) {
          // Пауза снимает удержания: клавишу отпустят вне игры, «up» не придёт.
          const next = { ...state, running: false, holdLeft: false, holdRight: false };
          return { state: next, effects: [{ kind: "cancel", timerId: SQ_TICK }, render(next)] };
        }
        return { state, effects: [] };
      }

      case "params": {
        const params = input.effective as SquashParams;
        if (!state.started || state.finished) return { state: { ...state, params }, effects: [] };
        return applyParams(state, params, input.tMs);
      }

      case "action": {
        if (!state.running || state.finished) return { state, effects: [] };
        if (input.actionId === "left" || input.actionId === "right") {
          const down = input.payload.phase !== "up";
          const next: SquashState =
            input.actionId === "left" ? { ...state, holdLeft: down } : { ...state, holdRight: down };
          return { state: next, effects: [] };
        }
        if (input.actionId === "aim") {
          const value = typeof input.payload.value === "number" ? input.payload.value : null;
          if (value === null) return { state, effects: [] };
          return { state: { ...state, aimX: clamp(value, 0, 1) }, effects: [] };
        }
        return { state, effects: [] };
      }

      case "deadline": {
        if (input.timerId !== SQ_TICK) return { state, effects: [] };
        if (!state.running || state.finished) return { state, effects: [] };
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
 * Новая сложность применяется на лету: шарики сохраняют направление, но
 * получают новый модуль скорости, а площадка — новую ширину.
 */
function applyParams(state: SquashState, params: SquashParams, tMs: number): ReduceResult<SquashState> {
  const half = params.paddleWidth / 2;
  const running = state.balls.length > 0 || state.pendingServes.length > 0;
  const fresh: SquashState = {
    ...state,
    params,
    paddleX: clamp(state.paddleX, half, 1 - half),
    balls: state.balls.map((ball) => withSpeed(ball, params.ballSpeed)),
  };
  if (running) {
    // Нагрузку можно поднять посреди блока: недостающие шарики доберутся сами.
    const topped = topUp(fresh, params, tMs);
    return { state: topped.state, effects: [...topped.effects, render(topped.state)] };
  }
  // Первая подача блока: столько шариков, сколько велит уровень, но вразнобой.
  const serves: number[] = [];
  for (let i = 0; i < params.ballCount; i++) serves.push(tMs + i * Math.max(200, params.serveDelayMs));
  const started: SquashState = { ...fresh, pendingServes: serves, lastTickMs: tMs };
  return {
    state: started,
    effects: [render(started), { kind: "schedule", timerId: SQ_TICK, afterMs: SIM_STEP_MS }],
  };
}

/**
 * Доводит число шариков до заданного. Это и есть манипуляция распределённым
 * вниманием: нагрузку меняет параметр, а не отдельная механика. Лишние шарики
 * при понижении не отбираются — те, что в полёте, доигрываются.
 */
function topUp(state: SquashState, params: SquashParams, tMs: number): ReduceResult<SquashState> {
  const missing = params.ballCount - (state.balls.length + state.pendingServes.length);
  if (missing <= 0) return { state, effects: [] };
  const serves: number[] = [];
  for (let i = 0; i < missing; i++) serves.push(tMs + i * Math.max(150, params.serveDelayMs / 2));
  return {
    state: { ...state, pendingServes: [...state.pendingServes, ...serves] },
    effects: [{ kind: "emit", event: { type: "load.changed", ballCount: params.ballCount, added: missing } }],
  };
}

/** Один шаг симуляции. Единственное место, где движется хоть что-нибудь. */
function step(state: SquashState, tMs: number): ReduceResult<SquashState> {
  const params = state.params;
  if (!params) return { state, effects: [] };
  const dtMs = clamp(tMs - state.lastTickMs, 0, MAX_STEP_MS);
  const dt = dtMs / 1000;
  const effects: Effect[] = [];

  let next: SquashState = { ...state, lastTickMs: tMs, playedMs: state.playedMs + dtMs };
  next = movePaddle(next, params, dt);

  // Отложенные подачи: время пришло — шарик выходит в поле.
  const stillPending: number[] = [];
  let balls = [...next.balls];
  let rng = next.rng;
  let nextBallId = next.nextBallId;
  for (const at of next.pendingServes) {
    if (at > tMs) {
      stillPending.push(at);
      continue;
    }
    const [ball, afterRng] = serve(rng, params, nextBallId++);
    rng = afterRng;
    balls.push(ball);
    effects.push({ kind: "emit", event: { type: "ball.served", ball: ball.id, x: ball.x, speed: params.ballSpeed } });
  }
  next = { ...next, pendingServes: stillPending, rng, nextBallId };

  let resolved = next.resolved;
  let returns = next.returns;
  let losses = next.losses;
  let rally = next.rally;
  let longestRally = next.longestRally;
  let contactErrorSum = next.contactErrorSum;
  let feedback = next.feedback;
  let feedbackUntilMs = next.feedbackUntilMs;
  let lastDebrief = next.lastDebrief;
  const survivors: Ball[] = [];
  /** Исходы шага: true — мяч отбит, false — потерян. */
  const resolutions: boolean[] = [];

  for (const ball of balls) {
    const moved = advance(ball, params, dt, next.paddleX, effects);
    if (moved.kind === "alive") {
      survivors.push(moved.ball);
      continue;
    }
    if (moved.kind === "returned") {
      survivors.push(moved.ball);
      returns += 1;
      resolved += 1;
      rally += 1;
      longestRally = Math.max(longestRally, rally);
      contactErrorSum += moved.contactError;
      feedback = "return";
      feedbackUntilMs = tMs + 180;
      lastDebrief = null;
      resolutions.push(true);
      effects.push({
        kind: "emit",
        event: { type: "ball.returned", ball: moved.ball.id, contactErrorFrac: moved.contactError, rally },
      });
      continue;
    }
    losses += 1;
    resolved += 1;
    rally = 0;
    feedback = "loss";
    // В обучении знак ошибки держится дольше: разбор надо успеть прочесть, а
    // триста миллисекунд — это меньше, чем взгляд переводится на строку.
    feedbackUntilMs = tMs + (next.training ? 1400 : 320);
    lastDebrief = next.training ? missDebrief(ball.x, next.paddleX) : null;
    resolutions.push(false);
    effects.push({ kind: "emit", event: { type: "ball.lost", ball: ball.id, x: ball.x } });
  }

  if (feedback && tMs > feedbackUntilMs) {
    feedback = null;
    lastDebrief = null;
  }

  // Потеря при живом конкуренте внизу — это цена деления внимания, а не
  // промах по одному шарику: такие потери считаются отдельно.
  const competitors = survivors.filter((ball) => ball.y > 0.5).length;
  const crowded = competitors > 0 ? resolutions.filter((correct) => !correct).length : 0;

  // Замена потерянного шарика — это тот же добор до заданной нагрузки. Если
  // нагрузку понизили, замены не будет: население сходится к цели по потерям.
  const shortfall = params.ballCount - (survivors.length + next.pendingServes.length);
  const replacements: number[] = [];
  for (let i = 0; i < shortfall; i++) replacements.push(tMs + params.serveDelayMs);

  next = {
    ...next,
    balls: survivors,
    pendingServes: [...next.pendingServes, ...replacements],
    resolved,
    returns,
    losses,
    rally,
    longestRally,
    contactErrorSum,
    loadSum: next.loadSum + balls.length,
    loadTicks: next.loadTicks + 1,
    crowdedLosses: next.crowdedLosses + crowded,
    feedback,
    feedbackUntilMs,
    lastDebrief,
  };

  // Зачётная единица — один мяч: в аркаде уровень обязан догонять участника
  // сразу, а не через блок, поэтому исход и новые параметры идут по каждому мячу.
  for (const correct of resolutions) {
    effects.push({
      kind: "outcome",
      outcome: { kind: "trial", scored: true, correct, rtMs: null, paramsUsed: { ...params } },
    });
  }

  // Аркада заканчивается по времени, а не по числу мячей: сколько эпизодов
  // успеет участник — само по себе результат, и в блоке он не должен зависеть
  // от того, насколько хорошо человек играет.
  if (next.playedMs >= params.blockMs) {
    const finish = endBlock(next);
    return { state: finish.state, effects: [...effects, ...finish.effects] };
  }

  effects.push(render(next));
  if (resolutions.length > 0) effects.push({ kind: "requestParams" });
  effects.push({ kind: "schedule", timerId: SQ_TICK, afterMs: SIM_STEP_MS });
  return { state: next, effects };
}

function movePaddle(state: SquashState, params: SquashParams, dt: number): SquashState {
  const half = params.paddleWidth / 2;
  // Клавиши главнее курсора: если участник держит клавишу, мышь не спорит.
  const direction = (state.holdRight ? 1 : 0) - (state.holdLeft ? 1 : 0);
  if (direction !== 0) {
    return { ...state, paddleX: clamp(state.paddleX + direction * PADDLE_SPEED * dt, half, 1 - half), aimX: null };
  }
  if (state.aimX !== null) return { ...state, paddleX: clamp(state.aimX, half, 1 - half) };
  return { ...state, paddleX: clamp(state.paddleX, half, 1 - half) };
}

type BallStep =
  | { kind: "alive"; ball: Ball }
  | { kind: "returned"; ball: Ball; contactError: number }
  | { kind: "lost" };

/**
 * Шаг одного шарика: стены отражают, площадка возвращает с углом по точке
 * касания, низ поля означает потерю.
 */
function advance(ball: Ball, params: SquashParams, dt: number, paddleX: number, effects: Effect[]): BallStep {
  let { x, y, vx, vy } = ball;
  x += vx * dt;
  y += vy * dt;

  if (x < BALL_R) {
    x = BALL_R + (BALL_R - x);
    vx = -vx;
    effects.push({ kind: "emit", event: { type: "ball.bounced", ball: ball.id, wall: "left" } });
  } else if (x > 1 - BALL_R) {
    x = 1 - BALL_R - (x - (1 - BALL_R));
    vx = -vx;
    effects.push({ kind: "emit", event: { type: "ball.bounced", ball: ball.id, wall: "right" } });
  }

  if (y < BALL_R) {
    y = BALL_R + (BALL_R - y);
    vy = -vy;
    effects.push({ kind: "emit", event: { type: "ball.bounced", ball: ball.id, wall: "top" } });
  }

  const contactY = PADDLE_Y - BALL_R;
  const crossing = vy > 0 && ball.y <= contactY && y >= contactY;
  if (crossing) {
    const reach = params.paddleWidth / 2 + BALL_R;
    const offset = (x - paddleX) / reach;
    if (Math.abs(offset) <= 1) {
      const angle = clamp(offset, -1, 1) * MAX_DEFLECT_RAD;
      const returned: Ball = {
        ...ball,
        x,
        y: contactY,
        vx: Math.sin(angle) * params.ballSpeed,
        vy: -Math.cos(angle) * params.ballSpeed,
      };
      return { kind: "returned", ball: returned, contactError: Math.abs(offset) };
    }
  }

  if (y - BALL_R > 1) return { kind: "lost" };
  return { kind: "alive", ball: { ...ball, x, y, vx, vy } };
}

function endBlock(state: SquashState): ReduceResult<SquashState> {
  if (state.finished) return { state, effects: [] };
  const next: SquashState = { ...state, running: false, finished: true, balls: [], pendingServes: [], feedback: null };
  const summary = squashSummary(next);
  return {
    state: next,
    effects: [
      { kind: "cancel", timerId: SQ_TICK },
      { kind: "emit", event: { type: "block.end", ...summary } },
      render(next),
      { kind: "complete", summary: summary as unknown as Json },
    ],
  };
}
