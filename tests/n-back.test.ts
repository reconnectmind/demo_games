import { describe, expect, it } from "vitest";
import { createRngState, headlessRun, Manual } from "@gamespace/core";

import { buildNBackStream, nback, paramsForLevel, type NBackParams, type NBackState } from "../packages/games/src/n-back/index.js";
import { describeContract } from "./contract-suite.js";

describeContract([nback], nback);

const games = [nback];

/** Прогон одного блока: pressWhen решает, нажимать ли «Совпадение» в текущей пробе. */
function runBlock(options: { seed?: number; level?: number; presses?: (state: NBackState) => number } = {}) {
  const run = headlessRun(games, "org.reconnect.n-back", {
    seed: options.seed ?? 7,
    policy: new Manual({ start: options.level ?? 1 }),
  });
  run.instance.start();
  for (let step = 0; step < 4000 && run.instance.phase !== "completed"; step++) {
    const state = run.instance.state as unknown as NBackState;
    const presses = options.presses?.(state) ?? 0;
    for (let i = 0; i < presses; i++) run.instance.submitAction("match", {}, "keyboard");
    run.clock.advance(50);
  }
  return run;
}

const state = (run: ReturnType<typeof runBlock>) => run.instance.state as unknown as NBackState;

describe("n-back: механика потока и блока", () => {
  it("доля целевых проб держится около targetRate", () => {
    const params = paramsForLevel(4) as NBackParams;
    let trials = 0;
    let targets = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const [stream] = buildNBackStream(createRngState(seed), params);
      trials += stream.targets.length;
      targets += stream.targets.filter(Boolean).length;
    }
    expect(trials).toBe(60 * params.blockLength);
    expect(targets / trials).toBeGreaterThan(params.targetRate - 0.08);
    expect(targets / trials).toBeLessThan(params.targetRate + 0.08);
  });

  it("доля совпадений набирается точно, а не в среднем по блоку", () => {
    // Позиции планируются на весь блок, поэтому «тридцать процентов» — это
    // ровно столько проб, сколько получается из длины блока, а не сколько
    // выпало. Разброс от блока к блоку сам по себе шумит в записи.
    for (let level = 0; level <= 8; level++) {
      const params = paramsForLevel(level) as NBackParams;
      const [stream] = buildNBackStream(createRngState(level * 7 + 1), params);
      const eligible = params.blockLength - params.n;
      expect(stream.targets.filter(Boolean).length).toBe(Math.round(params.targetRate * eligible));
    }
  });

  it("повторы не слипаются: одна буква идёт подряд не больше трёх раз", () => {
    // «ABCCCCCCCDEF» — это уже не повтор, а залипание: участник перестаёт
    // сравнивать буквы. Предел общий для любого шага, поэтому проверяется и
    // цепочка шага N, и просто одинаковые буквы подряд.
    for (let level = 0; level <= 8; level++) {
      const params = paramsForLevel(level) as NBackParams;
      for (let seed = 1; seed <= 40; seed++) {
        const [stream] = buildNBackStream(createRngState(seed + level * 100), params);
        for (let i = 0; i < stream.letters.length; i++) {
          const chain = stream.targets[i] && stream.targets[i - params.n] && stream.targets[i - 2 * params.n];
          expect(chain, `уровень ${level}, seed ${seed}: четвёртое вхождение подряд на ${i}`).toBeFalsy();
          const run = [i, i - 1, i - 2, i - 3].every(
            (j) => j >= 0 && stream.letters[j] === stream.letters[i],
          );
          expect(run, `уровень ${level}, seed ${seed}: четыре одинаковые буквы подряд на ${i}`).toBe(false);
        }
      }
    }
  });

  it("непреднамеренных совпадений в потоке нет", () => {
    for (let level = 1; level <= 8; level++) {
      const params = paramsForLevel(level) as NBackParams;
      const [stream] = buildNBackStream(createRngState(level * 13), params);
      for (let i = params.n; i < stream.letters.length; i++) {
        expect(stream.letters[i] === stream.letters[i - params.n]).toBe(stream.targets[i]);
      }
    }
  });

  it("без ответов все целевые пробы становятся промахами", () => {
    const run = runBlock({ seed: 9 });
    const final = state(run);
    expect(run.instance.phase).toBe("completed");
    expect(final.trials).toBe((paramsForLevel(1) as NBackParams).blockLength);
    expect(final.targets).toBeGreaterThan(0);
    expect(final.misses).toBe(final.targets);
    expect(final.correctRejections).toBe(final.trials - final.targets);
    expect(final.hits).toBe(0);
  });

  it("повторное нажатие в той же пробе не удваивает hit", () => {
    const single = runBlock({ seed: 4, presses: (s) => (s.visible && !s.responded && s.targetFlags[s.index] === true ? 1 : 0) });
    const double = runBlock({ seed: 4, presses: (s) => (s.visible && !s.responded && s.targetFlags[s.index] === true ? 3 : 0) });
    const a = state(single);
    const b = state(double);
    expect(a.hits).toBe(a.targets);
    expect(b.hits).toBe(a.hits);
    expect(b.falseAlarms).toBe(0);
    expect(b.misses).toBe(0);
  });

  it("за блок ровно один блочный outcome, отдельные пробы в сложность не идут", () => {
    const run = runBlock({ seed: 12, presses: (s) => (s.visible && !s.responded && s.targetFlags[s.index] === true ? 1 : 0) });
    const outcomes = run.records().filter((r) => r.type === "trial.outcome");
    expect(outcomes.length).toBe(1);
    const payload = outcomes[0]!.payload as { kind: string; accuracy: number; trials: number; scored: boolean };
    expect(payload.kind).toBe("block");
    expect(payload.scored).toBe(true);
    expect(payload.trials).toBe(state(run).trials);
    expect(payload.accuracy).toBe(1);
  });

  it("в обучении после 1-back идёт 2-back, и переход объявлен участнику", () => {
    // На 1-back правило «та же буква, что N шагов назад» неотличимо от «две
    // одинаковые подряд»: пока N не сменился, проверить понимание нечем.
    const run = headlessRun(games, "org.reconnect.n-back", {
      seed: 5,
      policy: new Manual({ start: 0 }),
      training: true,
    });
    run.instance.start();
    const depths = new Set<number>();
    for (let step = 0; step < 6000 && run.instance.phase !== "completed"; step++) {
      const now = run.instance.state as unknown as NBackState;
      depths.add(now.params?.n ?? 0);
      if (now.holding) run.instance.submitAction("match", {}, "keyboard");
      else if (now.visible && !now.responded && now.targetFlags[now.index] === true) {
        run.instance.submitAction("match", {}, "keyboard");
      }
      run.clock.advance(50);
    }
    expect([...depths].sort()).toEqual([1, 2]);
    const announced = run.views.some((view) =>
      /N = 2/.test(((view as unknown as { debrief: { hint?: string } | null }).debrief?.hint ?? "")),
    );
    expect(announced, "смена глубины объявлена до первой буквы новой ступени").toBe(true);
  });

  it("до 2-back участник доходит внутри одной попытки обучения", () => {
    // Ступени шли полным блоком, и вторая начиналась к концу первой минуты —
    // позже, чем кончается попытка. Участник видел только 1-back и уходил с
    // правилом «две одинаковые подряд».
    const run = headlessRun(games, "org.reconnect.n-back", {
      seed: 5,
      policy: new Manual({ start: 0 }),
      training: true,
    });
    run.instance.start();
    let deeperAtMs: number | null = null;
    for (let step = 0; step < 6000 && deeperAtMs === null; step++) {
      const now = run.instance.state as unknown as NBackState;
      if (now.visible && now.params?.n === 2) deeperAtMs = run.clock.now();
      if (now.holding) run.instance.submitAction("match", {}, "keyboard");
      run.clock.advance(50);
    }
    expect(deeperAtMs, "вторая ступень не началась вовсе").not.toBeNull();
    expect(deeperAtMs!).toBeLessThan(25_000);
  });

  it("в зачётном прогоне ступень одна: глубину меняет только уровень", () => {
    const run = runBlock({ seed: 5, level: 0 });
    expect((run.instance.state as unknown as NBackState).params?.n).toBe(1);
    const starts = run.records().filter((r) => r.type === "block.start");
    expect(starts).toHaveLength(1);
  });

  it("итог блока приходит в complete с полями resultSchema", () => {
    const run = runBlock({ seed: 15, presses: (s) => (s.visible && !s.responded && s.targetFlags[s.index] === true ? 1 : 0) });
    const end = run.records().filter((r) => r.type === "run.end").at(-1);
    const summary = (end!.payload as { summary: Record<string, number> }).summary;
    expect(Object.keys(summary).sort()).toEqual(["dPrimeApprox", "falseAlarms", "hits", "misses", "targets", "trials"]);
    expect(summary.dPrimeApprox).toBeGreaterThan(0);
  });
});
