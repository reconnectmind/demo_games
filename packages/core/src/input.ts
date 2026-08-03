import type {
  ActionEvent,
  ActionPayload,
  Handle,
  InputHandle,
  LayoutProfile,
  SignalSample,
  SignalState,
} from "./contracts.js";
import type { ActionSpec, SignalSpec } from "./manifest.types.js";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
/** Буквы идут рядами клавиатуры: подсказка на ячейке должна легко находиться пальцем. */
const LETTERS = [
  ..."QWERTYUIOP".split(""),
  ..."ASDFGHJKL".split(""),
  ..."ZXCVBNM".split(""),
];

/**
 * Клавиш ровно столько, сколько платформа умеет показать вариантов (36 ячеек —
 * максимум сетки), поэтому кнопки без клавиши не остаётся ни при каком уровне.
 */
export const INDEX_KEYS = [...DIGITS, ...LETTERS];
/** Тот же алфавит, но буквами вперёд: для игр, где сами варианты подписаны цифрами. */
export const LETTER_INDEX_KEYS = [...LETTERS, ...DIGITS];

export function indexKeysFor(keyset: string | undefined): string[] {
  return keyset === "letters-first" ? LETTER_INDEX_KEYS : INDEX_KEYS;
}

const FJDK = ["F", "J", "D", "K", "S", "L"];

/**
 * Какую клавишу нажали физически, независимо от раскладки.
 *
 * Браузер сообщает о нажатии двумя разными вещами. `key` — это символ, который
 * получился: в русской раскладке на месте `W` приходит `ц`, и привязка «газ на
 * W» перестаёт совпадать вовсе. `code` — это место на клавиатуре, и оно от
 * раскладки не зависит: `KeyW` остаётся `KeyW` при любом языке ввода.
 *
 * Привязки в манифестах записаны буквами латиницы, то есть на самом деле —
 * местами на клавиатуре. Значит и сравнивать надо с местом. Здесь `code`
 * приводится обратно к той букве или цифре, которую это место даёт на
 * латинской раскладке; всё остальное (`Enter`, `ArrowUp`, `Space`) в `code` и
 * так записано так же, как в привязке.
 */
export function physicalKey(code: string | undefined): string | null {
  if (!code) return null;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad") && code.length === 7) return code.slice(6);
  if (code === "NumpadEnter") return "Enter";
  return code;
}

export interface SignalSource {
  read(id: string): SignalSample | null;
  state(id: string): SignalState;
}

/** Источника нет: игра обязана остаться играбельной. */
export const absentSignals: SignalSource = {
  read: () => null,
  state: () => "absent",
};

export interface InputControllerOptions {
  actions: ActionSpec[];
  signals: SignalSpec[];
  now(): number;
  /** Куда уходит логическое действие: runtime кладёт его в очередь входов. */
  onAction(event: ActionEvent): void;
  signalSource?: SignalSource;
  profile?: LayoutProfile;
}

/**
 * Игра объявляет логические действия, хост раздаёт клавиши. Ни одна игра
 * больше не знает про физические клавиши и не сканирует DOM в поисках кнопок.
 */
export class InputController implements InputHandle {
  private readonly opts: InputControllerOptions;
  private profile: LayoutProfile;
  private listeners = new Map<string, Set<(e: ActionEvent) => void>>();
  private signalListeners = new Map<string, Set<(s: SignalSample) => void>>();
  private source: SignalSource;
  /** Сколько вариантов показано сейчас: раскладка 1..9 живёт ровно столько. */
  private optionCount = 0;
  private held = new Set<string>();

  constructor(opts: InputControllerOptions) {
    this.opts = opts;
    this.profile = opts.profile ?? "default";
    this.source = opts.signalSource ?? absentSignals;
  }

  setOptionCount(n: number): void {
    this.optionCount = n;
  }

  bindings(): Array<{ id: string; label: string; binding: string }> {
    const fjdk = [...FJDK];
    return this.opts.actions.map((a) => ({
      id: a.id,
      label: a.label,
      binding: this.profile === "fjdk" && !a.indexed ? fjdk.shift() ?? a.defaultBinding : a.defaultBinding,
    }));
  }

