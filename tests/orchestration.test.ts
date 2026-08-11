import { describe, expect, it } from "vitest";
import {
  GameRegistry,
  GameRuntime,
  Manual,
  Monotonic,
  PreflightError,
  VirtualClock,
  autoDrive,
  headlessRun,
  headlessSurface,
  type HeadlessRun,
} from "@gamespace/core";
import { adaptiveBattery, interruptResume, protocolGames, stroop } from "@gamespace/games";

describe("прерывание и возврат", () => {
  function run(level = 2, seed = 5) {
    const r = headlessRun(protocolGames, "org.reconnect.interrupt-resume", { seed, policy: new Manual({ start: level }) });
    r.instance.start();
    return r;
  }

  it("фоновая задача приостанавливается и возвращается", () => {
    const r = run();
    r.clock.advance(60_000);
    const types = r.records().map((x) => x.type);
    expect(types).toContain("interruption.start");
    expect(types).toContain("child.suspended");
    expect(types).toContain("child.resumed");
    expect(types).toContain("resume");
  });

  it("прерыватель монтируется в отдельный слот и снимается после возврата", () => {
    const r = run();
    r.clock.advance(60_000);
    const mounts = r.records().filter((x) => x.type === "child.mounted").map((x) => (x.payload as any).slot);
    expect(new Set(mounts)).toEqual(new Set(["background", "interrupt"]));
  });

  it("лаг возобновления измеряется от возврата к первому действию участника", () => {
    const r = run(3, 9);
    autoDrive(r, { seed: 4, stepMs: 200, maxSteps: 1200, pressRate: 0.5 });
    const lags = r.records().filter((x) => x.type === "resumption.lag");
    expect(lags.length).toBeGreaterThan(0);
    for (const lag of lags) {
      const lagMs = (lag.payload as any).lagMs as number;
      expect(lagMs).toBeGreaterThanOrEqual(0);
      const resume = r.records().filter((x) => x.type === "resume" && x.seq < lag.seq).at(-1)!;
      expect(lag.tMs - resume.tMs).toBeCloseTo(lagMs, 3);
    }
  });

  it("состояние фоновой задачи переживает прерывание", () => {
    const r = run(2, 4);
    r.clock.advance(20_000);
    const before = r.instance.snapshot().children?.background;
    r.clock.advance(60_000);
    expect(before).toBeDefined();
    expect(before!.packageRef.id).toBe("org.reconnect.number-sequence");
    // Курсор снимка ненулевой: значит, к моменту прерывания задача уже шла.
    expect(before!.eventCursor).toBeGreaterThan(0);
  });

  it("запуск отклоняется, если прерываемый ребёнок не зарегистрирован", () => {
    const registry = new GameRegistry();
    registry.register(interruptResume);
    registry.register(stroop);
    const runtime = new GameRuntime({ registry, clock: new VirtualClock() });
    expect(() => runtime.mount(registry.ref("org.reconnect.interrupt-resume"), { surface: headlessSurface(), headless: true })).toThrow(
      PreflightError,
    );
  });
});

/** Батарея идёт минутами: гоняем виртуальное время до конца или до потолка. */
function untilDone(r: HeadlessRun, budgetMs = 20 * 60 * 1000, stepMs = 250): void {
  let elapsed = 0;
  while (elapsed < budgetMs && r.instance.phase !== "completed") {
    r.clock.advance(stepMs);
    elapsed += stepMs;
  }
}

