import { beforeAll, describe, expect, it } from "vitest";
import { Manual, headlessRun, type LoggedEvent } from "@gamespace/core";
import {
  MASS_KG,
  RIDE_HEIGHT_M,
  SUSPENSION_LOADED_M,
  TIRE_COLD_C,
  engineSettle,
  engineStep,
  pumpingNm,
} from "@gamespace/car";
import { hash01 } from "@gamespace/env";
import {
  GEAR_NEUTRAL,
  GEAR_REVERSE,
  LIMP_THROTTLE,
  RPM_IDLE,
  RPM_MAX,
  STUCK_LIMIT_MS,
  Centerline,
  corridorHalfWidth,
  crossSection,
  gearLabel,
  race,
  raceStuck,
  ratioFor,
  trackAt,
  type RaceState,
} from "@gamespace/race";
import { cameraFollow } from "../packages/race/src/view/follow.js";
import { describeContract } from "./contract-suite.js";

describeContract([race], race);

const ID = "org.reconnect.race";
const G = 9.81;

// Физику считает WASM: без загрузки ядру нечем шагать, поэтому её ждут один раз.
beforeAll(async () => {
  await race.prepare?.();
});

/**
 * Заезд начинается на нейтрали, как настоящая стоящая машина, поэтому передача
 * выбирается сразу: почти всякий тест здесь про езду, а не про селектор. Кому
 * нужен нетронутый старт — те передают `null` и смотрят на машину как есть.
 */
function start(level = 4, overrides: Record<string, number> = {}, gear: number | null = 3) {
  const run = headlessRun([race], ID, {
    seed: 7,
    policy: new Manual({ start: level }),
    overrides: { blockMs: 300_000, ...overrides },
  });
  run.instance.start();
  if (gear !== null) shift(run, gear);
  return run;
}

/**
 * Прямая и ровная дорога: сравнивать передачи иначе нельзя. Без руля машина в
 * вираже уезжает на обочину, и мерилось бы не поведение коробки, а траектория.
 */
function straight(gear: number) {
  const run = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 8 });
  shift(run, gear);
  hold(run, "throttle");
  return run;
}

function state(run: ReturnType<typeof start>): RaceState {
  return run.instance.state as unknown as RaceState;
}

function speed(run: ReturnType<typeof start>): number {
  return Math.abs(state(run).frame?.speedMs ?? 0);
}

function domain(records: LoggedEvent[], type: string): LoggedEvent[] {
  return records.filter((r) => r.source === "domain" && r.type === type);
}

function hold(run: ReturnType<typeof start>, id: string, down = true): void {
  run.instance.submitAction(id, { phase: down ? "down" : "up" }, "keyboard");
}

/** Курс машины из кватерниона: рысканье вокруг вертикали. */
function heading(frame: { qx: number; qy: number; qz: number; qw: number }): number {
  return Math.atan2(
    2 * (frame.qw * frame.qy + frame.qx * frame.qz),
    1 - 2 * (frame.qy * frame.qy + frame.qx * frame.qx),
  );
}

/** Ступень вперёд, считая от нуля: селектор с задним ходом и нейтралью — ниже. */
function shift(run: ReturnType<typeof start>, to: number): void {
  select(run, to + 1);
}

/** Положение селектора как есть: −1 — задний ход, 0 — нейтраль, 1.. — вперёд. */
function select(run: ReturnType<typeof start>, gear: number): void {
  for (let i = 0; i < 12; i++) run.instance.submitAction("gearDown", {}, "keyboard");
  for (let i = GEAR_REVERSE; i < gear; i++) run.instance.submitAction("gearUp", {}, "keyboard");
}

