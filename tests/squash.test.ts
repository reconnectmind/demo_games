import { describe, expect, it } from "vitest";
import { Manual, headlessRun, project, replayCore, type LoggedEvent } from "@gamespace/core";
import { protocolGames, squash } from "@gamespace/games";
import {
  BALL_R,
  PADDLE_Y,
  SIM_STEP_MS,
  squashCore,
  squashSummary,
  type Ball,
  type SquashParams,
  type SquashState,
} from "../packages/games/src/squash/core.js";

const params: SquashParams = { ballSpeed: 0.4, ballCount: 1, paddleWidth: 0.2, episodes: 6, serveDelayMs: 200 };

/** Ядро без хоста: состояние собирается напрямую, чтобы проверять геометрию. */
function stateWith(balls: Ball[], overrides: Partial<SquashState> = {}): SquashState {
  const base = squashCore.init({ runId: "t", seed: 1, initialParams: params, training: false, locale: "ru" });
  return { ...base, params, running: true, started: true, balls, paddleX: 0.5, lastTickMs: 0, ...overrides };
}

function tick(state: SquashState, tMs: number) {
  return squashCore.reduce(state, { kind: "deadline", timerId: "sq.tick", tMs });
}

/** Шаги до выполнения условия: потеря шарика занимает несколько кадров. */
function tickUntil(state: SquashState, done: (s: SquashState) => boolean, maxTicks = 40) {
  let current = state;
  let last = tick(current, current.lastTickMs + SIM_STEP_MS);
  for (let i = 0; i < maxTicks && !done(last.state); i++) {
    current = last.state;
    last = tick(current, current.lastTickMs + SIM_STEP_MS);
  }
  return last;
}

function run(id = "org.reconnect.squash", options: Parameters<typeof headlessRun>[2] = {}) {
  const r = headlessRun(protocolGames, id, { seed: 5, policy: new Manual({ start: 1 }), ...options });
  r.instance.start();
  return r;
}

describe("сквош: физика", () => {
  it("шарик летит по прямой между отскоками", () => {
    const state = stateWith([{ id: 1, x: 0.5, y: 0.3, vx: 0, vy: 0.4 }]);
    const first = tick(state, SIM_STEP_MS).state;
    const second = tick(first, SIM_STEP_MS * 2).state;
    const step = 0.4 * (SIM_STEP_MS / 1000);
    expect(first.balls[0]!.y).toBeCloseTo(0.3 + step, 6);
    expect(second.balls[0]!.y).toBeCloseTo(0.3 + 2 * step, 6);
    expect(second.balls[0]!.x).toBeCloseTo(0.5, 6);
  });

  it("боковая стена отражает по горизонтали и сохраняет скорость", () => {
    const state = stateWith([{ id: 1, x: BALL_R + 0.001, y: 0.5, vx: -0.4, vy: 0.1 }]);
    const after = tick(state, SIM_STEP_MS).state;
    const ball = after.balls[0]!;
    expect(ball.vx).toBeGreaterThan(0);
    expect(ball.x).toBeGreaterThanOrEqual(BALL_R);
    expect(Math.hypot(ball.vx, ball.vy)).toBeCloseTo(Math.hypot(0.4, 0.1), 6);
  });

  it("верхняя стена отражает по вертикали", () => {
    const state = stateWith([{ id: 1, x: 0.5, y: BALL_R + 0.001, vx: 0.1, vy: -0.4 }]);
    const ball = tick(state, SIM_STEP_MS).state.balls[0]!;
    expect(ball.vy).toBeGreaterThan(0);
    expect(ball.y).toBeGreaterThanOrEqual(BALL_R);
  });

  it("площадка возвращает шарик и это считается попаданием", () => {
    const state = stateWith([{ id: 1, x: 0.5, y: PADDLE_Y - BALL_R - 0.002, vx: 0, vy: 0.4 }]);
    const result = tick(state, SIM_STEP_MS);
    expect(result.state.returns).toBe(1);
    expect(result.state.balls[0]!.vy).toBeLessThan(0);
    expect(result.effects.some((e) => e.kind === "outcome" && e.outcome.kind === "trial" && e.outcome.correct)).toBe(true);
  });

  it("край площадки задаёт угол отскока, центр отправляет вертикально", () => {
    const edge = stateWith([{ id: 1, x: 0.5 + 0.1, y: PADDLE_Y - BALL_R - 0.002, vx: 0, vy: 0.4 }]);
    const center = stateWith([{ id: 1, x: 0.5, y: PADDLE_Y - BALL_R - 0.002, vx: 0, vy: 0.4 }]);
    const edgeBall = tick(edge, SIM_STEP_MS).state.balls[0]!;
    const centerBall = tick(center, SIM_STEP_MS).state.balls[0]!;
    expect(Math.abs(edgeBall.vx)).toBeGreaterThan(Math.abs(centerBall.vx));
    expect(centerBall.vx).toBeCloseTo(0, 6);
    expect(Math.hypot(edgeBall.vx, edgeBall.vy)).toBeCloseTo(params.ballSpeed, 6);
  });

  it("мимо площадки — потеря, ошибка и новая подача", () => {
    const state = stateWith([{ id: 1, x: 0.1, y: 0.99, vx: 0, vy: 0.4 }]);
    const result = tickUntil(state, (s) => s.losses > 0);
    expect(result.state.losses).toBe(1);
    expect(result.state.balls).toHaveLength(0);
    expect(result.state.pendingServes).toHaveLength(1);
    expect(result.effects.some((e) => e.kind === "outcome" && e.outcome.kind === "trial" && !e.outcome.correct)).toBe(true);
  });

  it("серия обнуляется промахом и запоминается лучшая", () => {
    let state = stateWith([{ id: 1, x: 0.5, y: PADDLE_Y - BALL_R - 0.002, vx: 0, vy: 0.4 }]);
    state = tick(state, SIM_STEP_MS).state;
    expect(state.rally).toBe(1);
    state = { ...state, balls: [{ id: 2, x: 0.05, y: 0.99, vx: 0, vy: 0.4 }] };
    state = tickUntil(state, (s) => s.losses > 0).state;
    expect(state.rally).toBe(0);
    expect(state.longestRally).toBe(1);
  });

  it("шаг ограничен сверху: возврат из свёрнутой вкладки не телепортирует шарик", () => {
    const state = stateWith([{ id: 1, x: 0.5, y: 0.2, vx: 0, vy: 0.4 }]);
    const after = tick(state, 5_000).state;
    expect(after.balls[0]!.y).toBeLessThan(0.23);
  });

  it("удержание двигает площадку, отпускание останавливает", () => {
    let state = stateWith([]);
    state = squashCore.reduce(state, { kind: "action", actionId: "right", payload: { phase: "down" }, tMs: 0 }).state;
    state = tick(state, 200).state;
    const moved = state.paddleX;
    expect(moved).toBeGreaterThan(0.5);
    state = squashCore.reduce(state, { kind: "action", actionId: "right", payload: { phase: "up" }, tMs: 200 }).state;
    state = tick(state, 400).state;
    expect(state.paddleX).toBeCloseTo(moved, 6);
  });

  it("наведение мышью ставит площадку в указанную долю поля", () => {
    let state = stateWith([]);
    state = squashCore.reduce(state, { kind: "action", actionId: "aim", payload: { value: 0.8 }, tMs: 0 }).state;
    state = tick(state, SIM_STEP_MS).state;
    expect(state.paddleX).toBeCloseTo(0.8, 6);
  });

  it("площадка не выходит за поле", () => {
    let state = stateWith([]);
    state = squashCore.reduce(state, { kind: "action", actionId: "left", payload: { phase: "down" }, tMs: 0 }).state;
    for (let t = SIM_STEP_MS; t <= 3000; t += SIM_STEP_MS) state = tick(state, t).state;
    expect(state.paddleX).toBeCloseTo(params.paddleWidth / 2, 6);
  });
});

