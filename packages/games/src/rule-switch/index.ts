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
import { FeedbackMark, OptionRow, Stimulus, debriefText, el, verdictOf } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import presetsJson from "./presets.json" with { type: "json" };
import { ruleSwitchCore, type RuleSwitchParams, type RuleSwitchState, type RuleSwitchView } from "./core.js";

const presets = asPresets(presetsJson);

export function paramsForLevel(level: number): Params {
  return presetParams(presets, level) as RuleSwitchParams;
}

class RuleSwitchWebView implements GameView<RuleSwitchView> {
  private readonly cue = el("div", { class: "gs-cue" });
  private readonly stimulus = new Stimulus();
  private readonly options: OptionRow;
  private readonly feedback = new FeedbackMark();

  constructor(private readonly ctx: GameContext) {
    this.options = new OptionRow(ctx.input, "choose");
    this.options.onSelect((index) => this.ctx.input.submit("choose", { index }, "pointer"));
  }

  mount(surface: Surface): void {
    surface.setTask("Классифицируй число по текущему правилу. Правило меняется без предупреждения.", "Смена правила");
    surface.stage.replaceChildren(this.cue, this.stimulus.root, this.options.root, this.feedback.root);
  }

  render(view: RuleSwitchView): void {
    this.cue.textContent = view.cue;
    this.cue.className = `gs-cue${view.switched ? " is-switched" : ""}`;
    this.stimulus.show(view.stimulus);
    this.options.render(view.options.map((label, index) => ({ label, index })));
    this.ctx.input.setOptionCount(view.options.length);
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
    this.options.clear();
    this.stimulus.clear();
  }
}

export const ruleSwitch: Microgame<RuleSwitchState, RuleSwitchView> = {
  manifest: asManifest(manifest),
  presets,
  core: ruleSwitchCore,
  paramsForLevel,
  createView: (ctx) => new RuleSwitchWebView(ctx),
};

export { ruleSwitchCore } from "./core.js";
export type { RuleSwitchState, RuleSwitchView, RuleSwitchParams } from "./core.js";
