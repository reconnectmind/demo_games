import { describe, expect, it } from "vitest";
import { AdaptiveStaircase, Manual, autoDrive, headlessRun } from "@gamespace/core";
import { protocolGames } from "@gamespace/games";

describe("перехват сложности оператором", () => {
  it("политику можно сменить посреди запуска, уровень сохраняется", () => {
    const run = headlessRun(protocolGames, "org.reconnect.stroop", {
      seed: 5,
      policy: new AdaptiveStaircase({ start: 1, max: 8 }),
    });
    run.instance.start();
    autoDrive(run, { seed: 1, maxSteps: 60, pressRate: 1 });

    const before = run.instance.difficulty.level();
    run.instance.difficulty.setPolicy(new Manual({ start: 1, max: 8 }));
    expect(run.instance.difficulty.level()).toBe(before);
    expect(run.instance.difficulty.policy.id).toBe("manual");
  });

  it("адаптивная политика не отдаёт уровень оператору, ручная отдаёт", () => {
    const run = headlessRun(protocolGames, "org.reconnect.stroop", { seed: 5 });
    run.instance.start();
    expect(run.instance.difficulty.setLevel(6)).toBe(false);

    run.instance.difficulty.setPolicy(new Manual({ start: 2, max: 8 }));
    expect(run.instance.difficulty.setLevel(6)).toBe(true);
    expect(run.instance.difficulty.level()).toBe(6);
  });

  it("новый уровень применяется со следующей пробы, а не посреди текущей", () => {
    const run = headlessRun(protocolGames, "org.reconnect.stroop", { seed: 8, policy: new Manual({ start: 1, max: 8 }) });
    run.instance.start();
    run.clock.advance(10);
    const shownBefore = (run.views.at(-1) as any).options.length;

    run.instance.difficulty.setLevel(8);
    expect((run.views.at(-1) as any).options.length).toBe(shownBefore);

    run.instance.submitAction("choose", { index: 0 });
    run.clock.advance(500);
    expect((run.views.at(-1) as any).options.length).toBe(6);
  });
});
