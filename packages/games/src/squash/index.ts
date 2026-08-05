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
import { ActionButton, CanvasStage, el, stimulusScale } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import presetsJson from "./presets.json" with { type: "json" };
import { squashCore, type SquashParams, type SquashState, type SquashView } from "./core.js";

const presets = asPresets(presetsJson);

export function paramsForLevel(level: number): Params {
  return presetParams(presets, level) as SquashParams;
}

const COLORS = {
  court: "#0d1b2a",
  line: "#1f3350",
  ball: "#f2f6ff",
  paddle: "#58a6ff",
  return: "#3fb950",
  loss: "#f85149",
};

/**
 * Канвас — деталь представления: ядро отдаёт доли поля, а пиксели, плотность
 * экрана и кадр живут здесь. Никакой физики в этом файле нет.
 */
class SquashWebView implements GameView<SquashView> {
  private readonly stage = new CanvasStage({ aspect: 1, maxWidthPx: 460 });
  private readonly controls = el("div", { class: "gs-options" });
  private readonly left: ActionButton;
  private readonly right: ActionButton;
  private view: SquashView | null = null;
  private lastAim = -1;

  constructor(private readonly ctx: GameContext) {
    this.left = new ActionButton(ctx.input, "left", "Влево", "btn gs-hold");
    this.right = new ActionButton(ctx.input, "right", "Вправо", "btn gs-hold");
    this.left.onHold((phase) => this.ctx.input.submit("left", { phase }, "pointer"));
    this.right.onHold((phase) => this.ctx.input.submit("right", { phase }, "pointer"));
    this.controls.append(this.left.root, this.right.root);
    this.stage.onPaint((g, size) => this.paint(g, size));
    // В лабораторном профиле наведения нет: случайное движение мыши над канвасом
    // молча забирало площадку у клавиш, и участник переставал понимать, чем
    // управляет. Мышь остаётся там, где указание — существо задачи.
    if (ctx.input.profile().pointer === "free") {
      // Наведение шлётся только при заметном сдвиге: журнал не должен пухнуть от дрожи мыши.
      this.stage.canvas.addEventListener("pointermove", (event) => {
        const fraction = this.stage.pointerFraction(event);
        if (Math.abs(fraction - this.lastAim) < 0.004) return;
        this.lastAim = fraction;
        this.ctx.input.submit("aim", { value: fraction }, "pointer");
      });
    }
  }

  mount(surface: Surface): void {
    const aiming = this.ctx.input.profile().pointer === "free";
    surface.setTask(
      aiming
        ? "Отбивай шарик площадкой: держи клавиши влево-вправо или веди мышью. Пропущенный шарик считается ошибкой."
        : "Отбивай шарик площадкой: держи клавишу влево или вправо. Пропущенный шарик считается ошибкой.",
      "Сквош",
    );
    surface.stage.replaceChildren(this.stage.root, this.controls);
    this.stage.mount();
  }

  render(view: SquashView): void {
    this.view = view;
    this.stage.draw();
    this.ctx.surface.setStats(view.stats);
  }

  private paint(g: CanvasRenderingContext2D, size: { w: number; h: number }): void {
    const view = this.view;
    g.fillStyle = COLORS.court;
    g.fillRect(0, 0, size.w, size.h);
    g.strokeStyle = COLORS.line;
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, size.w - 1, size.h - 1);
    if (!view) return;

    const paddleY = view.paddleY * size.h;
    const paddleW = view.paddleWidth * size.w;
    const paddleH = view.paddleHeight * size.h;
    g.fillStyle = view.feedback === "loss" ? COLORS.loss : view.feedback === "return" ? COLORS.return : COLORS.paddle;
    g.beginPath();
    g.roundRect(view.paddleX * size.w - paddleW / 2, paddleY - paddleH / 2, paddleW, paddleH, paddleH / 2);
    g.fill();

    g.fillStyle = COLORS.ball;
    for (const ball of view.balls) {
      g.beginPath();
      g.arc(ball.x * size.w, ball.y * size.h, ball.r * size.w, 0, Math.PI * 2);
      g.fill();
    }

    // Текущая нагрузка видна прямо в поле: скорость, шарики и остаток блока.
    // Подписи в поле растут тем же множителем, что и стимулы: иначе на увеличенном
    // поле они остались бы прежними и стали бы нечитаемыми относительно него.
    const scale = stimulusScale();
    g.fillStyle = "rgba(230,237,243,0.55)";
    g.font = `${Math.round(12 * scale)}px ui-monospace, monospace`;
    g.textBaseline = "top";
    g.fillText(`скорость ${view.ballSpeed.toFixed(2)} · шариков ${view.ballCount}`, 10, 8);
    const left = Math.max(0, view.progress.blockMs - view.progress.playedMs);
    const progress = `осталось ${Math.ceil(left / 1000)} с`;
    g.fillText(progress, size.w - 10 - g.measureText(progress).width, 8);

    if (view.finished) {
      g.fillStyle = "rgba(13,27,42,0.72)";
      g.fillRect(0, 0, size.w, size.h);
      g.fillStyle = COLORS.ball;
      g.font = `${Math.round(16 * scale)}px system-ui, sans-serif`;
      g.textAlign = "center";
      g.fillText("блок завершён", size.w / 2, size.h / 2 - 8);
      g.textAlign = "left";
    }
  }

  unmount(): void {
    this.stage.unmount();
    this.controls.replaceChildren();
  }
}

export const squash: Microgame<SquashState, SquashView> = {
  manifest: asManifest(manifest),
  presets,
  core: squashCore,
  paramsForLevel,
  createView: (ctx) => new SquashWebView(ctx),
};

export {
  BALL_R,
  MAX_DEFLECT_RAD,
  MAX_STEP_MS,
  PADDLE_H,
  PADDLE_SPEED,
  PADDLE_Y,
  SIM_STEP_MS,
  SQ_TICK,
  squashAccuracy,
  squashCore,
  squashSummary,
  squashView,
} from "./core.js";

export type { Ball, SquashFeedback, SquashParams, SquashState, SquashSummary, SquashView } from "./core.js";