describe("сквош: сложность и блок", () => {
  it("уровни ускоряют шарик, добавляют шарики и сужают площадку", () => {
    const first = squash.paramsForLevel(1) as SquashParams;
    const last = squash.paramsForLevel(8) as SquashParams;
    expect(last.ballSpeed).toBeGreaterThan(first.ballSpeed);
    expect(last.ballCount).toBeGreaterThan(first.ballCount);
    expect(last.paddleWidth).toBeLessThan(first.paddleWidth);
  });

  it("новая сложность меняет модуль скорости, но не направление", () => {
    const state = stateWith([{ id: 1, x: 0.5, y: 0.5, vx: 0.3, vy: 0.4 }]);
    const faster: SquashParams = { ...params, ballSpeed: 1.0 };
    const after = squashCore.reduce(state, { kind: "params", effective: faster, tMs: 100 }).state;
    const ball = after.balls[0]!;
    expect(Math.hypot(ball.vx, ball.vy)).toBeCloseTo(1.0, 6);
    expect(ball.vx / ball.vy).toBeCloseTo(0.3 / 0.4, 6);
  });

  it("в поле столько шариков, сколько велит уровень", () => {
    const r = run("org.reconnect.squash", { policy: new Manual({ start: 8 }) });
    r.clock.advance(4000);
    const view = r.views.at(-1) as { balls: unknown[] };
    expect((squash.paramsForLevel(8) as SquashParams).ballCount).toBe(4);
    expect(view.balls.length).toBeGreaterThan(1);
  });

  it("блок заканчивается после заданного числа мячей", () => {
    const r = run();
    r.clock.advance(600_000);
    expect(r.instance.phase).toBe("completed");
    const end = r.records().find((rec: LoggedEvent) => rec.type === "block.end");
    expect(end).toBeDefined();
    const payload = end!.payload as { returns: number; losses: number };
    expect(payload.returns + payload.losses).toBeGreaterThanOrEqual(
      (squash.paramsForLevel(1) as SquashParams).episodes,
    );
  });

  it("после stop симуляция не тикает", () => {
    const r = run();
    r.clock.advance(2000);
    r.instance.stop();
    const before = r.records().length;
    r.clock.advance(60_000);
    expect(r.records().length).toBe(before);
  });
});

