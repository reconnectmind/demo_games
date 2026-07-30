import { asManifest, type GameContext, type GameView, type Microgame, type Params, type Surface } from "@gamespace/core";
import { ActionButton, CanvasStage, el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import { squashCore, type SquashParams, type SquashState, type SquashView } from "./core.js";

export function paramsForLevel(level: number): Params {
  const params: SquashParams = {
    ballSpeed: Number((0.28 + 0.075 * (level - 1)).toFixed(3)),
    ballCount: Math.min(4, 1 + Math.floor((level - 1) / 2)),
    paddleWidth: Number(Math.max(0.08, 0.3 - 0.028 * (level - 1)).toFixed(3)),
    episodes: 12,
    serveDelayMs: 600,
  };
  return params;
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
    // Наведение шлётся только при заметном сдвиге: журнал не должен пухнуть от дрожи мыши.
    this.stage.canvas.addEventListener("pointermove", (event) => {
      const fraction = this.stage.pointerFraction(event);
      if (Math.abs(fraction - this.lastAim) < 0.004) return;
      this.lastAim = fraction;
      this.ctx.input.submit("aim", { value: fraction }, "pointer");
    });
  }

  mount(surface: Surface): void {
    surface.setTask(
      "Отбивай шарик площадкой: держи стрелки ← → или веди мышью. Пропущенный шарик считается ошибкой.",
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

    // Текущая нагрузка видна прямо в поле: скорость и остаток мячей блока.
    g.fillStyle = "rgba(230,237,243,0.55)";
    g.font = "12px ui-monospace, monospace";
    g.textBaseline = "top";
    g.fillText(`скорость ${view.ballSpeed.toFixed(2)} · шариков ${view.ballCount}`, 10, 8);
    const progress = `эпизоды ${view.progress.resolved}/${view.progress.total}`;
    g.fillText(progress, size.w - 10 - g.measureText(progress).width, 8);

    if (view.finished) {
      g.fillStyle = "rgba(13,27,42,0.72)";
      g.fillRect(0, 0, size.w, size.h);
      g.fillStyle = COLORS.ball;
      g.font = "16px system-ui, sans-serif";
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
