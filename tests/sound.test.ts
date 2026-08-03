import { describe, expect, it } from "vitest";
import {
  CABIN,
  EXHAUST_BANKS,
  MUFFLER,
  cabinLoss,
  ROLL_CEILING,
  SILENCE,
  bankFirings,
  easeSound,
  exhaustOrders,
  intakeFirings,
  intakeModes,
  pipeModes,
  soundMix,
  type SoundIn,
  type SoundMix,
} from "../packages/race/src/view/sound.js";
import type { SurfaceKind } from "../packages/race/src/track.js";

function wheels(surface: SurfaceKind, slide = 0.02, contact = true) {
  return [0, 1, 2, 3].map(() => ({ surface, slide, contact }));
}

function driving(over: Partial<SoundIn> = {}): SoundIn {
  return { rpm: 3000, rpmMax: 7000, throttle: 0.6, speedMs: 25, wheels: wheels("asphalt"), ...over };
}

describe("звук: что слышно", () => {
  it("тон мотора идёт от оборотов, а не от скорости", () => {
    // Обороты и скорость расходятся при буксовании и при переключении, и звук
    // обязан идти за оборотами: иначе на срыве мотор взвоет молча.
    const slow = soundMix(driving({ rpm: 1500, speedMs: 40 }));
    const fast = soundMix(driving({ rpm: 6000, speedMs: 5 }));
    expect(fast.cycleHz).toBeGreaterThan(slow.cycleHz * 3.5);
    // Цикл четырёхтактного — два оборота, на трёх тысячах это двадцать пять герц.
    // Вспышки идут восьмой гармоникой этого цикла, то есть на двухстах.
    expect(soundMix(driving({ rpm: 3000 })).cycleHz).toBeCloseTo(25, 1);
  });

  it("ровная дорога молчит на любой скорости", () => {
    // Шум качения по асфальту синтезировать нечем: в жизни это плотный поток
    // ударов протектора о зерно, с высотой и ритмом, а получается из фильтра
    // шипение, которое прибывает с разгоном и ничего не сообщает. Чистый асфальт
    // молчит нарочно, и ощущение хода несёт ветер.
    for (const speedMs of [5, 25, 60, 120]) {
      expect(soundMix(driving({ speedMs })).rollGain).toBe(0);
    }
  });

  it("шум обочины упирается в потолок, а не растёт без конца", () => {
    // На гравии шина шумит громко, но не бесконечно: у роста есть предел, и
    // подходить к нему надо плавно. Резкий обрез слышен как ступенька — до неё
    // шум прибывает, после замирает намертво.
    const at = (speedMs: number) => soundMix(driving({ speedMs, wheels: wheels("gravel") })).rollGain;
    const ceiling = ROLL_CEILING;
    expect(at(30)).toBeLessThan(ceiling);
    expect(at(120)).toBeLessThan(ceiling);
    // Вдвое быстрее — заметно громче; вчетверо — уже почти без разницы.
    expect(at(30) - at(15)).toBeGreaterThan(at(120) - at(60));
    expect(at(120) - at(60)).toBeLessThan(ceiling * 0.1);
    // И до потолка звук всё-таки доходит: иначе потолок стоял бы зря.
    expect(at(120)).toBeGreaterThan(ceiling * 0.85);
  });

  it("нагрузка слышна яркостью, а не громкостью", () => {
    // Под нагрузкой выхлоп звенит обертонами, на сбросе оседает в бормотание. Если
    // отдать нагрузку одной громкости, сброс газа на высоких оборотах прозвучит
    // как выключенный мотор, а не как торможение двигателем.
    const pulling = soundMix(driving({ throttle: 1 }));
    const coasting = soundMix(driving({ throttle: 0 }));
    expect(pulling.engineCut).toBeGreaterThan(coasting.engineCut * 2);
    expect(coasting.engineGain).toBeGreaterThan(0);
    expect(pulling.engineGain).toBeLessThan(coasting.engineGain * 3);
  });

  it("яркость на верхах берётся из формант, а не из отдельной ручки", () => {
    // Мотор на отсечке обязан звучать звонче, чем на холостых, но добавка эта
    // рождается сама: порядки уезжают вверх и добираются до высоких мод трубы.
    // Если поднимать сюда ещё и срез, одно и то же посчитается дважды — и вместо
    // звонкого мотора выйдет визг пилы, на который и жалуются уши.
    const low = soundMix(driving({ rpm: 900, throttle: 1 }));
    const high = soundMix(driving({ rpm: 6800, throttle: 1 }));
    expect(high.engineCut).toBe(low.engineCut);
    // А глушитель эту самую пилу и режет: он стоит на месте при любых оборотах.
    expect(Math.max(...MUFFLER.stages)).toBeLessThan(3000);
    expect(MUFFLER.loss).toBeLessThan(1);
  });

  it("покрытие слышно по каждому колесу отдельно", () => {
    // Два колеса на обочине — это половина голоса гравия, и по этой половине
    // слышно, что машина уже на кромке. Сцене известно покрытие под каждым
    // колесом, и звук обязан этим пользоваться, а не спрашивать «где кузов».
    const road = soundMix(driving());
    const gravel = soundMix(driving({ wheels: wheels("gravel") }));
    const grass = soundMix(driving({ wheels: wheels("grass") }));
    expect(road.rollGain).toBe(0);
    expect(grass.rollGain).toBeGreaterThan(0);
    // Гравий гремит громче и злее травы — и звонче: зерно крупнее и твёрже.
    expect(gravel.rollGain).toBeGreaterThan(grass.rollGain);
    expect(gravel.rollCut).toBeGreaterThan(grass.rollCut);

    const half = soundMix(driving({ wheels: [...wheels("asphalt").slice(0, 2), ...wheels("gravel").slice(0, 2)] }));
    expect(half.rollGain).toBeGreaterThan(road.rollGain);
    expect(half.rollGain).toBeLessThan(gravel.rollGain);
  });

  it("колёса в воздухе молчат", () => {
    const flying = soundMix(driving({ wheels: wheels("asphalt", 0.02, false) }));
    expect(flying.rollGain).toBe(0);
    expect(flying.squealGain).toBe(0);
    // А мотор — нет: он и в полёте работает.
    expect(flying.engineGain).toBeGreaterThan(0);
  });

  it("визг начинается там, где кончается сцепление", () => {
    // Держащая часть кривой шины кончается около одной десятой проскальзывания.
    // До неё визга быть не должно вовсе, иначе он перестанет что-либо значить.
    expect(soundMix(driving({ wheels: wheels("asphalt", 0.05) })).squealGain).toBe(0);
    const slipping = soundMix(driving({ wheels: wheels("asphalt", 0.4) }));
    expect(slipping.squealGain).toBeGreaterThan(0.1);
    // Сильнее срыв — выше и злее.
    const gone = soundMix(driving({ wheels: wheels("asphalt", 1.2) }));
    expect(gone.squealGain).toBeGreaterThan(slipping.squealGain);
    expect(gone.squealHz).toBeGreaterThan(slipping.squealHz);
  });

  it("визжит асфальт, а не трава", () => {
    // Резина визжит о твёрдое. На траве то же проскальзывание — это не визг, а
    // шорох, и путать их нельзя: иначе съезд на газон звучал бы как гоночный трек.
    const road = soundMix(driving({ wheels: wheels("asphalt", 0.6) }));
    const grass = soundMix(driving({ wheels: wheels("grass", 0.6) }));
    expect(grass.squealGain).toBeLessThan(road.squealGain * 0.2);
  });

  it("стоящая машина шинами не скрипит", () => {
    // Буксование на месте даёт огромное проскальзывание, но визга на нулевой
    // скорости быть не должно: визжит резина, скользящая по дороге, а не
    // крутящаяся в одной точке.
    const still = soundMix(driving({ speedMs: 0, wheels: wheels("asphalt", 8) }));
    expect(still.squealGain).toBe(0);
    expect(still.rollGain).toBe(0);
  });

  it("ветер растёт со скоростью и на малом ходу не слышен", () => {
    const slow = soundMix(driving({ speedMs: 5 }));
    const fast = soundMix(driving({ speedMs: 45 }));
    expect(slow.windGain).toBeLessThan(0.02);
    expect(fast.windGain).toBeGreaterThan(slow.windGain * 10);
  });

  it("громкости не выходят за разумное: сумма голосов не рвёт выход", () => {
    const loudest = soundMix({
      rpm: 7000,
      rpmMax: 7000,
      throttle: 1,
      speedMs: 60,
      wheels: wheels("gravel", 2),
    });
    const total = loudest.engineGain + loudest.rollGain + loudest.squealGain + loudest.windGain;
    expect(total).toBeLessThan(1);
  });
});