describe("заезд: физика", () => {
  it("газ разгоняет, отпущенный газ замедляет", () => {
    const run = start();
    hold(run, "throttle");
    run.clock.advance(6000);
    const fast = speed(run);
    expect(fast).toBeGreaterThan(8);

    hold(run, "throttle", false);
    run.clock.advance(6000);
    expect(speed(run)).toBeLessThan(fast);
    expect(state(run).distance).toBeGreaterThan(0);
  });

  it("машина трогается с любой передачи: ни одна не глохнет", () => {
    // Раньше тяга была пропорциональна передаточному числу, и с высокой передачи
    // машина не двигалась вообще. В коробке всё наоборот, и это ровно та ошибка.
    for (const gear of [0, 2, 4, 5]) {
      const run = start(4);
      shift(run, gear);
      const from = state(run).distance;
      hold(run, "throttle");
      run.clock.advance(6000);
      expect({ gear, moved: state(run).distance - from > 5 }).toEqual({ gear, moved: true });
    }
  });

  it("низкая передача рвёт с места, высокая едет дальше", () => {
    const low = straight(0);
    const high = straight(5);

    low.clock.advance(2500);
    high.clock.advance(2500);
    expect(speed(low)).toBeGreaterThan(speed(high));

    low.clock.advance(40_000);
    high.clock.advance(40_000);
    // На низкой обороты давно в отсечке: тяги нет, и высокая обгоняет.
    expect(speed(high)).toBeGreaterThan(speed(low));
    expect(state(high).distance).toBeGreaterThan(state(low).distance);
    expect(state(low).rpm).toBeGreaterThan(state(high).rpm);
    // Вот в этом весь смысл метафоры: газ на низкой уходит в обороты и нагрев.
    expect(state(low).temp).toBeGreaterThan(state(high).temp);
  });

  it("КПД выше на высокой передаче, чем на низкой", () => {
    const low = straight(0);
    low.clock.advance(40_000);
    const high = straight(5);
    high.clock.advance(40_000);

    const efficiency = (s: RaceState) => s.distance / s.effortIntegral;
    expect(efficiency(state(high))).toBeGreaterThan(efficiency(state(low)));
  });

  it("полный газ на низкой передаче перегревает двигатель, высокая охлаждает", () => {
    const run = straight(0);
    run.clock.advance(60_000);
    expect(state(run).overheat).toBe(true);
    expect(domain(run.records(), "overheat.start").length).toBe(1);

    shift(run, 5);
    run.clock.advance(40_000);
    expect(state(run).overheat).toBe(false);
    expect(domain(run.records(), "overheat.end").length).toBe(1);
  });

  it("руль выводит из полосы, за полосой машина теряет скорость", () => {
    const run = start(1, { roadHalfWidth: 3.5 });
    hold(run, "throttle");
    run.clock.advance(10_000);
    const onRoad = speed(run);
    hold(run, "right");
    // Смотреть надо на весь заезд, а не на его конец: под полным рулём машина
    // успевает уйти за коридор, и там её возвращают на ось. Проверяется, что руль
    // уводит с полосы, а не то, где именно окажется машина к восьмой секунде.
    let farthest = 0;
    let offroad = false;
    for (let i = 0; i < 32; i++) {
      run.clock.advance(250);
      farthest = Math.max(farthest, Math.abs(state(run).lateral));
      offroad ||= state(run).offroad;
    }
    expect(farthest).toBeGreaterThan(3.5);
    expect(offroad).toBe(true);
    expect(speed(run)).toBeLessThan(onRoad);
    expect(domain(run.records(), "offroad.enter").length).toBeGreaterThan(0);
  });

  it("тормоз гасит скорость быстрее, чем сброс газа, и держит машину на месте", () => {
    const coast = start(1);
    hold(coast, "throttle");
    coast.clock.advance(15_000);
    const rolling = speed(coast);
    expect(rolling).toBeGreaterThan(5);
    hold(coast, "throttle", false);
    coast.clock.advance(2000);

    const braked = start(1);
    hold(braked, "throttle");
    braked.clock.advance(15_000);
    hold(braked, "throttle", false);
    hold(braked, "brake");
    braked.clock.advance(2000);

    expect(speed(braked)).toBeLessThan(speed(coast));

    // Держим тормоз долго: машина стоит, а не откатывается и не дрожит.
    braked.clock.advance(15_000);
    expect(speed(braked)).toBeLessThan(0.5);
    hold(braked, "brake", false);
    hold(braked, "throttle");
    braked.clock.advance(6000);
    expect(speed(braked)).toBeGreaterThan(2);
  });

  /**
   * Замедление меряется в долях g, потому что тормозит не педаль, а сцепление:
   * сколько шина держит, столько машина и отдаёт. Раньше сила шла в контроллер
   * вместо импульса за шаг, и выходило полтора g — то есть шину просто обходили.
   */
  it("тормоз замедляет по сцеплению, и руль в торможении жив", () => {
    // Верхняя граница — это сцепление: сильнее, чем держит асфальт, не тормозит
    // никакая педаль, и замедление за единицу же означало бы, что шину обошли.
    // Нижняя — что тормоз всё-таки тормоз: на одной задней оси выходило меньше
    // трети же, и машина катилась в поворот, будто педали нет.
    const run = straight(4);
    run.clock.advance(15_000);
    hold(run, "throttle", false);
    const from = speed(run);
    hold(run, "brake");
    run.clock.advance(1000);
    const decel = from - speed(run);
    expect(decel).toBeGreaterThan(0.45 * G);
    expect(decel).toBeLessThan(1.0 * G);

    // Руль под тормозом жив только потому, что колёса катятся, а не стоят юзом:
    // заблокированное колесо теряет боковую силу вместе с продольной. Мерить это
    // надо, пока машина едет: под этим замедлением она встаёт за две секунды, а у
    // стоящей курс не меняется ни при каком руле, и мерилось бы не сцепление.
    const before = heading(state(run).frame!);
    hold(run, "right");
    let turned = 0;
    while (speed(run) > 3) {
      run.clock.advance(100);
      turned = Math.abs(heading(state(run).frame!) - before);
    }
    expect(turned).toBeGreaterThan(0.05);
  });

  it("колёса живут своей жизнью: на траве буксуют, на асфальте катятся", () => {
    // Разница между «колесо катится» и «колесо крутится» — это и есть шина.
    // Пока продольную силу считала коробка, её не было вовсе: колесо было просто
    // картинкой, вращаемой по скорости машины, и забуксовать не могло.
    const road = straight(3);
    road.clock.advance(12_000);
    const rolling = state(road);
    expect(rolling.frame!.speedMs).toBeGreaterThan(5);
    // На асфальте обод обгоняет дорогу на проценты, а не в разы.
    expect(rolling.frame!.driveSpeedMs).toBeGreaterThan(rolling.frame!.speedMs * 0.95);
    expect(rolling.frame!.driveSpeedMs).toBeLessThan(rolling.frame!.speedMs * 1.15);
    for (const wheel of rolling.frame!.wheels) {
      expect(wheel.surface).toBe("asphalt");
      expect(wheel.slide).toBeLessThan(0.2);
    }

    const grass = straight(3);
    grass.clock.advance(6000);
    hold(grass, "right");
    // Смотреть надо пока машина на грунте, а не через шесть секунд: уехав за
    // коридор, она вернётся на полосу сама, и в последнем кадре все четыре колеса
    // снова на асфальте — мерилось бы уже не поведение шины, а возврат.
    let offroad = false;
    let slipping = 0;
    for (let i = 0; i < 24; i++) {
      grass.clock.advance(250);
      const wheels = state(grass).frame!.wheels;
      if (!wheels.some((wheel) => wheel.surface !== "asphalt")) continue;
      offroad = true;
      slipping = Math.max(slipping, ...wheels.map((wheel) => wheel.slide));
    }
    expect(offroad).toBe(true);
    // На траве та же машина под тем же газом скользит на порядок сильнее.
    const gripping = Math.max(...rolling.frame!.wheels.map((wheel) => wheel.slide));
    expect(slipping).toBeGreaterThan(gripping * 5);
  });

  it("обороты — маховик, а не показание: они набираются, падают и держат холостые", () => {
    // Раньше обороты назначались: газ ставил их на полку и держал там, отпущенный
    // газ не менял ничего, а падали они только когда тормоз замедлит колесо. Ни
    // маховика, ни отклика — обороты были следствием скорости, а не состоянием.
    const run = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 8 });
    shift(run, 0);
    hold(run, "brake");
    run.clock.advance(1000);
    expect(state(run).rpm).toBeCloseTo(RPM_IDLE, 0);

    // Под тормозом колесо стоит, значит всё, что делает газ, — крутит маховик
    // против трансформатора. Крутит не мгновенно: у маховика есть инерция.
    hold(run, "throttle");
    run.clock.advance(150);
    const early = state(run).rpm;
    run.clock.advance(1500);
    const settled = state(run).rpm;
    expect(early).toBeGreaterThan(RPM_IDLE + 100);
    expect(early).toBeLessThan(settled * 0.8);
    expect(settled).toBeGreaterThan(2000);
    expect(settled).toBeLessThan(2800);

    // И падают сами, без всякого тормоза: газ убрали — крутить стало нечем.
    hold(run, "throttle", false);
    run.clock.advance(1500);
    expect(state(run).rpm).toBeCloseTo(RPM_IDLE, 0);
  });

  it("сброшенный газ тормозит двигателем, а не только воздухом", () => {
    // Насосные потери — работа против закрытой заслонки. Пока их не было, сброс
    // газа не делал ничего: машина катилась на одном сопротивлении воздуха, и
    // обороты висели на месте, потому что держать их было некому.
    const run = straight(3);
    run.clock.advance(15_000);
    hold(run, "throttle", false);
    const from = speed(run);
    const revs = state(run).rpm;
    run.clock.advance(3000);
    const decel = (from - speed(run)) / 3;
    // Ощутимо больше воздуха, но заметно меньше тормоза: это мотор, а не колодки.
    expect(decel).toBeGreaterThan(0.4);
    expect(decel).toBeLessThan(0.3 * G);
    // Обороты падают вместе со скоростью: трансформатор замкнут, связь жёсткая.
    expect(state(run).rpm).toBeLessThan(revs * 0.95);
    // Заслонка открыта — качать против нечего, и потерь нет.
    expect(pumpingNm(3000, 1)).toBe(0);
    expect(pumpingNm(3000, 0)).toBeGreaterThan(pumpingNm(1000, 0));
  });

  it("шины греются от работы и остывают, когда работать перестают", () => {
    // Нагрев — не индикатор, а часть модели: горячая шина держит хуже холодной,
    // и долгий срыв поэтому наказывает сам себя.
    const run = straight(3);
    run.clock.advance(4000);
    const cold = state(run);
    for (const wheel of cold.frame!.wheels) expect(wheel.tempC).toBeLessThan(TIRE_COLD_C + 10);

    hold(run, "right");
    run.clock.advance(8000);
    const hot = state(run);
    const hottest = Math.max(...hot.frame!.wheels.map((wheel) => wheel.tempC));
    expect(hottest).toBeGreaterThan(TIRE_COLD_C + 25);

    hold(run, "right", false);
    hold(run, "throttle", false);
    run.clock.advance(20_000);
    const cooled = state(run);
    expect(Math.max(...cooled.frame!.wheels.map((wheel) => wheel.tempC))).toBeLessThan(hottest);
  });

  it("подвеска работает: колёса держат дорогу и ход не выходит из хода", () => {
    // Дорога прямая: иначе машина без руля уезжает с полосы, и мерилась бы не
    // подвеска, а траектория.
    const run = straight(3);
    run.clock.advance(12_000);
    const wheels = state(run).frame?.wheels ?? [];
    expect(wheels.length).toBe(4);
    for (const wheel of wheels) {
      expect(wheel.contact).toBe(true);
      expect(wheel.suspension).toBeGreaterThan(0);
      expect(wheel.suspension).toBeLessThanOrEqual(0.6);
    }
    // Колёса крутятся, а не проскальзывают на месте.
    expect(Math.abs(wheels[0]!.spin)).toBeGreaterThan(1);
  });

  it("машина стоит на дороге на той высоте, на которую её ставит сцена", () => {
    // Сцена вешает модель жёстким смещением от кузова физики, а колёса — по ходу
    // подвески. Если просадка в равновесии не та, что записана в габаритах, модель
    // поедет либо утопленной в асфальт, либо на невидимых сваях.
    const run = start(1, { curveRate: 0, gradeMax: 0 });
    run.clock.advance(4000);
    const frame = state(run).frame!;
    for (const wheel of frame.wheels) {
      expect(Math.abs(wheel.suspension - SUSPENSION_LOADED_M)).toBeLessThan(0.05);
    }
    const height = frame.y - frame.groundY;
    expect(Math.abs(height - RIDE_HEIGHT_M)).toBeLessThan(0.08);
  });

  it("руль не круче семи десятых g: иначе машина уходит в разворот, а не в поворот", () => {
    // Раньше предел руля был постоянным, и на пятидесяти километрах в час полный
    // вылет давал радиус поворота в три метра — два g в бок. Машина не поворачивала,
    // а уходила боком с дороги, и держаться полосы было нельзя.
    const run = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 9 });
    shift(run, 3);
    hold(run, "throttle");
    run.clock.advance(20_000);
    const fast = speed(run);
    expect(fast).toBeGreaterThan(12);

    hold(run, "right");
    let worst = 0;
    let measured = 0;
    let previous = heading(state(run).frame!);
    // Считаем только пока машина на асфальте: на валу за обочиной кузов кренит, и
    // мерилось бы уже не поведение руля, а склон.
    while (Math.abs(state(run).lateral) < 9) {
      const before = speed(run);
      run.clock.advance(100);
      const now = heading(state(run).frame!);
      let turn = now - previous;
      while (turn > Math.PI) turn -= 2 * Math.PI;
      while (turn < -Math.PI) turn += 2 * Math.PI;
      previous = now;
      // Боковое ускорение = скорость × угловая скорость рысканья.
      worst = Math.max(worst, (Math.abs(turn) / 0.1) * before);
      measured++;
    }
    expect(measured).toBeGreaterThan(5);
    // Запас к пределу — на дискретность: тик игры и шаг физики не совпадают, и
    // на стометровом интервале выборки угол набегает неровно.
    expect(worst).toBeLessThan(0.75 * G * 1.25);
    // И при этом машина всё-таки поворачивает, а не едет прямо.
    expect(worst).toBeGreaterThan(0.15 * G);
  });

  it("ведущие колёса можно сорвать на асфальте, и срываются именно задние", () => {
    // Сорвать шину было нельзя вовсе, и мешали этому две вещи сразу. Момент делился
    // на четыре поровну — на колесо приходилось вчетверо меньше, чем держит пятно.
    // А неявный шаг шины линеаризовался наклоном кривой в нуле, и за пиком, где
    // держать уже нечем, он всё равно делил ускорение колеса на полсотни.
    //
    // Рвать резину надо в повороте, а не с места. С места сухой асфальт держит:
    // две тонны на четырёх колёсах, полный привод, и сколько бы ни было момента,
    // предел сцепления выше. Так и должно быть — тяжёлый вседорожник не жжёт
    // резину со светофора. А вот в вираже под газом задняя ось разгружена
    // поперечной силой, и вот там она уходит.
    const run = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 9 });
    shift(run, 2);
    hold(run, "throttle");
    run.clock.advance(4000);
    shift(run, 1);
    hold(run, "right");

    let front = 0;
    let rear = 0;
    for (let i = 0; i < 20; i++) {
      run.clock.advance(150);
      const wheels = state(run).frame!.wheels;
      front = Math.max(front, wheels[0]!.slide, wheels[1]!.slide);
      rear = Math.max(rear, wheels[2]!.slide, wheels[3]!.slide);
    }
    expect(rear).toBeGreaterThan(0.5);
    expect(rear).toBeGreaterThan(front * 2);

    // И трение греет ровно то, что скользит: задние шины горячее передних.
    const hot = state(run).frame!.wheels;
    expect(Math.max(hot[2]!.tempC, hot[3]!.tempC)).toBeGreaterThan(
      Math.max(hot[0]!.tempC, hot[1]!.tempC) + 3,
    );
  });

  it("буксующая шина чернит асфальт, катящаяся — нет", () => {
    // Сорванные в заносе задние чернят дорогу, и чернят вместе с тем, как
    // греются: это тот самый след, который остаётся после силового заноса.
    const run = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 9 });
    shift(run, 2);
    hold(run, "throttle");
    run.clock.advance(4000);
    shift(run, 1);
    hold(run, "right");
    let blackest = 0;
    // Держащее колесо не чернит дорогу ни в один момент: чернит скольжение, а не
    // езда. Проверяется на каждом кадре, потому что это и есть содержание модели.
    for (let i = 0; i < 20; i++) {
      run.clock.advance(150);
      for (const wheel of state(run).frame!.wheels) {
        blackest = Math.max(blackest, wheel.mark);
        if (wheel.slide < 0.1) expect(wheel.mark).toBe(0);
      }
    }
    expect(blackest).toBeGreaterThan(0.3);

    // А спокойно катящееся колесо не чернит ничего, сколько ни едь.
    const rolling = straight(4);
    rolling.clock.advance(12_000);
    for (const wheel of state(rolling).frame!.wheels) expect(wheel.mark).toBe(0);
  });

  it("зад уходит в занос, и руль сам перекладывается в контрруль", () => {
    // Силовой занос: разогнались, воткнули пониженную, руль внутрь и полный газ.
    // Клавиша при этом всё время одна — «вправо»; то, что руль уходит влево,
    // делает не игрок, а стабилизирующий момент, который тянет колёса туда, куда
    // едет передняя ось. Ровно поэтому брошенный в заносе руль ловит машину сам.
    const run = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 9 });
    shift(run, 2);
    hold(run, "throttle");
    run.clock.advance(4000);
    shift(run, 1);
    hold(run, "right");

    let last = state(run).frame!;
    let worstSlip = 0;
    let counter = 0;
    let rearOut = 0;
    for (let i = 0; i < 20; i++) {
      run.clock.advance(150);
      const frame = state(run).frame!;
      const course = heading(frame);
      const going = Math.atan2(frame.x - last.x, frame.z - last.z);
      worstSlip = Math.max(worstSlip, Math.abs(Math.atan2(Math.sin(going - course), Math.cos(going - course))));
      counter = Math.min(counter, frame.wheels[0]!.steer);
      const front = Math.max(frame.wheels[0]!.slide, frame.wheels[1]!.slide);
      const rear = Math.max(frame.wheels[2]!.slide, frame.wheels[3]!.slide);
      rearOut = Math.max(rearOut, rear - front);
      last = frame;
    }
    // Кузов едет боком: не поворот, а занос.
    expect(worstSlip).toBeGreaterThan(0.17);
    // Наружу идёт зад, а не передок: иначе это снос, и лечится он не рулём.
    expect(rearOut).toBeGreaterThan(0.25);
    // Руль ушёл в другую сторону от нажатой клавиши.
    expect(counter).toBeLessThan(-0.03);
  });

  it("трава держит машину медленной, сколько ни дави на газ", () => {
    // Съезд обязан стоить скорости, иначе полоса не нужна: раньше грунт отнимал
    // десять километров в час, и по траве ехали как по асфальту.
    const road = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 9 });
    hold(road, "throttle");
    road.clock.advance(20_000);
    const onRoad = speed(road);

    // Съезд под малым углом: машина идёт по траве вдоль дороги, а не поперёк, и
    // потолок скорости на грунте успевает установиться до вала.
    hold(road, "right");
    road.clock.advance(400);
    hold(road, "right", false);
    for (let i = 0; i < 40 && !state(road).offroad; i++) road.clock.advance(250);
    expect(state(road).offroad).toBe(true);

    // Сразу после съезда машина ещё катится на дорожной скорости: важно не это
    // мгновение, а то, до чего грунт её доводит при полном газе.
    let onGrass = onRoad;
    let sampled = 0;
    for (let i = 0; i < 40 && state(road).offroad; i++) {
      road.clock.advance(250);
      if (!state(road).offroad) break;
      onGrass = speed(road);
      sampled++;
    }
    expect(sampled).toBeGreaterThan(10);
    expect(onGrass).toBeLessThan(onRoad * 0.45);
    // И при этом трава не капкан: у неё есть потолок, а не ноль. С постоянным
    // сопротивлением машина тормозилась насмерть, вставала на месте и грелась,
    // пока не сгорит, — вернуться на дорогу было нельзя вообще.
    expect(onGrass).toBeGreaterThan(4);
  });

  it("без газа машина стоит на любой передаче", () => {
    // Гидротрансформатор тянет на холостых всегда, и в первой передаче это та
    // самая ползучесть автомата — шесть километров в час. Но передачу здесь
    // выбирает человек, и во второй та же ползучесть выходила под четырнадцать:
    // отпустил тормоз на нуле, газа не касался, а машина уезжала сама. Настоящая
    // коробка от этого и разжимает пакет на стоянке.
    for (const gear of [0, 2, 5]) {
      const run = straight(gear);
      hold(run, "throttle", false);
      hold(run, "brake");
      run.clock.advance(3000);
      hold(run, "brake", false);
      run.clock.advance(30_000);
      expect(speed(run)).toBeLessThan(0.3);
    }
  });

  it("у стоящей на траве машины колёса не крутятся", () => {
    // Момент делился по колёсам независимо от того, есть ли под ними земля, и
    // вывешенное на кочке колесо разгонялось до сотен радиан в секунду: упиралось
    // только в вязкость. Отсюда росли обе небылицы — переднее колесо, крутящееся у
    // стоящей на траве машины, и тахометр на пятнадцати тысячах, потому что обороты
    // мотор берёт с обода ведущих. Дифференциал так не умеет: толкать одно колесо,
    // не опираясь на другое, нечем.
    const run = straight(1);
    hold(run, "throttle");
    hold(run, "right");
    for (let i = 0; i < 40; i++) {
      run.clock.advance(100);
      if (state(run).frame!.wheels.every((wheel) => wheel.surface !== "asphalt")) break;
    }
    hold(run, "right", false);
    hold(run, "throttle", false);
    hold(run, "brake");
    run.clock.advance(5000);
    expect(speed(run)).toBeLessThan(0.3);

    let fastest = 0;
    let was = state(run).frame!.wheels.map((wheel) => wheel.spin);
    for (let i = 0; i < 40; i++) {
      run.clock.advance(100);
      const wheels = state(run).frame!.wheels;
      fastest = Math.max(fastest, ...wheels.map((wheel, k) => Math.abs(wheel.spin - was[k]!) / 0.1));
      was = wheels.map((wheel) => wheel.spin);
    }
    // Меньше оборота в секунду по ободу — это уже дрожь решателя, а не вращение.
    expect(fastest).toBeLessThan(1);
    expect(state(run).rpm).toBeLessThan(RPM_MAX);
  });

  it("колесо, оторвавшееся от земли на ходу, не уносит за собой обороты", () => {
    // Оборотная сторона того же: обод ведущих задаёт обороты, и висящее колесо,
    // которому доставался момент, утаскивало тахометр за собой. На кочках вала
    // обод убегал от машины на полтораста километров в час, а стрелка уходила к
    // семи тысячам — на грунте, где машина едва ползёт.
    const run = straight(1);
    hold(run, "throttle");
    hold(run, "right");
    run.clock.advance(4000);
    hold(run, "right", false);

    let overrun = 0;
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      run.clock.advance(50);
      const frame = state(run).frame!;
      overrun = Math.max(overrun, frame.driveSpeedMs - Math.abs(frame.speedMs));
      peak = Math.max(peak, state(run).rpm);
    }
    // Буксовать на траве колесо обязано, но обод не может уйти от машины дальше,
    // чем позволяет сцепление: три десятка метров в секунду — это уже не занос.
    // Порог именно такой широкий нарочно. Ловится здесь обрыв связи обода с
    // дорогой, а он давал полтораста метров в секунду, а не двадцать против
    // двадцати трёх: сама траектория съезда на траву от любой мелочи в руле
    // гуляет, и десятки процентов буксования вместе с ней.
    expect(overrun).toBeLessThan(30);
    // Отсечка мягкая, поэтому предел с запасом на её полосу — но не в полтора раза.
    expect(peak).toBeLessThan(RPM_MAX * 1.1);
  });

  it("с травы можно тронуться и уехать обратно на полосу", () => {
    // Обратная сторона предыдущего: грунт обязан стоить скорости, но не обязан
    // быть капканом. Здесь сходилось сразу три вещи, и каждая по отдельности
    // выглядела безобидно. Постоянное сопротивление грунта было больше, чем
    // способна отдать шина. Хвост кривой Пацейки за срывом валился к четверти
    // пика, и буксующее колесо не тянуло почти ничего. А отсечка обрубала момент
    // ножом — стоило колесу забуксовать, оно само загоняло коленвал за предел и
    // обнуляло тягу. Вместе это давало машину, которая на полном газу ревёт,
    // роет землю и стоит.
    const run = straight(1);
    hold(run, "right");
    let out = 0;
    for (; out < 40; out++) {
      run.clock.advance(100);
      if (state(run).frame!.wheels.every((wheel) => wheel.surface === "grass")) break;
    }
    // Выравниваемся вдоль дороги и тормозим прямо в развороте: иначе меряли бы не
    // траву, а склон вала — или выкатились бы обратно на асфальт.
    hold(run, "right", false);
    hold(run, "throttle", false);
    hold(run, "brake");
    hold(run, "left");
    for (let i = 0; i <= out; i++) run.clock.advance(100);
    hold(run, "left", false);

    // Полная остановка на грунте: трогание с нуля и есть то место, где капкан
    // захлопывался.
    run.clock.advance(4000);
    hold(run, "brake", false);
    expect(speed(run)).toBeLessThan(0.5);
    const stood = state(run).frame!.wheels.map((wheel) => wheel.surface);
    expect(stood).not.toContain("asphalt");
    expect(stood).toContain("grass");

    hold(run, "throttle");
    let best = 0;
    for (let i = 0; i < 60; i++) {
      run.clock.advance(100);
      best = Math.max(best, speed(run));
    }
    expect(best).toBeGreaterThan(3);
  });

  it("за вал машина не уходит: её держит грунт, а не запрет", () => {
    // За гребнем вала земли нет ни в физике, ни в картинке, и ядро на этот случай
    // возвращает машину на полосу. Но выйти за вал своим ходом теперь нельзя
    // вовсе: раньше колёса тянули по траве почти как по асфальту, и вал брался
    // разгоном, а с честным сцеплением машина вязнет на подъёме и сползает
    // обратно. Сторожим здесь именно это — и то, что при этом ничего не сломалось:
    // машина остаётся в коридоре, на земле и на колёсах.
    const run = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 3 });
    hold(run, "throttle");
    run.clock.advance(25_000);
    const onRoad = speed(run);
    expect(onRoad).toBeGreaterThan(30);

    hold(run, "right");
    let farthest = 0;
    for (let i = 0; i < 30; i++) {
      run.clock.advance(1000);
      const frame = state(run).frame!;
      farthest = Math.max(farthest, Math.abs(frame.lateral));
      expect(Math.abs(frame.lateral)).toBeLessThan(corridorHalfWidth(3));
      expect(frame.y).toBeGreaterThan(frame.groundY - 1);
    }
    // Проверка не вырождена: машина дошла до вала, а не крутилась у обочины.
    expect(farthest).toBeGreaterThan(18);
    // И заплатила за съезд скоростью: трава — не второй асфальт.
    expect(speed(run)).toBeLessThan(onRoad * 0.45);
  });

  it("стоящая под газом машина вне полосы считается тупиком", () => {
    // Уткнувшись в склон вала на половинной мощности или улёгшись днищем в траву,
    // машина остаётся без хода: колёса крутятся, тяга никуда не идёт, а полный газ
    // на месте догревает мотор — тупик запирает сам себя. Такую машину возвращают
    // на полосу, и правило нарочно узкое: на полосе остановка законна, а без газа
    // участник и не пытается ехать.
    expect(raceStuck(0.1, true, 1)).toBe(true);
    expect(raceStuck(0.1, false, 1)).toBe(false);
    expect(raceStuck(0.1, true, 0)).toBe(false);
    expect(raceStuck(4, true, 1)).toBe(false);
    // Ждут недолго: дольше двух с половиной секунд неподвижности терпеть незачем.
    expect(STUCK_LIMIT_MS).toBeLessThanOrEqual(3000);
  });

  it("с обочины можно выехать даже перегретым: съезд стоит скорости, а не заезда", () => {
    // Сопротивление грунта обязано быть меньше самой слабой тяги: иначе съезд —
    // это конец заезда, а участник ничего не может сделать.
    const run = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 3 });
    hold(run, "throttle");
    run.clock.advance(6000);
    hold(run, "right");
    run.clock.advance(1500);
    hold(run, "right", false);
    expect(state(run).offroad).toBe(true);
    // На обочине, а не на валу: с вала разговор другой, оттуда машину возвращают.
    expect(Math.abs(state(run).lateral)).toBeLessThan(11);

    const before = state(run).distance;
    run.clock.advance(8000);
    expect(state(run).distance - before).toBeGreaterThan(20);
    expect(speed(run)).toBeGreaterThan(2);
  });

  it("физика детерминирована: одинаковые входы дают одинаковый мир до бита", () => {
    // На этом держится и повтор журнала, и снимок: движок физический, но
    // воспроизводимость обязана остаться нашей.
    const drive = (run: ReturnType<typeof start>) => {
      hold(run, "throttle");
      run.clock.advance(4000);
      hold(run, "right");
      run.clock.advance(3000);
      hold(run, "right", false);
      hold(run, "brake");
      run.clock.advance(2000);
    };
    const a = start(6);
    const b = start(6);
    drive(a);
    drive(b);
    expect(state(a).frame).toEqual(state(b).frame);
    expect(state(a).body).toEqual(state(b).body);
  });

  it("перевёрнутую машину возвращают на дорогу, а не бросают вверх колёсами", () => {
    const run = start(8, { roadHalfWidth: 2.4 });
    hold(run, "throttle");
    // Долго и с полным рулём: рано или поздно машина уходит на вал и кувыркается.
    hold(run, "right");
    run.clock.advance(60_000);
    const events = domain(run.records(), "spin.out");
    if (events.length === 0) {
      // Кувырка не случилось — это допустимо, важно, что машина осталась в мире.
      expect(Number.isFinite(state(run).frame?.y ?? Number.NaN)).toBe(true);
      return;
    }
    expect(state(run).frame!.upright).toBeGreaterThan(0);
    expect(state(run).respawns).toBe(events.length);
  });
});

