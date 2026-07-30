import { asManifest, type GameContext, type GameView, type Microgame, type Params, type Surface } from "@gamespace/core";
import { DomSurface, el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import {
  TASK_SLOT,
  adaptiveBatteryCore,
  type AdaptiveBatteryParams,
  type AdaptiveBatteryState,
  type AdaptiveBatteryView,
} from "./core.js";

export function paramsForLevel(level: number): Params {
  const params: AdaptiveBatteryParams = {
    blocks: Math.min(10, 2 + level),
    restMs: Math.max(500, 4000 - 450 * level),
    poolSize: Math.min(5, 1 + Math.ceil(level / 2)),
  };
  return params;
}

const TITLES: Record<string, string> = {
  "org.reconnect.arithmetic": "Арифметика",
  "org.reconnect.n-back": "N-back",
  "org.reconnect.stroop": "Stroop",
  "org.reconnect.rule-switch": "Смена правила",
  "org.reconnect.dual-load": "Двойная нагрузка",
};

class AdaptiveBatteryWebView implements GameView<AdaptiveBatteryView> {
  private readonly header = el("div", { class: "gs-banner" });
  private readonly slot = el("div", { class: "gs-slot" });

  constructor(private readonly ctx: GameContext) {}

  mount(surface: Surface): void {
    surface.setTask("Блоки разных задач идут подряд. Уровень каждой задачи запоминается между блоками.", "Адаптивная батарея");
    surface.stage.replaceChildren(this.header, this.slot);
    const parent = surface instanceof DomSurface ? surface : null;
    this.ctx.children?.registerSlot(TASK_SLOT, parent ? parent.child(this.slot) : surface);
  }

  render(view: AdaptiveBatteryView): void {
    this.header.textContent = view.resting
      ? "Пауза"
      : view.currentTask
        ? `Блок ${view.index + 1} из ${view.total}: ${TITLES[view.currentTask] ?? view.currentTask}`
        : "Готово";
    this.slot.style.opacity = view.resting ? "0.3" : "1";
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.header.textContent = "";
  }
}

export const adaptiveBattery: Microgame<AdaptiveBatteryState, AdaptiveBatteryView> = {
  manifest: asManifest(manifest),
  core: adaptiveBatteryCore,
  paramsForLevel,
  createView: (ctx) => new AdaptiveBatteryWebView(ctx),
};

export { adaptiveBatteryCore } from "./core.js";
export type { AdaptiveBatteryState, AdaptiveBatteryView, AdaptiveBatteryParams } from "./core.js";
