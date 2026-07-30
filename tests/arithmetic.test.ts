import { describe, expect, it } from "vitest";
import { headlessRun, Manual, type HeadlessRun } from "@gamespace/core";
import { arithmetic } from "../packages/games/src/arithmetic/index.js";
import type { ArithmeticState, ArithmeticView } from "../packages/games/src/arithmetic/index.js";
import { describeContract } from "./contract-suite.js";

const games = [arithmetic];

describeContract(games, arithmetic);

function startRun(options: Record<string, unknown> = {}): HeadlessRun {
  const run = headlessRun(games, "org.reconnect.arithmetic", {
    seed: 7,
    policy: new Manual({ start: 1 }),
    ...options,
  });
  run.instance.start();
  return run;
}

const core = (run: HeadlessRun): ArithmeticState => run.instance.state as unknown as ArithmeticState;

describe("арифметический спринт", () => {
  it("верный ответ попадает в исход как correct с измеренным RT", () => {
    const run = startRun();
    const pending = core(run).pending;
    expect(pending).not.toBeNull();
    run.clock.advance(400);
    run.instance.submitAction("choose", { index: pending!.options.indexOf(pending!.answer) });

    const outcomes = run.records().filter((r) => r.type === "trial.outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.payload).toMatchObject({ kind: "trial", correct: true, rtMs: 400 });
    expect(core(run).correct).toBe(1);
  });

  it("варианты содержат ответ ровно один раз и не повторяются", () => {
    const run = startRun();
    const distance = 6;
    let checked = 0;
    for (let step = 0; step < 20; step++) {
      const pending = core(run).pending;
      if (!pending) {
        run.clock.advance(150);
        continue;
      }
      expect(pending.options).toHaveLength(4);
      expect(new Set(pending.options).size).toBe(4);
      expect(pending.options.filter((v) => v === pending.answer)).toHaveLength(1);
      for (const option of pending.options) {
        if (option === pending.answer) continue;
        expect(Math.abs(option - pending.answer)).toBeLessThanOrEqual(distance);
      }
      checked++;
      run.instance.submitAction("choose", { index: pending.options.indexOf(pending.answer) });
      run.clock.advance(150);
    }
    expect(checked).toBeGreaterThan(4);
    expect(core(run).correct).toBe(checked);
  });

  it("спринт заканчивается ровно по timeLimitMs", () => {
    const run = startRun();
    run.clock.advance(59_999);
    expect(run.instance.phase).not.toBe("completed");
    run.clock.advance(1);
    expect(run.instance.phase).toBe("completed");

    const end = run.records().filter((r) => r.type === "run.end").at(-1);
    expect(end?.tMs).toBe(60_000);
    expect((end?.payload as { summary: Record<string, number> }).summary).toEqual({
      trials: 1,
      correct: 0,
      meanRtMs: 0,
      throughputPerMin: 0,
    });
  });

  it("submit без значения и choose с чужим индексом ничего не меняют", () => {
    const run = startRun();
    const before = structuredClone(run.instance.state);
    run.instance.input.submit("submit", {}, "keyboard");
    run.instance.input.submit("submit", { value: "" }, "keyboard");
    run.instance.input.submit("submit", { value: "не число" }, "keyboard");
    run.instance.submitAction("choose", { index: 99 });
    run.instance.submitAction("choose", { index: -1 });
    expect(run.instance.state).toEqual(before);
    expect(run.records().some((r) => r.type === "trial.outcome")).toBe(false);
  });

  it("в режиме text-entry вариантов нет, а ответ числом засчитывается", () => {
    const run = startRun({ overrides: { responseMode: "text-entry" } });
    const pending = core(run).pending;
    expect(pending!.options).toEqual([]);
    const view = run.views.at(-1) as unknown as ArithmeticView;
    expect(view.options).toEqual([]);
    expect(view.responseMode).toBe("text-entry");

    run.clock.advance(250);
    run.instance.input.submit("submit", { value: String(pending!.answer) }, "pointer");
    const outcome = run.records().find((r) => r.type === "trial.outcome");
    expect(outcome?.payload).toMatchObject({ correct: true, rtMs: 250 });
  });
});
