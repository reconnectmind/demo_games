// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  GameRegistry,
  GameRuntime,
  INDEX_KEYS,
  LETTER_INDEX_KEYS,
  Manual,
  THREE_KEYS,
  VirtualClock,
  type InputProfile,
} from "@gamespace/core";
import { DomSurface, keyLabel } from "@gamespace/ui-web";
import { protocolGames } from "@gamespace/games";
import { race } from "@gamespace/race";

const games = [...protocolGames, race];

/** Оркестраторы своих кнопок не рисуют: их проверяют дочерние модули. */
const interactive = games.filter((game) => game.manifest.interaction.actions.length > 0);

// jsdom не умеет 2d-контекст и шумит в stderr; канвас в этих тестах не рисуется.
HTMLCanvasElement.prototype.getContext = () => null;

/** Что написано на клавише: латинская буква, без второй подписи русской раскладки. */
function cap(node: Element | null | undefined): string {
  return node?.querySelector(".gs-key-main")?.textContent ?? node?.textContent ?? "";
}

function mount(id: string, level = 1, input?: InputProfile) {
  const registry = new GameRegistry();
  for (const game of games) registry.register(game);
  const clock = new VirtualClock();
  const runtime = new GameRuntime({
    registry,
    clock,
    capabilities: ["keyboard", "pointer", "audio-output", "canvas", "webgl"],
    t0WallMs: 1_700_000_000_000,
    wallNow: () => 1_700_000_000_000 + clock.now(),
  });
  const stage = document.createElement("div");
  document.body.replaceChildren(stage);
  const instance = runtime.mount(registry.ref(id), {
    surface: new DomSurface({ stage }),
    seed: 7,
    policy: new Manual({ start: level }),
    ...(input ? { input } : {}),
  });
  instance.start();
  clock.advance(200);
  return { instance, clock, stage };
}

describe("подписи клавиш на кнопках", () => {
  for (const game of interactive) {
    const id = game.manifest.id;
    // Крупные поля появляются только на верхних уровнях: там и ловятся ячейки без клавиш.
    const levels = game.manifest.levels.count;

    for (const level of [1, levels]) {
      it(`${id}: уровень ${level} — у каждой кнопки есть подпись клавиши`, () => {
        const { stage, instance } = mount(id, level);
        const buttons = [...stage.querySelectorAll("button")];
        expect(buttons.length).toBeGreaterThan(0);

        for (const button of buttons) {
          const hint = cap(button.querySelector("kbd"));
          expect(hint, `${id}: кнопка «${button.textContent}» без подсказки`).not.toBe("");
        }
        instance.stop();
      });
    }

    it(`${id}: подпись совпадает с реальной привязкой действия`, () => {
      const { stage, instance } = mount(id, levels);
      const bindings = new Map(instance.input.bindings().map((b) => [keyLabel(b.binding), b.id]));
      const indexKeys = new Set<string>([...INDEX_KEYS, ...LETTER_INDEX_KEYS]);

      const seen = new Set<string>();
      for (const kbd of stage.querySelectorAll("kbd")) {
        const hint = cap(kbd);
        expect(indexKeys.has(hint) || bindings.has(hint), `${id}: подпись «${hint}» ничему не соответствует`).toBe(true);
        expect(seen.has(hint), `${id}: подпись «${hint}» повторяется на двух кнопках`).toBe(false);
        seen.add(hint);
      }
      instance.stop();
    });
  }

  it("клавиша с подсказки адресует именно свою ячейку большого поля", () => {
    const { stage, instance } = mount("org.reconnect.number-sequence", 8);
    const cells = [...stage.querySelectorAll("button")];
    // Поле верхнего уровня заведомо больше цифрового ряда: там и жил баг.
    expect(cells.length).toBeGreaterThan(10);

    const picks: number[] = [];
    instance.input.on("choose", (event) => {
      if (event.source === "keyboard" && typeof event.payload.index === "number") picks.push(event.payload.index);
    });

    const last = cells.length - 1;
    instance.input.handleKey(cap(cells[last]!.querySelector("kbd")));
    expect(picks).toEqual([last]);
    instance.stop();
  });
});

/**
 * Ёмкость ответа объявляет протокол, и это утверждение проверяемо: при трёх
 * объявленных клавишах ни один модуль не должен отвечать четвёртой. Смена
 * способа ответа стоит внимания, и падение точности на ней неотличимо от
 * падения на самой задаче — то есть это порча данных, а не неудобство.
 */
describe("объявленная ёмкость ответа", () => {
  const keyed = new Set(THREE_KEYS.keys);

  for (const game of interactive) {
    const id = game.manifest.id;
    const addressedBy = game.manifest.responseAlternatives?.addressedBy;

    it(`${id}: живые привязки лежат внутри объявленного набора`, () => {
      const { instance } = mount(id, game.manifest.levels.count, THREE_KEYS);
      for (const binding of instance.input.bindings()) {
        // Пустая привязка законна: в этом профиле действие клавиши не получило.
        if (binding.binding === "") continue;
        expect(keyed.has(binding.binding), `${id}: ${binding.id} отвечает клавишей ${binding.binding}`).toBe(true);
      }
      instance.stop();
    });

    it(`${id}: подписей клавиш не больше объявленной ёмкости`, () => {
      const { stage, instance } = mount(id, game.manifest.levels.count, THREE_KEYS);
      const caps = [...stage.querySelectorAll("kbd")].map(cap).filter((text) => text !== "");
      if (addressedBy === "pointer") {
        // Зрительный поиск адресуется мышью: тремя клавишами 36 ячеек не подписать,
        // и подписывать их наполовину хуже, чем не подписывать вовсе.
        expect(caps).toEqual([]);
      } else {
        expect(caps.length).toBeLessThanOrEqual(THREE_KEYS.keys.length);
        for (const text of caps) expect(keyed.has(text), `${id}: подпись «${text}» вне набора`).toBe(true);
      }
      instance.stop();
    });
  }

  it("текстового ввода в объявленной ёмкости нет", () => {
    const { stage, instance } = mount("org.reconnect.arithmetic", 1, THREE_KEYS);
    const entry = stage.querySelector<HTMLElement>(".gs-entry");
    expect(entry?.style.display).toBe("none");
    instance.stop();
  });

  it("свободная сборка сохраняет привязки манифеста", () => {
    // Витрина и одиночные запуски не обязаны знать про ёмкость протокола.
    const { instance } = mount("org.reconnect.dual-load", 1);
    expect(instance.input.bindings().map((b) => b.binding)).toEqual(["Space", "J"]);
    instance.stop();
  });
});
