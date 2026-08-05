import { type Handle, type InputHandle, type TrialDebrief } from "@gamespace/core";

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
 * Что напечатано на этом же месте в русской раскладке. Привязки записаны
 * латиницей, но означают места на клавиатуре, а на лабораторном ноутбуке в этих
 * местах стоит `Й Ц У`: без второй буквы участник искал бы `Q`, которой на
 * клавише нет.
 */
const CYRILLIC_LEGEND: Record<string, string> = {
  Q: "Й", W: "Ц", E: "У", R: "К", T: "Е", Y: "Н", U: "Г", I: "Ш", O: "Щ", P: "З",
  A: "Ф", S: "Ы", D: "В", F: "А", G: "П", H: "Р", J: "О", K: "Л", L: "Д",
  Z: "Я", X: "Ч", C: "С", V: "М", B: "И", N: "Т", M: "Ь",
};

export function cyrillicLegend(binding: string): string | null {
  return binding.length === 1 ? CYRILLIC_LEGEND[binding.toUpperCase()] ?? null : null;
}

/** Подпись клавиши: латинская буква и то, что на этом месте стоит в русской раскладке. */
function keyCap(binding: string): HTMLElement {
  const cap = el("kbd", { class: "gs-key" }, [el("span", { class: "gs-key-main", text: keyLabel(binding) })]);
  const legend = cyrillicLegend(binding);
  if (legend) cap.append(el("span", { class: "gs-key-legend", text: legend }));
  return cap;
}

/**
 * Подпись клавиши берётся из фактической привязки, а не из констант виджета:
 * иначе профиль с другой ёмкостью поменял бы управление, а кнопки продолжали бы
 * врать. Пустая привязка — законное состояние: в этом профиле действие клавиши
 * не получило, и подписывать нечего.
 */
export function keyHint(input: InputHandle | undefined, actionId: string, index?: number): string | null {
  const raw = rawBinding(input, actionId, index);
  return raw ? keyLabel(raw) : null;
}

/** Сама привязка, без человеческого имени: нужна там, где рисуется клавиша целиком. */
function rawBinding(input: InputHandle | undefined, actionId: string, index?: number): string | null {
  if (!input) return null;
  const binding = input.bindings().find((b) => b.id === actionId);
  if (!binding) return null;
  if (index === undefined) return binding.binding || null;
  return input.indexKeys(actionId)[index] ?? null;
}

/**
 * Множитель размера стимулов. Живёт в переменной темы, потому что размер — дело
 * представления, а не игры; отсюда его берут канвасы, которым CSS-переменная
 * недоступна напрямую. Без темы (тесты, безголовый прогон) множитель равен единице.
 */
export function stimulusScale(): number {
  if (typeof getComputedStyle !== "function" || typeof document === "undefined") return 1;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--gs-scale");
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
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
        const binding = item.actionId
          ? rawBinding(this.input, item.actionId)
          : rawBinding(this.input, this.defaultActionId, item.index);
        if (binding) button.append(keyCap(binding));
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
    // Размер ячейки задан стилями через общий множитель стимулов; виджет говорит
    // только про число столбцов, иначе px из кода не подчинялись бы множителю.
    this.root.style.setProperty("--gs-grid-side", String(side));
    this.root.replaceChildren(
      ...cells.map((cell) => {
        const button = el("button", {
          class: `gs-cell${cell.state && cell.state !== "idle" ? ` is-${cell.state}` : ""}`,
          type: "button",
          "data-index": String(cell.index),
        });
        button.append(el("span", { class: "gs-cell-label", text: cell.label ?? "" }));
        // Клавиш хватает не на всякую сетку: подписываем только адресуемые ячейки.
        const binding = rawBinding(this.input, this.actionId, cell.index);
        if (binding) {
          const cap = keyCap(binding);
          cap.classList.add("gs-cell-key");
          button.append(cap);
        }
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

  /** Привязка может смениться вместе с профилем ввода. */
  sync(): void {
    const binding = rawBinding(this.input, this.actionId);
    this.key.replaceChildren();
    this.key.style.display = binding ? "" : "none";
    if (!binding) return;
    this.key.append(el("span", { class: "gs-key-main", text: keyLabel(binding) }));
    const legend = cyrillicLegend(binding);
    if (legend) this.key.append(el("span", { class: "gs-key-legend", text: legend }));
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

/**
 * Разбор ошибки словами. Ядро отдаёт «что требовалось» и «что пришло», фраза
 * собирается здесь: три случая — не тот ответ, ответа не было, отвечать было не
 * нужно, — и участник в обучении узнаёт, в чём именно ошибся.
 */
export function debriefText(debrief: TrialDebrief | null | undefined): string {
  if (!debrief) return "";
  const { expected, got } = debrief;
  if (expected === null && got === null) return "";
  if (expected === null) return "Здесь нажимать было не нужно.";
  if (got === null) return `Ответа не было. Нужно было: ${expected}.`;
  return `Вы выбрали ${got}, а нужно было ${expected}.`;
}

export type Verdict = "hit" | "miss" | null;

const HIT_NAMES = new Set(["correct", "hit", "return", "resumed"]);

/**
 * Исход пробы к одному из двух знаков. Внутри модулей исходов больше — «мимо»,
 * «пропуск», «не успел», — но участнику различать их не нужно и вредно: он
 * начинает разбирать подпись вместо следующего стимула. Разбор ошибки — дело
 * обучения, где на него есть время.
 */
export function verdictOf(feedback: string | null | undefined): Verdict {
  if (!feedback) return null;
  return HIT_NAMES.has(feedback) ? "hit" : "miss";
}

/**
 * Знак вместо слова и без цвета. Цветная подпись в задаче про цвет — источник
 * помех: зелёное «верно» рядом со стимулом Струпа само становится стимулом. По
 * той же причине место под знак занято всегда, иначе строка дёргала бы сцену.
 */
export class FeedbackMark {
  readonly root = el("div", { class: "gs-feedback" });
  private readonly mark = el("span", { class: "gs-mark" });
  private readonly reason = el("span", { class: "gs-mark-reason" });

  constructor() {
    this.root.append(this.mark, this.reason);
  }

  /** `reason` показывается только в обучении: в зачётном прогоне его не передают. */
  show(verdict: Verdict, reason = ""): void {
    this.mark.textContent = verdict === "hit" ? "✓" : verdict === "miss" ? "✗" : "";
    this.reason.textContent = verdict ? reason : "";
  }
}
