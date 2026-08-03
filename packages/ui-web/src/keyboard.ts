import { physicalKey, type InputController } from "@gamespace/core";

export interface KeyboardOptions {
  /** Клавиши ловятся только пока фокус внутри этого элемента. */
  scope: HTMLElement;
  onKeyVisual?(key: string, accepted: boolean): void;
}

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Раскладка живёт здесь, а не в играх: это то, что позволяет эксперименту
 * принудительно включить F/J/D/K, не трогая ни одного модуля.
 *
 * Нажатие и отпускание пропускаются через разные сита, и это не небрежность, а
 * единственный способ не залипнуть. Нажатие имеет право не дойти до игры: курсор
 * стоит в поле ввода, нажат Cmd, фокус ушёл из площадки — во всех этих случаях
 * клавиша принадлежит не игре. Отпускание же отдаётся всегда. Оно ничего не
 * начинает, оно только заканчивает уже начатое, и снять можно ровно то, что
 * было нажато: если нажатия не было, ядро само вернёт «не моё». Пока «up»
 * фильтровался наравне с «down», достаточно было в удержанном газе щёлкнуть
 * мышью по любой кнопке рядом с площадкой — фокус переезжал, отпускание
 * отбрасывалось, и педаль оставалась вдавленной до конца заезда.
 */
export function bindKeyboard(
  input: InputController | (() => InputController),
  opts: KeyboardOptions,
): { dispose(): void } {
  const resolve = () => (typeof input === "function" ? input() : input);
  const ignored = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && (EDITABLE.has(target.tagName) || target.isContentEditable)) return true;
    if (event.metaKey || event.ctrlKey || event.altKey) return true;
    return !opts.scope.contains(document.activeElement) && document.activeElement !== document.body;
  };

  const onDown = (event: KeyboardEvent) => {
    if (ignored(event)) return;
    const accepted = resolve().handleKey(event.key, event.code);
    const place = physicalKey(event.code) ?? event.key;
    opts.onKeyVisual?.(place === " " ? "Space" : place.toUpperCase(), accepted);
    if (accepted) event.preventDefault();
  };

  // Удерживаемые действия требуют отпускания: без него ядро не узнает конец нажатия.
  const onUp = (event: KeyboardEvent) => {
    if (resolve().handleKeyUp(event.key, event.code)) event.preventDefault();
  };

  // Окно потеряло фокус — «up» не придёт, поэтому удержания снимаем сами.
  const onBlur = () => resolve().releaseAll();

  window.addEventListener("keydown", onDown);
  window.addEventListener("keyup", onUp);
  window.addEventListener("blur", onBlur);
  // Смена языка ввода, Cmd+Tab, системная панель — всё это уводит окно так, что
  // «up» до него уже не доходит. Видимость страницы ловит эти случаи там, где
  // `blur` молчит.
  document.addEventListener("visibilitychange", onBlur);
  return {
    dispose: () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
    },
  };
}
