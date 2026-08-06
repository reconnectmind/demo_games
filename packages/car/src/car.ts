import type * as RAPIER from "@dimforge/rapier3d-compat";
import {
  PHYSICS_STEP_S,
  SURFACES,
  rapier,
  surfaceKindOf,
  surfaceOf,
  type Surface,
  type SurfaceKind,
  type SurfaceMix,
} from "@gamespace/env";
import {
  CHASSIS_HALF,
  COM_DROP_M,
  MASS_KG,
  RIDE_HEIGHT_M,
  SUSPENSION_REST_M,
  WHEEL_FRONT_Z,
  WHEEL_MOUNTS,
  WHEEL_RADIUS_M,
} from "./geometry.js";
import { steerNeutral, steerStep } from "./steering.js";
import { TIRE_COLD_C, WHEEL_INERTIA, loadFactor, tempFactor, tireStep } from "./tire.js";

/**
 * Машина: кузов, подвеска, четыре пятна контакта.
 *
 * Здесь нет ни игры, ни трассы, ни зачёта — только автомобиль. О мире машина
 * знает ровно две вещи: в каком физическом мире ей строить тела и что за
 * покрытие под колесом (`CarGround`). Больше ей не нужно, и это не аскеза, а
 * проверяемое утверждение: всё остальное, что раньше приходило из дороги — путь
 * по осевой линии, поперечное смещение, коллизионная сетка, возврат на полосу, —
 * машине для езды не требовалось никогда, оно требовалось заезду.
 *
 * Разрез стоит именно тут по простому признаку: то, что осталось, не изменится,
 * если поставить эту машину в другой мир. Поменяется мир — поменяются ответы
 * `CarGround`, а кузов, коробка, руль и шина останутся теми же.
 */

/**
 * Земля под колесом с точки зрения машины.
 *
 * Единственный вопрос, который машина задаёт миру, и задаёт она его по мировой
 * точке пятна контакта, а не по «месту на трассе»: пятна четыре, они в разных
 * местах, и именно из-за этого съезд одной стороной разворачивает машину. Мир
 * отвечает смесью двух покрытий — на границе асфальта и гравия честного ответа
 * «одно покрытие» не бывает, а скачок сцепления в сантиметре давал бы дребезг.
 */
export interface CarGround {
  surfaceAt(x: number, z: number): SurfaceMix;
}

/** Куда и как поставлена машина: точка и курс. */
export interface CarPose {
  x: number;
  y: number;
  z: number;
  /** Курс в радианах: тот же отсчёт, что у осевой линии дороги. */
  h: number;
}

/**
 * Сопротивление воздуха. От массы не зависит, но зависит от кузова: у внедорожника
 * лоб втрое больше купе, и это единственное, что держит верхнюю скорость на
 * асфальте. Сопротивление качению здесь больше не живёт — оно ушло в шину, где ему
 * и место: оно разное под каждым колесом и зависит от того, по чему это колесо
 * катится. Оттуда же приходит и вспашка грунта (`plow` покрытия): на грунте лоб
 * машины ловит не только воздух, но и траву с землёй, летящие в кузов и в арки.
 */
const DRAG_K = 0.62;
/**
 * Момент тормоза по колёсам, Н·м, спереди назад. Заведомо больше того, что держит
 * асфальт: колодки здесь не слабое звено, сколько машина затормозит — решает
 * грунт вместе с ABS.
 *
 * Перед тормозит вдвое сильнее задней оси, и это не произвол: при замедлении
 * масса переносится вперёд, передние колёса прижимаются, задние разгружаются.
 * Тормози всеми поровну — задние сорвались бы в юз первыми, а машина под
 * тормозом разворачивалась бы задом наперёд.
 */
const BRAKE_NM = [3600, 3600, 2000, 2000];
/**
 * Антиблокировочная система: доля предела сцепления, выше которой момент тормоза
 * не поднимается.
 *
 * Без неё каждое нажатие тормоза кончалось бы юзом, и это не выдумка ради
 * удобства: заблокированное колесо не только хуже тормозит, но и полностью
 * теряет боковую силу, поэтому машина с педалью в полу переставала бы
 * поворачиваться. У настоящего Cayenne ABS есть, и работает она ровно так —
 * держит проскальзывание у пика кривой, не давая ему уйти за него.
 */
