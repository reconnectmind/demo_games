import { asManifest, type GameContext, type GameView, type Microgame, type Params, type Surface } from "@gamespace/core";
import { OptionRow, Stimulus, el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import { ruleSwitchCore, type RuleSwitchParams, type RuleSwitchState, type RuleSwitchView } from "./core.js";

export function paramsForLevel(level: number): Params {
  const params: RuleSwitchParams = {
    ruleCount: level >= 5 ? 3 : 2,
    switchRate: Math.min(0.85, 0.4 + 0.05 * level),
    deadlineMs: Math.max(900, 2600 - 170 * level),
    cueLeadMs: Math.max(150, 800 - 70 * level),
    blockLength: 24,
  };
  return params;
}

class RuleSwitchWebView implements GameView<RuleSwitchView> {
  private readonly cue = el("div", { class: "gs-cue" });
  private readonly stimulus = new Stimulus();
  private readonly options: OptionRow;
  private readonly feedback = el("div", { class: "gs-feedback" });

  constructor(private readonly ctx: GameContext) {
    this.options = new OptionRow(ctx.input, "choose");
    this.options.onSelect((index) => this.ctx.input.submit("choose", { index }, "pointer"));
  }

  mount(surface: Surface): void {
    surface.setTask("Классифицируй число по текущему правилу. Правило меняется без предупреждения.", "Смена правила");
    surface.stage.replaceChildren(this.cue, this.stimulus.root, this.options.root, this.feedback);
  }

  render(view: RuleSwitchView): void {
    this.cue.textContent = view.cue;
    this.cue.className = `gs-cue${view.switched ? " is-switched" : ""}`;
    this.stimulus.show(view.stimulus);
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

export const ruleSwitch: Microgame<RuleSwitchState, RuleSwitchView> = {
  manifest: asManifest(manifest),
  core: ruleSwitchCore,
  paramsForLevel,
  createView: (ctx) => new RuleSwitchWebView(ctx),
};

export { ruleSwitchCore } from "./core.js";
export type { RuleSwitchState, RuleSwitchView, RuleSwitchParams } from "./core.js";
