import { asManifest, type GameContext, type GameView, type Microgame, type Params, type Surface } from "@gamespace/core";
import { DomSurface, el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import {
  BACKGROUND_SLOT,
  INTERRUPT_SLOT,
  interruptResumeCore,
  type InterruptResumeParams,
  type InterruptResumeState,
  type InterruptResumeView,
} from "./core.js";

export function paramsForLevel(level: number): Params {
  const params: InterruptResumeParams = {
    interruptions: Math.min(6, level),
    backgroundRunMs: Math.max(4000, 16000 - 1800 * level),
    interruptionMs: Math.min(15000, 3000 + 1200 * level),
    warningMs: Math.max(0, 1500 - 250 * level),
  };
  return params;
}

class InterruptResumeWebView implements GameView<InterruptResumeView> {
  private readonly banner = el("div", { class: "gs-banner" });
  private readonly backgroundSlot = el("div", { class: "gs-slot is-background" });
  private readonly interruptSlot = el("div", { class: "gs-slot is-interrupt" });

  constructor(private readonly ctx: GameContext) {}

  mount(surface: Surface): void {
    surface.setTask(
      "Держи основную задачу. Когда прервут — выполни побочную и вернись ровно туда, где остановился.",
      "Прерывание и возврат",
    );
    surface.stage.replaceChildren(this.banner, this.backgroundSlot, this.interruptSlot);
    // Оркестратор отдаёт контейнеры, но не знает, что в них смонтируют.
    const parent = surface instanceof DomSurface ? surface : null;
    this.ctx.children?.registerSlot(BACKGROUND_SLOT, parent ? parent.child(this.backgroundSlot) : surface);
    this.ctx.children?.registerSlot(INTERRUPT_SLOT, parent ? parent.child(this.interruptSlot) : surface);
  }

  render(view: InterruptResumeView): void {
    this.banner.textContent = view.banner;
    this.banner.className = `gs-banner is-${view.stage}`;
    this.interruptSlot.style.display = view.stage === "interruption" ? "" : "none";
    this.backgroundSlot.style.opacity = view.stage === "interruption" ? "0.25" : "1";
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.banner.textContent = "";
  }
}

export const interruptResume: Microgame<InterruptResumeState, InterruptResumeView> = {
  manifest: asManifest(manifest),
  core: interruptResumeCore,
  paramsForLevel,
  createView: (ctx) => new InterruptResumeWebView(ctx),
};

export { interruptResumeCore } from "./core.js";
export type { InterruptResumeState, InterruptResumeView, InterruptResumeParams } from "./core.js";
