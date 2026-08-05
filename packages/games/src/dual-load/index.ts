import {
  asManifest,
  asPresets,
  presetParams,
  type GameContext,
  type GameView,
  type Microgame,
  type Params,
  type Surface,
  type TrialDebrief,
} from "@gamespace/core";
import { FeedbackMark, OptionRow, Stimulus, debriefText, el, type Verdict } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import presetsJson from "./presets.json" with { type: "json" };
import { dualLoadCore, type DualLoadParams, type DualLoadState, type DualLoadView, type PeripheralSide } from "./core.js";

const presets = asPresets(presetsJson);

export function paramsForLevel(level: number): Params {
  return presetParams(presets, level) as DualLoadParams;
}

// Арена и площадки — стимулы, поэтому их размеры выражены общим множителем, а не
// фиксированными пикселями: иначе периферия осталась бы прежней, а центр вырос.
const ARENA_STYLE =
  "display:flex;align-items:center;justify-content:space-between;gap:calc(18px * var(--gs-scale, 1));" +
  "width:min(calc(520px * var(--gs-scale, 1)),88vw);min-height:calc(180px * var(--gs-scale, 1))";
const PAD_STYLE =
  "width:calc(44px * var(--gs-scale, 1));height:calc(44px * var(--gs-scale, 1));border-radius:50%;" +
  "border:2px solid currentColor;opacity:0.25;transition:opacity 90ms linear";

/** Площадка периферийного сигнала: в ui-web такого виджета нет, он нужен только здесь. */
class PeripheralPad {
  readonly root: HTMLElement;

  constructor(side: PeripheralSide) {
    this.root = el("div", { class: `gs-periph is-${side}`, style: PAD_STYLE });
  }

  set(active: boolean): void {
    this.root.style.opacity = active ? "1" : "0.25";
    this.root.classList.toggle("is-active", active);
  }
}

class DualLoadWebView implements GameView<DualLoadView> {
  private readonly stimulus = new Stimulus();
  private readonly left = new PeripheralPad("left");
  private readonly right = new PeripheralPad("right");
  private readonly arena = el("div", { class: "gs-dual-arena", style: ARENA_STYLE });
  private readonly options: OptionRow;
  private readonly feedback = new FeedbackMark();

  constructor(private readonly ctx: GameContext) {
    this.options = new OptionRow(ctx.input);
    this.arena.replaceChildren(this.left.root, this.stimulus.root, this.right.root);
    // Оба действия не indexed, поэтому индекс варианта служит только адресом кнопки.
    this.options.onSelect((index) => this.ctx.input.submit(index === 0 ? "match" : "peripheral", {}, "pointer"));
  }

  mount(surface: Surface): void {
    surface.setTask(
      "Держи центральную последовательность букв и одновременно отмечай метку слева или справа.",
      "Двойная нагрузка",
    );
    surface.stage.replaceChildren(this.arena, this.options.root, this.feedback.root);
  }

  render(view: DualLoadView): void {
    this.stimulus.show(view.primary.letter || (view.primary.finished ? "✓" : "·"));
    this.left.set(view.secondary.side === "left");
    this.right.set(view.secondary.side === "right");
    // Кнопка метки не подсвечивается на её появление: следить нужно за самой
    // меткой на периферии, а подсказка у клавиши подменяла бы задачу — участник
    // смотрел бы на кнопку, где сигнал заметнее.
    this.options.render([
      { label: `Совпадение · N = ${view.primary.n}`, index: 0, actionId: "match" },
      { label: "Метка", index: 1, actionId: "peripheral" },
    ]);
    this.ctx.input.setOptionCount(0);
    this.feedback.show(verdict(view), this.ctx.training ? debriefText(debrief(view)) : "");
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.options.clear();
    this.stimulus.clear();
  }
}

/**
 * Два канала — один знак: ошибка в любом из них важнее попадания в другом,
 * иначе «✓» за центр прикрыл бы пропущенную метку на периферии.
 */
/**
 * Разбор называет канал: «пропустил метку слева» и «нажал, когда совпадения не
 * было» — разные ошибки, и без указания канала участник поправит не ту задачу.
 */
function debrief(view: DualLoadView): TrialDebrief | null {
  const side = view.secondary.side === "left" ? "слева" : "справа";
  if (view.secondary.feedback === "miss") return { expected: `отметить метку ${side}`, got: null };
  if (view.secondary.feedback === "false-alarm") return { expected: null, got: "отметка метки" };
  if (view.primary.feedback === "miss") return { expected: "отметить совпадение в центре", got: null };
  if (view.primary.feedback === "false-alarm") return { expected: null, got: "нажатие в центре" };
  return null;
}

function verdict(view: DualLoadView): Verdict {
  const both = [view.secondary.feedback, view.primary.feedback];
  if (both.some((f) => f && f !== "hit")) return "miss";
  return both.some((f) => f === "hit") ? "hit" : null;
}

export const dualLoad: Microgame<DualLoadState, DualLoadView> = {
  manifest: asManifest(manifest),
  presets,
  core: dualLoadCore,
  paramsForLevel,
  createView: (ctx) => new DualLoadWebView(ctx),
};

export {
  PERIPHERAL_DEADLINE,
  PERIPHERAL_ON,
  PRIMARY_PREFIX,
  dualLoadAccuracy,
  dualLoadCore,
  dualLoadSummary,
  dualLoadView,
  toNBackParams,
} from "./core.js";
export type {
  DualLoadParams,
  DualLoadState,
  DualLoadSummary,
  DualLoadView,
  DualSecondaryState,
  PeripheralFeedback,
  PeripheralSide,
} from "./core.js";

