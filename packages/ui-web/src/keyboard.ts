import type { InputController } from "@gamespace/core";

export interface KeyboardOptions {
  /** Клавиши ловятся только пока фокус внутри этого элемента. */
  scope: HTMLElement;
  onKeyVisual?(key: string, accepted: boolean): void;
}

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Раскладка живёт здесь, а не в играх: это то, что позволяет эксперименту
 * принудительно включить F/J/D/K, не трогая ни одного модуля.
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
    const accepted = resolve().handleKey(event.key);
    opts.onKeyVisual?.(event.key === " " ? "Space" : event.key.toUpperCase(), accepted);
    if (accepted) event.preventDefault();
  };

  // Удерживаемые действия требуют отпускания: без него ядро не узнает конец нажатия.
  const onUp = (event: KeyboardEvent) => {
    if (ignored(event)) return;
    if (resolve().handleKeyUp(event.key)) event.preventDefault();
  };

  // Окно потеряло фокус — «up» не придёт, поэтому удержания снимаем сами.
  const onBlur = () => resolve().releaseAll();

  window.addEventListener("keydown", onDown);
  window.addEventListener("keyup", onUp);
  window.addEventListener("blur", onBlur);
  return {
    dispose: () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    },
  };
}
