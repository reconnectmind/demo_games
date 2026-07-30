import { asManifest, type GameContext, type GameView, type Microgame, type Params, type Surface } from "@gamespace/core";
import { CellGrid, el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import {
  numberSequenceCore,
  type NumberSequenceParams,
  type NumberSequenceState,
  type NumberSequenceView,
} from "./core.js";

export function paramsForLevel(level: number): Params {
  const params: NumberSequenceParams = {
    gridCells: Math.min(36, 9 + 3 * level),
    sequenceLength: Math.min(25, 5 + 2 * level),
    deadlineMs: Math.max(1500, 6000 - 450 * level),
    reshuffleAfterEach: level >= 5,
  };
  return params;
}

class NumberSequenceWebView implements GameView<NumberSequenceView> {
  private readonly grid: CellGrid;
  private readonly feedback = el("div", { class: "gs-feedback" });

  constructor(private readonly ctx: GameContext) {
    this.grid = new CellGrid(ctx.input, "choose");
    this.grid.onSelect((index) => this.ctx.input.submit("choose", { index }, "pointer"));
  }

  mount(surface: Surface): void {
    surface.setTask(
      "Нажимай числа по возрастанию: 1, 2, 3 и дальше по порядку. Клавиши подписаны на ячейках, остальные — мышью.",
      "Числа по порядку",
    );
    surface.stage.replaceChildren(this.grid.root, this.feedback);
  }

  render(view: NumberSequenceView): void {
    this.grid.render(
      view.side,
      view.cells.map((cell) => ({ index: cell.index, label: cell.label, state: cell.state })),
    );
    this.ctx.input.setOptionCount(view.cells.length);
    this.feedback.textContent =
      view.feedback === "wrong" ? "не то число" : view.feedback === "timeout" ? "не успел" : "";
    this.feedback.className = `gs-feedback${view.feedback && view.feedback !== "correct" ? ` is-${view.feedback}` : ""}`;
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.grid.render(1, []);
  }
}

export const numberSequence: Microgame<NumberSequenceState, NumberSequenceView> = {
  manifest: asManifest(manifest),
  core: numberSequenceCore,
  paramsForLevel,
  createView: (ctx) => new NumberSequenceWebView(ctx),
};

export { numberSequenceCore } from "./core.js";
export type {
  NumberSequenceState,
  NumberSequenceView,
  NumberSequenceParams,
  NumberSequenceCell,
} from "./core.js";
