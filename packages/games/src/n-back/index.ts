import { asManifest, type GameContext, type GameView, type Microgame, type Params, type Surface } from "@gamespace/core";
import { OptionRow, Stimulus, el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import { nbackCore, type NBackParams, type NBackState, type NBackView } from "./core.js";

export function paramsForLevel(level: number): Params {
  const params: NBackParams = {
    n: Math.min(4, 1 + Math.floor((level - 1) / 2)),
    stimulusMs: Math.max(500, 1600 - 90 * level),
    isiMs: Math.max(200, 500 - 25 * level),
    targetRate: 0.3,
    blockLength: Math.min(40, 18 + 2 * level),
  };
  return params;
}

class NBackWebView implements GameView<NBackView> {
  private readonly stimulus = new Stimulus();
  private readonly options: OptionRow;
  private readonly feedback = el("div", { class: "gs-feedback" });

  constructor(private readonly ctx: GameContext) {
    this.options = new OptionRow(ctx.input);
    this.options.onSelect(() => this.ctx.input.submit("match", {}, "pointer"));
  }

  mount(surface: Surface): void {
    surface.setTask("Нажми «Совпадение», если буква та же, что N шагов назад.", "N-back");
    surface.stage.replaceChildren(this.stimulus.root, this.options.root, this.feedback);
  }

  render(view: NBackView): void {
    this.stimulus.show(view.letter || (view.finished ? "✓" : "·"));
    this.options.render([{ label: `Совпадение · N = ${view.n}`, index: 0, actionId: "match" }]);
    // Действие не indexed: клавишу раздаёт хост по defaultBinding, вариантов для 1..9 нет.
    this.ctx.input.setOptionCount(0);
    this.feedback.textContent =
      view.feedback === "hit" ? "совпало" : view.feedback === "false-alarm" ? "мимо" : view.feedback === "miss" ? "пропуск" : "";
    this.feedback.className = `gs-feedback${view.feedback ? ` is-${view.feedback}` : ""}`;
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.options.clear();
    this.stimulus.clear();
  }
}

export const nback: Microgame<NBackState, NBackView> = {
  manifest: asManifest(manifest),
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
