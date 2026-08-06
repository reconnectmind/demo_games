import { describe, expect, it } from "vitest";
import { SURFACES } from "@gamespace/env";
import {
  GEAR_NEUTRAL,
  GEAR_REVERSE,
  MODEL,
  PUFFS,
  RATE_MAX,
  REVERSE_RATIO,
  RPM_MAX,
  STEER_LOCK,
  TIRE_COLD_C,
  WHEELBASE_M,
  WHEEL_RADIUS_M,
  dustRate,
  engineSettle,
  flashC,
  geometricRpm,
  markAt,
  ratioFor,
  ratiosFor,
  smearAt,
  steerLimit,
  steerNeutral,
  steerStep,
  tireSlope,
  torqueAt,
} from "@gamespace/car";
// Прямо файлом, а не через пакет: тест сверяет габариты физики с обмерами модели,
// и смотреть он обязан именно в тот файл, который печатает `bake-car.mjs`.
import carAsset from "../packages/car/src/assets/car.json";

/**
 * Машина сама по себе: коробка, руль, пятно контакта, обмеры кузова.
 *
 * Здесь только то, что считается числами и проверяется без мира: заезд, дорога и
 * зачёт живут в `race.test.ts`, а поведение машины на дороге — там же, потому что
 * это уже про мир. Разделение то же, что и в коде: `@gamespace/car` не знает, где
 * едет, и тесты его знать не должны.
 */

const G = 9.81;

describe("машина: коробка передач", () => {
  it("низкая передача умножает момент, высокая экономит обороты", () => {
    const gears = 6;
    let previous = Infinity;
    for (let gear = 1; gear <= gears; gear++) {
      const ratio = ratioFor(gear, gears);
      expect(ratio).toBeLessThan(previous);
      previous = ratio;
      // Сила с места падает с номером передачи, а обороты на одной скорости — тоже.
      expect(engineSettle({ wheelSpeedMs: 0, ratio, throttle: 1, powerCap: 1 }).forceN).toBeGreaterThan(0);
    }
    const pull = (gear: number) =>
      engineSettle({ wheelSpeedMs: 0, ratio: ratioFor(gear, gears), throttle: 1, powerCap: 1 }).forceN;
    expect(pull(1)).toBeGreaterThan(pull(gears));
    expect(geometricRpm(30, ratioFor(1, gears))).toBeGreaterThan(geometricRpm(30, ratioFor(gears, gears)));
  });

  it("селектор идёт от заднего хода через нейтраль к ступеням вперёд", () => {
    expect(ratioFor(GEAR_REVERSE, 6)).toBe(REVERSE_RATIO);
    expect(ratioFor(GEAR_REVERSE, 6)).toBeLessThan(0);
    expect(ratioFor(GEAR_NEUTRAL, 6)).toBe(0);
    expect(ratioFor(1, 6)).toBe(ratiosFor(6)[0]);
    expect(ratioFor(6, 6)).toBe(ratiosFor(6)[5]);
    // Ниже заднего и выше последней селектор не уходит: рычагу некуда.
    expect(ratioFor(-5, 6)).toBe(REVERSE_RATIO);
    expect(ratioFor(9, 6)).toBe(ratiosFor(6)[5]);
  });

  it("крайние передачи одинаковы при любом числе ступеней", () => {
    const full = ratiosFor(8);
    for (const gears of [2, 3, 4, 6, 8]) {
      const ratios = ratiosFor(gears);
      expect(ratios.length).toBe(gears);
      expect(ratios[0]).toBe(full[0]);
      expect(ratios[gears - 1]).toBe(full[7]);
      for (let i = 1; i < gears; i++) expect(ratios[i]!).toBeLessThan(ratios[i - 1]!);
    }
  });

  it("за отсечкой момента нет, до пика он растёт", () => {
    // Ограничитель гасит подачу полосой, а не ножом: у самой отсечки мотор ещё
    // тянет, чуть выше — уже нет. Нож здесь стоил машине способности выехать с
    // травы: буксующее колесо само загоняло коленвал за предел и обнуляло тягу.
    expect(torqueAt(RPM_MAX + 1)).toBeGreaterThan(0);
    expect(torqueAt(RPM_MAX + 1)).toBeLessThan(torqueAt(RPM_MAX - 100));
    expect(torqueAt(RPM_MAX + 400)).toBe(0);
    expect(torqueAt(3000)).toBeGreaterThan(torqueAt(1000));
    expect(torqueAt(4200)).toBeGreaterThan(torqueAt(6800));
  });

  it("на нейтрали мотор раскручивается свободно, а тяги не даёт вовсе", () => {
    // Нейтраль — это нулевое отношение, и обе её приметы отсюда и следуют: тяги
    // нет, а трансформатору нечего держать, поэтому мотор уходит до отсечки,
    // вместо того чтобы упереться в стоячую турбину на двух с половиной тысячах.
    const idle = engineSettle({ wheelSpeedMs: 0, ratio: 0, throttle: 1, powerCap: 1 });
    expect(idle.forceN).toBe(0);
    expect(idle.rpm).toBeGreaterThan(RPM_MAX * 0.95);
    const stall = engineSettle({ wheelSpeedMs: 0, ratio: ratioFor(1, 6), throttle: 1, powerCap: 1 });
    expect(stall.rpm).toBeLessThan(idle.rpm * 0.6);
  });
});

