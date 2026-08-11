// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  GameRegistry,
  GameRuntime,
  Fixed,
  HOLD_MS,
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

/** Один модуль в поле: разбор ошибки живёт в игре, и проверять его проще без участка. */
function single(id: string, opts: { level: number; seed?: number; training?: boolean }) {
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
  const instance = runtime.mount(reg.ref(id), {
    surface: new DomSurface({ stage }),
    seed: opts.seed ?? 11,
    policy: new Manual({ start: opts.level }),
    input: THREE_KEYS,
    ...(opts.training ? { training: true } : {}),
  });
  instance.start();
  return { instance, stage, clock };
}

/**
 * Участок обучения на автоответчике. Ответы даёт `answer`: так проверяется не
 * механика задач, а то, что участок ведёт по покрытию и считает допуск.
 */
function trainingSection(
  answer: (gameId: string) => void,
  timeCapMs = 3_600_000,
  /**
   * Укорочение участков оператором. Задано — участок идёт ровно с тем
   * завершением, которое собрал компилятор: именно это и проверяется, когда
   * речь о репетиции.
   */
  durations?: Record<string, number>,
) {
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
  const compiled = compileProtocol(pilot, {
    participantId: "p-train",
    registry: reg,
    ...(durations ? { durations } : {}),
  });
  const section = compiled.sections.find((s) => s.id === "training")!;
  const screens: Screen[] = [];
  const done: RunRecord[] = [];
  const runner = new SectionRunner({
    runtime,
    section: durations
      ? section
      : {
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

  it("репетиция укорачивает попытку, а не покрытие", () => {
    // Оператор ставит участкам тридцать секунд. Пока это укорачивало потолок
    // участка, обучение показывало первую задачу и кончалось: пять остальных
    // участник не видел вовсе. Укорачивать нужно попытку — тогда все задачи
    // предъявлены, просто коротко.
    const { runner, clock, sink } = trainingSection(() => {}, 0, { training: 30_000 });
    runner.start();
    drive(runner, clock, false);
    const started = sink.records
      .filter((r: LoggedEvent) => r.type === "section.run.start")
      .map((r) => (r.payload as { game: string }).game);
    for (const game of TRAINING_GAMES) expect(started).toContain(game);
    const runs = sink.records.filter((r: LoggedEvent) => r.type === "section.run.end");
    // Попытки действительно короткие: иначе это был бы обычный полный участок.
    for (const run of runs) {
      const { startedMs, endedMs } = run.payload as { startedMs: number; endedMs: number };
      expect(endedMs - startedMs).toBeLessThanOrEqual(31_000);
    }
  });

  it("правило подписано номером задания, а не номером части", () => {
    const { runner, clock, screens } = trainingSection(() => {}, 3_600_000);
    runner.start();
    drive(runner, clock, true, 200, 600);
    const rules = screens.slice(1);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      // Часть — про сессию, задание — про обучение внутри неё. Витрина подставляла
      // номер участка обеим карточкам, и правило спринта подписывалось «часть 1 из 4».
      expect(rule.position).toMatch(/^Задание [1-6] из 6$/);
    }
    expect(new Set(rules.map((r) => r.position)).size).toBeGreaterThan(1);
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

  it("у непрерывного управления ошибка описана движением, а не выбором", () => {
    // «Вы выбрали влево, а нужно было вправо» про площадку не читается: участник
    // ничего не выбирал, он не довёл её. Такие механики дают фразу целиком.
    expect(debriefText({ expected: "влево", got: null, hint: "Мяч ушёл слева." })).toBe("Мяч ушёл слева.");
  });

  it("каждый отвечающий модуль умеет разбирать ошибку в обучении", () => {
    // Обучение без разбора — это «неверно» без объяснения: участник видит крест и
    // не узнаёт, что от него требовалось. Поэтому разбор обязателен всем, кто
    // вообще принимает ответы, включая аркадные модули.
    const reg = registry();
    for (const game of protocolGames) {
      const manifest = game.manifest;
      if (!manifest.responseAlternatives || (manifest.children ?? []).length > 0) continue;
      expect({ id: manifest.id, rule: Boolean(manifest.training.rule) }).toEqual({ id: manifest.id, rule: true });
      expect(reg.has(manifest.id)).toBe(true);
    }
  });

  it("сквош в обучении говорит, в какую сторону надо было вести площадку", () => {
    const { stage, clock } = single("org.reconnect.squash", { level: 4, seed: 4, training: true });
    // Площадку не двигаем: мяч уйдёт мимо, и это как раз тот случай, который
    // участнику нужно объяснить.
    let text = "";
    for (let i = 0; i < 200 && !text; i++) {
      clock.advance(100);
      text = stage.querySelector(".gs-mark-reason")?.textContent ?? "";
    }
    expect(text).toMatch(/Мяч ушёл (слева|справа)\. Площадку нужно было вести (влево|вправо)/);
  });

  it("stroop называет, что было выбрано и что требовалось", () => {
    const { instance, stage, clock } = single("org.reconnect.stroop", { level: 0, seed: 11, training: true });
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

  it("n-back называет обе буквы: и текущую, и ту, что была n назад", () => {
    const { instance, stage, clock } = single("org.reconnect.n-back", { level: 1, training: true });
    type Stream = { stream: string[]; targetFlags: boolean[]; index: number; visible: boolean; params: { n: number } };
    const st = () => instance.state as Stream;

    // Ложная тревога на пробе, у которой есть с чем сравнивать: только там разбор
    // может назвать обе буквы.
    let text = "";
    let answered = -1;
    for (let i = 0; i < 400 && !text; i++) {
      const now = st();
      if (now.visible && now.index !== answered && now.index >= now.params.n) {
        answered = now.index;
        // На совпадениях отвечаем верно: пропуск сам остановил бы поток разбором,
        // а нужен разбор именно ложной тревоги.
        instance.input.submit("match", {}, "keyboard");
        if (!now.targetFlags[now.index]) {
          clock.advance(1600);
          text = stage.querySelector(".gs-mark-reason")?.textContent ?? "";
          expect(text).toContain(now.stream[now.index]!);
          expect(text).toContain(now.stream[now.index - now.params.n]!);
          break;
        }
      }
      clock.advance(100);
    }
    expect(text).toMatch(/Совпадения не было/);
    instance.stop();
  });

  it("разбор держит задачу до ответа участника, а не гаснет сам", () => {
    const { instance, stage, clock } = single("org.reconnect.stroop", { level: 0, training: true });
    const ink = () => (instance.state as { pending: { inkIndex: number } | null }).pending?.inkIndex;

    const wrong = (ink() ?? 0) === 0 ? 1 : 0;
    instance.input.submit("choose", { index: wrong }, "keyboard");
    clock.advance(50);
    expect(stage.querySelector(".gs-mark-reason")!.textContent).toMatch(/нужно было/);

    // Обычный промежуток между пробами кончился, а разбор на месте: следующего
    // слова нет, пока участник не нажмёт.
    clock.advance(1000);
    expect(stage.querySelector(".gs-mark-reason")!.textContent).toMatch(/нужно было/);
    expect(stage.querySelector<HTMLButtonElement>(".gs-mark-next")!.hidden).toBe(false);

    stage.querySelector<HTMLButtonElement>(".gs-mark-next")!.click();
    clock.advance(50);
    expect(stage.querySelector(".gs-mark-reason")!.textContent).toBe("");
    expect(ink()).not.toBeUndefined();
    instance.stop();
  });

  it("разбор снимается клавишей ответа, а не только кнопкой", () => {
    // Обещание под знаком — «или любая клавиша ответа», и в арифметике оно не
    // работало: между пробами вариантов на сцене нет, а клавиши раздаются по их
    // числу, и все три оказывались мёртвыми ровно тогда, когда нужны.
    const { instance, stage, clock } = single("org.reconnect.arithmetic", { level: 1, seed: 5, training: true });
    clock.advance(100);
    const pending = () => (instance.state as { pending: { answer: number; options: number[] } | null }).pending;
    const trial = pending()!;
    const wrong = trial.options.findIndex((value) => value !== trial.answer);
    instance.input.submit("choose", { index: wrong }, "pointer");
    clock.advance(50);
    expect(stage.querySelector(".gs-mark-reason")!.textContent).toMatch(/нужно было/);

    // Клавиша варианта — тот же ответ участника, что и мышь, и снимать разбор
    // она обязана так же.
    expect(instance.input.handleKey("Q", "KeyQ")).toBe(true);
    clock.advance(50);
    expect(stage.querySelector(".gs-mark-reason")!.textContent).toBe("");
    expect(pending()).not.toBeNull();
    instance.stop();
  });

  it("отвернувшийся участник не останавливает прогон навсегда", () => {
    const { instance, stage, clock } = single("org.reconnect.stroop", { level: 0, training: true });
    const ink = () => (instance.state as { pending: { inkIndex: number } | null }).pending?.inkIndex;
    const wrong = (ink() ?? 0) === 0 ? 1 : 0;
    instance.input.submit("choose", { index: wrong }, "keyboard");
    clock.advance(50);
    expect(stage.querySelector(".gs-mark-reason")!.textContent).toMatch(/нужно было/);

    // Ждать разбор задача согласна долго, но не бесконечно: блок обязан кончиться
    // сам, иначе сессия висит на отвернувшемся участнике.
    clock.advance(HOLD_MS + 100);
    expect(stage.querySelector(".gs-mark-reason")!.textContent).toBe("");
    instance.stop();
  });

  it("в зачёте разбора нет", () => {
    const { instance, stage, clock } = single("org.reconnect.stroop", { level: 1, seed: 11 });
    clock.advance(100);
    instance.input.submit("choose", { index: 0 }, "keyboard");
    clock.advance(50);
    // Знак есть, слов нет: в зачёте разбор отнимал бы время у следующего стимула.
    expect(stage.querySelector(".gs-mark-reason")!.textContent).toBe("");
    expect(["✓", "✗"]).toContain(stage.querySelector(".gs-mark")!.textContent);
  });
});