const ABS_HOLD = 0.92;
/**
 * Что тормозит колесо само по себе, без дороги: сухое трение в ступичном
 * подшипнике и сальнике, Н·м, и вязкая часть от скорости вращения, Н·м·с.
 *
 * Числа маленькие — свободное колесо и правда крутится долго, — но не нулевые:
 * с нулём оно крутится вечно.
 */
const HUB_DRAG_NM = 4;
const HUB_VISCOUS_NMS = 0.35;
/**
 * Как момент делится по колёсам, спереди назад.
 *
 * Полный привод у Cayenne есть, но он с задним уклоном, и уклон этот — не
 * характер, а условие того, что машина умеет ехать боком. Ровные четверти
 * означают, что сорвать колёса на асфальте нельзя вовсе: на каждое приходится
 * вчетверо меньше момента, чем держит пятно, и вся тяга уходит в разгон при
 * любом газе. Такая машина не буксует, не заносится и не выходит из заноса —
 * она просто едет, и педаль газа у неё одна на все случаи.
 *
 * С задним уклоном на каждое заднее колесо приходится втрое больше, чем на
 * переднее, и на первой передаче этого уже хватает, чтобы перешагнуть предел
 * сцепления. Дальше всё делает сама шина: сорванное заднее колесо теряет и
 * боковую силу тоже, зад выходит наружу поворота — это и есть занос.
 */
const DRIVE_SHARE = [0.15, 0.15, 0.35, 0.35];

export interface CarControls {
  /** Сила на колёсах от двигателя, ньютоны. */
  forceN: number;
  /**
   * Инерция трансмиссии, приведённая к одному колесу, кг·м². Зависит от
   * передачи, поэтому приходит снаружи: коробка — не дело физики контакта.
   */
  driveInertia: number;
  /** Тормоз колодками, доля от полного. */
  brake: number;
  /** Цель поворота руля: −1 влево, +1 вправо. */
  steer: number;
}

export interface WheelFrame {
  /** Ход подвески, метры: сцена по нему ставит колесо под кузовом. */
  suspension: number;
  steer: number;
  /** Накрученный угол вращения колеса, радианы. */
  spin: number;
  contact: boolean;
  /** Нормальная нагрузка, Н: по ней видно перенос веса в поворотах и под тормозом. */
  loadN: number;
  /** Насколько шина за пределом сцепления: 0 — держит, 1 — на пике, больше — срыв. */
  slide: number;
  /** Температура шины, °C. */
  tempC: number;
  /** Покрытие под этим колесом. */
  surface: SurfaceKind;
  /**
   * Насколько чёрный след остаётся под этим колесом: 0 — никакого, 1 — смоль.
   * Считает его шина (`markAt`), а укладывает на дорогу сцена (`marks.ts`).
   */
  mark: number;
  /**
   * Пятно контакта в мире и поперечная ось колеса в нём: по ним сцена и кладёт
   * ленту следа. Без оси лента не имеет ширины, а без точки её негде положить —
   * положение кузова для этого не годится, колесо ходит по подвеске и по рулю.
   */
  atX: number;
  atY: number;
  atZ: number;
  sideX: number;
  sideZ: number;
}

export interface CarFrame {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Скорость вдоль курса машины, м/с. */
  speedMs: number;
  /**
   * Скорость, с которой едет обод ведущих колёс, м/с.
   *
   * От скорости машины она отличается ровно на проскальзывание, и коробке нужна
   * именно она: обороты держит колесо, а не дорога. Пока шина цепляется, разницы
   * нет; как только колёса сорвались, обороты уходят вверх, а машина остаётся на
   * месте — и в КПД это честно видно как газ, не ставший движением.
   */
  driveSpeedMs: number;
  /** Косинус угла между «верхом» машины и небом: ниже нуля — машина на крыше. */
  upright: number;
  wheels: WheelFrame[];
}

export interface CarSave {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  steer: number;
  /**
   * Колёса крутятся сами, а не следуют за кузовом, поэтому их вращение и нагрев —
   * часть состояния машины. Без них снимок терял бы буксование, а сброшенное
   * колесо на паузе вставало бы как вкопанное.
   */
  omega: number[];
  tempC: number[];
}

export interface Car {
  /** Один шаг физики машины. Мир шагает тот, кто миром владеет. */
  step(controls: CarControls): void;
  frame(): CarFrame;
  save(): CarSave;
  /**
   * Поставить машину в это место с этой скоростью вдоль курса. Куда и с какой —
   * решает мир: машина не знает, где у него полоса.
   */
  place(at: CarPose, speedMs: number): void;
  dispose(): void;
}

