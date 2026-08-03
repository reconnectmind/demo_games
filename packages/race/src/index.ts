import { asManifest, type GameContext, type GameView, type Microgame, type Params, type Surface } from "@gamespace/core";
import { ActionButton, el } from "@gamespace/ui-web";
import manifest from "./manifest.json" with { type: "json" };
import { raceCore, type RaceParams, type RaceState, type RaceView } from "./core.js";
import { prepareSim } from "./sim.js";
import { RaceHud } from "./view/hud.js";
import type { RaceScene } from "./view/scene.js";

/**
 * Сложность растёт по трассе, а не по управлению: дорога становится извилистее,
 * подъёмы круче, полоса уже. Длина блока от уровня не зависит — это расписание.
 */
export function paramsForLevel(level: number): Params {
  const params: RaceParams = {
    blockMs: 90_000,
    curveRate: Number((0.004 + 0.0026 * (level - 1)).toFixed(5)),
    gradeMax: Number((0.02 + 0.012 * (level - 1)).toFixed(4)),
    roadHalfWidth: Number((8 - 0.6 * (level - 1)).toFixed(2)),
    gears: 6,
  };
  return params;
}

const TASK =
  "Газ — W, тормоз — S, руль — A и D, передачи — стрелки ↑ ↓. Заезд начинается на нейтрали: чтобы тронуться, " +
  "сначала включите передачу стрелкой вверх; ниже нейтрали стоит задний ход. Низкая передача рвёт с места, но обороты сразу " +
  "уходят в отсечку: рёва много, пути мало, мотор греется. Высокая тянет мягко, зато тянет далеко. " +
  "Клавиша руля — это усилие на ободе, а не угол: на ходу отпущенный руль возвращается сам, и тем быстрее, " +
  "чем быстрее едешь. Цель не скорость, а КПД: больше пути на меньшем газе.";

class RaceWebView implements GameView<RaceView> {
  private readonly wrap = el("div", { class: "race-wrap" });
  private readonly canvas = el("canvas", { class: "race-canvas" }) as HTMLCanvasElement;
  private readonly notice = el("div", { class: "race-notice", text: "сцена загружается…" });
  private readonly hud = new RaceHud();
  private readonly controls = el("div", { class: "gs-options race-controls" });
  private readonly sound = el("button", {
    class: "race-sound",
    text: "♪",
    title: "Звук мотора и шин",
  }) as HTMLButtonElement;
  private readonly buttons: ActionButton[] = [];
  private scene: RaceScene | null = null;
  private observer: ResizeObserver | null = null;
  private last: RaceView | null = null;
  private disposed = false;

  constructor(private readonly ctx: GameContext) {
    this.wrap.append(this.canvas, this.notice, this.hud.root);
    // Кнопка появляется только вместе со сценой: без неё выключать нечего.
    this.sound.hidden = true;
    this.sound.addEventListener("click", () => this.showSound(this.scene?.toggleSound() ?? false));

    const hold = (id: string, text: string) => {
      const button = new ActionButton(ctx.input, id, text, "btn gs-hold");
      button.onHold((phase) => ctx.input.submit(id, { phase }, "pointer"));
      this.buttons.push(button);
      return button;
    };
    const tap = (id: string, text: string) => {
      const button = new ActionButton(ctx.input, id, text);
      button.onClick(() => ctx.input.submit(id, {}, "pointer"));
      this.buttons.push(button);
      return button;
    };

    // Порядок кнопок повторяет порядок рук: газ, тормоз, руль, передачи.
    this.controls.append(
      hold("throttle", "Газ").root,
      hold("brake", "Тормоз").root,
      hold("left", "Влево").root,
      hold("right", "Вправо").root,
      tap("gearDown", "Передача ниже").root,
      tap("gearUp", "Передача выше").root,
    );
  }

