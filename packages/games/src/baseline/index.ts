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
import { el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import presetsJson from "./presets.json" with { type: "json" };
import { baselineCore, type BaselineParams, type BaselineState, type BaselineView } from "./core.js";

const presets = asPresets(presetsJson);

const TASK = "Отдых: реагировать не нужно.";

export function paramsForLevel(level: number): Params {
  return presetParams(presets, level) as BaselineParams;
}

class BaselineWebView implements GameView<BaselineView> {
  private readonly text = el("div", { class: "gs-baseline-text" });
  private readonly timer = el("div", { class: "gs-baseline-timer" });
  private readonly fixation = el("div", { class: "gs-baseline-fixation", text: "+" });

  constructor(private readonly ctx: GameContext) {}

  mount(surface: Surface): void {
    surface.setTask(TASK, "Базовая линия");
    surface.stage.replaceChildren(this.text, this.fixation, this.timer);
  }

  render(view: BaselineView): void {
    // Напоминание о задании участнику покоя не нужно: смотреть он должен на
    // крестик. Подпись задания в шапке остаётся — она операторская.
    this.ctx.surface.setReminder(view.fixation ? "" : TASK);
    this.text.textContent = view.fixation ? "" : view.finished ? "Участок завершён." : view.text;
    this.timer.textContent = view.showTimer ? fmt(view.remainingMs) : "";
    this.timer.style.display = view.showTimer ? "" : "none";
    this.fixation.style.display = view.fixation ? "" : "none";
    this.fixation.style.opacity = view.finished ? "0.2" : "1";
    this.ctx.surface.setStats(view.stats);
  }

  unmount(): void {
    this.text.textContent = "";
    this.timer.textContent = "";
  }
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export const baseline: Microgame<BaselineState, BaselineView> = {
  manifest: asManifest(manifest),
  presets,
  core: baselineCore,
  paramsForLevel,
  createView: (ctx) => new BaselineWebView(ctx),
};

export { BASELINE_TICK, baselineCore, baselineSummary, baselineView } from "./core.js";
export type { BaselineParams, BaselineState, BaselineSummary, BaselineView } from "./core.js";
