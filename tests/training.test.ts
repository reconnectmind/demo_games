// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  GameRegistry,
  GameRuntime,
  Fixed,
  Manual,
  MemorySink,
  THREE_KEYS,
  VirtualClock,
  headlessSurface,
  type LoggedEvent,
} from "@gamespace/core";
import { DomSurface, debriefText } from "@gamespace/ui-web";
import { protocolGames } from "@gamespace/games";
import { SectionRunner, compileProtocol, terminationOf, type RunRecord, type Screen } from "@gamespace/protocol";
import pilot from "../packages/protocol/examples/reconnect-pilot.json" with { type: "json" };

HTMLCanvasElement.prototype.getContext = () => null;

const TRAINING_GAMES = [
  "org.reconnect.arithmetic",
  "org.reconnect.n-back",
  "org.reconnect.stroop",
  "org.reconnect.rule-switch",
  "org.reconnect.dual-load",
  "org.reconnect.number-sequence",
];

function registry() {
  const r = new GameRegistry();
  for (const game of protocolGames) r.register(game);
  return r;
}

/**
 * Участок обучения на автоответчике. Ответы даёт `answer`: так проверяется не
 * механика задач, а то, что участок ведёт по покрытию и считает допуск.
 */
function trainingSection(answer: (gameId: string) => void, timeCapMs = 3_600_000) {
  const reg = registry();
  const clock = new VirtualClock();
  const sink = new MemorySink();
  const runtime = new GameRuntime({
    registry: reg,
    clock,
    sink,
    capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
    t0WallMs: 1_700_000_000_000,
    wallNow: () => 1_700_000_000_000 + clock.now(),
  });
  const compiled = compileProtocol(pilot, { participantId: "p-train", registry: reg });
  const section = compiled.sections.find((s) => s.id === "training")!;
  const screens: Screen[] = [];
  const done: RunRecord[] = [];
  const runner = new SectionRunner({
    runtime,
    section: {
      ...section,
      // Потолок по времени поднят, чтобы участок кончился именно покрытием, а
      // прогон ограничен минутой: иначе автоответчик доигрывает блоки целиком.
      end: terminationOf({
        by: "first",
        of: [{ by: "coverage" }, { by: "time", ms: timeCapMs }, { by: "run-limit", ms: 60_000 }],
      }),
    },
    surface: headlessSurface(),
    headless: true,
    seed: 5,
    sessionId: "s-train",
    input: compiled.input,
    policyFor: () => new Fixed(0),
    present: (screen, _index, proceed) => {
      screens.push(screen);
      proceed();
    },
    onRunStart: (instance) => answer(instance.ref.id),
    onRunEnd: (record) => done.push(record),
  });
  return { runner, clock, screens, done, sink, runtime };
}

/** Автоответчик: отвечает на каждый стимул, пока прогон не кончится. */
function drive(runner: SectionRunner, clock: VirtualClock, correct: boolean, stepMs = 200, steps = 12_000): void {
  for (let i = 0; i < steps && !runner.finished; i++) {
    const instance = runner.current();
    const active = instance?.activeInstance?.() ?? instance;
    if (active) {
      const actions = registry().resolve(active.ref.id).manifest.interaction.actions;
      const indexed = actions.find((a) => a.indexed);
      if (indexed) active.input.submit(indexed.id, { index: correct ? 0 : 1 }, "keyboard");
      else if (actions[0]) active.input.submit(actions[0].id, {}, "keyboard");
    }
    clock.advance(stepMs);
  }
}