describe("звук: салон", () => {
  it("кузов глушит тем сильнее, чем выше частота", () => {
    // Закон массы: перегородке тем труднее, чем быстрее её просят колебаться.
    // Отсюда и то, как звучит машина снаружи и изнутри — снаружи цокает, изнутри
    // гудит.
    const curve = [100, 250, 600, 1500, 3000, 6000].map(cabinLoss);
    for (let i = 1; i < curve.length; i++) expect(curve[i]!).toBeLessThan(curve[i - 1]!);
    // Низ проходит почти весь, от верха не остаётся ничего.
    expect(cabinLoss(100)).toBeGreaterThan(-2);
    expect(cabinLoss(3000)).toBeLessThan(-12);
    expect(cabinLoss(8000)).toBeLessThan(-24);
  });

  it("на моде объёма салон не глушит, а подпевает", () => {
    // Тот самый низкий гул, который давит на уши на определённых оборотах: на
    // своей частоте закрытый объём отдаёт больше, чем получает.
    expect(cabinLoss(CABIN.boom.hz)).toBeGreaterThan(cabinLoss(CABIN.boom.hz * 4) + 3);
    expect(cabinLoss(CABIN.boom.hz)).toBeGreaterThan(0);
  });
});

describe("звук: сглаживание", () => {
  const to = soundMix(driving());

  it("к цели приходит, но не мгновенно: скачок громкости — это щелчок", () => {
    let mix = SILENCE;
    const first = easeSound(mix, to, 1 / 60);
    expect(first.engineGain).toBeGreaterThan(0);
    expect(first.engineGain).toBeLessThan(to.engineGain * 0.9);
    for (let i = 0; i < 120; i++) mix = easeSound(mix, to, 1 / 60);
    for (const key of Object.keys(to) as (keyof SoundMix)[]) {
      expect(mix[key]).toBeCloseTo(to[key], 1);
    }
  });

  it("шаг не зависит от того, как часто его делать", () => {
    // Кадры приходят неровно, и сглаживание, считающее «долю за кадр» вместо
    // постоянной времени, на просадке частоты меняло бы характер звука.
    let slow = SILENCE;
    let fast = SILENCE;
    for (let i = 0; i < 30; i++) slow = easeSound(slow, to, 1 / 30);
    for (let i = 0; i < 120; i++) fast = easeSound(fast, to, 1 / 120);
    expect(fast.engineGain).toBeCloseTo(slow.engineGain, 3);
    expect(fast.rollCut).toBeCloseTo(slow.rollCut, 0);
  });

  it("визг вспыхивает быстрее, чем гаснет", () => {
    // Короткий срыв на кочке должен успеть прозвучать, а возврат сцепления не
    // должен обрывать звук: на границе срыва это дало бы стрекот.
    const loud = { ...SILENCE, squealGain: 0.5 };
    const rise = easeSound(SILENCE, loud, 0.05).squealGain;
    const fall = 0.5 - easeSound(loud, SILENCE, 0.05).squealGain;
    expect(rise).toBeGreaterThan(fall);
  });

  it("тон мотора успевает за оборотами быстрее, чем покрытие за колесом", () => {
    // Иначе мотор «плывёт» на переключении, а колесо на кромке асфальта трещит
    // сменой покрытия на каждом сантиметре.
    const target = soundMix(driving({ rpm: 6500, wheels: wheels("gravel") }));
    const step = easeSound(soundMix(driving()), target, 0.05);
    const reached = (now: number, from: number, aim: number) => (now - from) / (aim - from);
    const base = soundMix(driving());
    expect(reached(step.cycleHz, base.cycleHz, target.cycleHz)).toBeGreaterThan(
      reached(step.rollCut, base.rollCut, target.rollCut),
    );
  });
});

