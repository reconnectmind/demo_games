// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { GameRegistry, GameRuntime, INDEX_KEYS, LETTER_INDEX_KEYS, Manual, VirtualClock } from "@gamespace/core";
import { DomSurface, keyLabel } from "@gamespace/ui-web";
import { protocolGames } from "@gamespace/games";
import { race } from "@gamespace/race";

const games = [...protocolGames, race];

/** Оркестраторы своих кнопок не рисуют: их проверяют дочерние модули. */
const interactive = games.filter((game) => game.manifest.interaction.actions.length > 0);

// jsdom не умеет 2d-контекст и шумит в stderr; канвас в этих тестах не рисуется.
HTMLCanvasElement.prototype.getContext = () => null;

function mount(id: string, level = 1) {
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
          const hint = button.querySelector("kbd")?.textContent ?? "";
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
        const hint = kbd.textContent ?? "";
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
    instance.input.handleKey(cells[last]!.querySelector("kbd")!.textContent!);
    expect(picks).toEqual([last]);
    instance.stop();
  });
});
