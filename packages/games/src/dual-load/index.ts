import { asManifest, type GameContext, type GameView, type Microgame, type Params, type Surface } from "@gamespace/core";
import { OptionRow, Stimulus, el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import { dualLoadCore, type DualLoadParams, type DualLoadState, type DualLoadView, type PeripheralSide } from "./core.js";

export function paramsForLevel(level: number): Params {
  const params: DualLoadParams = {
    n: Math.min(4, 1 + Math.floor((level - 1) / 2)),
    stimulusMs: Math.max(500, 1600 - 90 * level),
    isiMs: Math.max(200, 500 - 25 * level),
    targetRate: 0.3,
    blockLength: Math.min(40, 18 + 2 * level),
    peripheralIsiMs: Math.max(900, 2600 - 180 * level),
    peripheralDeadlineMs: Math.max(600, 1800 - 120 * level),
  };
  return params;
}

const ARENA_STYLE =
  "display:flex;align-items:center;justify-content:space-between;gap:18px;width:min(520px,88vw);min-height:180px";
const PAD_STYLE =
  "width:44px;height:44px;border-radius:50%;border:2px solid currentColor;opacity:0.25;transition:opacity 90ms linear";

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
  private readonly feedback = el("div", { class: "gs-feedback" });

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
    surface.stage.replaceChildren(this.arena, this.options.root, this.feedback);
  }

  render(view: DualLoadView): void {
    this.stimulus.show(view.primary.letter || (view.primary.finished ? "✓" : "·"));
    this.left.set(view.secondary.side === "left");
    this.right.set(view.secondary.side === "right");
    this.options.render([
      { label: `Совпадение · N = ${view.primary.n}`, index: 0, actionId: "match" },
      { label: "Метка", index: 1, actionId: "peripheral", state: view.secondary.awaiting ? "correct" : "idle" },
    ]);
    this.ctx.input.setOptionCount(0);
    this.feedback.textContent = describe(view);
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.options.clear();
    this.stimulus.clear();
  }
}

function describe(view: DualLoadView): string {
  if (view.secondary.feedback === "miss") return "метка пропущена";
  if (view.secondary.feedback === "false-alarm") return "метки не было";
  if (view.primary.feedback === "miss") return "пропуск в центре";
  if (view.primary.feedback === "false-alarm") return "мимо в центре";
  if (view.primary.feedback === "hit" || view.secondary.feedback === "hit") return "верно";
  return "";
}

export const dualLoad: Microgame<DualLoadState, DualLoadView> = {
  manifest: asManifest(manifest),
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
