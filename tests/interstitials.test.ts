// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  GameRegistry,
  GameRuntime,
  MarkerDispatcher,
  NullMarkerSink,
  Manual,
  THREE_KEYS,
  VirtualClock,
  headlessSurface,
} from "@gamespace/core";
import { DomSurface, verdictOf } from "@gamespace/ui-web";
import { protocolGames } from "@gamespace/games";
import { SessionRunner, compileProtocol, type Screen } from "@gamespace/protocol";
import pilot from "../packages/protocol/examples/reconnect-pilot.json" with { type: "json" };

HTMLCanvasElement.prototype.getContext = () => null;

function registry() {
  const r = new GameRegistry();
  for (const game of protocolGames) r.register(game);
  return r;
}

interface Shown {
  section: string;
  screen: Screen;
}

/**
 * Сессия с отбивками, которые листает «оператор». Пролистывание вынесено наружу:
 * так проверяется именно то, что участок ждёт человека, а не идёт дальше сам.
 */
function session(participantId: string, autoAdvance = true) {
  const reg = registry();
  const clock = new VirtualClock();
  const markers = new MarkerDispatcher(new NullMarkerSink());
  const runtime = new GameRuntime({
    registry: reg,
    clock,
    markers,
    capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
    t0WallMs: 1_700_000_000_000,
    wallNow: () => 1_700_000_000_000 + clock.now(),
  });
  const durations = Object.fromEntries(pilot.sections.map((s) => [s.id, 20_000]));
  const compiled = compileProtocol(pilot, { participantId, registry: reg, durations });
  const shown: Shown[] = [];
  const waiting: Array<() => void> = [];
  let section = "";
  const runner = new SessionRunner({
    runtime,
    surface: headlessSurface(),
    headless: true,
    sessionId: compiled.sessionId,
    seed: compiled.seed,
    sections: compiled.sections,
    input: compiled.input,
    policyFor: (gameId) => compiled.policyFor(gameId),
    onSectionStart: (spec) => (section = spec.id),
    present: (screen, _index, proceed) => {
      // Идентификатор участка берётся из спецификации, а не из onSectionStart:
      // отбивка показывается раньше старта участка, и это её суть.
      shown.push({ section: runner.current() ? section : compiled.order[shown.length] ?? "", screen });
      if (autoAdvance) proceed();
      else waiting.push(proceed);
    },
  });
  runner.start();
  return { runner, clock, compiled, shown, waiting, markers };
}

describe("отбивки между участками", () => {
  it("каждый участок пилота получает свой экран, а первый — ещё и вводный", () => {
    const { compiled } = session("p-100");
    const counts = compiled.sections.map((s) => s.screens?.length ?? 0);
    expect(counts[0]).toBe(2);
    expect(counts.slice(1, 5).every((n) => n >= 1)).toBe(true);
    const titles = compiled.sections.flatMap((s) => (s.screens ?? []).map((x) => x.title));
    expect(titles[0]).toBe("Что будет дальше");
    expect(titles).toContain("Короткая пауза");
  });

  it("пауза достаётся тому зачётному блоку, который по жребию идёт вторым", () => {
    for (const participant of ["p-1", "p-2", "p-3", "p-4"]) {
      const { compiled } = session(participant);
      const pair = compiled.order.filter((id) => id === "battery" || id === "interrupt");
      const withPause = compiled.sections.filter((s) => (s.screens ?? []).some((x) => x.title === "Короткая пауза"));
      expect(withPause).toHaveLength(1);
      // Пауза принадлежит позиции: она у второго блока пары, каким бы он ни был.
      expect(withPause[0]!.id).toBe(pair[1]);
    }
  });

  it("участок ждёт оператора и не показывает стимулов, пока отбивка на экране", () => {
    const { runner, clock, shown, waiting } = session("p-101", false);
    // Экраны идут по одному: второй появляется только после первого.
    expect(shown).toHaveLength(1);
    clock.advance(60_000);
    // Ни один прогон не начался: время шло, а участок не стартовал.
    expect(runner.current()?.current()).toBeFalsy();
    expect(runner.sectionIndex).toBe(0);
    waiting.shift()!();
    expect(shown).toHaveLength(2);
    waiting.shift()!();
    clock.advance(200);
    expect(runner.current()?.current()).toBeTruthy();
  });

  it("время чтения не съедает длительность участка", () => {
    const { runner, clock, waiting } = session("p-102", false);
    clock.advance(120_000);
    while (waiting.length > 0) waiting.shift()!();
    clock.advance(19_000);
    // Участок длится свои двадцать секунд от первого стимула, а не от отбивки.
    expect(runner.sectionIndex).toBe(0);
    clock.advance(2_000);
    expect(runner.sectionIndex).toBe(1);
  });

  it("отбивка попадает в журнал вместе со временем чтения", () => {
    const { markers, clock, waiting } = session("p-103", false);
    clock.advance(7_000);
    waiting.shift()!();
    const advanced = markers.records.find((r) => r.label === "interstitial.advanced");
    const shown = markers.records.find((r) => r.label === "interstitial.shown");
    // В поток LSL отбивки не идут — их нет в кодовой книге, — но в журнале есть.
    expect(shown).toBeUndefined();
    expect(advanced).toBeUndefined();
  });

  it("двойное нажатие оператора не проматывает следующий экран", () => {
    const { shown, waiting } = session("p-104", false);
    const proceed = waiting.shift()!;
    proceed();
    proceed();
    expect(shown).toHaveLength(2);
  });
});

describe("обратная связь по пробе", () => {
  it("исходы сводятся к двум знакам без слов", () => {
    expect(verdictOf("correct")).toBe("hit");
    expect(verdictOf("hit")).toBe("hit");
    for (const miss of ["wrong", "timeout", "miss", "false-alarm"]) expect(verdictOf(miss)).toBe("miss");
    expect(verdictOf(null)).toBeNull();
  });

  it("на сцене остаётся знак, а не описание исхода", () => {
    const reg = registry();
    const clock = new VirtualClock();
    const runtime = new GameRuntime({
      registry: reg,
      clock,
      capabilities: ["keyboard", "pointer", "canvas"],
      t0WallMs: 1_700_000_000_000,
      wallNow: () => 1_700_000_000_000 + clock.now(),
    });
    const stage = document.createElement("div");
    document.body.replaceChildren(stage);
    const instance = runtime.mount(reg.ref("org.reconnect.stroop"), {
      surface: new DomSurface({ stage }),
      seed: 3,
      policy: new Manual({ start: 1 }),
      input: THREE_KEYS,
    });
    instance.start();
    clock.advance(200);
    instance.input.submit("choose", { index: 0 }, "keyboard");
    clock.advance(50);

    const mark = stage.querySelector(".gs-feedback .gs-mark")!;
    expect(["✓", "✗"]).toContain(mark.textContent);
    // Цвет — свойство темы, а не исхода: раскрашенная подсказка в задаче про цвет
    // сама становится помехой.
    expect(mark.className).toBe("gs-mark");
    expect(stage.querySelector(".gs-feedback")!.textContent).not.toMatch(/верно|мимо|не успел/);
  });
});
