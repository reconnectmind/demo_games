import { describe, expect, it } from "vitest";
import { AdaptiveStaircase, autoDrive, headlessRun, Manual } from "@gamespace/core";
import { protocolGames, stroop } from "@gamespace/games";

const SESSION_MS = 110 * 60 * 1000;

/**
 * Бюджет журнала в записях на секунду игры. Дискретные механики пишут по пробе,
 * а непрерывная симуляция — по шагу таймера, то есть на два порядка чаще: у неё
 * бюджет свой и явный, чтобы регресс в плотности всё равно был виден.
 */
const DENSITY_BUDGET: Record<string, number> = { "org.reconnect.squash": 90 };
const DEFAULT_DENSITY_BUDGET = 25;

/**
 * Валидация из бэклога: сессия длиной 110 минут. В виртуальном времени она
 * проходит за секунды, поэтому проверка выполнима в CI, а не «когда-нибудь».
 */
describe("длинная сессия", () => {
  it.each(protocolGames.map((g) => g.manifest.id))("%s выдерживает 110 минут подряд", (id) => {
    let elapsed = 0;
    let blocks = 0;
    let recordsTotal = 0;

    while (elapsed < SESSION_MS && blocks < 3000) {
      const run = headlessRun(protocolGames, id, { seed: 100 + blocks, policy: new AdaptiveStaircase() });
      run.instance.start();
      autoDrive(run, { seed: blocks, maxSteps: 4000, pressRate: 0.55 });
      elapsed += run.clock.now();
      recordsTotal += run.records().length;
      blocks++;
      expect(["completed", "aborted", "main"]).toContain(run.instance.phase);
      run.instance.stop();
    }

    expect(elapsed).toBeGreaterThanOrEqual(SESSION_MS);
    // Журнал растёт линейно по времени игры, а не квадратично: иначе к концу
    // сессии экспорт станет неподъёмным.
    const density = recordsTotal / (elapsed / 1000);
    expect(density).toBeLessThan(DENSITY_BUDGET[id] ?? DEFAULT_DENSITY_BUDGET);
  });
});

describe("точность расписания", () => {
  it("пропуск фиксируется ровно по дедлайну", () => {
    const run = headlessRun(protocolGames, "org.reconnect.stroop", { seed: 2, policy: new Manual({ start: 4 }) });
    run.instance.start();
    run.clock.advance(20_000);
    const deadlineMs = stroop.paramsForLevel(4).deadlineMs as number;
    const records = run.records();
    const onsets = records.filter((r) => r.type === "stimulus.presented");
    const timeouts = records.filter((r) => r.type === "response" && (r.payload as any).rtMs === null);
    expect(onsets.length).toBeGreaterThan(2);
    for (const timeout of timeouts.slice(0, 5)) {
      const onset = onsets.filter((o) => o.seq < timeout.seq).at(-1)!;
      expect(timeout.tMs - onset.tMs).toBe(deadlineMs);
    }
  });

  it("межпробный интервал не наслаивается на дедлайн следующей пробы", () => {
    const run = headlessRun(protocolGames, "org.reconnect.stroop", { seed: 12, policy: new Manual({ start: 1 }) });
    run.instance.start();
    run.clock.advance(30_000);
    const onsets = run.records().filter((r) => r.type === "stimulus.presented").map((r) => r.tMs);
    const gaps = onsets.slice(1).map((t, i) => t - onsets[i]!);
    expect(gaps.every((g) => g > 0)).toBe(true);
  });
});
