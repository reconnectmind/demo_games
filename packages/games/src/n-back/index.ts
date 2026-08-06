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
import { FeedbackMark, OptionRow, Stimulus, debriefText, verdictOf } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import presetsJson from "./presets.json" with { type: "json" };
import { nbackCore, type NBackParams, type NBackState, type NBackView } from "./core.js";

const presets = asPresets(presetsJson);

export function paramsForLevel(level: number): Params {
  return presetParams(presets, level) as NBackParams;
}

class NBackWebView implements GameView<NBackView> {
  private readonly stimulus = new Stimulus();
  private readonly options: OptionRow;
  private readonly feedback = new FeedbackMark();

  constructor(private readonly ctx: GameContext) {
    this.options = new OptionRow(ctx.input);
    this.options.onSelect(() => this.ctx.input.submit("match", {}, "pointer"));
  }

  mount(surface: Surface): void {
    surface.setTask("Нажми «Совпадение», если буква та же, что N шагов назад.", "N-back");
    surface.stage.replaceChildren(this.stimulus.root, this.options.root, this.feedback.root);
  }

  render(view: NBackView): void {
    this.stimulus.show(view.letter || (view.finished ? "✓" : "·"));
    this.options.render([{ label: `Совпадение · N = ${view.n}`, index: 0, actionId: "match" }]);
    // Действие не indexed: клавишу раздаёт хост по defaultBinding, вариантов для 1..9 нет.
    this.ctx.input.setOptionCount(0);
    this.feedback.show(
      verdictOf(view.feedback),
      this.ctx.training ? debriefText(view.debrief) : "",
      view.holding ? () => this.ctx.input.submit("match", {}, "pointer") : null,
    );
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.options.clear();
    this.stimulus.clear();
  }
}

export const nback: Microgame<NBackState, NBackView> = {
  manifest: asManifest(manifest),
  presets,
  core: nbackCore,
  paramsForLevel,
  createView: (ctx) => new NBackWebView(ctx),
};

export {
  NBACK_LETTERS,
  NB_ISI,
  NB_STIM,
  buildNBackStream,
  isTargetTrial,
  nbackAccuracy,
  nbackCore,
  nbackSummary,
  nbackView,
} from "./core.js";

export type { NBackFeedback, NBackParams, NBackState, NBackStream, NBackSummary, NBackView } from "./core.js";
