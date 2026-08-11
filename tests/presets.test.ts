import { describe, expect, it } from "vitest";
import {
  GameRegistry,
  GameRuntime,
  Manual,
  THREE_KEYS,
  VirtualClock,
  curvesInUse,
  freeAxes,
  headlessSurface,
  presetParams,
} from "@gamespace/core";
import { protocolGames } from "@gamespace/games";
import { ProtocolError, compileProtocol, pilotProtocol } from "@gamespace/protocol";
import { stroop } from "../packages/games/src/stroop/index.js";

function registry() {
  const r = new GameRegistry();
  for (const game of protocolGames) r.register(game);
  return r;
}

function runtime(reg = registry()) {
  const clock = new VirtualClock();
  return {
    clock,
    reg,
    runtime: new GameRuntime({
      registry: reg,
      clock,
      capabilities: ["keyboard", "pointer", "audio-output", "canvas", "webgl"],
      t0WallMs: 1_700_000_000_000,
      wallNow: () => 1_700_000_000_000 + clock.now(),
    }),
  };
}

describe("таблицы уровней как данные", () => {
  it("у каждого модуля протокола есть таблица", () => {
    for (const game of protocolGames) {
      expect(game.presets, `${game.manifest.id} без таблицы уровней`).toBeDefined();
    }
  });

  it("обучающий уровень ниже первого объявлен и легче его", () => {
    const presets = stroop.presets!;
    expect(presets.levels.min).toBe(0);
    const zero = presetParams(presets, 0);
    const first = presetParams(presets, 1);
    // Легче — это не «другое», а строго не тяжелее по каждой объявленной оси.
    expect(zero.colorCount as number).toBeLessThanOrEqual(first.colorCount as number);
    expect(zero.incongruentRate as number).toBeLessThanOrEqual(first.incongruentRate as number);
    expect(zero.deadlineMs as number).toBeGreaterThanOrEqual(first.deadlineMs as number);
  });

  it("уровень ниже минимального не выходит за таблицу", () => {
    expect(presetParams(stroop.presets!, -3)).toEqual(presetParams(stroop.presets!, 0));
  });
});

describe("закреплённая ось и степени свободы", () => {
  it("закрепление числа цветов переводит рост на другие кривые", () => {
    const presets = stroop.presets!;
    expect(curvesInUse(presets, [])).toMatchObject({ incongruentRate: "base", deadlineMs: "base" });
    expect(curvesInUse(presets, ["colorCount"])).toMatchObject({
      incongruentRate: "steep",
      deadlineMs: "steep",
    });
    // Компенсация обязана быть заметной: иначе объявлять её незачем.
    for (const level of [2, 3, 4, 5]) {
      const free = presetParams(presets, level, []);
      const frozen = presetParams(presets, level, ["colorCount"]);
      expect(frozen.deadlineMs as number).toBeLessThan(free.deadlineMs as number);
      expect(frozen.incongruentRate as number).toBeGreaterThan(free.incongruentRate as number);
    }
  });

  it("свободные оси не включают длительность блока", () => {
    const dual = protocolGames.find((g) => g.manifest.id === "org.reconnect.dual-load")!;
    expect(dual.presets!.axes.blockLength!.role).toBe("duration");
    expect(freeAxes(dual.presets!, [])).not.toContain("blockLength");
  });

  it("степени свободы доходят до журнала рядом с уровнем", () => {
    const { runtime: host, reg, clock } = runtime();
    const instance = host.mount(reg.ref("org.reconnect.stroop"), {
      surface: headlessSurface(),
      headless: true,
      seed: 5,
      policy: new Manual({ start: 1 }),
      overrides: { colorCount: 3 },
    });
    instance.start();
    clock.advance(50);
    expect(instance.difficulty.freedom()).toEqual({
      frozen: ["colorCount"],
      free: ["incongruentRate", "deadlineMs"],
    });

    instance.difficulty.setLevel(4);
    const changed = instance.log.records().filter((r) => r.type === "difficulty.changed").at(-1)!;
    expect(changed.payload).toMatchObject({ level: 4, frozen: ["colorCount"], free: ["incongruentRate", "deadlineMs"] });
    // Закреплённая ось остаётся закреплённой на всех уровнях.
    expect((changed.payload as { params: Record<string, unknown> }).params.colorCount).toBe(3);
    instance.stop();
  });
});

describe("проверки закреплений до старта сессии", () => {
  const pin = (overrides: Record<string, Record<string, number>>) => ({
    ...pilotProtocol,
    overrides: { ...pilotProtocol.overrides, ...overrides },
  });

  it("пилот с тремя клавишами компилируется", () => {
    expect(() => compileProtocol(pilotProtocol, { participantId: "p-1", registry: registry() })).not.toThrow();
  });

  it("вариантов больше, чем клавиш, — отказ до старта", () => {
    expect(() =>
      compileProtocol(pin({ "org.reconnect.stroop": { colorCount: 4 } }), {
        participantId: "p-1",
        registry: registry(),
      }),
    ).toThrow(/вариантов ответа 4, а клавиш объявлено 3/);
  });

  it("закрепление вне диапазона схемы — отказ до старта", () => {
    // Раньше overrides против parametersSchema не проверялись вовсе.
    expect(() =>
      compileProtocol(pin({ "org.reconnect.stroop": { colorCount: 2 } }), {
        participantId: "p-1",
        registry: registry(),
      }),
    ).toThrow(ProtocolError);
  });

  it("закрепление всех осей нагрузки — отказ до старта", () => {
    expect(() =>
      compileProtocol(
        pin({ "org.reconnect.stroop": { colorCount: 3, incongruentRate: 0.5, deadlineMs: 2000 } }),
        { participantId: "p-1", registry: registry() },
      ),
    ).toThrow(/уровень перестал что-либо значить/);
  });
});

describe("закрепление доходит до дочерней задачи", () => {
  it("stroop внутри батареи получает три цвета из протокола", () => {
    const reg = registry();
    const compiled = compileProtocol(pilotProtocol, { participantId: "p-1", registry: reg });
    const battery = compiled.sections.find((s) => s.id === "battery")!;
    expect(battery.overrides?.["org.reconnect.stroop"]).toEqual({ colorCount: 3 });

    const { runtime: host, clock } = runtime(reg);
    const instance = host.mount(reg.ref("org.reconnect.adaptive-battery"), {
      surface: headlessSurface(),
      headless: true,
      seed: 3,
      policy: new Manual({ start: 6 }),
      childOverrides: battery.overrides,
      // Состав и шаг смены объявлены, иначе ожидание stroop зависит от того,
      // каким по счёту его поставит перемешивание всех пяти задач.
      overrides: { tasks: "stroop,arithmetic", switchEveryMs: 5000 },
    });
    instance.start();
    // Батарея сама выбирает, какую задачу смонтировать: ждём до появления stroop.
    let child: ReturnType<typeof instance.activeInstance> | null = null;
    for (let step = 0; step < 400 && !child; step++) {
      clock.advance(250);
      const live = instance.activeInstance();
      if (live && live.ref.id === "org.reconnect.stroop") child = live;
    }
    expect(child, "stroop не появился в батарее").toBeTruthy();
    expect(child!.difficulty.params().colorCount).toBe(3);
    expect(child!.difficulty.freedom().frozen).toEqual(["colorCount"]);
    instance.stop();
  });
});
