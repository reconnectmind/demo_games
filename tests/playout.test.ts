import { describe, expect, it } from "vitest";
import { Playout } from "../packages/race/src/view/playout.js";

/**
 * Часы кадра проверяются на том же, на чём они и сломались вживую: три
 * несоизмеримые частоты. Физика шагает по 1/60 секунды, ядро тикает раз в 16 мс и
 * потому иногда не двигает физику вовсе, а экран обновляется своим темпом.
 *
 * Полезное свойство здесь ровно одно, и оно не про «плавность вообще»: положение
 * в кадре обязано ехать с почти постоянной скоростью, когда физика едет с
 * постоянной. Пульсация скорости и есть то, что видно глазом как дрожание.
 */

const STEP_S = 1 / 60;
const TICK_S = 0.016;

interface Run {
  /** Смещение показанного положения между соседними кадрами. */
  steps: number[];
}

/**
 * Гоняет мир: физика движется строго равномерно (положение равно её времени),
 * ядро тикает своим шагом с накопителем, кадры идут своим.
 */
function run(playout: Playout<number>, frameS: number, seconds: number, jitterS = 0, measureS = 0): Run {
  let sim = 0;
  let accumulator = 0;
  let nextTick = 0;
  let nextFrame = 0;
  let shown = Number.NaN;
  let noise = 12345;
  // Таймер ядра не идеален: браузер отдаёт тик с разбросом в несколько миллисекунд.
  const jitter = (amount: number): number => {
    noise = (noise * 1103515245 + 12345) & 0x7fffffff;
    return (noise / 0x7fffffff - 0.5) * 2 * amount;
  };
  const steps: number[] = [];
  for (let now = 0; now < seconds; now += 0.0005) {
    if (now >= nextTick) {
      const tick = TICK_S + jitter(jitterS);
      accumulator += tick;
      while (accumulator >= STEP_S) {
        sim += STEP_S;
        accumulator -= STEP_S;
      }
      // Ядро отдаёт картинке состояние каждый тик, даже если физика не двигалась.
      playout.arrive(sim, sim);
      nextTick += tick;
    }
    if (now >= nextFrame) {
      /**
       * Показ идёт по линейке экрана, а замер промежутка — нет: обработчик зовут
       * то раньше, то позже, и часам достаётся зашумлённое число при ровном
       * показе. Именно на этом расхождении и держится подрагивание на ходу.
       */
      const blend = playout.at(frameS + jitter(measureS));
      if (blend) {
        const value = blend.from + (blend.to - blend.from) * blend.alpha;
        if (Number.isFinite(shown)) steps.push(value - shown);
        shown = value;
      }
      nextFrame += frameS;
    }
  }
  return { steps };
}

/** Насколько неровно ехало: наибольшее отклонение шага от среднего, в долях. */
function ripple(steps: number[]): number {
  const settled = steps.slice(30);
  const mean = settled.reduce((sum, step) => sum + step, 0) / settled.length;
  return Math.max(...settled.map((step) => Math.abs(step - mean))) / mean;
}

describe("часы кадра", () => {
  for (const hz of [60, 75, 144]) {
    it(`на ${hz} кадрах в секунду картинка едет ровно, хотя физика шагает мимо тиков`, () => {
      const { steps } = run(new Playout<number>(), 1 / hz, 8);
      // Пятая часть — предел заметности: при смешивании по времени ядра тот же
      // замер давал единицу и больше, то есть кадр то стоял, то ехал вдвое.
      expect(ripple(steps)).toBeLessThan(0.2);
    });
  }

  it("разброс таймера ядра в четыре миллисекунды картинку не портит", () => {
    // Тик ядра приходит не по линейке: браузер отдаёт его с разбросом, и от этого
    // паузы в доставке шагов физики становятся ещё неровнее. Запас в два шага
    // берётся именно на это, а не на красивое число.
    const { steps } = run(new Playout<number>(), 1 / 60, 12, 0.004);
    expect(ripple(steps)).toBeLessThan(0.2);
  });

  it("шум в замере кадра не попадает в скорость картинки", () => {
    // Экран обновляется ровно, а вот замер промежутка шумит на пятую часть: в
    // живом заезде между вызовами насчитывалось от 12.9 до 20.3 мс при медиане
    // 16.7. Двигать мир на измеренное — значит показывать эту пятую часть через
    // ровные промежутки, и на скорости это видно как дрожание вперёд-назад.
    const { steps } = run(new Playout<number>(), 1 / 60, 12, 0.004, 0.0034);
    expect(ripple(steps)).toBeLessThan(0.1);
  });

  it("настоящая смена частоты экрана подхватывается, а не сглаживается насмерть", () => {
    const playout = new Playout<number>();
    // Полсекунды на 60 кадрах, потом экран ушёл на 30: часы обязаны перестроиться,
    // иначе сглаживание темпа превратится в вечное отставание.
    const { steps } = run(playout, 1 / 60, 4);
    expect(steps.at(-1)! / (1 / 60)).toBeGreaterThan(0.9);
    const slow = run(playout, 1 / 30, 4);
    const settled = slow.steps.slice(30);
    const mean = settled.reduce((sum, step) => sum + step, 0) / settled.length;
    expect(mean / (1 / 30)).toBeGreaterThan(0.99);
    expect(mean / (1 / 30)).toBeLessThan(1.01);
  });

  it("картинка не едет назад: показанное положение только растёт", () => {
    const { steps } = run(new Playout<number>(), 1 / 62.5, 8);
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
  });

  it("в среднем картинка идёт со скоростью физики, а не своей", () => {
    const frameS = 1 / 60;
    const { steps } = run(new Playout<number>(), frameS, 20);
    const settled = steps.slice(60);
    const mean = settled.reduce((sum, step) => sum + step, 0) / settled.length;
    // Часы подстраиваются темпом, а не прыжком, поэтому проверяем именно средний
    // ход: уплыви он хоть на процент, за сорок минут набежит секунда отставания.
    expect(mean / frameS).toBeGreaterThan(0.99);
    expect(mean / frameS).toBeLessThan(1.01);
  });

  it("пересборка мира не роняет картинку в прошлое", () => {
    const playout = new Playout<number>();
    playout.arrive(10, 10);
    playout.at(1 / 60);
    playout.arrive(10 + STEP_S, 10 + STEP_S);
    playout.at(1 / 60);
    // Снимок, повтор журнала, смена уровня: у нового мира время идёт с нуля.
    playout.arrive(0, 0);
    const blend = playout.at(1 / 60);
    expect(blend).not.toBeNull();
    expect(blend!.from).toBe(0);
    expect(blend!.to).toBe(0);
  });
});
