import { describe, expect, it } from "vitest";
import { headlessRun, project, replayCore, Manual, PreflightError } from "@gamespace/core";
import { stroop } from "@gamespace/games";

const games = [stroop];

function runBlock(seed = 7, answers: (view: any) => number = () => 0) {
  const run = headlessRun(games, "org.reconnect.stroop", { seed, policy: new Manual({ start: 1 }) });
  run.instance.start();
  for (let i = 0; i < 200 && run.instance.phase !== "completed"; i++) {
    const last = run.views.at(-1) as any;
    if (last?.word && last.running) {
      run.instance.submitAction("choose", { index: answers(last) });
    }
    run.clock.advance(60);
  }
  return run;
}

describe("stroop как вертикальный срез", () => {
  it("проводит блок до конца и завершает запуск", () => {
    const run = runBlock();
    expect(run.instance.phase).toBe("completed");
    const state = run.instance.state as any;
    expect(state.trial).toBe(20);
  });

  it("одинаковый seed даёт одинаковую последовательность стимулов", () => {
    const a = project(runBlock(11));
    const b = project(runBlock(11));
    expect(a.domain).toEqual(b.domain);
    expect(a.coreState).toEqual(b.coreState);
  });

  it("другой seed даёт другую последовательность", () => {
    const a = project(runBlock(11));
    const b = project(runBlock(12));
    expect(a.domain).not.toEqual(b.domain);
  });

  it("повтор журнала восстанавливает то же состояние ядра", () => {
    const run = runBlock(5);
    const replayed = replayCore(stroop, run.records(), 5);
    expect(replayed).toEqual(run.instance.state);
  });

  it("таймаут засчитывается как ошибка без RT", () => {
    const run = headlessRun(games, "org.reconnect.stroop", { seed: 3, policy: new Manual({ start: 1 }) });
    run.instance.start();
    run.clock.advance(3000);
    const outcomes = run.records().filter((r) => r.type === "trial.outcome");
    expect(outcomes.length).toBeGreaterThan(0);
    expect((outcomes[0]!.payload as any).rtMs).toBeNull();
    expect((outcomes[0]!.payload as any).correct).toBe(false);
  });

  it("preflight отклоняет запуск без объявленной capability", () => {
    expect(() =>
      headlessRun(games, "org.reconnect.stroop", { capabilities: [] }),
    ).toThrow(PreflightError);
  });
});
