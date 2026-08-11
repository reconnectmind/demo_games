import { describe, expect, it } from "vitest";
import { createRngState, headlessRun, Manual, type HeadlessRun } from "@gamespace/core";
import { arithmetic, buildExpression, paramsForLevel } from "../packages/games/src/arithmetic/index.js";
import type { ArithmeticParams, ArithmeticState, ArithmeticView } from "../packages/games/src/arithmetic/index.js";
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
    // Число вариантов — ось из таблицы уровней, а не константа: закрепить её
    // вправе протокол, и тест не должен знать за него.
    const expected = paramsForLevel(1).optionCount as number;
    const distance = paramsForLevel(1).distractorDistance as number;
    let checked = 0;
    for (let step = 0; step < 20; step++) {
      const pending = core(run).pending;
      if (!pending) {
        run.clock.advance(150);
        continue;
      }
      expect(pending.options).toHaveLength(expected);
      expect(new Set(pending.options).size).toBe(expected);
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

  it("внутри уровня примеры одной трудности: операнды из объявленной полосы", () => {
    // Раньше на одном уровне соседствовали «3 + 2» и «27 + 24»: операнды брались
    // от единицы, и уровень задавал только потолок. Участник видел случайный
    // разброс, а не ступень.
    for (let level = 0; level <= 10; level++) {
      const params = paramsForLevel(level) as unknown as ArithmeticParams;
      const low = Math.ceil(Math.max(2, params.operandMax) / 2);
      let rng = createRngState(level + 1);
      for (let trial = 0; trial < 200; trial++) {
        const [expr, next] = buildExpression(rng, params);
        rng = next;
        const numbers = expr.expr.split(/[^0-9]+/).filter(Boolean).map(Number);
        if (expr.expr.includes("×")) {
          // У умножения своя полоса: «32 × 9» и «32 + 17» — разная работа.
          const [a, b] = numbers as [number, number];
          expect(a).toBeLessThanOrEqual(params.factorMax);
          expect(b).toBeLessThanOrEqual(params.factorMax);
          const addend = numbers[2];
          if (addend !== undefined) expect(addend).toBeGreaterThanOrEqual(low);
          continue;
        }
        for (const value of numbers) {
          expect(value, `уровень ${level}: ${expr.expr}`).toBeGreaterThanOrEqual(low);
          expect(value, `уровень ${level}: ${expr.expr}`).toBeLessThanOrEqual(params.operandMax);
        }
      }
    }
  });

  it("уровень поднимает и полосу операндов, и множители", () => {
    const easy = paramsForLevel(1) as unknown as ArithmeticParams;
    const hard = paramsForLevel(9) as unknown as ArithmeticParams;
    expect(hard.operandMax).toBeGreaterThan(easy.operandMax);
    expect(hard.factorMax).toBeGreaterThan(easy.factorMax);
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
