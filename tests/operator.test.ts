import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GameRegistry, GameRuntime, Manual, THREE_KEYS, VirtualClock, headlessSurface, type LoggedEvent, MemorySink } from "@gamespace/core";
import { protocolGames } from "@gamespace/games";

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), "utf8");

function battery(switchEveryMs: number) {
  const registry = new GameRegistry();
  for (const game of protocolGames) registry.register(game);
  const clock = new VirtualClock();
  const sink = new MemorySink();
  const runtime = new GameRuntime({
    registry,
    clock,
    sink,
    capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
    t0WallMs: 1_700_000_000_000,
    wallNow: () => 1_700_000_000_000 + clock.now(),
  });
  const instance = runtime.mount(registry.ref("org.reconnect.adaptive-battery"), {
    surface: headlessSurface(),
    headless: true,
    seed: 9,
    policy: new Manual({ start: 1 }),
    input: THREE_KEYS,
    overrides: { switchEveryMs, blocks: 4, restMs: 500 },
  });
  instance.start();
  return { instance, clock, sink };
}

const blockStarts = (sink: MemorySink): LoggedEvent[] =>
  sink.records.filter((r) => r.type === "block.start" && (r.payload as { task?: string }).task !== undefined);

describe("шаг смены задач в батарее", () => {
  it("без шага темп задаёт ребёнок: за минуту смены не происходит", () => {
    const { clock, sink } = battery(0);
    clock.advance(60_000);
    // Блок stroop на первом уровне длиннее минуты, поэтому смена одна — начальная.
    expect(blockStarts(sink)).toHaveLength(1);
  });

  it("объявленный шаг задаёт частоту смен, а не длина блока ребёнка", () => {
    const step = 12_000;
    const { clock, sink } = battery(step);
    clock.advance(step * 3 + 3_000);
    const starts = blockStarts(sink);
    // Четыре блока по двенадцать секунд: за это время сменились все, а не один.
    expect(starts.length).toBeGreaterThanOrEqual(3);
    const forced = sink.records.filter((r) => r.type === "switch.forced");
    expect(forced.length).toBeGreaterThanOrEqual(2);
  });

  it("смена закрывает блок ребёнка, а не обрывает его", () => {
    const { clock, sink } = battery(10_000);
    clock.advance(25_000);
    // Тот же путь, которым блок закрывает протокол: у ребёнка есть свой block.end,
    // а у батареи — свой. Обрыв дал бы блок без конца и без сводки.
    const childEnds = sink.records.filter((r) => r.type === "block.end" && (r.payload as { slot?: string }).slot);
    expect(childEnds.length).toBeGreaterThanOrEqual(1);
    const batteryEnds = sink.records.filter(
      (r) => r.type === "block.end" && !(r.payload as { slot?: string }).slot,
    );
    expect(batteryEnds.length).toBeGreaterThanOrEqual(1);
  });

  it("шаг объявлен параметром модуля, а не спрятан в коде", () => {
    const manifest = JSON.parse(read("packages/games/src/adaptive-battery/manifest.json"));
    const props = manifest.parametersSchema.schema.properties;
    expect(props.switchEveryMs).toBeTruthy();
    // Темп смены — расписание, а не сложность: в монотонных осях его нет.
    const axes = manifest.levels.monotonicAxes.map((a: { param: string }) => a.param);
    expect(axes).not.toContain("switchEveryMs");
    const presets = JSON.parse(read("packages/games/src/adaptive-battery/presets.json"));
    expect(presets.axes.switchEveryMs.role).toBe("duration");
  });
});

describe("ручки оператора вне экрана участника", () => {
  const main = read("apps/showcase/src/main.ts");
  const css = read("apps/showcase/src/styles.css");

  it("панель и управление прогоном переезжают в отдельное окно одним узлом", () => {
    // Именно переезд, а не копия: копия развела бы состояние двух панелей.
    expect(main).toMatch(/adoptNode\(ops\)/);
    expect(main).toMatch(/adoptNode\(panel\)/);
    expect(main).toMatch(/gamespace-operator/);
  });

  it("закрытие окна оператора возвращает ручки на место", () => {
    const block = main.slice(main.indexOf('opened.addEventListener("beforeunload"'));
    expect(block).toMatch(/port-head[\s\S]{0,200}adoptNode\(ops\)/);
    expect(block).toMatch(/port-body[\s\S]{0,200}adoptNode\(panel\)/);
    expect(block).toMatch(/setParticipantView\(false\)/);
  });

  it("выбор политики, уровень и параметры лежат в панели, а не рядом со сценой", () => {
    const side = main.slice(main.indexOf('<div class="side"'), main.indexOf('<div class="foot"'));
    for (const id of ['id="policy"', 'id="level"', 'id="params"', 'id="schedule"']) {
      expect(side, `${id} должен быть в операторской панели`).toContain(id);
    }
    const stageWrap = main.slice(main.indexOf('<div class="stage-wrap">'), main.indexOf('<div class="side"'));
    for (const id of ['id="policy"', 'id="level"']) {
      expect(stageWrap).not.toContain(id);
    }
  });

  it("после переезда пустой колонки под панель не остаётся", () => {
    expect(css).toMatch(/body\.is-detached \.port-body \{[^}]*grid-template-columns: 1fr/);
  });
});
