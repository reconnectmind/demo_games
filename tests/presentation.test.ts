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
    for (const hidden of [".side", ".port-head", ".foot"]) {
      expect(rules).toContain(`body.is-participant ${hidden}`);
    }
    expect(rules).toMatch(/body\.is-participant \.stage-wrap \{[^}]*justify-content: center/);
    expect(rules).toMatch(/body\.is-participant \.port-body \{[^}]*grid-template-columns: 1fr/);
  });

  it("`hidden` выключает элемент при любом правиле класса", () => {
    // Правило класса с `display` сильнее браузерного стиля для `hidden`. Из-за
    // этого отбивка висела над сценой с текстом прошлого экрана и мёртвой
    // кнопкой, а экран настройки оставался поверх сессии участника.
    const style = document.createElement("style");
    style.textContent = css;
    document.head.replaceChildren(style);
    try {
      for (const className of ["interstitial", "setup", "debrief", "port"]) {
        const box = document.createElement("div");
        box.className = className;
        document.body.replaceChildren(box);
        expect(getComputedStyle(box).display, `.${className} без hidden`).not.toBe("none");
        box.hidden = true;
        expect(getComputedStyle(box).display, `.${className} с hidden`).toBe("none");
      }
    } finally {
      // Стили подключены только на время проверки: иначе тема протекла бы в
      // соседние тесты, которые считают её отсутствующей.
      style.remove();
    }
  });

  it("на покое с крестиком не остаётся ни текста, ни напоминания", () => {
    // Любая строка рядом с точкой фиксации читается, а чтение — это задача:
    // инструкцию участник получает до блока, на отбивке.
    const { stage, runtime, registry, clock } = root();
    const reminder = document.createElement("div");
    document.body.append(reminder);
    const instance = runtime.mount(registry.ref("org.reconnect.baseline"), {
      surface: new DomSurface({ stage, reminder }),
      seed: 1,
      policy: new Manual({ start: 1 }),
      overrides: { durationMs: 60_000, showTimer: false, text: "Сидите спокойно", fixation: true },
    });
    instance.start();
    clock.advance(600);
    expect((stage.querySelector(".gs-baseline-fixation") as HTMLElement).style.display).not.toBe("none");
    expect(stage.querySelector(".gs-baseline-text")!.textContent).toBe("");
    expect(reminder.textContent).toBe("");
    instance.stop();
  });

  it("перерыв без крестика, наоборот, объясняет себя словами", () => {
    const { stage, runtime, registry, clock } = root();
    const reminder = document.createElement("div");
    document.body.append(reminder);
    const instance = runtime.mount(registry.ref("org.reconnect.baseline"), {
      surface: new DomSurface({ stage, reminder }),
      seed: 1,
      policy: new Manual({ start: 1 }),
      overrides: { durationMs: 60_000, showTimer: true, text: "Перерыв: можно отвести глаза", fixation: false },
    });
    instance.start();
    clock.advance(600);
    expect(stage.querySelector(".gs-baseline-text")!.textContent).toBe("Перерыв: можно отвести глаза");
    expect((stage.querySelector(".gs-baseline-fixation") as HTMLElement).style.display).toBe("none");
    expect(reminder.textContent).not.toBe("");
    instance.stop();
  });

  it("место под знак ответа занято всегда и тем же размером, что и знак", () => {
    // Строка в 26 px не вмещала знак в 30 px, и каждая проба дёргала сцену:
    // стимул подпрыгивал ровно в момент, когда участник смотрит на него.
    const feedback = css.slice(css.indexOf(".gs-feedback"));
    expect(feedback.slice(0, feedback.indexOf("}"))).toMatch(
      /min-height:\s*calc\(26px \* var\(--gs-scale\)\)/,
    );
    const mark = css.slice(css.indexOf(".gs-mark {"));
    const block = mark.slice(0, mark.indexOf("}"));
    expect(block).toMatch(/min-height:\s*1\.2em/);
    expect(block).toMatch(/display:\s*inline-block/);
  });

  it("пауза между пробами не убирает со сцены ни строку стимула, ни ряд вариантов", () => {
    // Настоящая причина «прыгающего» текста была не в знаке, а в том, что на
    // треть секунды исчезали и пример, и кнопки: центрированная сцена
    // схлопывалась и весь текст уезжал вверх.
    const { stage, runtime, registry, clock } = root();
    const instance = runtime.mount(registry.ref("org.reconnect.arithmetic"), {
      surface: new DomSurface({ stage }),
      seed: 3,
      policy: new Manual({ start: 1 }),
      input: THREE_KEYS,
    });
    instance.start();
    clock.advance(50);
    const stim = stage.querySelector(".gs-stim") as HTMLElement;
    const options = stage.querySelector(".gs-options") as HTMLElement;
    const shown = options.childElementCount;
    expect(shown).toBeGreaterThan(0);
    expect(stim.textContent).not.toBe("");

    (options.firstElementChild as HTMLButtonElement).click();
    // Проба ответена: пример и варианты сняты с показа, но место осталось за ними.
    expect(options.childElementCount, "кнопки исчезли, и ряд схлопнулся").toBe(shown);
    expect(options.style.visibility).toBe("hidden");
    expect(stim.textContent, "строка стимула осталась без строки текста").not.toBe("");
    instance.stop();
  });

  it("разбор ошибки висит под знаком и не двигает сцену", () => {
    // Строка разбора занимает от одной строки до трёх, и в потоке эта разница
    // поднимала сцену вверх ровно в тот момент, когда участник смотрит на свою
    // ошибку. Поэтому разбор вынесен из потока под знак.
    const { stage, runtime, registry, clock } = root();
    const instance = runtime.mount(registry.ref("org.reconnect.stroop"), {
      surface: new DomSurface({ stage }),
      seed: 11,
      policy: new Manual({ start: 0 }),
      input: THREE_KEYS,
      training: true,
    });
    instance.start();
    clock.advance(100);
    const aside = stage.querySelector(".gs-feedback-aside") as HTMLElement;
    expect(aside, "разбор лежит отдельным слоем, а не в строке знака").toBeTruthy();
    expect(aside.querySelector(".gs-mark-reason")).toBeTruthy();
    expect(aside.querySelector(".gs-mark-next")).toBeTruthy();
    // Знак остаётся единственным, что занимает место в строке.
    expect([...(stage.querySelector(".gs-feedback") as HTMLElement).children].map((c) => c.className)).toEqual([
      "gs-mark",
      "gs-feedback-aside",
    ]);
    instance.stop();

    const row = css.slice(css.indexOf(".gs-feedback {"));
    expect(row.slice(0, row.indexOf("}"))).toMatch(/position:\s*relative/);
    const layer = css.slice(css.indexOf(".gs-feedback-aside {"));
    expect(layer.slice(0, layer.indexOf("}"))).toMatch(/position:\s*absolute/);
  });

  it("крестик фиксации стоит в середине сцены", () => {
    // Сцена растягивает детей на всю ширину, поэтому выравнивание обязательно.
    const fixation = css.slice(css.indexOf(".gs-baseline-fixation"));
    expect(fixation.slice(0, fixation.indexOf("}"))).toMatch(/text-align:\s*center/);
  });

  it("без темы множитель равен единице, а не ломает безголовый прогон", () => {
    // В jsdom переменная темы не подключена: канвасы обязаны это пережить.
    expect(stimulusScale()).toBe(1);
  });
});