describe("заезд: коробка передач", () => {
  it("приборы называют передачи словами, а не числом с минусом", () => {
    // Ступени и отношения — дело коробки, а вот подпись под стрелкой читает
    // участник, и «−1» на ней не говорит ничего.
    expect(gearLabel(GEAR_REVERSE, 6)).toContain("задний");
    expect(gearLabel(GEAR_NEUTRAL, 6)).toContain("нейтраль");
    expect(gearLabel(3, 6)).toBe("3 из 6");
  });

  it("заезд начинается на нейтрали и без передачи не трогается", () => {
    // Первый шаг отдан участнику: сначала передача, потом газ. Пока блок
    // начинался сразу в передаче, машина ехала с первого касания газа.
    const run = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 8 }, null);
    expect(state(run).gear).toBe(GEAR_NEUTRAL);
    hold(run, "throttle");
    run.clock.advance(5000);
    expect(speed(run)).toBeLessThan(0.5);
    expect(state(run).rpm).toBeGreaterThan(RPM_MAX * 0.9);

    // Одна стрелка вверх — и та же педаль уже везёт.
    run.instance.submitAction("gearUp", {}, "keyboard");
    expect(state(run).gear).toBe(1);
    run.clock.advance(4000);
    expect(speed(run)).toBeGreaterThan(3);
  });

  it("на нейтрали мотор раскручивается свободно, а на колёса не уходит ничего", () => {
    // Нулевое отношение считает коробка, а видно это на дороге так: газ ревёт, а
    // машина стоит. Обратная сторона того же — нейтраль не тормозит двигателем.
    const run = straight(1);
    select(run, GEAR_NEUTRAL);
    run.clock.advance(4000);
    expect(speed(run)).toBeLessThan(0.5);
    expect(state(run).rpm).toBeGreaterThan(RPM_MAX * 0.9);
    // И тормозить двигателем нейтраль не умеет: газ отпущен, обороты падают к
    // холостым, а машина катится дальше почти без потерь.
    hold(run, "throttle", false);
    run.clock.advance(3000);
    expect(state(run).rpm).toBeLessThan(RPM_IDLE * 1.2);
  });

  it("задний ход везёт назад, а вперёд — не даёт", () => {
    const run = straight(1);
    select(run, GEAR_REVERSE);
    run.clock.advance(4000);
    const back = state(run);
    expect(back.frame!.speedMs).toBeLessThan(-3);
    expect(back.distance).toBeLessThan(0);
    // Обороты при этом обычные: назад едут на первой по сути передаче.
    expect(back.rpm).toBeGreaterThan(RPM_IDLE);
    expect(back.rpm).toBeLessThan(RPM_MAX * 1.1);
  });

  it("на ходу вперёд задний ход не включается, пока не остановишься", () => {
    // Блокировка настоящей коробки: смыкать пакет против хода нельзя. Мотор при
    // этом взвывает вхолостую — связи с колёсами нет вовсе.
    const run = straight(2);
    run.clock.advance(5000);
    const rolling = speed(run);
    expect(rolling).toBeGreaterThan(10);

    select(run, GEAR_REVERSE);
    run.clock.advance(4000);
    expect(state(run).rpm).toBeGreaterThan(RPM_MAX * 0.9);
    // Машина всё ещё едет вперёд и только замедляется накатом.
    expect(state(run).frame!.speedMs).toBeGreaterThan(0);
    expect(speed(run)).toBeLessThan(rolling);

    hold(run, "throttle", false);
    hold(run, "brake");
    run.clock.advance(8000);
    hold(run, "brake", false);
    hold(run, "throttle");
    run.clock.advance(3000);
    // Остановились — и задний взялся сам, безо всяких повторных переключений.
    expect(state(run).frame!.speedMs).toBeLessThan(-1);
  });

  it("самая сильная передача побеждает самый крутой подъём даже с перегревом", () => {
    // Иначе заезд превращается в ловушку: перегретая машина встанет на уклоне
    // навсегда, а участник не сможет сделать ничего.
    const gradeMax = (race.manifest.parametersSchema.schema as any).properties.gradeMax.maximum as number;
    const weakest = engineSettle({
      wheelSpeedMs: 0,
      ratio: ratioFor(1, 6),
      throttle: 1,
      powerCap: LIMP_THROTTLE,
    }).forceN;
    expect(weakest).toBeGreaterThan(MASS_KG * G * gradeMax);
  });
});