describe("сквош: распределённое внимание", () => {
  it("поднятая нагрузка добирает шарики посреди блока", () => {
    const state = stateWith([{ id: 1, x: 0.5, y: 0.3, vx: 0, vy: 0.4 }]);
    const loaded = squashCore.reduce(state, {
      kind: "params",
      effective: { ...params, ballCount: 4 },
      tMs: 100,
    });
    expect(loaded.state.balls.length + loaded.state.pendingServes.length).toBe(4);
    expect(loaded.effects.some((e) => e.kind === "emit" && e.event.type === "load.changed")).toBe(true);

    const after = tickUntil(loaded.state, (s) => s.balls.length === 4, 200);
    expect(after.state.balls).toHaveLength(4);
  });

  it("понижение нагрузки не отбирает шарики из полёта", () => {
    const state = stateWith([
      { id: 1, x: 0.3, y: 0.3, vx: 0, vy: 0.4 },
      { id: 2, x: 0.7, y: 0.4, vx: 0, vy: 0.4 },
    ]);
    const after = squashCore.reduce(state, { kind: "params", effective: { ...params, ballCount: 1 }, tMs: 50 });
    expect(after.state.balls).toHaveLength(2);
    expect(after.state.pendingServes).toHaveLength(0);
  });

  it("после понижения нагрузки население сходится к цели по потерям", () => {
    const state = stateWith(
      [
        { id: 1, x: 0.05, y: 0.9, vx: 0, vy: 0.4 },
        { id: 2, x: 0.95, y: 0.9, vx: 0, vy: 0.4 },
        { id: 3, x: 0.06, y: 0.8, vx: 0, vy: 0.4 },
      ],
      { params: { ...params, ballCount: 1 }, paddleX: 0.5 },
    );
    // Все три летят мимо площадки, замена придёт только одному.
    const after = tickUntil(state, (s) => s.losses >= 3, 400);
    expect(after.state.balls.length + after.state.pendingServes.length).toBeLessThanOrEqual(1);
  });

  it("нагрузка попадает в сводку средним числом шариков", () => {
    const single = run("org.reconnect.squash", { policy: new Manual({ start: 1 }) });
    const many = run("org.reconnect.squash", { policy: new Manual({ start: 1 }), overrides: { ballCount: 4 } });
    single.clock.advance(20_000);
    many.clock.advance(20_000);
    const a = squashSummary(single.instance.state as unknown as SquashState);
    const b = squashSummary(many.instance.state as unknown as SquashState);
    expect(b.meanBallsInPlay).toBeGreaterThan(a.meanBallsInPlay);
    expect(b.meanBallsInPlay).toBeGreaterThan(1);
  });

  it("потеря при конкуренте в нижней половине считается отдельно", () => {
    const state = stateWith([
      { id: 1, x: 0.05, y: 0.99, vx: 0, vy: 0.4 },
      { id: 2, x: 0.9, y: 0.7, vx: 0, vy: 0.2 },
    ]);
    const after = tickUntil(state, (s) => s.losses > 0);
    expect(after.state.losses).toBe(1);
    expect(after.state.crowdedLosses).toBe(1);
  });

  it("одиночная потеря конкурентной не считается", () => {
    const state = stateWith([{ id: 1, x: 0.05, y: 0.99, vx: 0, vy: 0.4 }]);
    const after = tickUntil(state, (s) => s.losses > 0);
    expect(after.state.losses).toBe(1);
    expect(after.state.crowdedLosses).toBe(0);
  });
});

describe("сквош: детерминизм", () => {
  it("одинаковый seed даёт ту же траекторию", () => {
    const a = run();
    const b = run();
    a.clock.advance(30_000);
    b.clock.advance(30_000);
    expect(project(a)).toEqual(project(b));
  });

  it("повтор журнала воспроизводит состояние ядра", () => {
    const r = run();
    r.clock.advance(30_000);
    expect(replayCore(squash, r.records(), 5)).toEqual(r.instance.state);
  });

  it("прерывание и возврат продолжают блок, а не начинают новый", () => {
    const r = run();
    r.clock.advance(8_000);
    const before = r.instance.state as unknown as SquashState;
    const snapshot = r.instance.snapshot();
    expect(before.resolved).toBeGreaterThan(0);

    const restored = run();
    restored.instance.restore(snapshot);
    restored.instance.start();
    const after = restored.instance.state as unknown as SquashState;
    expect(after.resolved).toBe(before.resolved);
    expect(after.returns).toBe(before.returns);
    restored.clock.advance(2_000);
    expect((restored.instance.state as unknown as SquashState).resolved).toBeGreaterThanOrEqual(before.resolved);
  });
});
