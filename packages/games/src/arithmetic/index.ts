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
import { ActionButton, FeedbackMark, OptionRow, Stimulus, debriefText, el, verdictOf } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import presetsJson from "./presets.json" with { type: "json" };
import { arithmeticCore, type ArithmeticParams, type ArithmeticState, type ArithmeticView } from "./core.js";

const presets = asPresets(presetsJson);

export function paramsForLevel(level: number): Params {
  return presetParams(presets, level) as ArithmeticParams;
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
  private readonly feedback = new FeedbackMark();

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

  /**
   * Ввод числа с клавиатуры — другой способ ответа, и в протоколе с объявленной
   * ёмкостью его быть не должно: поле ввода к тому же не видно контроллеру, то
   * есть такой ответ идёт мимо единой раздачи клавиш.
   */
  private get typingAllowed(): boolean {
    return this.ctx.input.profile().keys.length === 0;
  }

  mount(surface: Surface): void {
    surface.setTask(
      this.typingAllowed
        ? "Посчитай выражение и дай ответ: выбери вариант или введи число."
        : "Посчитай выражение и выбери верный вариант.",
      "Арифметический спринт",
    );
    surface.stage.replaceChildren(this.stimulus.root, this.options.root, this.entry, this.feedback.root);
  }

  render(view: ArithmeticView): void {
    this.stimulus.show(view.expr);
    this.options.render(view.options.map((label, index) => ({ label, index })));
    this.ctx.input.setOptionCount(view.options.length);
    const entering = view.responseMode === "text-entry" && this.typingAllowed;
    this.entry.style.display = entering ? "" : "none";
    if (entering && view.running) this.field.focus();
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

export const arithmetic: Microgame<ArithmeticState, ArithmeticView> = {
  manifest: asManifest(manifest),
  presets,
  core: arithmeticCore,
  paramsForLevel,
  createView: (ctx) => new ArithmeticWebView(ctx),
};

export { arithmeticCore } from "./core.js";
export type { ArithmeticState, ArithmeticView, ArithmeticParams, ArithmeticTrial, ResponseMode } from "./core.js";