describe("заезд: обучение", () => {
  it("правило и критерий допуска объявлены проверяемо", () => {
    // Без правила обучение начинается со стимула, а критерий прозой («точность
    // хотя бы шестьдесят процентов») нечем проверить: неизвестно, что считается
    // попыткой и сколько последних берётся в окно.
    expect(race.manifest.training.rule?.summary).toBeTruthy();
    expect(race.manifest.training.admission).toMatchObject({ counts: "trial" });
  });

  it("незачтённый сектор в обучении разбирается словами", () => {
    const run = headlessRun([race], ID, {
      seed: 7,
      policy: new Manual({ start: 1 }),
      overrides: { blockMs: 300_000, curveRate: 0, gradeMax: 0, roadHalfWidth: 3 },
      training: true,
    });
    run.instance.start();
    select(run, 4);
    hold(run, "throttle");
    // Уводим машину с полотна и ждём закрытия сектора: именно съезд его и портит.
    run.clock.advance(4000);
    hold(run, "right");
    run.clock.advance(1500);
    hold(run, "right", false);
    const sectors = () => state(run).sectors;
    for (let i = 0; i < 200 && sectors() === 0; i++) run.clock.advance(500);
    expect(sectors()).toBeGreaterThan(0);
    expect(state(run).lastSectorClean).toBe(false);
    expect(state(run).lastDebrief?.hint).toMatch(/выехали за полотно/);
  });

  it("в зачётном заезде разбора нет", () => {
    // Строка под дорогой в зачётном блоке — это лишний стимул: участник читает её
    // вместо того, чтобы вести машину.
    const run = start(1, { curveRate: 0, gradeMax: 0, roadHalfWidth: 3 }, 4);
    hold(run, "throttle");
    run.clock.advance(4000);
    hold(run, "right");
    run.clock.advance(1500);
    hold(run, "right", false);
    for (let i = 0; i < 200 && state(run).sectors === 0; i++) run.clock.advance(500);
    expect(state(run).sectors).toBeGreaterThan(0);
    expect(state(run).sectorsClean).toBe(0);
    expect(state(run).lastDebrief).toBeNull();
    expect(state(run).lastSectorClean).toBeNull();
  });
});