  setProfile(profile: LayoutProfile): void {
    this.profile = profile;
  }

  /** Раскладку indexed-действия знает хост: виджет только читает её для подписи. */
  indexKeys(actionId: string): string[] {
    const action = this.opts.actions.find((a) => a.id === actionId);
    if (!action?.indexed) return [];
    return indexKeysFor(action.indexKeyset);
  }

  on(actionId: string, cb: (e: ActionEvent) => void): Handle {
    const set = this.listeners.get(actionId) ?? new Set();
    set.add(cb);
    this.listeners.set(actionId, set);
    return { dispose: () => set.delete(cb) };
  }

  submit(actionId: string, payload: ActionPayload = {}, source: ActionEvent["source"] = "pointer"): void {
    const event: ActionEvent = { actionId, payload, tMs: this.opts.now(), source };
    this.opts.onAction(event);
    this.listeners.get(actionId)?.forEach((cb) => cb(event));
  }

  /** Возвращает true, если клавиша принадлежит игре: хост тогда гасит событие. */
  handleKey(key: string, code?: string): boolean {
    const normalized = key.length === 1 ? key.toUpperCase() : key;
    const place = physicalKey(code);
    const indexed = this.opts.actions.find((a) => a.indexed);
    if (indexed) {
      const keys = indexKeysFor(indexed.indexKeyset);
      const typed = keys.indexOf(normalized);
      const idx = typed >= 0 ? typed : place ? keys.indexOf(place) : -1;
      if (idx >= 0 && idx < this.optionCount) {
        this.submit(indexed.id, { index: idx }, "keyboard");
        return true;
      }
    }
    const match = this.match(key, normalized) ?? (place ? this.match(place, place) : undefined);
    if (!match) return false;
    const action = this.opts.actions.find((a) => a.id === match.id);
    if (action?.holdable) {
      // Автоповтор клавиатуры не создаёт новых нажатий: удержание — одно событие.
      if (this.held.has(match.id)) return true;
      this.held.add(match.id);
      this.submit(match.id, { phase: "down" }, "keyboard");
      return true;
    }
    this.submit(match.id, {}, "keyboard");
    return true;
  }

  /** Отпускание значимо только для удерживаемых действий. */
  handleKeyUp(key: string, code?: string): boolean {
    const normalized = key.length === 1 ? key.toUpperCase() : key;
    const place = physicalKey(code);
    const match = this.match(key, normalized) ?? (place ? this.match(place, place) : undefined);
    if (!match) return false;
    const action = this.opts.actions.find((a) => a.id === match.id);
    if (!action?.holdable) return false;
    if (!this.held.delete(match.id)) return false;
    this.submit(match.id, { phase: "up" }, "keyboard");
    return true;
  }

  /**
   * Фокус ушёл из окна: удержания нужно снять, иначе площадка уедет в стену и
   * останется там, потому что «up» уже никогда не придёт.
   */
  releaseAll(): void {
    for (const id of [...this.held]) {
      this.held.delete(id);
      this.submit(id, { phase: "up" }, "keyboard");
    }
  }

  private match(key: string, normalized: string): { id: string } | undefined {
    // Сравнение без регистра: иначе «Enter» и «ArrowLeft» не совпали бы никогда.
    const upper = normalized.toUpperCase();
    return this.bindings().find((b) => b.binding.toUpperCase() === upper || (b.binding === "Space" && key === " "));
  }

  setSignalSource(source: SignalSource): void {
    this.source = source;
  }

  /** Хост толкает сюда сэмплы решающей частоты — те, что уходят в ядро и журнал. */
  pushSignal(id: string, sample: SignalSample): void {
    this.signalListeners.get(id)?.forEach((cb) => cb(sample));
  }

  signal(id: string): SignalSample | null {
    return this.source.read(id);
  }

  onSignal(id: string, cb: (s: SignalSample) => void): Handle {
    const set = this.signalListeners.get(id) ?? new Set();
    set.add(cb);
    this.signalListeners.set(id, set);
    return { dispose: () => set.delete(cb) };
  }

  signalState(id: string): SignalState {
    const declared = this.opts.signals.find((s) => s.id === id);
    if (!declared) return "absent";
    return this.source.state(id);
  }
}