/** Амплитуда гармоники `k`, она же порядок коленвала `k/2`. */
function order(spectrum: { real: number[]; imag: number[] }, k: number): number {
  return Math.hypot(spectrum.real[k] ?? 0, spectrum.imag[k] ?? 0);
}

/** Сколько всего энергии сидит на тех гармониках, что проходят проверку. */
function energy(spectrum: { real: number[]; imag: number[] }, pick: (k: number) => boolean): number {
  let sum = 0;
  for (let k = 1; k < spectrum.real.length; k++) if (pick(k)) sum += order(spectrum, k) ** 2;
  return sum;
}

describe("звук: выхлоп", () => {
  it("вспышки ряда идут неровно, и в этом весь голос V8", () => {
    // Крестовый коленвал раскладывает четыре вспышки ряда через 270-180-90-180
    // градусов. Это не тембр, подобранный на слух, а следствие порядка вспышек,
    // и проверяется оно прямо по нему.
    const fires = bankFirings(0);
    expect(fires).toHaveLength(4);
    const gaps = fires.map((at, i) => ((fires[(i + 1) % fires.length]! - at + 1) % 1) * 720);
    expect(gaps.map(Math.round).sort((a, b) => a - b)).toEqual([90, 180, 180, 270]);
  });

  it("неровный ряд даёт половинные порядки, ровный — не даёт", () => {
    // Ровно этим бульканье американского V8 отличается от воя плоского
    // коленвала: половинные порядки бывают только у неравномерного чередования.
    const cross = exhaustOrders(bankFirings(0));
    const flat = exhaustOrders([0, 0.25, 0.5, 0.75]);
    const half = (k: number) => k % 2 === 1;
    expect(energy(flat, half)).toBeCloseTo(0, 10);
    expect(energy(cross, half)).toBeGreaterThan(energy(cross, (k) => !half(k)) * 0.3);
  });

  it("рокот живёт в разнице между рядами, а не в моторе целиком", () => {
    // Все восемь вспышек вместе идут через ровные 90°, и если сложить ряды без
    // разбора, вся неравномерность взаимно уничтожится — останутся только
    // кратные восьми гармоники, то есть ровное гудение. Поэтому у каждого ряда
    // должна быть своя труба: рокот берётся из того, что они звучат порознь.
    const both = [...Array(EXHAUST_BANKS).keys()].map((bank) => exhaustOrders(bankFirings(bank)));
    const together = {
      real: both[0]!.real.map((value, k) => value + (both[1]!.real[k] ?? 0)),
      imag: both[0]!.imag.map((value, k) => value + (both[1]!.imag[k] ?? 0)),
    };
    expect(energy(together, (k) => k % 8 !== 0)).toBeCloseTo(0, 10);
    expect(order(together, 8)).toBeGreaterThan(0.1);
  });

  it("импульс завален сверху, и завал сидит на порядке, а не на частоте", () => {
    // Клапан открыт постоянное число градусов коленвала, поэтому форма спектра
    // источника от оборотов не зависит вовсе — её и считают один раз навсегда.
    // Сравниваются кратные восьми гармоники: на них четыре импульса ряда всегда
    // складываются в фазе, так что от расстановки вспышек тут ничего не зависит
    // и видна ровно форма импульса.
    const bank = exhaustOrders(bankFirings(0));
    expect(order(bank, 24)).toBeLessThan(order(bank, 8) * 0.6);
    expect(order(bank, 120)).toBeLessThan(order(bank, 24) * 0.3);
    // Но не в ноль: без верхних порядков выхлоп звучит подушкой, а не ударами.
    expect(order(bank, 120)).toBeGreaterThan(0);
  });

  it("трубы стоят на месте и не совпадают друг с другом", () => {
    // Форманты заданы длиной трубы и скоростью звука, а не оборотами: именно
    // потому разгон слышен как смена тембра — порядки проползают сквозь них.
    const left = pipeModes(0);
    const right = pipeModes(1);
    // Гармонический ряд: труба, открытая с обоих концов, звучит именно так.
    for (let n = 1; n < left.length; n++) expect(left[n]!).toBeCloseTo(left[0]! * (n + 1), 6);
    // Первая мода — низы кузова, а не писк: горячий газ в трёх метрах трубы.
    expect(left[0]!).toBeGreaterThan(70);
    expect(left[0]!).toBeLessThan(130);
    // Ряды расстроены: пара сантиметров разницы даёт биения на низах.
    expect(right[0]!).toBeGreaterThan(left[0]!);
    expect(right[0]!).toBeLessThan(left[0]! * 1.15);
  });

  it("впуск ровно гудит целыми порядками, а половинных не знает", () => {
    // Ресивер один на весь мотор, и все восемь тактов приходят в него через
    // ровные 90°. Значит, неравномерности рядов впуск не видит вовсе: рокот —
    // дело выпуска, а впуск даёт чистый тон на частоте вспышек и его обертона.
    const air = exhaustOrders(intakeFirings());
    expect(energy(air, (k) => k % 8 !== 0)).toBeCloseTo(0, 10);
    expect(order(air, 8)).toBeGreaterThan(order(air, 16));
    // Тракт короткий и воздух холодный, поэтому поёт он выше выпускной трубы.
    expect(intakeModes()[0]!).toBeGreaterThan(pipeModes(0)[0]! * 1.5);
  });

  it("впуск слышен через открытую заслонку и молчит на накате", () => {
    // Заслонка не только пускает воздух в мотор, но и запирает звук: на сбросе
    // газа впуску просто неоткуда выйти наружу. По этому и слышно тягу.
    expect(soundMix(driving({ throttle: 0, rpm: 6500 })).intakeGain).toBe(0);
    const pulling = soundMix(driving({ throttle: 1, rpm: 6500 }));
    const lugging = soundMix(driving({ throttle: 1, rpm: 1200 }));
    expect(pulling.intakeGain).toBeGreaterThan(lugging.intakeGain);
    expect(lugging.intakeGain).toBeGreaterThan(0);
  });

  it("дыхание выпуска растёт с расходом газа", () => {
    // Шум потока — это расход, то есть обороты, помноженные на дроссель. На
    // холостых он почти не слышен, под нагрузкой на верхах — слышен заметно.
    const idle = soundMix(driving({ rpm: 800, throttle: 0 }));
    const pulling = soundMix(driving({ rpm: 6500, throttle: 1 }));
    expect(pulling.breathGain).toBeGreaterThan(idle.breathGain * 8);
    // И на сбросе газа он падает, но не исчезает: мотор всё ещё качает воздух.
    const coasting = soundMix(driving({ rpm: 6500, throttle: 0 }));
    expect(coasting.breathGain).toBeLessThan(pulling.breathGain * 0.5);
    expect(coasting.breathGain).toBeGreaterThan(0);
  });
});
