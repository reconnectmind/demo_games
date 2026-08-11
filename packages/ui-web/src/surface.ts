import type { Surface } from "@gamespace/core";

export interface DomSurfaceElements {
  stage: HTMLElement;
  task?: HTMLElement;
  taskLabel?: HTMLElement;
  /**
   * Напоминание о задаче над самой сценой. Тот же текст, что в шапке, но шапка —
   * место оператора: участник смотрит в центр экрана и до неё не дотягивается
   * взглядом, а правило нужно ему там, где стимул.
   */
  reminder?: HTMLElement;
  hint?: HTMLElement;
  stats?: HTMLElement;
}

/** DOM-реализация Surface. Игра не знает ни одного идентификатора витрины. */
export class DomSurface implements Surface {
  constructor(private readonly el: DomSurfaceElements) {}

  get stage(): HTMLElement {
    return this.el.stage;
  }

  setTask(text: string, label = "Задание"): void {
    if (this.el.task) this.el.task.textContent = text;
    if (this.el.taskLabel) this.el.taskLabel.textContent = label;
    this.setReminder(text);
  }

  setReminder(text: string): void {
    if (this.el.reminder) this.el.reminder.textContent = text;
  }

  setHint(text: string): void {
    if (this.el.hint) this.el.hint.textContent = text;
  }

  setStats(pairs: Array<[string, string | number]>): void {
    if (!this.el.stats) return;
    this.el.stats.replaceChildren(
      ...pairs.map(([k, v]) => {
        const span = document.createElement("span");
        span.className = "stat";
        span.innerHTML = `<b>${escapeHtml(k)}</b> ${escapeHtml(String(v))}`;
        return span;
      }),
    );
  }

  clear(): void {
    this.el.stage.replaceChildren();
    this.setHint("");
    this.setStats([]);
  }

  /**
   * Вложенная поверхность под дочернюю задачу. У неё своя подпись и своя
   * статистика внутри слота: иначе ребёнок затирал бы показатели оркестратора.
   */
  child(container: HTMLElement): DomSurface {
    const task = document.createElement("div");
    task.className = "gs-slot-task";
    const stats = document.createElement("div");
    stats.className = "gs-slot-stats";
    const stage = document.createElement("div");
    stage.className = "gs-slot-stage";
    container.replaceChildren(task, stage, stats);
    return new DomSurface({ stage, task, stats });
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
