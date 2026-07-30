import { el } from "./widgets.js";

function tryContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

export interface CanvasStageOptions {
  /** Пропорции игрового поля: ядро работает в долях, пиксели знает только сцена. */
  aspect?: number;
  maxWidthPx?: number;
  className?: string;
}

/**
 * Канвас-подложка. Держит размер, плотность пикселей и один кадр отрисовки;
 * что рисовать — знает только игра. Ядро о существовании канваса не знает:
 * оно отдаёт view-модель в долях поля, а масштаб живёт здесь.
 */
export class CanvasStage {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D | null;
  private readonly aspect: number;
  private observer: ResizeObserver | null = null;
  private cssWidth = 0;
  private cssHeight = 0;
  private paint: ((g: CanvasRenderingContext2D, size: { w: number; h: number }) => void) | null = null;

  constructor(options: CanvasStageOptions = {}) {
    this.aspect = options.aspect ?? 4 / 3;
    this.canvas = el("canvas", { class: options.className ?? "gs-canvas" }) as HTMLCanvasElement;
    this.root = el("div", { class: "gs-canvas-wrap" });
    this.root.style.maxWidth = `${options.maxWidthPx ?? 620}px`;
    this.root.append(this.canvas);
    // Хост без 2d-контекста возможен (jsdom в тестах): игра обязана это пережить.
    this.ctx2d = tryContext(this.canvas);
  }

  /** Кадр рисуется по требованию: сцена сама не заводит цикл анимации. */
  onPaint(cb: (g: CanvasRenderingContext2D, size: { w: number; h: number }) => void): void {
    this.paint = cb;
  }

  mount(): void {
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.root);
    }
    this.resize();
  }

  unmount(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Пиксели под плотность экрана: иначе шарик и площадка будут мыльными. */
  private resize(): void {
    const width = this.root.clientWidth || Number(this.root.style.maxWidth.replace("px", "")) || 620;
    const height = Math.round(width / this.aspect);
    const dpr = typeof devicePixelRatio === "number" ? Math.min(devicePixelRatio, 3) : 1;
    this.cssWidth = width;
    this.cssHeight = height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx2d?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw(): void {
    if (!this.ctx2d || !this.paint || this.cssWidth === 0) return;
    this.ctx2d.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.paint(this.ctx2d, { w: this.cssWidth, h: this.cssHeight });
  }

  /** Доля по горизонтали под курсором: непрерывное управление мышью и пальцем. */
  pointerFraction(event: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return 0.5;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }
}
