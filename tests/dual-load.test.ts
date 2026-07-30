import { describe, expect, it } from "vitest";
import { headlessRun, Manual } from "@gamespace/core";
import { dualLoad, paramsForLevel, type DualLoadParams, type DualLoadState } from "../packages/games/src/dual-load/index.js";
import { nback, type NBackState } from "../packages/games/src/n-back/index.js";
import { describeContract } from "./contract-suite.js";

describeContract([dualLoad], dualLoad);

const games = [dualLoad];

interface Presses {
  match?: (state: DualLoadState) => number;
  peripheral?: (state: DualLoadState) => number;
}

function runBlock(options: { seed?: number; level?: number } & Presses = {}) {
  const run = headlessRun(games, "org.reconnect.dual-load", {
    seed: options.seed ?? 7,
    policy: new Manual({ start: options.level ?? 1 }),
  });
  run.instance.start();
  for (let step = 0; step < 4000 && run.instance.phase !== "completed"; step++) {
    const state = run.instance.state as unknown as DualLoadState;
    for (let i = 0; i < (options.match?.(state) ?? 0); i++) run.instance.submitAction("match", {}, "keyboard");
    for (let i = 0; i < (options.peripheral?.(state) ?? 0); i++) run.instance.submitAction("peripheral", {}, "keyboard");
    run.clock.advance(50);
  }
  return run;
}

const state = (run: ReturnType<typeof runBlock>) => run.instance.state as unknown as DualLoadState;
const pendingTarget = (s: DualLoadState) =>
  s.primary.visible && !s.primary.responded && s.primary.targetFlags[s.primary.index] === true;

describe("dual-load: композиция ядра n-back", () => {
  it("центральная задача идёт тем же ядром: поток совпадает с одиночным n-back", () => {
    const dual = runBlock({ seed: 21 });
    const solo = headlessRun([nback], "org.reconnect.n-back", { seed: 21, policy: new Manual({ start: 1 }) });
    solo.instance.start();
    const soloState = solo.instance.state as unknown as NBackState;
    const dualState = state(dual);
    expect(dualState.primary.stream).toEqual(soloState.stream);
    expect(dualState.primary.targetFlags).toEqual(soloState.targetFlags);
    expect(dualState.primary.params).toEqual(soloState.params);
  });

  it("таймеры центральной задачи приходят с префиксом primary:", () => {
    const run = runBlock({ seed: 5 });
    const timers = run
      .records()
      .filter((r) => r.type === "input.deadline")
      .map((r) => (r.payload as { timerId: string }).timerId);
    expect(timers).toContain("primary:nb.stim");
    expect(timers).toContain("primary:nb.isi");
    expect(timers).toContain("dl.periph.on");
    expect(timers.filter((id) => id === "nb.stim" || id === "nb.isi")).toEqual([]);
  });

  it("эффекты центральной задачи не утекают наружу как outcome, complete и requestParams", () => {
    const run = runBlock({ seed: 5, match: (s) => (pendingTarget(s) ? 1 : 0), peripheral: (s) => (s.secondary.side ? 1 : 0) });
    const outcomes = run.records().filter((r) => r.type === "trial.outcome");
    expect(outcomes.length).toBe(1);
    const outcome = outcomes[0]!.payload as { kind: string; trials: number; accuracy: number };
    expect(outcome.kind).toBe("block");
    expect(outcome.trials).toBe(state(run).primary.trials + state(run).secondary.cues);
    expect(outcome.accuracy).toBe(1);
    // Параметры запрашивает только dual-load: requestParams центральной задачи проглочен.
    expect(run.records().filter((r) => r.type === "input.params").length).toBe(1);
    const ends = run.records().filter((r) => r.type === "run.end");
    expect(ends.length).toBe(1);
    const summary = (ends[0]!.payload as { summary: Record<string, number> }).summary;
    expect(Object.keys(summary).sort()).toEqual([
      "dualCostMs",
      "peripheralFalseAlarms",
      "peripheralHits",
      "peripheralMisses",
      "primaryAccuracy",
      "trials",
    ]);
    expect(summary.primaryAccuracy).toBe(1);
  });

  it("события центральной задачи помечены каналом primary", () => {
    const run = runBlock({ seed: 5 });
    const stimuli = run.records().filter((r) => r.type === "stimulus.presented");
    expect(stimuli.length).toBeGreaterThan(0);
    for (const record of stimuli) expect((record.payload as { channel?: string }).channel).toBe("primary");
    const peripheral = run.records().filter((r) => r.type === "peripheral.presented");
    expect(peripheral.length).toBeGreaterThan(0);
    for (const record of peripheral) expect((record.payload as { channel?: string }).channel).toBe("secondary");
  });

  it("периферийная метка без ответа становится пропуском, лишнее нажатие — ложной тревогой", () => {
    const ignored = state(runBlock({ seed: 3 }));
    expect(ignored.secondary.cues).toBeGreaterThan(0);
    expect(ignored.secondary.misses).toBe(ignored.secondary.cues);
    expect(ignored.secondary.hits).toBe(0);

    const run = headlessRun(games, "org.reconnect.dual-load", { seed: 3, policy: new Manual({ start: 1 }) });
    run.instance.start();
    run.instance.submitAction("peripheral", {}, "keyboard");
    expect(state(run).secondary.falseAlarms).toBe(1);
    expect(state(run).secondary.cues).toBe(0);
  });

  it("повторное нажатие в одном окне не удваивает ни центральный, ни периферийный hit", () => {
    const once = state(
      runBlock({ seed: 8, match: (s) => (pendingTarget(s) ? 1 : 0), peripheral: (s) => (s.secondary.side && !s.secondary.responded ? 1 : 0) }),
    );
    const thrice = state(
      runBlock({ seed: 8, match: (s) => (pendingTarget(s) ? 3 : 0), peripheral: (s) => (s.secondary.side && !s.secondary.responded ? 3 : 0) }),
    );
    expect(once.primary.hits).toBe(once.primary.targets);
    expect(thrice.primary.hits).toBe(once.primary.hits);
    expect(thrice.secondary.hits).toBe(once.secondary.hits);
    expect(thrice.secondary.falseAlarms).toBe(0);
    expect(thrice.secondary.misses).toBe(0);
  });

  it("RT центральной задачи разделён на пробы с меткой и без неё", () => {
    const run = runBlock({ seed: 14, match: (s) => (pendingTarget(s) ? 1 : 0), peripheral: (s) => (s.secondary.side ? 1 : 0) });
    const final = state(run);
    expect(final.dualRtCount + final.soloRtCount).toBe(final.primary.hits);
    expect(final.dualRtCount).toBeGreaterThan(0);
    const summary = (run.records().filter((r) => r.type === "run.end")[0]!.payload as { summary: { dualCostMs: number } }).summary;
    expect(Number.isFinite(summary.dualCostMs)).toBe(true);
  });

  it("параметры уровня покрывают обе задачи", () => {
    const params = paramsForLevel(6) as DualLoadParams;
    expect(params.peripheralIsiMs).toBe(Math.max(900, 2600 - 180 * 6));
    expect(params.peripheralDeadlineMs).toBe(Math.max(600, 1800 - 120 * 6));
    expect(params.peripheralDeadlineMs).toBeLessThan(params.peripheralIsiMs);
  });
});
