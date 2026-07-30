import { asManifest, type GameContext, type GameView, type Microgame, type Params, type Surface } from "@gamespace/core";
import { ActionButton, OptionRow, Stimulus, el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import { arithmeticCore, type ArithmeticParams, type ArithmeticState, type ArithmeticView } from "./core.js";

export function paramsForLevel(level: number): Params {
  const params: ArithmeticParams = {
    operandMax: 8 + 4 * level,
    operations: level >= 3 ? 3 : 2,
    operationSteps: level >= 6 ? 2 : 1,
    distractorDistance: Math.max(1, 6 - Math.floor(level / 2)),
    optionCount: 4,
    responseMode: "selection",
    timeLimitMs: 60_000,
  };
  return params;
}

class ArithmeticWebView implements GameView<ArithmeticView> {
  private readonly stimulus = new Stimulus();
  private readonly options: OptionRow;
  private readonly entry = el("div", { class: "gs-entry" });
  private readonly field = el("input", {
    class: "gs-entry-input",
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
    placeholder: "введи ответ",
  });
  private readonly button: ActionButton;
  private readonly feedback = el("div", { class: "gs-feedback" });

  constructor(private readonly ctx: GameContext) {
    this.options = new OptionRow(ctx.input, "choose");
    this.button = new ActionButton(ctx.input, "submit", "Ответить");
    this.options.onSelect((index) => this.ctx.input.submit("choose", { index }, "pointer"));
    this.button.onClick(() => this.send());
    this.field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.send();
    });
    this.entry.append(this.field, this.button.root);
  }

  private send(): void {
    const value = this.field.value.trim();
    this.field.value = "";
    this.ctx.input.submit("submit", { value }, "pointer");
  }

  mount(surface: Surface): void {
    surface.setTask("Посчитай выражение и дай ответ: выбери вариант или введи число.", "Арифметический спринт");
    surface.stage.replaceChildren(this.stimulus.root, this.options.root, this.entry, this.feedback);
  }

  render(view: ArithmeticView): void {
    this.stimulus.show(view.expr);
    this.options.render(view.options.map((label, index) => ({ label, index })));
    this.ctx.input.setOptionCount(view.options.length);
    const entering = view.responseMode === "text-entry";
    this.entry.style.display = entering ? "" : "none";
    if (entering && view.running) this.field.focus();
    this.feedback.textContent = view.feedback === "correct" ? "верно" : view.feedback === "wrong" ? "мимо" : "";
    this.feedback.className = `gs-feedback${view.feedback ? ` is-${view.feedback}` : ""}`;
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.options.clear();
    this.stimulus.clear();
  }
}

export const arithmetic: Microgame<ArithmeticState, ArithmeticView> = {
  manifest: asManifest(manifest),
  core: arithmeticCore,
  paramsForLevel,
  createView: (ctx) => new ArithmeticWebView(ctx),
};

export { arithmeticCore } from "./core.js";
export type { ArithmeticState, ArithmeticView, ArithmeticParams, ArithmeticTrial, ResponseMode } from "./core.js";