describe("заезд: блок и трасса", () => {
  it("блок кончается по времени, а не по числу секторов", () => {
    const run = start(1, { blockMs: 20_000 });
    hold(run, "throttle");
    run.clock.advance(19_000);
    expect(run.instance.phase).toBe("main");
    expect(state(run).sectors).toBeGreaterThan(0);
    run.clock.advance(2000);
    expect(run.instance.phase).toBe("completed");
    const end = domain(run.records(), "block.end")[0];
    expect((end?.payload as { playedMs: number }).playedMs).toBeGreaterThanOrEqual(20_000);
  });

  it("пауза не съедает наигранное время блока", () => {
    const run = start(1, { blockMs: 30_000 });
    hold(run, "throttle");
    run.clock.advance(10_000);
    run.instance.pause();
    run.clock.advance(60_000);
    expect(run.instance.phase).toBe("paused");
    run.instance.resume();
    run.clock.advance(5000);
    expect(run.instance.phase).toBe("main");
    expect(state(run).playedMs).toBeLessThan(20_000);
  });

  it("после паузы заезд продолжается с того же места, а не с нуля", () => {
    const run = start(4);
    hold(run, "throttle");
    run.clock.advance(12_000);
    const was = state(run).distance;
    expect(was).toBeGreaterThan(20);
    run.instance.pause();
    // Пауза отпускает физический мир: он собирается обратно из слепка.
    expect(state(run).body).not.toBeNull();
    run.instance.resume();
    run.clock.advance(4000);
    expect(state(run).distance).toBeGreaterThan(was);
  });

  it("смена формы дороги приходит впереди машины, а не под ней", () => {
    const run = start(1);
    hold(run, "throttle");
    run.clock.advance(30_000);
    const stamps = state(run).stamps;
    const segment = Math.floor(state(run).distance / 10);
    for (const stamp of stamps.slice(1)) {
      // Отметка, попавшая назад, означала бы переписанную под колёсами трассу.
      expect(stamp.fromSegment).toBeGreaterThan(segment);
    }
  });

  it("трасса — чистая функция от seed и номера сегмента", () => {
    const shape = { curveRate: 0.02, gradeMax: 0.08 };
    expect(trackAt(11, 500, shape)).toEqual(trackAt(11, 500, shape));
    expect(trackAt(11, 500, shape)).not.toEqual(trackAt(12, 500, shape));
    for (let i = 0; i < 400; i++) {
      const segment = trackAt(3, i, shape);
      expect(Math.abs(segment.curvature)).toBeLessThanOrEqual(shape.curveRate);
      expect(Math.abs(segment.grade)).toBeLessThanOrEqual(shape.gradeMax);
    }
  });

  it("трасса гладкая на мелком шаге: кривизна меняется плавно, а не ступенькой", () => {
    // Из-за этого повороты и были ломаными: геометрия шла шагом в десять метров.
    const shape = { curveRate: 0.02, gradeMax: 0.08 };
    let worst = 0;
    for (let i = 0; i < 500; i++) {
      const a = trackAt(9, i / 5, shape).curvature;
      const b = trackAt(9, (i + 1) / 5, shape).curvature;
      worst = Math.max(worst, Math.abs(b - a));
    }
    expect(worst).toBeLessThan(shape.curveRate / 8);
  });

  it("хеш обстановки — чистая функция номера сегмента и лежит в [0,1)", () => {
    for (let index = -20; index < 400; index++) {
      for (const salt of [11, 12, 21]) {
        const value = hash01(5, index, salt);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
        expect(hash01(5, index, salt)).toBe(value);
      }
    }
    expect(hash01(5, 100, 11)).not.toBe(hash01(5, 100, 12));
    expect(hash01(5, 100, 11)).not.toBe(hash01(6, 100, 11));
  });

  it("обочина живая: кювет то есть, то нет, а выехать из него можно", () => {
    const line = new Centerline(7);
    line.applyStamps([{ fromSegment: 0, curveRate: 0.004, gradeMax: 0.02, halfWidth: 8 }]);
    let deepest = 0;
    let shallowest = -Infinity;
    let grassLow = 0;
    let grassHigh = -Infinity;
    let steepest = 0;
    let jumpiest = 0;
    let previous: number | null = null;
    for (let i = 0; i < 600; i++) {
      const point = line.at(i);
      const cuts = crossSection(point.halfWidth, point.verge);
      // Раскладка обязана быть по порядку слева направо: по этому же массиву
      // строится треугольная сетка коллайдера, и перехлёст в ней — дыра в земле.
      for (let c = 1; c < cuts.length; c++) expect(cuts[c]!.lateral).toBeGreaterThan(cuts[c - 1]!.lateral);
      const gravel = cuts[3]!;
      const ditch = cuts[2]!;
      const grass = cuts[1]!;
      const depth = gravel.dy - ditch.dy;
      deepest = Math.max(deepest, depth);
      shallowest = Math.max(shallowest, -depth);
      grassLow = Math.min(grassLow, grass.dy);
      grassHigh = Math.max(grassHigh, grass.dy);
      steepest = Math.max(steepest, depth / (gravel.lateral - ditch.lateral === 0 ? 1 : ditch.lateral - gravel.lateral));
      // Вдоль трассы профиль обязан быть непрерывным: ступенька в земле — это
      // трамплин под колесом там, где на картинке ровное место.
      if (previous !== null) jumpiest = Math.max(jumpiest, Math.abs(ditch.dy - previous));
      previous = ditch.dy;
      // Обочина всегда ниже асфальта, а гребень вала — всегда выше травы.
      expect(gravel.dy).toBeLessThan(0);
      expect(cuts[0]!.dy).toBeGreaterThan(grass.dy);
    }
    // Кювет местами глубокий, а местами его почти нет: одинаковый по всей трассе
    // читается каналом, а не дорогой.
    expect(deepest).toBeGreaterThan(0.4);
    expect(shallowest).toBeGreaterThan(-0.25);
    // Трава идёт волной, а не ровным газоном.
    expect(grassHigh - grassLow).toBeGreaterThan(0.3);
    // Из кювета надо выезжать: уклон положе одного к четырём.
    expect(steepest).toBeLessThan(0.25);
    // Шаг геометрии — два метра, и на нём земля меняется на сантиметры: десять
    // сантиметров на два метра — это тряско, но это яма, а не ступенька.
    expect(jumpiest).toBeLessThan(0.12);
  });

  it("камера ведёт машину без излома на кромке асфальта", () => {
    const half = 8;
    // Излом на кромке читался рывком: скорость, с которой машина едет по кадру,
    // менялась вдвое за один кадр, и на проезде поперёк полосы их было два.
    const step = 0.02;
    let worst = 0;
    let previous = 0;
    for (let lateral = -3 * half; lateral <= 3 * half; lateral += step) {
      const slope = (cameraFollow(lateral + step, half) - cameraFollow(lateral, half)) / step;
      if (lateral > -3 * half) worst = Math.max(worst, Math.abs(slope - previous));
      previous = slope;
    }
    // Наклон меняется от половины в середине полосы до единицы вдали, и весь этот
    // рост размазан по ширине полосы, а не собран в одну точку.
    expect(worst).toBeLessThan(0.01);
    expect(cameraFollow(0, half)).toBe(0);
    // Середина полосы: камера идёт за машиной вполовину.
    expect(cameraFollow(0.1, half) / 0.1).toBeCloseTo(0.5, 2);
    // Далеко за полосой: один к одному, машина держится в середине кадра.
    expect(cameraFollow(40, half) - cameraFollow(39, half)).toBeCloseTo(1, 3);
    // Знак сохраняется: камера не уезжает в другую сторону от машины.
    expect(cameraFollow(-5, half)).toBe(-cameraFollow(5, half));
  });

  it("состояние ядра не тащит физический мир: он висит скрытым полем", () => {
    const run = start(4);
    hold(run, "throttle");
    run.clock.advance(3000);
    const raw = state(run) as unknown as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      expect(typeof raw[key]).not.toBe("function");
    }
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
  });
});
