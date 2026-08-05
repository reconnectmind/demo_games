// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GameRegistry, GameRuntime, Manual, THREE_KEYS, VirtualClock } from "@gamespace/core";
import { DomSurface, stimulusScale } from "@gamespace/ui-web";
import { protocolGames } from "@gamespace/games";
import { COLORS as STROOP_COLORS } from "../packages/games/src/stroop/core.js";

// В jsdom `import.meta.url` не файловый, поэтому пути считаются от корня пакета.
const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), "utf8");
const css = read("apps/showcase/src/styles.css");

function root(): { stage: HTMLElement; clock: VirtualClock; runtime: GameRuntime; registry: GameRegistry } {
  const registry = new GameRegistry();
  for (const game of protocolGames) registry.register(game);
  const clock = new VirtualClock();
  const runtime = new GameRuntime({
    registry,
    clock,
    capabilities: ["keyboard", "pointer", "canvas"],
    t0WallMs: 1_700_000_000_000,
    wallNow: () => 1_700_000_000_000 + clock.now(),
  });
  const stage = document.createElement("div");
  document.body.replaceChildren(stage);
  return { stage, clock, runtime, registry };
}

describe("предъявление стимулов", () => {
  it("множитель размера объявлен один раз и равен согласованному", () => {
    expect(css).toMatch(/--gs-scale:\s*1\.5;/);
  });

  it("размеры стимулов выражены множителем, а не пикселями", () => {
    // Проверяется именно отсутствие голых px у стимульных селекторов: их
    // разбросанность по стилям, виджетам и канвасам и была дефектом.
    for (const selector of [".gs-stim", ".gs-opt:hover", ".gs-cell-key", ".gs-mark ", ".gs-grid"]) {
      const start = css.indexOf(selector.trimEnd());
      expect(start, `${selector} не найден в стилях`).toBeGreaterThan(-1);
    }
    const stim = css.slice(css.indexOf(".gs-stim"), css.indexOf(".gs-cue"));
    expect(stim).toMatch(/font-size:\s*calc\(64px \* var\(--gs-scale\)\)/);
    expect(stim).not.toMatch(/font-size:\s*64px/);
  });

  it("сетка зрительного поиска задаёт число столбцов, а размер берёт из темы", () => {
    const { stage, runtime, registry, clock } = root();
    const instance = runtime.mount(registry.ref("org.reconnect.number-sequence"), {
      surface: new DomSurface({ stage }),
      seed: 4,
      policy: new Manual({ start: 1 }),
      input: THREE_KEYS,
    });
    instance.start();
    clock.advance(50);
    const grid = stage.querySelector(".gs-grid") as HTMLElement;
    expect(grid.style.getPropertyValue("--gs-grid-side")).not.toBe("");
    // px-сетки в стиле элемента больше нет: её задаёт тема через множитель.
    expect(grid.style.gridTemplateColumns).toBe("");
  });

  it("вторая тема переопределяет палитру целиком, включая чернила", () => {
    const low = css.slice(css.indexOf('[data-theme="low-contrast"]'));
    const block = low.slice(0, low.indexOf("}"));
    for (const variable of ["--bg", "--text", "--muted", "--border", "--ink-red", "--ink-green", "--ink-blue"]) {
      // Тема, не достающая до чернил, оставила бы Струп в прежнем контрасте.
      expect(block, `${variable} не переопределён во второй теме`).toMatch(new RegExp(`${variable}:`));
    }
  });

  it("ядро stroop называет цвет, а пиксель выбирает представление", () => {
    // Шестнадцатеричных цветов в ядре не осталось: цвет — дело темы.
    const core = read("packages/games/src/stroop/core.ts");
    expect(core).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(STROOP_COLORS).toContain("красный");

    const { stage, runtime, registry, clock } = root();
    const instance = runtime.mount(registry.ref("org.reconnect.stroop"), {
      surface: new DomSurface({ stage }),
      seed: 7,
      policy: new Manual({ start: 1 }),
      input: THREE_KEYS,
    });
    instance.start();
    clock.advance(50);
    const stim = stage.querySelector(".gs-stim") as HTMLElement;
    expect(stim.style.color).toMatch(/var\(--ink-(red|blue|green|yellow|purple|cyan)\)/);
  });

  it("экран участника убирает операторскую обвязку и центрирует сцену", () => {
    const rules = css.slice(css.indexOf("body.is-participant"));
    for (const hidden of [".catalog", ".side", ".port-head", ".foot"]) {
      expect(rules).toContain(`body.is-participant ${hidden}`);
    }
    expect(rules).toMatch(/body\.is-participant \.stage-wrap \{[^}]*justify-content: center/);
    expect(rules).toMatch(/body\.is-participant \.port-body \{[^}]*grid-template-columns: 1fr/);
  });

  it("без темы множитель равен единице, а не ломает безголовый прогон", () => {
    // В jsdom переменная темы не подключена: канвасы обязаны это пережить.
    expect(stimulusScale()).toBe(1);
  });
});
