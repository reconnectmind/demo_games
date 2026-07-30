import { type Handle, type InputHandle } from "@gamespace/core";

/** Человеческое имя клавиши: на кнопке нужен знак, а не код события. */
export function keyLabel(binding: string): string {
  const named: Record<string, string> = {
    Space: "Пробел",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
  };
  return named[binding] ?? binding;
}

/**
 * Подпись клавиши берётся из фактической привязки, а не из констант виджета:
 * иначе профиль F/J/D/K поменял бы управление, а кнопки продолжали бы врать.
 */
export function keyHint(input: InputHandle | undefined, actionId: string, index?: number): string | null {
  if (!input) return null;
  const binding = input.bindings().find((b) => b.id === actionId);
  if (!binding) return null;
  if (index === undefined) return keyLabel(binding.binding);
  return input.indexKeys(actionId)[index] ?? null;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

export interface OptionItem {
  label: string;
  /** Индекс приходит в payload действия: клавиши раздаёт хост, не игра. */
  index: number;
  /** Какое действие нажимает кнопка, если это не indexed-действие ряда. */
  actionId?: string;
  state?: "idle" | "correct" | "wrong" | "disabled";
}

/**
 * Ряд вариантов ответа. Подпись клавиши рисует виджет, потому что раскладка —
 * дело хоста; игра знает только логическое действие и номер варианта.
 */
export class OptionRow {
  readonly root = el("div", { class: "gs-options" });
  private onPick: (index: number) => void = () => {};
  private readonly subscriptions = new Map<string, Handle>();

  /** `input` нужен, чтобы кнопка показывала настоящую привязку, а не догадку. */
  constructor(
    private readonly input?: InputHandle,
    private readonly defaultActionId = "choose",
  ) {}

  onSelect(cb: (index: number) => void): void {
    this.onPick = cb;
  }

  /** Клавиатурное действие подсвечивает ту же кнопку, что и мышь. */
  private watch(actionId: string, index: number | null): void {
    if (!this.input || this.subscriptions.has(actionId)) return;
    this.subscriptions.set(
      actionId,
      this.input.on(actionId, (event) => {
        if (event.source !== "keyboard") return;
        const target = index ?? (typeof event.payload.index === "number" ? event.payload.index : null);
        if (target !== null) this.flash(target);
      }),
    );
  }

  render(items: OptionItem[]): void {
    for (const item of items) this.watch(item.actionId ?? this.defaultActionId, item.actionId ? item.index : null);
    this.root.replaceChildren(
      ...items.map((item) => {
        const button = el("button", {
          class: `gs-opt${item.state && item.state !== "idle" ? ` is-${item.state}` : ""}`,
          type: "button",
          "data-index": String(item.index),
        });
        button.append(el("span", { class: "gs-opt-label", text: item.label }));
        // Indexed-действие адресуется номером варианта, обычное — своей клавишей.
        const hint = item.actionId
          ? keyHint(this.input, item.actionId)
          : keyHint(this.input, this.defaultActionId, item.index);
        if (hint) button.append(el("kbd", { class: "gs-key", text: hint }));
        button.disabled = item.state === "disabled";
        button.addEventListener("click", () => this.onPick(item.index));
        return button;
      }),
    );
  }

  /** Подсветка нажатия: одна и та же и для мыши, и для клавиши. */
  flash(index: number, kind: "correct" | "wrong" | "press" = "press"): void {
    const button = this.root.querySelector<HTMLButtonElement>(`[data-index="${index}"]`);
    if (!button) return;
    button.classList.add(`is-${kind}`);
    setTimeout(() => button.classList.remove(`is-${kind}`), kind === "press" ? 140 : 320);
  }

  clear(): void {
    this.root.replaceChildren();
    for (const handle of this.subscriptions.values()) handle.dispose();
    this.subscriptions.clear();
  }
}

export class Stimulus {
  readonly root = el("div", { class: "gs-stim" });

  show(content: string, style: Partial<CSSStyleDeclaration> = {}): void {
    this.root.textContent = content;
    Object.assign(this.root.style, { color: "", ...style });
  }

  html(markup: string): void {
    this.root.innerHTML = markup;
  }

  clear(): void {
    this.root.textContent = "";
  }
}

export interface CellState {
  index: number;
  label?: string;
  state?: "idle" | "active" | "done" | "wrong";
}

/** Сетка ячеек: поле для числовой последовательности и позиционного n-back. */
export class CellGrid {
  readonly root = el("div", { class: "gs-grid" });
  private onPick: (index: number) => void = () => {};

  constructor(
    private readonly input?: InputHandle,
    private readonly actionId = "choose",
  ) {
    this.input?.on(this.actionId, (event) => {
      if (event.source !== "keyboard" || typeof event.payload.index !== "number") return;
      const button = this.root.querySelector<HTMLButtonElement>(`[data-index="${event.payload.index}"]`);
      if (!button) return;
      button.classList.add("is-press");
      setTimeout(() => button.classList.remove("is-press"), 140);
    });
  }

  onSelect(cb: (index: number) => void): void {
    this.onPick = cb;
  }

  render(side: number, cells: CellState[]): void {
    this.root.style.gridTemplateColumns = `repeat(${side}, minmax(38px, 62px))`;
    this.root.replaceChildren(
      ...cells.map((cell) => {
        const button = el("button", {
          class: `gs-cell${cell.state && cell.state !== "idle" ? ` is-${cell.state}` : ""}`,
          type: "button",
          "data-index": String(cell.index),
        });
        button.append(el("span", { class: "gs-cell-label", text: cell.label ?? "" }));
        // Клавиш хватает не на всякую сетку: подписываем только адресуемые ячейки.
        const hint = keyHint(this.input, this.actionId, cell.index);
        if (hint) button.append(el("kbd", { class: "gs-key gs-cell-key", text: hint }));
        button.addEventListener("click", () => this.onPick(cell.index));
        return button;
      }),
    );
  }
}

/**
 * Отдельная кнопка вне ряда вариантов: сама подписывает свою клавишу и
 * подсвечивается так же, как варианты.
 */
export class ActionButton {
  readonly root: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly key: HTMLElement;

  constructor(
    private readonly input: InputHandle | undefined,
    private readonly actionId: string,
    text: string,
    className = "btn",
  ) {
    this.root = el("button", { class: className, type: "button", "data-action": actionId });
    this.label = el("span", { class: "gs-opt-label", text });
    this.key = el("kbd", { class: "gs-key" });
    this.root.append(this.label, this.key);
    this.input?.on(actionId, (event) => {
      if (event.source !== "keyboard") return;
      // У удержания подсветка длится ровно столько, сколько нажата клавиша.
      if (event.payload.phase === "down") this.root.classList.add("is-held");
      else if (event.payload.phase === "up") this.root.classList.remove("is-held");
      else this.flash();
    });
    this.sync();
  }

  onClick(cb: () => void): void {
    this.root.addEventListener("click", cb);
  }

  /**
   * Удержание мышью или пальцем. `up` приходит и при уходе курсора с кнопки:
   * иначе отпускание за её пределами оставило бы действие зажатым навсегда.
   */
  onHold(cb: (phase: "down" | "up") => void): void {
    let down = false;
    const press = (event: PointerEvent) => {
      event.preventDefault();
      if (down) return;
      down = true;
      this.root.classList.add("is-held");
      cb("down");
    };
    const release = () => {
      if (!down) return;
      down = false;
      this.root.classList.remove("is-held");
      cb("up");
    };
    this.root.addEventListener("pointerdown", press);
    this.root.addEventListener("pointerup", release);
    this.root.addEventListener("pointercancel", release);
    this.root.addEventListener("pointerleave", release);
  }

  setText(text: string): void {
    this.label.textContent = text;
    this.sync();
  }

  /** Привязка может смениться вместе с профилем раскладки. */
  sync(): void {
    const hint = keyHint(this.input, this.actionId);
    this.key.textContent = hint ?? "";
    this.key.style.display = hint ? "" : "none";
  }

  flash(kind: "correct" | "wrong" | "press" = "press"): void {
    this.root.classList.add(`is-${kind}`);
    setTimeout(() => this.root.classList.remove(`is-${kind}`), kind === "press" ? 140 : 320);
  }
}

export class HintLine {
  readonly root = el("div", { class: "gs-hint" });
  show(text: string): void {
    this.root.textContent = text;
  }
}
