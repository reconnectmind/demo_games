import { describe, expect, it } from "vitest";
import {
  SURFACES,
  TIRE_COLD_C,
  WHEEL_INERTIA,
  blendSurface,
  heatStep,
  loadFactor,
  tempFactor,
  tireCurve,
  tireStep,
  type Surface,
  type TireStep,
} from "../packages/race/src/tire.js";
import { WHEEL_RADIUS_M } from "../packages/race/src/geometry.js";
import { surfaceAt, Centerline } from "../packages/race/src/track.js";

const G = 9.81;
const LOAD = (2100 * G) / 4;

/** Колесо, катящееся ровно по дороге: от него и считаются все отклонения. */
function rolling(over: Partial<TireStep> = {}): TireStep {
  const speed = over.alongMs ?? 20;
  return {
    omega: speed / WHEEL_RADIUS_M,
    tempC: 80,
    loadN: LOAD,
    alongMs: speed,
    acrossMs: 0,
    driveNm: 0,
    brakeNm: 0,
    inertia: WHEEL_INERTIA + 3,
    radiusM: WHEEL_RADIUS_M,
    surface: SURFACES.asphalt!,
    dtS: 1 / 60,
    ...over,
  };
}

describe("шина: пятно контакта", () => {
  it("сила рождается из проскальзывания, растёт до пика и за пиком падает", () => {
    // Это и есть вся модель в одной строке: колесо тянет не потому, что зацепилось,
    // а потому, что резину в пятне сдвинуло относительно дороги.
    expect(tireCurve(0)).toBe(0);
    const peak = Math.max(...Array.from({ length: 200 }, (_, i) => tireCurve(i / 500)));
    let best = 0;
    for (let i = 1; i < 200; i++) if (tireCurve(i / 500) === peak) best = i / 500;
    // Пик там, где ему место у настоящей шины: около десятой доли проскальзывания.
    expect(best).toBeGreaterThan(0.05);
    expect(best).toBeLessThan(0.25);
    // За пиком сорванная шина держит хуже, но держит: срыв обратим.
    expect(tireCurve(1)).toBeLessThan(peak);
    expect(tireCurve(1)).toBeGreaterThan(peak * 0.7);
  });

  it("больше предела сцепления шина не даёт, как её ни крути", () => {
    for (const drive of [500, 2000, 10_000]) {
      const out = tireStep(rolling({ driveNm: drive }));
      expect(Math.abs(out.alongN)).toBeLessThanOrEqual(LOAD * 1.02);
    }
  });

  it("круг сцепления: чем больше уходит на разгон, тем меньше остаётся на поворот", () => {
    // Ровно поэтому в повороте нельзя дать полный газ. Меряется на установившемся
    // проскальзывании: за один шаг колесо ещё не успевает раскрутиться, и круг
    // просто не проявился бы.
    const settle = (driveNm: number) => {
      let step = rolling({ acrossMs: 2, driveNm });
      for (let i = 0; i < 120; i++) {
        const out = tireStep(step);
        step = { ...step, omega: out.omega };
      }
      return tireStep(step);
    };
    const free = settle(0);
    const busy = settle(3000);
    expect(Math.abs(busy.acrossN)).toBeLessThan(Math.abs(free.acrossN) * 0.8);
    // И суммарная сила при этом за круг не выходит.
    expect(Math.hypot(busy.alongN, busy.acrossN)).toBeLessThanOrEqual(LOAD * 1.05);
  });

  it("перегруженное колесо держит хуже, чем два по половине груза", () => {
    // Нелинейность по нагрузке — причина, по которой машина в повороте держит
    // хуже, чем на прямой: наружное колесо перегружено, внутреннее разгружено, и
    // сумма меньше, чем была бы поровну.
    expect(loadFactor(LOAD)).toBeCloseTo(1, 5);
    expect(loadFactor(LOAD * 2)).toBeLessThan(1);
    expect(loadFactor(LOAD / 2)).toBeGreaterThan(1);
    const even = 2 * loadFactor(LOAD) * LOAD;
    const tilted = loadFactor(LOAD * 1.6) * LOAD * 1.6 + loadFactor(LOAD * 0.4) * LOAD * 0.4;
    expect(tilted).toBeLessThan(even);
  });

  it("холодная и перегретая шина держат хуже прогретой", () => {
    const cold = tempFactor(TIRE_COLD_C);
    const warm = tempFactor(85);
    const burnt = tempFactor(160);
    expect(warm).toBeGreaterThan(cold);
    expect(warm).toBeGreaterThan(burnt);
    // Разница заметная, но не решающая: холодная шина скользит, а не отказывает.
    expect(cold).toBeGreaterThan(0.5);
  });

  it("греет скольжение, а не езда: катящееся колесо остывает", () => {
    // Нагрев — это мощность трения, то есть газ и тормоз, не ставшие движением.
    const hot = heatStep(TIRE_COLD_C, 60_000, 20, 1);
    expect(hot).toBeGreaterThan(TIRE_COLD_C + 1);
    const cooled = heatStep(120, 0, 30, 1);
    expect(cooled).toBeLessThan(120);
    // Остывает быстрее на ходу, чем на месте: шину обдувает.
    expect(heatStep(120, 0, 40, 1)).toBeLessThan(heatStep(120, 0, 0, 1));
  });

  it("покрытия отличаются не только сцеплением, но и тем, как вязнут", () => {
    expect(SURFACES.asphalt!.grip).toBeGreaterThan(SURFACES.gravel!.grip);
    expect(SURFACES.gravel!.grip).toBeGreaterThan(SURFACES.grass!.grip);
    expect(SURFACES.grass!.dig).toBeGreaterThan(SURFACES.gravel!.dig);
    expect(SURFACES.asphalt!.dig).toBe(0);
    const half = blendSurface(SURFACES.asphalt!, SURFACES.grass!, 0.5);
    expect(half.grip).toBeCloseTo((SURFACES.asphalt!.grip + SURFACES.grass!.grip) / 2, 6);
    // На каждом покрытии предел разный, и разница читается прямо в силе.
    const pull = (surface: Surface) => tireStep(rolling({ surface, driveNm: 9000 })).alongN;
    expect(pull(SURFACES.asphalt!)).toBeGreaterThan(pull(SURFACES.gravel!));
    expect(pull(SURFACES.gravel!)).toBeGreaterThan(pull(SURFACES.grass!));
  });

  it("колесо буксует, когда момента больше, чем держит земля", () => {
    // Момент вдвое выше предела: колесо обязано раскручиваться, а не толкать.
    let step = rolling({ surface: SURFACES.grass!, driveNm: 4000 });
    for (let i = 0; i < 60; i++) {
      const out = tireStep(step);
      step = { ...step, omega: out.omega, tempC: out.tempC };
    }
    const out = tireStep(step);
    expect(out.slipRatio).toBeGreaterThan(0.3);
    // И греется: буксование — это работа трения на месте.
    expect(step.tempC).toBeGreaterThan(80);
  });

  it("умеренный момент колесо не срывает: оно катится, чуть обгоняя дорогу", () => {
    let step = rolling({ driveNm: 400 });
    for (let i = 0; i < 60; i++) {
      const out = tireStep(step);
      step = { ...step, omega: out.omega, tempC: out.tempC };
    }
    const out = tireStep(step);
    expect(out.slipRatio).toBeGreaterThan(0);
    expect(out.slipRatio).toBeLessThan(0.1);
    expect(out.alongN).toBeGreaterThan(300);
  });

  it("тормоз останавливает колесо, но не крутит его назад", () => {
    let step = rolling({ alongMs: 1, brakeNm: 5000, driveNm: 0 });
    for (let i = 0; i < 30; i++) {
      const out = tireStep(step);
      expect(out.omega).toBeGreaterThanOrEqual(0);
      step = { ...step, omega: out.omega, tempC: out.tempC };
    }
    expect(step.omega).toBe(0);
  });

  it("на малой скорости колесо не идёт вразнос", () => {
    // Шина у нуля проскальзывания очень жёсткая, и явный шаг такую жёсткость не
    // держит: колесо начинает раскачиваться между «буксует» и «тормозит», а
    // машина от этого подпрыгивает на месте. Проверяется на самой опасной точке —
    // трогание на высшей передаче, где инерции за колесом почти нет.
    let step = rolling({ alongMs: 0.4, driveNm: 300, inertia: WHEEL_INERTIA + 0.5 });
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      const out = tireStep(step);
      worst = Math.max(worst, Math.abs(out.alongN));
      step = { ...step, omega: out.omega, tempC: out.tempC };
    }
    expect(Number.isFinite(step.omega)).toBe(true);
    expect(worst).toBeLessThan(LOAD * 1.2);
    // Колесо крутится вперёд, а не пилит туда-сюда.
    expect(step.omega).toBeGreaterThan(0);
  });
});

