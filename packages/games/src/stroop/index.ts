import { asManifest, type GameContext, type GameView, type Microgame, type Params, type Surface } from "@gamespace/core";
import { OptionRow, Stimulus, el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import { stroopCore, type StroopParams, type StroopState, type StroopView } from "./core.js";

export function paramsForLevel(level: number): Params {
  const params: StroopParams = {
    colorCount: Math.min(6, 3 + Math.floor(level / 2)),
    incongruentRate: Math.min(0.9, 0.5 + 0.05 * level),
    deadlineMs: Math.max(900, 2600 - 180 * level),
    blockLength: 20,
  };
  return params;
}

class StroopWebView implements GameView<StroopView> {
  private readonly stimulus = new Stimulus();
  private readonly options: OptionRow;
  private readonly feedback = el("div", { class: "gs-feedback" });

  constructor(private readonly ctx: GameContext) {
    this.options = new OptionRow(ctx.input, "choose");
    this.options.onSelect((index) => this.ctx.input.submit("choose", { index }, "pointer"));
  }

  mount(surface: Surface): void {
    surface.setTask("Выбери ЦВЕТ, которым написано слово, а не то, что написано.", "Stroop");
    surface.stage.replaceChildren(this.stimulus.root, this.options.root, this.feedback);
  }

  render(view: StroopView): void {
    this.stimulus.show(view.word, { color: view.inkHex });
    this.options.render(view.options.map((label, index) => ({ label, index })));
    this.ctx.input.setOptionCount(view.options.length);
    this.feedback.textContent =
      view.feedback === "correct" ? "верно" : view.feedback === "wrong" ? "мимо" : view.feedback === "timeout" ? "не успел" : "";
    this.feedback.className = `gs-feedback${view.feedback ? ` is-${view.feedback}` : ""}`;
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.options.clear();
    this.stimulus.clear();
  }
}

export const stroop: Microgame<StroopState, StroopView> = {
  manifest: asManifest(manifest),
  core: stroopCore,
  paramsForLevel,
  createView: (ctx) => new StroopWebView(ctx),
};

export { stroopCore } from "./core.js";
export type { StroopState, StroopView, StroopParams } from "./core.js";