describe("обучение по покрытию", () => {
  it("участок обучения объявлен покрытием, а не только временем", () => {
    const compiled = compileProtocol(pilot, { participantId: "p-1", registry: registry() });
    const training = compiled.sections.find((s) => s.id === "training")!;
    expect(training.coverage).toBe(true);
    expect(training.training).toBe(true);
    // Прочие участки идут по времени: покрытие — свойство обучения.
    for (const other of compiled.sections.filter((s) => s.id !== "training")) {
      expect(other.coverage).toBeUndefined();
    }
  });

  it("каждая задача обучения получает экран правила до первого стимула", () => {
    const seen: string[] = [];
    const { runner, clock, screens } = trainingSection((gameId) => seen.push(gameId));
    runner.start();
    drive(runner, clock, true);
    // Шесть задач — шесть правил, и каждое показано раньше своего прогона.
    // Первый экран — отбивка самого участка, дальше идут правила задач.
    const rules = screens.slice(1);
    expect(rules.length).toBeGreaterThanOrEqual(6);
    for (const rule of rules) {
      expect(rule.body.join(" ")).toMatch(/Ответы клавишами Q W E|Ответы здесь мышью/);
    }
    expect(new Set(seen).size).toBe(6);
  });

  it("правило называет критерий допуска числами, а не прозой", () => {
    const { runner, clock, screens } = trainingSection(() => {});
    runner.start();
    drive(runner, clock, true, 200, 400);
    const text = screens.map((s) => s.body.join(" ")).join(" ");
    expect(text).toMatch(/из последних \d+ попыток верными будут \d+/);
    expect(text).toMatch(/Попыток даётся \d+/);
  });

  it("все шесть задач предъявлены, и это видно из журнала", () => {
    const { runner, clock, sink } = trainingSection(() => {});
    runner.start();
    drive(runner, clock, true);
    const started = sink.records
      .filter((r: LoggedEvent) => r.type === "section.run.start")
      .map((r) => (r.payload as { game: string }).game);
    // Из расчёта времени это восстановить нельзя, из журнала — можно.
    for (const game of TRAINING_GAMES) expect(started).toContain(game);
  });

  it("покрытие закрывается допуском, а участок кончается сам", () => {
    const { runner, clock } = trainingSection(() => {});
    runner.start();
    drive(runner, clock, true);
    expect(runner.finished).toBe(true);
    for (const item of runner.coverage()) {
      // Задача либо прошла критерий, либо исчерпала попытки: держать участника на
      // одной задаче до победы нельзя.
      expect(item.passed || item.exhausted).toBe(true);
      expect(item.attempts).toBeGreaterThan(0);
    }
  });

  it("попытки ограничены объявленным числом", () => {
    const { runner, clock, done } = trainingSection(() => {});
    runner.start();
    // Автоответчик молчит: критерий не выполнится ни разу.
    drive(runner, clock, false);
    const attempts = new Map<string, number>();
    for (const record of done) attempts.set(record.gameId, (attempts.get(record.gameId) ?? 0) + 1);
    for (const [gameId, count] of attempts) {
      const limit = registry().resolve(gameId).manifest.training.admission?.maxAttempts ?? 1;
      expect(count, `${gameId}: попыток ${count} при пределе ${limit}`).toBeLessThanOrEqual(limit);
    }
  });

  it("итог попытки записан числами: сколько верных в окне и какой порог", () => {
    const { runner, clock, done } = trainingSection(() => {});
    runner.start();
    drive(runner, clock, true);
    const judged = done.filter((r) => r.admission);
    expect(judged.length).toBeGreaterThan(0);
    for (const record of judged) {
      const a = record.admission!;
      expect(a.minCorrect).toBeGreaterThan(0);
      expect(a.attempt).toBeGreaterThan(0);
      // «Прошёл» без чисел проверить нельзя, поэтому они лежат рядом с итогом.
      expect(a.passed).toBe(a.window >= a.minCorrect && a.correct >= a.minCorrect);
    }
  });

  it("выполненный критерий закрывает задачу с первой попытки", () => {
    const reg = registry();
    const clock = new VirtualClock();
    const runtime = new GameRuntime({
      registry: reg,
      clock,
      capabilities: ["keyboard", "pointer", "canvas"],
      t0WallMs: 1_700_000_000_000,
      wallNow: () => 1_700_000_000_000 + clock.now(),
    });
    const done: RunRecord[] = [];
    const runner = new SectionRunner({
      runtime,
      section: {
        id: "training-stroop",
        games: ["org.reconnect.stroop"],
        training: true,
        coverage: true,
        end: terminationOf({ by: "coverage" }),
      },
      surface: headlessSurface(),
      headless: true,
      seed: 3,
      sessionId: "s-one",
      input: THREE_KEYS,
      policyFor: () => new Fixed(0),
      present: (_screen, _index, proceed) => proceed(),
      onRunEnd: (record) => done.push(record),
    });
    runner.start();
    // Отвечаем верно: цвет чернил берётся из состояния ядра — извне его знать
    // неоткуда, а критерий допуска проверяется именно на верных ответах.
    for (let step = 0; step < 400 && !runner.finished; step++) {
      const instance = runner.current();
      const pending = (instance?.state as { pending: { inkIndex: number } | null } | undefined)?.pending;
      if (pending) instance!.input.submit("choose", { index: pending.inkIndex }, "keyboard");
      clock.advance(120);
    }

    expect(runner.finished).toBe(true);
    expect(done).toHaveLength(1);
    expect(done[0]!.admission).toMatchObject({ passed: true, attempt: 1 });
    expect(runner.coverage()[0]).toMatchObject({ passed: true, attempts: 1, exhausted: false });
  });

  it("обучение идёт ниже первого уровня", () => {
    const compiled = compileProtocol(pilot, { participantId: "p-2", registry: registry() });
    const training = compiled.protocol.sections.find((s) => s.id === "training")!;
    expect(training.difficulty).toMatchObject({ policy: "fixed", start: 0 });
    const stroop = protocolGames.find((g) => g.manifest.id === "org.reconnect.stroop")!;
    const zero = stroop.paramsForLevel(0) as { deadlineMs: number; incongruentRate: number };
    const first = stroop.paramsForLevel(1) as { deadlineMs: number; incongruentRate: number };
    // Нулевой уровень легче первого, а не просто «другой».
    expect(zero.deadlineMs).toBeGreaterThan(first.deadlineMs);
    expect(zero.incongruentRate).toBeLessThanOrEqual(first.incongruentRate);
  });
});

