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
    // Состав объявлен, чтобы проверялся именно шаг смены: без него в блоке идут
    // все пять задач, и порядок решает, чей блок попадёт в окно измерения.
    overrides: { switchEveryMs, blocks: 4, restMs: 500, tasks: "arithmetic" },
  });
  instance.start();
  return { instance, clock, sink };
}

const blockStarts = (sink: MemorySink): LoggedEvent[] =>
  sink.records.filter((r) => r.type === "block.start" && (r.payload as { task?: string }).task !== undefined);

describe("шаг смены задач в батарее", () => {
  it("без шага темп задаёт ребёнок: за минуту смены не происходит", () => {
    const { clock, sink } = battery(0);
    clock.advance(55_000);
    // Спринт длится минуту, поэтому за это время смена одна — начальная.
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

describe("экран настройки до старта, экран участника после", () => {
  const main = read("apps/showcase/src/main.ts");
  const css = read("apps/showcase/src/styles.css");
  const markup = main.slice(main.indexOf("app.innerHTML"), main.indexOf("const $ ="));
  const between = (from: string, to: string): string => markup.slice(markup.indexOf(from), markup.indexOf(to));

  it("витрина состоит из трёх экранов, а не одного с флажками", () => {
    for (const id of ['id="setup"', 'id="run"', 'id="debrief"']) expect(markup).toContain(id);
    // Экран выбирается один: два одновременно означали бы ручки поверх сессии.
    expect(main).toMatch(/for \(const id of \["setup", "run", "debrief"\] as const\)/);
  });

  it("всё, что выбирает оператор, лежит на экране настройки", () => {
    const setup = between('<section class="setup"', '<main class="port"');
    for (const id of [
      'id="participant"',
      'id="scenario"',
      'id="pace"',
      'id="compress"',
      'id="theme"',
      'id="schedule"',
      'id="policy"',
      'id="level"',
      'id="params"',
    ]) {
      expect(setup, `${id} должен быть на экране настройки`).toContain(id);
    }
  });

  it("на экране прогона операторских ручек нет", () => {
    const run = between('<main class="port"', '<section class="debrief"');
    for (const id of ['id="participant"', 'id="compress"', 'id="theme"', 'id="scenario"', 'id="pace"']) {
      expect(run, `${id} не должен жить на экране прогона`).not.toContain(id);
    }
    // Отдельного окна оператора больше нет: экран участника — это состояние
    // витрины, а не панель, спрятанная за флагом.
    expect(main).not.toMatch(/gamespace-operator|adoptNode/);
  });

  it("сессия участника прячет шапку, панель и подвал целиком", () => {
    const rules = css.slice(css.indexOf("body.is-participant"));
    for (const hidden of [".side", ".port-head", ".foot", "#banner"]) {
      expect(rules).toContain(`body.is-participant ${hidden}`);
    }
    expect(rules).toMatch(/body\.is-participant \.stage-wrap \{[^}]*justify-content: center/);
  });

  it("выгрузка журнала ждёт конца сессии на отдельном экране", () => {
    const debrief = markup.slice(markup.indexOf('<section class="debrief"'));
    for (const id of ['id="exportJsonl"', 'id="exportCsv"', 'id="exportMarkers"', 'id="exportCodebook"']) {
      expect(debrief, `${id} должен быть в сводке`).toContain(id);
    }
    // Escape открывает сводку только после конца сессии: во время прогона у
    // участника руки на клавиатуре.
    expect(main).toMatch(/event\.key === "Escape" && finished/);
  });

  it("ручки сложности переезжают на отладочный прогон одним узлом", () => {
    // Отладке они нужны живыми, но второй копии, расходящейся по состоянию, нет.
    expect(main).toMatch(/\$\("side"\)\.prepend\(\$\("setupDifficulty"\)\)/);
    expect(main).toMatch(/\$\("setupAside"\)\.append\(\$\("setupDifficulty"\)\)/);
  });
});
