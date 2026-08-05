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
import { stroopCore, type StroopParams, type StroopState, type StroopView } from "./core.js";

const presets = asPresets(presetsJson);

export function paramsForLevel(level: number): Params {
  return presetParams(presets, level) as StroopParams;
}

/**
 * Имя цвета — в переменную темы. Так вторая тема с низким контрастом приглушает
 * чернила вместе с фоном, а ядро про пиксели по-прежнему не знает.
 */
const INK_VARIABLE: Record<string, string> = {
  красный: "--ink-red",
  синий: "--ink-blue",
  зелёный: "--ink-green",
  жёлтый: "--ink-yellow",
  фиолетовый: "--ink-purple",
  голубой: "--ink-cyan",
};

function inkColor(ink: string | null): string {
  if (!ink) return "var(--muted)";
  const variable = INK_VARIABLE[ink];
  return variable ? `var(${variable})` : "var(--text)";
}

class StroopWebView implements GameView<StroopView> {
  private readonly stimulus = new Stimulus();
  private readonly options: OptionRow;
  private readonly feedback = new FeedbackMark();

  constructor(private readonly ctx: GameContext) {
    this.options = new OptionRow(ctx.input, "choose");
    this.options.onSelect((index) => this.ctx.input.submit("choose", { index }, "pointer"));
  }

  mount(surface: Surface): void {
    surface.setTask("Выбери ЦВЕТ, которым написано слово, а не то, что написано.", "Stroop");
    surface.stage.replaceChildren(this.stimulus.root, this.options.root, this.feedback.root);
  }

  render(view: StroopView): void {
    this.stimulus.show(view.word, { color: inkColor(view.ink) });
    this.options.render(view.options.map((label, index) => ({ label, index })));
    this.ctx.input.setOptionCount(view.options.length);
    // Разбор ошибки — только в обучении: в зачёте он отнимал бы время у
    // следующего стимула и менял бы саму задачу.
    this.feedback.show(verdictOf(view.feedback), this.ctx.training ? debriefText(view.debrief) : "");
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.options.clear();
    this.stimulus.clear();
  }
}

export const stroop: Microgame<StroopState, StroopView> = {
  manifest: asManifest(manifest),
  presets,
  core: stroopCore,
  paramsForLevel,
  createView: (ctx) => new StroopWebView(ctx),
};

export { stroopCore } from "./core.js";
export type { StroopState, StroopView, StroopParams } from "./core.js";