describe("машина: кузов и колёса", () => {
  it("колея и клиренс физики взяты из самой модели, а не подобраны на глаз", () => {
    // Обмеры пишет печать модели (`tools/bake-car.mjs`), а физика читает их из
    // `geometry.ts`. Разъехавшись, колёса поедут рядом с арками.
    expect(MODEL).toMatchObject(carAsset.model);
    // Модель обмеряна в метрах и в натуральную величину: масштабировать нечего.
    expect(WHEEL_RADIUS_M).toBeCloseTo(carAsset.model.wheelRadius, 6);
    // Ось колеса на высоте радиуса: колесо стоит на дороге, а не висит над ней.
    expect(carAsset.model.hubY).toBeCloseTo(carAsset.model.wheelRadius, 3);
    // База несимметрична, и перед стоит дальше от середины, чем зад: у прежней
    // модели-купе оси стояли ровно, и печать писала на обе одно число.
    expect(carAsset.model.hubFrontZ).toBeGreaterThan(carAsset.model.hubBackZ);
    // Габариты — настоящего Cayenne: 4.8 м в длину, 2.9 м база, колесо в 74 см.
    const length = carAsset.model.bodyMax[2]! - carAsset.model.bodyMin[2]!;
    expect(length).toBeGreaterThan(4.5);
    expect(length).toBeLessThan(5.1);
    expect(carAsset.model.hubFrontZ + carAsset.model.hubBackZ).toBeCloseTo(2.85, 1);
    // Зеркала торчат за кузов, и коллайдер строится не по габариту, а по корпусу:
    // иначе машина цепляется зеркалами за то, что зрительно проходит мимо.
    expect(carAsset.model.hullX).toBeLessThan(carAsset.model.bodyMax[0]!);
    expect(carAsset.model.hullX).toBeGreaterThan(carAsset.model.bodyMax[0]! * 0.8);
    // Колея уже корпуса, но не вдвое: иначе машину валит в вираже.
    expect(carAsset.model.wheelX).toBeGreaterThan(carAsset.model.hullX * 0.7);
  });

  it("остекление затемнено при печати: белой заплаты на крыше нет", () => {
    // У модели стёкла честно прозрачные, вид им добирает то, что видно насквозь. У
    // нас материал без прозрачности, и белёсое стекло выходило бы самым ярким пятном
    // в кадре — ярче разметки, хотя камера весь заезд смотрит машине в затылок.
    const colors = Buffer.from(carAsset.body.colors, "base64");
    const packed = Buffer.from(carAsset.body.positions, "base64");
    const positions = new Int16Array(packed.buffer, packed.byteOffset, packed.byteLength / 2);
    let bright = 0;
    for (let v = 0; v < carAsset.body.vertexCount; v++) {
      const y = positions[v * 3 + 1]! * carAsset.body.scale;
      const darkest = Math.min(colors[v * 3]!, colors[v * 3 + 1]!, colors[v * 3 + 2]!);
      if (y > 0.65 && darkest > 200) bright++;
    }
    expect(bright).toBe(0);
  });
});

