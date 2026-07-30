import { describe, expect, it } from "vitest";
import { headlessRun, Manual } from "@gamespace/core";
import { ruleSwitch } from "../packages/games/src/rule-switch/index.js";
import { describeContract } from "./contract-suite.js";

describeContract([ruleSwitch], ruleSwitch);

function start(seed = 4, level = 6) {
  const run = headlessRun([ruleSwitch], "org.reconnect.rule-switch", { seed, policy: new Manual({ start: level }) });
  run.instance.start();
  return run;
}

describe("смена правила", () => {
  it("подсказка приходит раньше стимула на cueLeadMs", () => {
    const run = start(4, 1);
    run.clock.advance(2000);
    const cue = run.records().find((r) => r.type === "cue.presented");
    const stimulus = run.records().find((r) => r.type === "stimulus.presented");
    expect(cue).toBeDefined();
    expect(stimulus).toBeDefined();
    expect(stimulus!.tMs - cue!.tMs).toBe(ruleSwitch.paramsForLevel(1).cueLeadMs);
  });

  it("третье правило появляется только с пятого уровня", () => {
    const low = start(9, 4);
    const high = start(9, 6);
    for (const run of [low, high]) run.clock.advance(20_000);
    const rules = (run: ReturnType<typeof start>) =>
      new Set(run.records().filter((r) => r.type === "cue.presented").map((r) => (r.payload as any).rule));
    expect(rules(low).has("prime")).toBe(false);
    expect([...rules(high)].length).toBeGreaterThanOrEqual(2);
  });

  it("верный ответ по текущему правилу засчитывается", () => {
    const run = start(11, 1);
    run.clock.advance(900);
    const stimulus = run.records().find((r) => r.type === "stimulus.presented");
    expect(stimulus).toBeDefined();
    const { rule, number } = stimulus!.payload as any;
    const correctIndex = rule === "parity" ? (number % 2 === 0 ? 0 : 1) : rule === "magnitude" ? (number < 5 ? 0 : 1) : [2, 3, 5, 7].includes(number) ? 0 : 1;
    run.instance.submitAction("choose", { index: correctIndex });
    const response = run.records().find((r) => r.type === "response");
    expect((response!.payload as any).correct).toBe(true);
  });

  it("итог содержит цену переключения", () => {
    const run = start(2, 3);
    let guard = 0;
    while (run.instance.phase !== "completed" && guard++ < 400) {
      const stimulus = run.records().filter((r) => r.type === "stimulus.presented").at(-1);
      const answered = run.records().filter((r) => r.type === "response").length;
      if (stimulus && answered < (stimulus.payload as any).trial) {
        const { rule, number } = stimulus.payload as any;
        const idx = rule === "parity" ? (number % 2 === 0 ? 0 : 1) : rule === "magnitude" ? (number < 5 ? 0 : 1) : [2, 3, 5, 7].includes(number) ? 0 : 1;
        run.instance.submitAction("choose", { index: idx });
      }
      run.clock.advance(80);
    }
    const end = run.records().find((r) => r.type === "block.end");
    expect(end).toBeDefined();
    expect((end!.payload as any).switchCostMs).toBeTypeOf("number");
    expect((end!.payload as any).trials).toBe(24);
  });
});
