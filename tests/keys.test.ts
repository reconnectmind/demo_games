// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { InputController, physicalKey } from "@gamespace/core";
import type { ActionSpec } from "../packages/core/src/manifest.types.js";
import { bindKeyboard } from "@gamespace/ui-web";

const ACTIONS: ActionSpec[] = [
  { id: "throttle", label: "Газ", defaultBinding: "W", holdable: true },
  { id: "brake", label: "Тормоз", defaultBinding: "S", holdable: true },
  { id: "gearUp", label: "Выше", defaultBinding: "E" },
];

function rig() {
  const log: Array<{ id: string; phase?: string }> = [];
  const input = new InputController({
    actions: ACTIONS,
    signals: [],
    now: () => 0,
    onAction: (e) => log.push({ id: e.actionId, phase: e.payload.phase as string | undefined }),
  });
  document.body.replaceChildren();
  (document.activeElement as HTMLElement | null)?.blur();
  const scope = document.createElement("div");
  document.body.append(scope);
  const bound = bindKeyboard(input, { scope });
  return { log, input, scope, bound };
}

function press(type: "keydown" | "keyup", init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent(type, { ...init, bubbles: true }));
}

describe("клавиатура", () => {
  it("код клавиши читается как место, а не как буква", () => {
    expect(physicalKey("KeyW")).toBe("W");
    expect(physicalKey("Digit4")).toBe("4");
    expect(physicalKey("Numpad4")).toBe("4");
    expect(physicalKey("NumpadEnter")).toBe("Enter");
    expect(physicalKey("ArrowLeft")).toBe("ArrowLeft");
    expect(physicalKey(undefined)).toBe(null);
  });

  it("русская раскладка нажимает те же места, что и латинская", () => {
    // В русской раскладке на месте W приходит «ц», и по букве оно не совпадало ни
    // с чем: газ просто не нажимался, пока язык ввода не переключат обратно.
    const { log, bound } = rig();
    press("keydown", { key: "ц", code: "KeyW" });
    press("keyup", { key: "ц", code: "KeyW" });
    press("keydown", { key: "у", code: "KeyE" });
    expect(log).toEqual([
      { id: "throttle", phase: "down" },
      { id: "throttle", phase: "up" },
      { id: "gearUp", phase: undefined },
    ]);
    bound.dispose();
  });

  it("отпускание доходит всегда, куда бы ни ушёл фокус", () => {
    // Педаль залипала так: держишь газ, щёлкаешь мышью по кнопке рядом с
    // площадкой — и «up» отбрасывался вместе с «down», потому что фокус уехал.
    const { log, bound } = rig();
    press("keydown", { key: "w", code: "KeyW" });
    // И тормоз заодно: его отпустят с зажатым Cmd, как это выходит при Cmd+Tab.
    press("keydown", { key: "s", code: "KeyS" });

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    press("keyup", { key: "w", code: "KeyW" });
    expect(log.at(-1)).toEqual({ id: "throttle", phase: "up" });

    press("keyup", { key: "s", code: "KeyS", metaKey: true });
    expect(log.at(-1)).toEqual({ id: "brake", phase: "up" });
    bound.dispose();
  });

  it("уход окна снимает все удержания", () => {
    const { log, bound } = rig();
    press("keydown", { key: "w", code: "KeyW" });
    press("keydown", { key: "s", code: "KeyS" });
    window.dispatchEvent(new Event("blur"));
    expect(log.filter((e) => e.phase === "up").map((e) => e.id).sort()).toEqual(["brake", "throttle"]);
    bound.dispose();
  });

  it("лишнее отпускание никого не будит", () => {
    const { log, bound } = rig();
    press("keyup", { key: "w", code: "KeyW" });
    expect(log).toEqual([]);
    bound.dispose();
  });
});