function yawQuat(h: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) };
}

export function createCar(world: RAPIER.World, ground: CarGround, at: CarPose, save?: CarSave): Car {
  const R = rapier();

  /**
   * Моменты инерции считаются как у однородного кузова-коробки. Центр масс при
   * этом опущен отдельным полем, а не сдвигом коллайдера: коллайдер обязан
   * совпадать с видимым кузовом, иначе машина цепляется за рельеф там, где на
   * картинке ничего нет, — а низкий центр масс это единственная дешёвая защита от
   * кувырка в вираже.
   */
  const inertia = {
    x: (MASS_KG / 3) * (CHASSIS_HALF.y ** 2 + CHASSIS_HALF.z ** 2),
    y: (MASS_KG / 3) * (CHASSIS_HALF.x ** 2 + CHASSIS_HALF.z ** 2),
    z: (MASS_KG / 3) * (CHASSIS_HALF.x ** 2 + CHASSIS_HALF.y ** 2),
  };
  const chassis = world.createRigidBody(
    R.RigidBodyDesc.dynamic()
      .setTranslation(at.x, at.y + RIDE_HEIGHT_M, at.z)
      .setRotation(yawQuat(at.h))
      .setAdditionalMassProperties(MASS_KG, { x: 0, y: -COM_DROP_M, z: 0 }, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setAngularDamping(0.6)
      .setCanSleep(false),
  );
  // Плотность нулевая: всю массу задаёт тело, коллайдер отвечает только за форму.
  world.createCollider(
    R.ColliderDesc.cuboid(CHASSIS_HALF.x, CHASSIS_HALF.y, CHASSIS_HALF.z)
      .setDensity(0)
      .setFriction(0.4)
      .setRestitution(0.05),
    chassis,
  );

  const vehicle = world.createVehicleController(chassis);
  vehicle.indexUpAxis = 1;
  vehicle.setIndexForwardAxis = 2;
  for (const [x, y, z] of WHEEL_MOUNTS) {
    vehicle.addWheel({ x, y, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSPENSION_REST_M, WHEEL_RADIUS_M);
  }
  for (let i = 0; i < 4; i++) {
    vehicle.setWheelSuspensionStiffness(i, 34);
    vehicle.setWheelSuspensionCompression(i, 1.1);
    vehicle.setWheelSuspensionRelaxation(i, 1.7);
    vehicle.setWheelMaxSuspensionTravel(i, 0.24);
    vehicle.setWheelMaxSuspensionForce(i, 30_000);
    /**
     * Собственное трение контроллера выключено начисто, и это главное изменение
     * во всей физике машины. Контроллер Rapier умеет только «сцепление есть до
     * такой-то силы, дальше нет», без проскальзывания, без нагрузки и без
     * температуры — с таким колесом нельзя ни забуксовать, ни поймать занос.
     * Теперь от контроллера остаётся то, что он делает хорошо: луч под колесо и
     * пружина подвески. Силу в пятне контакта считает `tire.ts`, а прикладывает
     * `applyTires` — прямо в точку касания, отчего сам собой получается и
     * перенос веса, и крен.
     */
    vehicle.setWheelFrictionSlip(i, 0);
    vehicle.setWheelSideFrictionStiffness(i, 0);
  }

  let steer = save?.steer ?? 0;
  const spin = [0, 0, 0, 0];
  const omega = [0, 0, 0, 0].map((_, i) => save?.omega?.[i] ?? 0);
  const tempC = [0, 0, 0, 0].map((_, i) => save?.tempC?.[i] ?? TIRE_COLD_C);
  const loadN = [0, 0, 0, 0];
  const slide = [0, 0, 0, 0];
  const mark = [0, 0, 0, 0];
  /** Пятно контакта и поперечная ось колеса в нём: x, y, z, sideX, sideZ. */
  const patch = [0, 1, 2, 3].map(() => [0, 0, 0, 0, 0]);
  const under: SurfaceKind[] = ["asphalt", "asphalt", "asphalt", "asphalt"];
  /** Средняя вспашка под колёсами: по ней тормозится кузов на скорости. */
  let plow = 0;

  if (save) {
    chassis.setTranslation({ x: save.x, y: save.y, z: save.z }, true);
    chassis.setRotation({ x: save.qx, y: save.qy, z: save.qz, w: save.qw }, true);
    chassis.setLinvel({ x: save.vx, y: save.vy, z: save.vz }, true);
    chassis.setAngvel({ x: save.ax, y: save.ay, z: save.az }, true);
  }

  /** Поворот вектора кватернионом: нужен, чтобы знать, куда смотрит колесо. */
  function spun(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number) {
    const tx = 2 * (q.y * z - q.z * y);
    const ty = 2 * (q.z * x - q.x * z);
    const tz = 2 * (q.x * y - q.y * x);
    return {
      x: x + q.w * tx + (q.y * tz - q.z * ty),
      y: y + q.w * ty + (q.z * tx - q.x * tz),
      z: z + q.w * tz + (q.x * ty - q.y * tx),
    };
  }

  function applyControls(controls: CarControls): void {
    // Скорость рулю отдаётся со знаком: стабилизация держится на следе пятна
    // контакта, а он на заднем ходу работает наоборот (см. `steering.ts`).
    const speed = vehicle.currentVehicleSpeed();
    // Клавиша — не угол, а усилие на ободе: угол считает сам руль (`steering.ts`).
    // Отсчитывается он от того, куда едет передняя ось, а не от кузова: в заносе
    // это и есть разница между «можно поймать» и «нельзя».
    const q = chassis.rotation();
    const v = chassis.linvel();
    const w = chassis.angvel();
    const ahead = spun(q, 0, 0, 1);
    const side = spun(q, 1, 0, 0);
    const armX = ahead.x * WHEEL_FRONT_Z;
    const armY = ahead.y * WHEEL_FRONT_Z;
    const armZ = ahead.z * WHEEL_FRONT_Z;
    const fx = v.x + (w.y * armZ - w.z * armY);
    const fy = v.y + (w.z * armX - w.x * armZ);
    const fz = v.z + (w.x * armY - w.y * armX);
    const neutral = steerNeutral(
      fx * side.x + fy * side.y + fz * side.z,
      fx * ahead.x + fy * ahead.y + fz * ahead.z,
    );
    steer = steerStep(steer, controls.steer, speed, PHYSICS_STEP_S, neutral);
    vehicle.setWheelSteering(0, steer);
    vehicle.setWheelSteering(1, steer);
    for (let i = 0; i < 4; i++) {
      vehicle.setWheelEngineForce(i, 0);
      vehicle.setWheelBrake(i, 0);
    }

    // Сила в Rapier постоянная и живёт до сброса, поэтому её сбрасывают каждый
    // шаг: иначе она копится, и машина вместо разгона дрожит на месте. Момент
    // сбрасывается отдельно и обязательно: сила в точке касания — это ещё и
    // момент относительно центра масс, и накопленный он переворачивает машину
    // на второй секунде.
    chassis.resetForces(false);
    chassis.resetTorques(false);
    const speed3 = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (speed3 > 0.05) {
      // Лобовое сопротивление и вспашка грунта кузовом. Всё, что происходит в
      // пятне контакта, считает шина: сюда попадает только то, что действует на
      // машину целиком.
      const resist = (DRAG_K + plow) * speed3 * speed3;
      chassis.addForce({ x: (-v.x / speed3) * resist, y: 0, z: (-v.z / speed3) * resist }, true);
    }
  }

  /**
   * Шины: четыре пятна контакта, каждое со своим покрытием, своей нагрузкой и
   * своей температурой.
   *
   * Порядок внутри шага заезжен и важен. Сначала контроллер стреляет лучами и
   * считает подвеску — только после этого известно, с какой силой колесо прижато
   * к земле, а без нагрузки шина не считается вовсе. Потом по нагрузке и
   * проскальзыванию считается сила в пятне, и прикладывается она именно в точку
   * касания, а не к центру масс: отсюда и перенос веса под тормозом, и разгрузка
   * внутреннего колеса в повороте — их не нужно подделывать отдельно.
   */
  function applyTires(controls: CarControls): void {
    const q = chassis.rotation();
    const com = chassis.worldCom();
    const v = chassis.linvel();
    const w = chassis.angvel();
    const inertia = WHEEL_INERTIA + controls.driveInertia;
    let plowSum = 0;

    for (let i = 0; i < 4; i++) {
      const drive = controls.forceN * DRIVE_SHARE[i]! * WHEEL_RADIUS_M;
      const angle = i < 2 ? steer : 0;
      const contact = vehicle.wheelIsInContact(i) ?? false;
      const at = vehicle.wheelContactPoint(i);
      const where = contact && at ? at : null;
      const mix = where ? ground.surfaceAt(where.x, where.z) : null;
      const surface: Surface = mix ? surfaceOf(mix) : SURFACES.asphalt;
      under[i] = mix ? surfaceKindOf(mix) : "asphalt";
      plowSum += surface.plow;

      if (!where) {
        /**
         * Колесо в воздухе. Земли нет — нет ни силы, ни отдачи, и при касании
         * оно проскользнёт: так это и выглядит на трамплине.
         *
         * Момента ему теперь не достаётся вовсе, и это не упрощение, а
         * дифференциал. Полуось не умеет толкать одно колесо, не опираясь на
         * другое: момент на висящем колесе ограничен тем, что держит его сосед
         * по оси, а сосед в этот миг держит землю и никуда не проворачивается.
         * Пока каждому колесу отдавалась его доля момента независимо от того,
         * есть ли под ним земля, висящее колесо разгонялось без предела —
         * упиралось только в вязкость, то есть в сотни радиан в секунду. Отсюда
         * росли сразу две небылицы: переднее колесо, крутящееся у стоящей на
         * траве машины, и тахометр, показывающий пятнадцать тысяч, потому что
         * обороты мотор берёт с обода ведущих.
         *
         * Остаётся то, что тормозит колесо без всякой дороги: колодки, которые
         * держат диск независимо от касания, и сухое с вязким трение в ступице.
         */
        loadN[i] = 0;
        slide[i] = 0;
        mark[i] = 0;
        const free = omega[i]!;
        const dir = Math.sign(free);
        const dry = HUB_DRAG_NM + controls.brake * BRAKE_NM[i]!;
        const next = free - ((dir * dry + free * HUB_VISCOUS_NMS) / inertia) * PHYSICS_STEP_S;
        // Сухое трение останавливает, а не раскручивает назад: через ноль оно
        // колесо не переносит.
        omega[i] = dir === 0 || Math.sign(next) !== dir ? 0 : next;
        spin[i] = spin[i]! + omega[i]! * PHYSICS_STEP_S;
        continue;
      }

      const load = Math.max(0, vehicle.wheelSuspensionForce(i) ?? 0);
      loadN[i] = load;

      // Оси колеса в мире: продольная повёрнута рулём, поперечная — к ней под
      // прямым углом, обе положены на плоскость земли по нормали контакта.
      const forward = spun(q, Math.sin(angle), 0, Math.cos(angle));
      const normal = vehicle.wheelContactNormal(i) ?? { x: 0, y: 1, z: 0 };
      const drop = forward.x * normal.x + forward.y * normal.y + forward.z * normal.z;
      let fx = forward.x - normal.x * drop;
      let fy = forward.y - normal.y * drop;
      let fz = forward.z - normal.z * drop;
      const flen = Math.hypot(fx, fy, fz) || 1;
      fx /= flen;
      fy /= flen;
      fz /= flen;
      const rx = normal.y * fz - normal.z * fy;
      const ry = normal.z * fx - normal.x * fz;
      const rz = normal.x * fy - normal.y * fx;

      // Скорость земли под колесом — скорость точки касания твёрдого тела.
      const dx = where.x - com.x;
      const dy = where.y - com.y;
      const dz = where.z - com.z;
      const vx = v.x + (w.y * dz - w.z * dy);
      const vy = v.y + (w.z * dx - w.x * dz);
      const vz = v.z + (w.x * dy - w.y * dx);
      const along = vx * fx + vy * fy + vz * fz;
      const across = vx * rx + vy * ry + vz * rz;

      // ABS: момент тормоза не поднимается выше того, что держит земля. Иначе
      // колесо встаёт юзом, теряет боковую силу вместе с продольной, и машина
      // под тормозом перестаёт слушаться руля.
      let brakeNm = 0;
      if (controls.brake > 0) {
        const hold = surface.grip * loadFactor(load) * tempFactor(tempC[i]!) * load * WHEEL_RADIUS_M;
        brakeNm = Math.min(controls.brake * BRAKE_NM[i]!, hold * ABS_HOLD);
      }

      const out = tireStep({
        omega: omega[i]!,
        tempC: tempC[i]!,
        loadN: load,
        alongMs: along,
        acrossMs: across,
        driveNm: drive,
        brakeNm,
        inertia,
        radiusM: WHEEL_RADIUS_M,
        surface,
        dtS: PHYSICS_STEP_S,
      });
      omega[i] = out.omega;
      tempC[i] = out.tempC;
      slide[i] = out.slide;
      spin[i] = spin[i]! + out.omega * PHYSICS_STEP_S;
      mark[i] = out.mark;
      // Ось следа — поперечная ось колеса, положенная на дорогу: лента должна
      // лежать поперёк колеса, а не поперёк кузова, иначе в заносе она вывернется.
      const flat = Math.hypot(rx, rz) || 1;
      patch[i] = [where.x, where.y, where.z, rx / flat, rz / flat];

      chassis.addForceAtPoint(
        {
          x: fx * out.alongN + rx * out.acrossN,
          y: fy * out.alongN + ry * out.acrossN,
          z: fz * out.alongN + rz * out.acrossN,
        },
        where,
        true,
      );
    }
    plow = plowSum / 4;
  }

  return {
    step(controls) {
      applyControls(controls);
      // Контроллер отрабатывает подвеску и заодно даёт нагрузку на колесо — без
      // неё шину считать не из чего, поэтому только потом шины.
      vehicle.updateVehicle(PHYSICS_STEP_S);
      applyTires(controls);
    },

    frame() {
      const p = chassis.translation();
      const q = chassis.rotation();
      const wheels: WheelFrame[] = [];
      let driven = 0;
      for (let i = 0; i < 4; i++) {
        wheels.push({
          suspension: vehicle.wheelSuspensionLength(i) ?? SUSPENSION_REST_M,
          steer: i < 2 ? steer : 0,
          spin: spin[i]!,
          contact: vehicle.wheelIsInContact(i) ?? false,
          loadN: loadN[i]!,
          slide: slide[i]!,
          tempC: tempC[i]!,
          surface: under[i]!,
          mark: mark[i]!,
          atX: patch[i]![0]!,
          atY: patch[i]![1]!,
          atZ: patch[i]![2]!,
          sideX: patch[i]![3]!,
          sideZ: patch[i]![4]!,
        });
        driven += omega[i]! * WHEEL_RADIUS_M * DRIVE_SHARE[i]!;
      }
      // «Верх» машины в мировых координатах: y-столбец матрицы поворота из кватерниона.
      const upright = 1 - 2 * (q.x * q.x + q.z * q.z);
      return {
        x: p.x,
        y: p.y,
        z: p.z,
        qx: q.x,
        qy: q.y,
        qz: q.z,
        qw: q.w,
        speedMs: vehicle.currentVehicleSpeed(),
        // Обороты трансмиссии — среднее по колёсам с весом их доли момента: у
        // дифференциала на входе именно оно. Сорвавшееся заднее колесо тянет это
        // среднее вверх сильнее переднего, потому что через него идёт больше.
        driveSpeedMs: driven,
        upright,
        wheels,
      };
    },

    save() {
      const p = chassis.translation();
      const q = chassis.rotation();
      const v = chassis.linvel();
      const a = chassis.angvel();
      return {
        x: p.x,
        y: p.y,
        z: p.z,
        qx: q.x,
        qy: q.y,
        qz: q.z,
        qw: q.w,
        vx: v.x,
        vy: v.y,
        vz: v.z,
        ax: a.x,
        ay: a.y,
        az: a.z,
        steer,
        omega: [...omega],
        tempC: [...tempC],
      };
    },

    place(to, speedMs) {
      chassis.setTranslation({ x: to.x, y: to.y + RIDE_HEIGHT_M + 0.3, z: to.z }, true);
      chassis.setRotation(yawQuat(to.h), true);
      chassis.setLinvel({ x: Math.sin(to.h) * speedMs, y: 0, z: Math.cos(to.h) * speedMs }, true);
      chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
      steer = 0;
      // Колёса возвращают в согласие с дорогой: иначе машину отпускают с уже
      // сорванными шинами, и она сходит с полосы в первую же секунду.
      for (let i = 0; i < 4; i++) omega[i] = speedMs / WHEEL_RADIUS_M;
    },

    dispose() {
      // Мир не наш: закрывать его машина не имеет права, а свои тела — обязана.
      world.removeVehicleController(vehicle);
      world.removeRigidBody(chassis);
    },
  };
}
