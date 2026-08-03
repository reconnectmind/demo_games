import { beforeAll, describe, expect, it } from "vitest";
import {
  autoDrive,
  checkMonotonicAxes,
  headlessRun,
  Manual,
  project,
  replayCore,
  validateManifest,
  validateParams,
  AdaptiveStaircase,
  Monotonic,
  type Microgame,
} from "@gamespace/core";
/**
 * Контрактный набор: одинаковые требования ко всем модулям протокола.
 * Новая игра считается готовой ровно тогда, когда проходит этот набор.
 * Первый аргумент — все игры, которые нужно зарегистрировать (у оркестратора
 * это он сам плюс его дети), второй — проверяемая.
 */
export function describeContract(protocolGames: Microgame<any, any>[], game: Microgame<any, any>): void {
  /**
   * У участка покоя или инструкции сложности нет вовсе: единственный уровень и
   * ни одной оси. Требовать от него монотонности — требовать выдуманной оси.
   */
  const graded = game.manifest.levels.count > 1;

  describe(`контракт: ${game.manifest.id}`, () => {
    /**
     * Модуль, которому нужна подготовка (например, физика в WASM), обязан пройти
     * тот же контракт, что и остальные. Ждать её здесь — единственная уступка:
     * иначе контракт проверялся бы на игре, симуляция которой ни разу не шагнула.
     */
    beforeAll(async () => {
      for (const module of protocolGames) await module.prepare?.();
    });

    it("манифест проходит схему", () => {
      const report = validateManifest(game.manifest);
      expect(report.issues).toEqual([]);
    });

    it("paramsForLevel даёт валидные параметры на каждом уровне", () => {
      for (let level = 1; level <= game.manifest.levels.count; level++) {
        const report = validateParams(game.manifest, game.paramsForLevel(level));
        expect({ level, issues: report.issues }).toEqual({ level, issues: [] });
      }
    });

    it("объявленные оси монотонны", () => {
      expect(game.manifest.levels.monotonicAxes.length).toBeGreaterThan(graded ? 0 : -1);
      if (!graded) expect(game.manifest.levels.monotonicAxes).toEqual([]);
      expect(checkMonotonicAxes(game.manifest, (l) => game.paramsForLevel(l)).issues).toEqual([]);
    });

    it("объявленная длина блока указывает на существующий параметр", () => {
      const decl = game.manifest.blockLength;
      if (!decl) return;
      const props = (game.manifest.parametersSchema.schema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props)).toContain(decl.param);
      // Длину блока задаёт расписание, поэтому уровень её трогать не должен.
      const axes = game.manifest.levels.monotonicAxes.map((a) => a.param);
      const first = game.paramsForLevel(1)[decl.param];
      const last = game.paramsForLevel(game.manifest.levels.count)[decl.param];
      if (!axes.includes(decl.param)) expect(last).toEqual(first);
    });

    it("состояние ядра сериализуемо", () => {
      const run = headlessRun(protocolGames, game.manifest.id, { seed: 4 });
      run.instance.start();
      autoDrive(run, { maxSteps: 200 });
      const state = run.instance.state;
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    });

    it("одинаковый seed даёт одинаковый прогон", () => {
      const a = headlessRun(protocolGames, game.manifest.id, { seed: 21, policy: new Manual({ start: 3 }) });
      a.instance.start();
      autoDrive(a, { seed: 5 });
      const b = headlessRun(protocolGames, game.manifest.id, { seed: 21, policy: new Manual({ start: 3 }) });
      b.instance.start();
      autoDrive(b, { seed: 5 });
      expect(project(a)).toEqual(project(b));
    });

    it("повтор входов из журнала воспроизводит состояние ядра", () => {
      const run = headlessRun(protocolGames, game.manifest.id, { seed: 8 });
      run.instance.start();
      autoDrive(run, { seed: 3, maxSteps: 400 });
      expect(replayCore(game, run.records(), 8)).toEqual(run.instance.state);
    });

    it("снимок сериализуем и восстанавливается", () => {
      const run = headlessRun(protocolGames, game.manifest.id, { seed: 12 });
      run.instance.start();
      autoDrive(run, { seed: 2, maxSteps: 60 });
      const snapshot = run.instance.snapshot();
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

      const restored = headlessRun(protocolGames, game.manifest.id, { seed: 12 });
      restored.instance.restore(snapshot);
      expect(restored.instance.state).toEqual(run.instance.state);
      restored.instance.start();
      expect(restored.instance.phase).toBe("main");
    });

    it("после stop не остаётся живых таймеров", () => {
      const run = headlessRun(protocolGames, game.manifest.id, { seed: 6 });
      run.instance.start();
      autoDrive(run, { seed: 1, maxSteps: 40 });
      run.instance.stop();
      const before = run.records().length;
      run.clock.advance(120_000);
      expect(run.records().length).toBe(before);
    });

    it("монотонная политика не понижает уровень ни при каких исходах", () => {
      const run = headlessRun(protocolGames, game.manifest.id, {
        seed: 33,
        policy: new Monotonic({ max: game.manifest.levels.count }),
      });
      run.instance.start();
      let lowest = 1;
      const levels: number[] = [];
      autoDrive(run, { seed: 9, pressRate: 0.35, maxSteps: 800 });
      for (const record of run.records()) {
        // Только корневой запуск: у детей оркестратора своя политика.
        if (record.type === "difficulty.changed" && record.slot === undefined) levels.push((record.payload as any).level);
      }
      for (const level of levels) {
        expect(level).toBeGreaterThanOrEqual(lowest);
        lowest = level;
      }
    });

    it.skipIf(!graded)("адаптивная политика поднимает уровень при верных ответах", () => {
      const policy = new AdaptiveStaircase({ max: game.manifest.levels.count });
      for (let i = 0; i < 8; i++) {
        policy.report({ kind: "trial", scored: true, correct: true, rtMs: 400, paramsUsed: game.paramsForLevel(1) });
      }
      expect(policy.current()).toBeGreaterThan(1);
    });
  });
}