describe("покрытие под колесом", () => {
  const point = new Centerline(3).atDistance(0);

  it("покрытие спрашивают по месту колеса, а не по середине машины", () => {
    expect(surfaceAt(point, 0).kind).toBe("asphalt");
    expect(surfaceAt(point, point.halfWidth + 2).kind).toBe("gravel");
    expect(surfaceAt(point, point.halfWidth + 20).kind).toBe("grass");
    // Стороны равноправны: слева то же, что справа.
    expect(surfaceAt(point, -point.halfWidth - 2).kind).toBe("gravel");
  });

  it("кромка размыта: сцепление не прыгает в одном сантиметре", () => {
    // Кромка асфальта в жизни не нож, а полметра выкрошенного края. Скачок
    // сцепления на границе дал бы не реализм, а дребезг: колесо на кромке
    // перескакивало бы между покрытиями каждый шаг.
    const edge = surfaceAt(point, point.halfWidth);
    expect(edge.kind).toBe("asphalt");
    expect(edge.next).toBe("gravel");
    expect(edge.blend).toBeCloseTo(0.5, 2);
    const grip = (lateral: number) => {
      const mix = surfaceAt(point, lateral);
      return blendSurface(SURFACES[mix.kind]!, SURFACES[mix.next]!, mix.blend).grip;
    };
    let jumpiest = 0;
    for (let lateral = 0; lateral < point.halfWidth + 12; lateral += 0.05) {
      jumpiest = Math.max(jumpiest, Math.abs(grip(lateral + 0.05) - grip(lateral)));
    }
    expect(jumpiest).toBeLessThan(0.03);
  });
});