describe("разбор ошибки в обучении", () => {
  it("три случая ошибки читаются словами", () => {
    expect(debriefText({ expected: "зелёный", got: "красный" })).toBe("Вы выбрали красный, а нужно было зелёный.");
    expect(debriefText({ expected: "зелёный", got: null })).toBe("Ответа не было. Нужно было: зелёный.");
    expect(debriefText({ expected: null, got: "нажатие" })).toBe("Здесь нажимать было не нужно.");
    expect(debriefText(null)).toBe("");
  });

  it("stroop называет, что было выбрано и что требовалось", () => {
    const reg = registry();
    const clock = new VirtualClock();
    const runtime = new GameRuntime({
      registry: reg,
      clock,
      capabilities: ["keyboard", "pointer", "canvas"],
      t0WallMs: 1_700_000_000_000,
      wallNow: () => 1_700_000_000_000 + clock.now(),
    });
    const stage = document.createElement("div");
    document.body.replaceChildren(stage);
    const instance = runtime.mount(reg.ref("org.reconnect.stroop"), {
      surface: new DomSurface({ stage }),
      seed: 11,
      policy: new Manual({ start: 0 }),
      input: THREE_KEYS,
      training: true,
    });
    instance.start();
    clock.advance(100);

    // Неверный ответ ищется перебором вариантов: какой из них верный, знает ядро.
    let text = "";
    for (let index = 0; index < 3 && !text.includes("нужно было"); index++) {
      instance.input.submit("choose", { index }, "keyboard");
      clock.advance(50);
      text = stage.querySelector(".gs-mark-reason")?.textContent ?? "";
      clock.advance(400);
    }
    expect(text).toMatch(/Вы выбрали .+, а нужно было .+\.|Ответа не было/);
  });

  it("в зачёте разбора нет", () => {
    const reg = registry();
    const clock = new VirtualClock();
    const runtime = new GameRuntime({
      registry: reg,
      clock,
      capabilities: ["keyboard", "pointer", "canvas"],
      t0WallMs: 1_700_000_000_000,
      wallNow: () => 1_700_000_000_000 + clock.now(),
    });
    const stage = document.createElement("div");
    document.body.replaceChildren(stage);
    const instance = runtime.mount(reg.ref("org.reconnect.stroop"), {
      surface: new DomSurface({ stage }),
      seed: 11,
      policy: new Manual({ start: 1 }),
      input: THREE_KEYS,
    });
    instance.start();
    clock.advance(100);
    instance.input.submit("choose", { index: 0 }, "keyboard");
    clock.advance(50);
    // Знак есть, слов нет: в зачёте разбор отнимал бы время у следующего стимула.
    expect(stage.querySelector(".gs-mark-reason")!.textContent).toBe("");
    expect(["✓", "✗"]).toContain(stage.querySelector(".gs-mark")!.textContent);
  });
});