describe("машина: пятно контакта", () => {
  it("след оставляет не проскальзывание, а горячая резина под нагрузкой", () => {
    // Чёрная полоса — это плёнка стёртой резины, а не царапина. Значит нужны обе
    // вещи сразу: работа трения, которая отрывает резину от протектора, и
    // температура, которая заставляет оторванное мазать, а не крошиться в пыль.
    const asphalt = SURFACES.asphalt;
    // Срыв: пятно скользит целиком.
    const loose = 3;
    // Свежей шине нужен настоящий срыв: поверхность пятна разогревает сам поток
    // трения, и слабого скольжения на это не хватает.
    expect(markAt(3_000, TIRE_COLD_C, asphalt, loose)).toBe(0);
    expect(markAt(20_000, TIRE_COLD_C, asphalt, loose)).toBeGreaterThan(0.5);
    // А прогретой хватает и слабого: толща уже горячая, поверхности недалеко.
    expect(markAt(3_000, 90, asphalt, loose)).toBeGreaterThan(0.1);
    expect(flashC(20, 20_000)).toBeGreaterThan(flashC(20, 3_000));
    // Холодная поверхность стирается тоже, но следа не оставляет: пыль уносит.
    expect(smearAt(20)).toBe(0);
    expect(smearAt(120)).toBe(1);
    expect(smearAt(75)).toBeGreaterThan(0);
    expect(smearAt(75)).toBeLessThan(1);
    // Проскальзывание без нагрузки не стирает ничего: работы нет.
    expect(markAt(0, 120, asphalt, loose)).toBe(0);
    // Держащее пятно не мажет, сколько бы работы через него ни шло: на скорости
    // и три процента проскальзывания дают киловатты, но там ничего не скользит.
    expect(markAt(20_000, 120, asphalt, 0.03)).toBe(0);
    // И мазать надо по чему-то: трава след не держит, гравий почти не держит.
    expect(markAt(20_000, 120, SURFACES.grass, loose)).toBe(0);
    expect(markAt(20_000, 120, SURFACES.gravel, loose)).toBeLessThan(
      markAt(20_000, 120, asphalt, loose) * 0.3,
    );
  });

  it("наклон кривой сцепления падает до нуля на пике и уходит в минус за ним", () => {
    // Это и есть то число, из-за которого шина не срывалась: неявный шаг брал
    // наклон в нуле на любом проскальзывании и держал колесо там, где держать
    // уже нечем.
    expect(tireSlope(0)).toBeGreaterThan(20);
    expect(tireSlope(0.13)).toBeLessThan(1);
    expect(tireSlope(0.13)).toBeGreaterThan(-1);
    expect(tireSlope(0.4)).toBeLessThan(0);
    expect(tireSlope(0.02)).toBeGreaterThan(tireSlope(0.08));
  });
});

describe("машина: руль", () => {
  it("руль возвращается сам, и тем быстрее, чем быстрее едешь", () => {
    // На месте руль остаётся там, где его бросили: возвращать его нечем.
    let idle = 0.3;
    for (let i = 0; i < 120; i++) idle = steerStep(idle, 0, 0, 1 / 60);
    expect(idle).toBeCloseTo(0.3, 3);

    // На ходу — сам приходит в ноль, и время возврата падает со скоростью.
    const settle = (speedMs: number) => {
      let angle = steerLimit(speedMs);
      for (let i = 0; i < 600; i++) {
        angle = steerStep(angle, 0, speedMs, 1 / 60);
        if (Math.abs(angle) < 0.1 * steerLimit(speedMs)) return (i + 1) / 60;
      }
      return Infinity;
    };
    const slow = settle(8);
    const fast = settle(25);
    expect(fast).toBeLessThan(slow);
    expect(slow).toBeLessThan(2);
    expect(fast).toBeGreaterThan(1 / 30);

    // Полное усилие держит примерно постоянное боковое ускорение, а не
    // постоянный угол: в этом вся разница между рулём и тумблером.
    for (const v of [12, 20, 30]) {
      let angle = 0;
      for (let i = 0; i < 120; i++) angle = steerStep(angle, 1, v, 1 / 60);
      const lateral = (v * v * Math.tan(angle)) / WHEELBASE_M;
      expect(lateral).toBeGreaterThan(0.6 * G);
      expect(lateral).toBeLessThan(0.9 * G);
    }

    // Руль ходит в обе стороны и не проскакивает механический предел рейки.
    let hard = 0;
    for (let i = 0; i < 120; i++) hard = steerStep(hard, -1, 0.5, 1 / 60);
    expect(hard).toBeCloseTo(-STEER_LOCK, 3);
  });

  it("на заднем ходу руль не возвращается, а уходит от центра", () => {
    // Возврат держится на следе пятна контакта: оно тащится позади оси поворота и
    // разворачивает колесо по ходу. Задом след становится ведущим, и тот же
    // механизм работает наоборот — как у магазинной тележки, которую тянут задом.
    // Пока скорость рулю отдавали по модулю, задний ход центровался как передний.
    const away = (speedMs: number, from = 0.15) => {
      let angle = from;
      for (let i = 0; i < 90; i++) angle = steerStep(angle, 0, speedMs, 1 / 60);
      return angle;
    };
    expect(away(-6)).toBeGreaterThan(0.15);
    expect(away(-6, -0.15)).toBeLessThan(-0.15);
    // Вперёд на той же скорости — к центру, и это та же строчка кода.
    expect(away(6)).toBeLessThan(0.05);

    // Ползком назад след слаб, и центр держит наклон шкворня: он от направления
    // не зависит вовсе, потому что возвращает колесо вес кузова, а не шина.
    expect(away(-1.2)).toBeLessThan(0.15);
    expect(away(-1.2)).toBeGreaterThan(0);

    // Руки перебивают раскачку с запасом: назад можно ехать по дуге, просто руль
    // приходится держать самому.
    let held = 0;
    for (let i = 0; i < 90; i++) held = steerStep(held, -1, -6, 1 / 60);
    expect(held).toBeLessThan(-0.3);

    // Брошенный на стоянке руль остаётся где брошен: неподвижное пятно держит
    // трением покоя, и подъём кузова его не перевешивает.
    let parked = 0.3;
    for (let i = 0; i < 120; i++) parked = steerStep(parked, 0, 0, 1 / 60);
    expect(parked).toBeCloseTo(0.3, 3);
  });

  it("возврат руля упирается в сцепление, а не растёт с углом без предела", () => {
    // Квадрат скорости честен, пока шина в линейной зоне. За пиком сила расти
    // перестаёт, а формула — нет: на ста сорока километрах в час полный угол
    // требовал бы от передка пяти g и возвращал руль за один кадр.
    let angle = 0.4;
    let quickest = 0;
    for (let i = 0; i < 30; i++) {
      const next = steerStep(angle, 0, 40, 1 / 120);
      quickest = Math.max(quickest, Math.abs(next - angle) * 120);
      angle = next;
    }
    // Предел — сцепление передка, и он ниже механического предела перекладки:
    // упирается руль в дорогу, а не в рейку.
    expect(quickest).toBeLessThan(2.8);
    expect(quickest).toBeGreaterThan(2);
    // Возвращаться руль при этом не перестаёт.
    expect(angle).toBeLessThan(0.05);

    // Вперёд на равновесии предел не работает вовсе: полное усилие рук держит
    // три четверти g, и до срыва передку остаётся запас.
    for (const v of [12, 20, 30, 45]) {
      let held = 0;
      const rates: number[] = [];
      for (let i = 0; i < 240; i++) {
        const next = steerStep(held, 1, v, 1 / 120);
        rates.push(Math.abs(next - held) * 120);
        held = next;
      }
      expect((v * v * Math.tan(Math.abs(held))) / WHEELBASE_M).toBeLessThan(0.9 * G);
      // Равновесие достигнуто плавно, без упора в предел на последних шагах.
      expect(rates[rates.length - 1]).toBeLessThan(0.01);
    }
  });

  it("угол без увода зеркален на заднем ходу", () => {
    // Колесо катится ровно, когда его плоскость лежит вдоль вектора скорости, а
    // вектор на заднем ходу развёрнут. Отсюда и контрруль в заносе задом — в
    // другую сторону, чем передом.
    expect(steerNeutral(4, 12)).toBeGreaterThan(0);
    expect(steerNeutral(4, -12)).toBeCloseTo(-steerNeutral(4, 12), 6);
    // Без сноса нейтраль в нуле на любом направлении.
    expect(steerNeutral(0, -12)).toBeCloseTo(0, 12);
  });
});

