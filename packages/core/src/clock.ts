import type { Clock, Handle } from "./contracts.js";

interface Timer {
  id: number;
  dueAt: number;
  intervalMs: number | null;
  cb: () => void;
  cancelled: boolean;
}

/**
 * Общая часть обеих реализаций: реестр таймеров. Он же снимает целый класс
 * утечек — runtime гасит все таймеры одним вызовом, а не по одному из игры.
 */
abstract class BaseClock implements Clock {
  protected timers = new Map<number, Timer>();
  protected nextId = 1;

  abstract now(): number;
  protected abstract onScheduled(): void;

  after(ms: number, cb: () => void): Handle {
    return this.schedule(ms, null, cb);
  }

  every(ms: number, cb: () => void): Handle {
    return this.schedule(ms, ms, cb);
  }

  protected schedule(ms: number, intervalMs: number | null, cb: () => void): Handle {
    const id = this.nextId++;
    const timer: Timer = { id, dueAt: this.now() + ms, intervalMs, cb, cancelled: false };
    this.timers.set(id, timer);
    this.onScheduled();
    return {
      dispose: () => {
        timer.cancelled = true;
        this.timers.delete(id);
      },
    };
  }

  /** Остаток по каждому активному таймеру: нужен для checkpoint. */
  pending(): Array<{ id: number; remainingMs: number }> {
    const t = this.now();
    return [...this.timers.values()].map((x) => ({ id: x.id, remainingMs: Math.max(0, x.dueAt - t) }));
  }

  disposeAll(): void {
    this.timers.clear();
  }
}

/** Реальное время. t0 фиксируется при создании, now() отсчитывается от него. */
export class RealClock extends BaseClock {
  private readonly t0: number;
  private handles = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(now: () => number = () => performance.now()) {
    super();
    this.readNow = now;
    this.t0 = now();
  }

  private readNow: () => number;

  now(): number {
    return this.readNow() - this.t0;
  }

  protected onScheduled(): void {
    for (const timer of this.timers.values()) {
      if (this.handles.has(timer.id)) continue;
      const fire = () => {
        if (timer.cancelled) return;
        if (timer.intervalMs === null) {
          this.timers.delete(timer.id);
          this.handles.delete(timer.id);
        } else {
          timer.dueAt = this.now() + timer.intervalMs;
          this.handles.set(timer.id, setTimeout(fire, timer.intervalMs));
        }
        timer.cb();
      };
      this.handles.set(timer.id, setTimeout(fire, Math.max(0, timer.dueAt - this.now())));
    }
  }

  override disposeAll(): void {
    for (const h of this.handles.values()) clearTimeout(h);
    this.handles.clear();
    super.disposeAll();
  }
}

/**
 * Виртуальное время: 110-минутная сессия прогоняется за секунды, и порядок
 * срабатываний детерминирован — при равном сроке первым идёт тот, кто раньше поставлен.
 */
export class VirtualClock extends BaseClock {
  private t = 0;

  now(): number {
    return this.t;
  }

  protected onScheduled(): void {
    /* виртуальные таймеры срабатывают только в advance */
  }

  /** Двигает время вперёд, исполняя все сроки по пути. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.values()]
        .filter((x) => !x.cancelled && x.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (!due) break;
      this.t = due.dueAt;
      if (due.intervalMs === null) this.timers.delete(due.id);
      else due.dueAt = this.t + due.intervalMs;
      due.cb();
    }
    this.t = target;
  }

  /** Прокручивает время до опустошения очереди или до предела шагов. */
  runUntilIdle(maxSteps = 100000): void {
    let steps = 0;
    while (this.timers.size > 0 && steps++ < maxSteps) {
      const next = [...this.timers.values()].sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (!next) break;
      this.advance(Math.max(0, next.dueAt - this.t));
    }
  }
}