  mount(surface: Surface): void {
    surface.setTask(TASK, "Заезд");
    surface.stage.replaceChildren(this.wrap, this.controls);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.scene?.resize());
      this.observer.observe(this.wrap);
    }
    void this.boot();
  }

  render(view: RaceView): void {
    this.last = view;
    this.hud.render(view);
    this.scene?.update(view);
    this.ctx.surface.setStats(view.stats);
    // Блок закрылся, а клавиша может остаться зажатой: «up» придёт уже мимо игры,
    // поэтому подсветку удержания снимаем сами, иначе кнопка врёт.
    if (view.finished) for (const button of this.buttons) button.root.classList.remove("is-held");
  }

  unmount(): void {
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.scene?.dispose();
    this.scene = null;
    this.controls.replaceChildren();
  }

  private showSound(on: boolean): void {
    this.sound.textContent = on ? "♪" : "✕";
    this.sound.classList.toggle("is-off", !on);
    this.sound.title = on ? "Выключить звук" : "Включить звук";
  }

  /**
   * Babylon грузится лениво и только здесь: остальные модули витрины не должны
   * платить за трёхмерный движок ни байтом бандла, ни временем старта.
   */
  private async boot(): Promise<void> {
    try {
      const { createRaceScene } = await import("./view/scene.js");
      if (this.disposed) return;
      const scene = createRaceScene(this.canvas);
      if (this.disposed) {
        scene.dispose();
        return;
      }
      // Виды идут в сцену сразу, а заглушка снимается позже: пока машина
      // собирается, дорога уже может строиться под ней.
      this.scene = scene;
      if (this.last) scene.update(this.last);
      // Заглушка держится до готовности машины: иначе в первом кадре дорога уже
      // есть, а машины ещё нет.
      await scene.whenReady();
      if (this.disposed) return;
      this.notice.remove();
      this.sound.hidden = false;
      this.wrap.append(this.sound);
      this.showSound(scene.soundOn());
    } catch (error) {
      // Сцена — деталь представления: без неё игра остаётся играбельной по приборам.
      this.notice.textContent = "Трёхмерная сцена не запустилась (нужен WebGL). Приборы и управление работают.";
      console.warn("race: scene unavailable", error);
    }
  }
}

export const race: Microgame<RaceState, RaceView> = {
  manifest: asManifest(manifest),
  core: raceCore,
  paramsForLevel,
  createView: (ctx) => new RaceWebView(ctx),
  // Физику считает WASM: без него ядру нечем шагать, поэтому у заезда, в отличие
  // от плоских игр витрины, есть подготовка.
  prepare: prepareSim,
};

export {
  GEAR_NEUTRAL,
  GEAR_REVERSE,
  LIMP_THROTTLE,
  MAX_STEP_MS,
  RACE_TICK,
  RPM_IDLE,
  RPM_MAX,
  SIM_STEP_MS,
  STUCK_LIMIT_MS,
  gearLabel,
  raceAccuracy,
  raceCore,
  raceEfficiency,
  raceStuck,
  raceSummary,
  raceView,
  ratioFor,
} from "./core.js";
export type { RaceParams, RaceState, RaceSummary, RaceView } from "./core.js";
export {
  FINAL_DRIVE,
  REVERSE_RATIO,
  engineSettle,
  engineStep,
  geometricRpm,
  pumpingNm,
  ratiosFor,
  torqueAt,
} from "./drivetrain.js";
export { RIDE_HEIGHT_M, createSim, prepareSim, simReady } from "./sim.js";
export type { SimFrame, SimSave } from "./sim.js";
export { STEER_LOCK, steerLimit, steerStep } from "./steering.js";
export {
  BODY_SCALE,
  MASS_KG,
  MODEL,
  SUSPENSION_LOADED_M,
  WHEEL_MOUNTS,
  WHEEL_RADIUS_M,
  WHEELBASE_M,
  WHEEL_BACK_Z,
  WHEEL_FRONT_Z,
  WHEEL_X,
} from "./geometry.js";
export {
  Centerline,
  FINE_M,
  FINE_PER_SEGMENT,
  SECTOR_SEGMENTS,
  SEGMENT_M,
  SHOULDER_M,
  STAMP_LEAD_SEGMENTS,
  corridorHalfWidth,
  crossSection,
  hash01,
  sectorIndexAt,
  segmentIndexAt,
  shapeAt,
  trackAt,
} from "./track.js";
export type { FinePoint, ShapeStamp, TrackSegment, TrackShape } from "./track.js";