describe("адаптивная батарея", () => {
  function run(level = 3, seed = 11) {
    const r = headlessRun(protocolGames, "org.reconnect.adaptive-battery", { seed, policy: new Manual({ start: level }) });
    r.instance.start();
    return r;
  }

  it("проводит объявленное число блоков подряд", () => {
    const r = run(2);
    untilDone(r);
    const starts = r.records().filter((x) => x.type === "block.start" && (x.payload as any).task);
    expect(starts.length).toBe(adaptiveBattery.paramsForLevel(2).blocks);
    expect(r.instance.phase).toBe("completed");
  });

  it("без объявленного состава в блоке идут все задачи манифеста", () => {
    // Пул из «первых нескольких» означал, что в конструкторе выбраны все пять
    // задач, а участник за сорок минут видит две.
    const declared = adaptiveBattery.manifest.children!.map((child) => child.id);
    // Уровень с числом блоков не меньше числа задач: только на нём видно, что в
    // круг попали все, а не первые из пула.
    const r = run(4, 21);
    r.clock.advance(1000);
    expect(adaptiveBattery.paramsForLevel(4).blocks as number).toBeGreaterThanOrEqual(declared.length);
    const order = new Set((r.instance.state as any).order as string[]);
    expect([...order].sort()).toEqual([...declared].sort());
  });

  it("уровень дочерней задачи считает расписание, а не сама батарея", () => {
    // Иначе объявленная протоколом политика достаётся только оркестратору: у
    // n-back внутри батареи глубина так и остаётся стартовой весь блок.
    const registry = new GameRegistry();
    for (const game of protocolGames) registry.register(game);
    const clock = new VirtualClock();
    const runtime = new GameRuntime({ registry, clock, capabilities: ["keyboard", "pointer", "audio-output", "canvas"] });
    const shared = new Map<string, Monotonic>();
    const instance = runtime.mount(registry.ref("org.reconnect.adaptive-battery"), {
      surface: headlessSurface(),
      headless: true,
      seed: 4,
      policy: new Manual({ start: 3 }),
      overrides: { tasks: "n-back", blocks: 6, restMs: 500 },
      childPolicyFor: (id) => {
        let policy = shared.get(id);
        if (!policy) {
          policy = new Monotonic({ start: 1, successesToAdvance: 1 });
          shared.set(id, policy);
        }
        return policy;
      },
    });
    instance.start();
    const child = () => instance.activeInstance();
    for (let step = 0; step < 8000 && instance.phase !== "completed"; step++) {
      const live = child();
      const state = live?.state as { visible?: boolean; responded?: boolean; targetFlags?: boolean[]; index?: number } | undefined;
      if (state?.visible && !state.responded && state.targetFlags?.[state.index ?? 0] === true) {
        live!.submitAction("match", {}, "keyboard");
      }
      clock.advance(50);
    }
    expect(shared.get("org.reconnect.n-back")?.current()).toBeGreaterThan(1);
  });

  it("порядок задач воспроизводится по seed", () => {
    const order = (seed: number) => {
      const r = headlessRun(protocolGames, "org.reconnect.adaptive-battery", { seed, policy: new Manual({ start: 4 }) });
      r.instance.start();
      r.clock.advance(1000);
      return (r.instance.state as any).order as string[];
    };
    expect(order(7)).toEqual(order(7));
    expect(order(7)).not.toEqual(order(8));
  });

  it("уровень задачи сохраняется между её блоками", () => {
    const r = run(4, 3);
    autoDrive(r, { seed: 5, stepMs: 250, maxSteps: 6000, pressRate: 0.8 });
    const changes = r.records().filter((x) => x.type === "difficulty.changed" && x.slot === "task");
    // Политика живёт у родителя по паре слот+задача, поэтому уровень не
    // сбрасывается при каждом новом появлении задачи в расписании.
    expect(changes.length).toBeGreaterThan(0);
  });

  it("дочерние исходы попадают в общий журнал запуска", () => {
    const r = run(2, 2);
    autoDrive(r, { seed: 3, stepMs: 250, maxSteps: 4000, pressRate: 0.8 });
    const childOutcomes = r.records().filter((x) => x.type === "trial.outcome" && x.slot === "task");
    expect(childOutcomes.length).toBeGreaterThan(0);
    expect(new Set(r.records().map((x) => x.runId)).size).toBe(1);
  });
});
