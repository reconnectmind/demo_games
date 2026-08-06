import {
  asManifest,
  asPresets,
  presetParams,
  type GameContext,
  type GameView,
  type Microgame,
  type Params,
  type Surface,
} from "@gamespace/core";
import { CellGrid, FeedbackMark, debriefText, verdictOf } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import presetsJson from "./presets.json" with { type: "json" };
import {
  numberSequenceCore,
  type NumberSequenceParams,
  type NumberSequenceState,
  type NumberSequenceView,
} from "./core.js";

const presets = asPresets(presetsJson);

export function paramsForLevel(level: number): Params {
  return presetParams(presets, level) as NumberSequenceParams;
}

class NumberSequenceWebView implements GameView<NumberSequenceView> {
  private readonly grid: CellGrid;
  private readonly feedback = new FeedbackMark();

  constructor(private readonly ctx: GameContext) {
    this.grid = new CellGrid(ctx.input, "choose");
    this.grid.onSelect((index) => this.ctx.input.submit("choose", { index }, "pointer"));
  }

  mount(surface: Surface): void {
    surface.setTask(
      "Нажимай числа по возрастанию: 1, 2, 3 и дальше по порядку. Клавиши подписаны на ячейках, остальные — мышью.",
      "Числа по порядку",
    );
    surface.stage.replaceChildren(this.grid.root, this.feedback.root);
  }

  render(view: NumberSequenceView): void {
    this.grid.render(
      view.side,
      view.cells.map((cell) => ({ index: cell.index, label: cell.label, state: cell.state })),
    );
    this.ctx.input.setOptionCount(view.cells.length);
    // Разбор ошибки — только в обучении: в зачёте он отнимал бы время у
    // следующего стимула и менял бы саму задачу.
    this.feedback.show(
      verdictOf(view.feedback),
      this.ctx.training ? debriefText(view.debrief) : "",
      view.holding ? () => this.ctx.input.submit("choose", { index: -1 }, "pointer") : null,
    );
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.grid.render(1, []);
  }
}

export const numberSequence: Microgame<NumberSequenceState, NumberSequenceView> = {
  manifest: asManifest(manifest),
  presets,
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