describe("машина: пыль из-под колёс", () => {
  // Пыль заменила собой то, чем раньше показывали обочину: там на весь мир втрое
  // густел туман, и горизонт превращался в серую стену от одного колеса на траве.
  it("стоящая машина не пылит, катящаяся по грунту — пылит", () => {
    expect(dustRate(PUFFS.grass, 0, 0)).toBe(0);
    expect(dustRate(PUFFS.gravel, 0, 0)).toBe(0);
    expect(dustRate(PUFFS.grass, 0, 20)).toBeGreaterThan(0);
    // Чем быстрее катится, тем гуще шлейф — но до потолка, а не без конца.
    expect(dustRate(PUFFS.gravel, 0, 25)).toBeGreaterThan(dustRate(PUFFS.gravel, 0, 8));
    expect(dustRate(PUFFS.gravel, 3, 30)).toBeLessThanOrEqual(RATE_MAX);
  });

  it("асфальт пылит только из-под сорванной шины", () => {
    // Рвать на асфальте нечего: там дымит сама резина, и только когда её рвут.
    expect(dustRate(PUFFS.asphalt, 0, 30)).toBe(0);
    expect(dustRate(PUFFS.asphalt, 2.5, 30)).toBeGreaterThan(0);
    // А в рыхлое сорвавшееся колесо зарывается и на месте.
    expect(dustRate(PUFFS.grass, 2.5, 0)).toBeGreaterThan(0);
    expect(dustRate(PUFFS.grass, 2.5, 20)).toBeGreaterThan(dustRate(PUFFS.grass, 0.5, 20));
  });

  it("грунт пылит гуще асфальта на той же работе", () => {
    for (const slide of [1.5, 2.5]) {
      expect(dustRate(PUFFS.gravel, slide, 20)).toBeGreaterThan(dustRate(PUFFS.asphalt, slide, 20));
      expect(dustRate(PUFFS.gravel, slide, 20)).toBeGreaterThan(dustRate(PUFFS.grass, slide, 20));
    }
  });
});
