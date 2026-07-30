import { describe, expect, it } from "vitest";
import { headlessRun, Manual, type HeadlessRun, type Json } from "@gamespace/core";
import { numberSequence } from "../packages/games/src/number-sequence/index.js";
import type { NumberSequenceParams, NumberSequenceState } from "../packages/games/src/number-sequence/index.js";
import { describeContract } from "./contract-suite.js";

const games = [numberSequence];

describeContract(games, numberSequence);

const level1 = numberSequence.paramsForLevel(1) as NumberSequenceParams;

function startRun(options: Record<string, unknown> = {}): HeadlessRun {
  const run = headlessRun(games, "org.reconnect.number-sequence", {
    seed: 5,
    policy: new Manual({ start: 1 }),
    ...options,
  });
  run.instance.start();
  return run;
}

const core = (run: HeadlessRun): NumberSequenceState => run.instance.state as unknown as NumberSequenceState;

function pressExpected(run: HeadlessRun): void {
  const state = core(run);
  if (state.expected < 1) return;
  run.instance.submitAction("choose", { index: state.layout.indexOf(state.expected) });
}

describe("числа по порядку", () => {
  it("последовательность без ошибок даёт block-исход с точностью 1", () => {
    const run = startRun();
    const length = core(run).lastNumber;
    expect(length).toBe(level1.sequenceLength);
    for (let i = 0; i < length; i++) {
      pressExpected(run);
      run.clock.advance(200);
    }
    const outcomes = run.records().filter((r) => r.type === "trial.outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.payload).toMatchObject({ kind: "block", scored: true, accuracy: 1, trials: length });
  });

  it("промах по дедлайну не сдвигает ожидаемое число и перезапускает окно", () => {
    const run = startRun();
    const expected = core(run).expected;
    const layout = [...core(run).layout];

    run.clock.advance(level1.deadlineMs);
    expect(core(run).expected).toBe(expected);
    expect(core(run).layout).toEqual(layout);
    expect(core(run).errors).toBe(1);
    // Пропуск — не нажатие: presses считает только реальные нажатия.
    expect(core(run).presses).toBe(0);

    run.clock.advance(level1.deadlineMs);
    expect(core(run).errors).toBe(2);
    expect(core(run).expected).toBe(expected);
    expect(core(run).seqTrials).toBe(2);
  });

  it("ошибочное нажатие считается ошибкой, но не сбрасывает последовательность", () => {
    const run = startRun();
    const expected = core(run).expected;
    const wrongCell = core(run).layout.findIndex((n) => n > 0 && n !== expected);
    run.instance.submitAction("choose", { index: wrongCell });
    expect(core(run).expected).toBe(expected);
    expect(core(run).errors).toBe(1);
    expect(core(run).seqCorrect).toBe(0);

    pressExpected(run);
    expect(core(run).expected).toBe(expected + 1);
    expect(core(run).seqCorrect).toBe(1);
    expect(core(run).errors).toBe(1);
  });

  it("снимок и восстановление сохраняют раскладку поля и ожидаемое число", () => {
    const run = startRun();
    for (let i = 0; i < 3; i++) {
      pressExpected(run);
      run.clock.advance(150);
    }
    const before = core(run);
    expect(before.expected).toBe(4);

    const snapshot = run.instance.snapshot();
    expect(snapshot.pendingDeadlines.map((d) => d.timerId)).toContain("sequence.press");

    const restored = headlessRun(games, "org.reconnect.number-sequence", { seed: 5, policy: new Manual({ start: 1 }) });
    restored.instance.restore(snapshot);
    expect(core(restored).layout).toEqual(before.layout);
    expect(core(restored).expected).toBe(before.expected);

    restored.instance.start();
    pressExpected(restored);
    expect(core(restored).expected).toBe(before.expected + 1);
  });

  it("три последовательности завершают запуск с итогом", () => {
    let summary: Json = null;
    const run = headlessRun(games, "org.reconnect.number-sequence", {
      seed: 9,
      policy: new Manual({ start: 1 }),
      onComplete: (value) => {
        summary = value;
      },
    });
    run.instance.start();
    for (let step = 0; step < 500 && run.instance.phase !== "completed"; step++) {
      pressExpected(run);
      run.clock.advance(100);
    }
    expect(run.instance.phase).toBe("completed");
    expect(summary).toMatchObject({
      sequences: 3,
      presses: 3 * level1.sequenceLength,
      errors: 0,
      meanPressRtMs: expect.any(Number),
    });
  });
});
