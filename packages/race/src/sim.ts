import type * as RAPIER from "@dimforge/rapier3d-compat";
import { PHYSICS_STEP_S, createWorld, rapier, type SurfaceMix } from "@gamespace/env";
import { createCar, type Car, type CarControls, type CarFrame, type CarSave } from "@gamespace/car";
import {
  Centerline,
  FINE_M,
  FINE_PER_SEGMENT,
  crossSection,
  lateralOf,
  surfaceAt,
  type FinePoint,
  type ShapeStamp,
} from "./track.js";

/**
 * Мир заезда: дорога, по которой едет машина, и место машины на этой дороге.
 *
 * Сама машина здесь больше не считается — она приехала из `@gamespace/car`
 * целиком, вместе с кузовом, подвеской, коробкой и шинами. Осталось то, что к
 * машине не относится и никогда не относилось: полотно под колёсами, путь по
 * осевой линии, поперечное смещение от неё, возврат на полосу и накопитель
 * времени физики.
 *
 * Разрез удобно проверять по вопросу «изменится ли это, если поставить машину в
 * другой мир». Коллизионная сетка, кольцо сегментов вокруг машины, проекция
 * кузова на ломаную — изменится всё; кузов, руль и шина — ничего. Из четырёх
 * сотен строк, что тут лежали раньше, машине принадлежало три четверти, и это
 * было единственной причиной, по которой физику нельзя было использовать без
 * заезда.
 *
 * Мир живёт вне состояния ядра: состояние остаётся сериализуемым и сравнимым, а
 * симуляция висит на нём скрытым полем и пересобирается из сохранённых координат.
 */

/** Больше четырёх шагов за тик не догоняем: после свёрнутой вкладки не телепортируемся. */
const MAX_STEPS_PER_TICK = 4;
/** Сегментов коллизионной сетки позади машины и впереди. */
const COLLIDERS_BEHIND = 3;
const COLLIDERS_AHEAD = 18;
/** С какой скоростью машину отпускают после возврата на полосу, м/с. */
const RESPAWN_SPEED_MAX = 12;

export { PHYSICS_STEP_S };

/** Управление доходит до машины как есть: заезд ничего в нём не переиначивает. */
export type SimControls = CarControls;

export interface SimFrame extends CarFrame {
  /**
   * Прожитое физикой время, секунды: ровно число сделанных шагов на длину шага.
   * Ко времени ядра оно не привязано и привязано быть не может — шаг физики
   * шестнадцать и две трети миллисекунды, тик ядра шестнадцать, поэтому на части
   * тиков физика не двигается вовсе, а на части делает два шага. Картинке этот
   * счётчик нужен, чтобы смешивать положения по времени физики: смешивание по
   * времени ядра как раз и даёт видимое подрагивание пару раз в секунду.
   */
  t: number;
  /** Путь по осевой линии, метры. */
  s: number;
  lateral: number;
  /** Высота дороги под машиной: по ней видно, что машина улетела за коридор. */
  groundY: number;
}

export interface SimSave extends CarSave {
  s: number;
}

export interface Sim {
  step(dtS: number, controls: SimControls): void;
  frame(): SimFrame;
  save(): SimSave;
  /** Поставить машину обратно на дорогу: перевернулась или улетела. */
  respawn(): void;
  setStamps(stamps: readonly ShapeStamp[]): void;
  dispose(): void;
}

export function createSim(seed: number, stamps: readonly ShapeStamp[], save?: SimSave): Sim {
  const R = rapier();

  const line = new Centerline(seed);
  line.applyStamps(stamps);

  const world = createWorld();

  let stampCount = stamps.length;
  let accumulator = 0;
  /** Прожитое физикой время: счётчик шагов, а не часы. Не сохраняется — картинке
   * важны только разности внутри одной жизни мира, а после снимка мир новый. */
  let lived = 0;
  let s = save?.s ?? 0;
  let fine = Math.floor(s / FINE_M);
  /**
   * Точка осевой линии под машиной. Держится отдельным полем, потому что её
   * спрашивают четыре пятна контакта за шаг, а меняется она раз в шаг: покрытие
   * под колесом считается от поперечного смещения относительно этой точки.
   */
  let here: FinePoint = line.atDistance(s);

  const start = line.atDistance(s);
  const car = createCar(world, { surfaceAt: (x, z): SurfaceMix => surfaceAt(here, lateralOf(here, x, z)) }, start, save);

  /** Коллизионная сетка: по одному телу на сегмент, кольцом вокруг машины. */
  const ground = new Map<number, RAPIER.Collider>();

  /**
   * Полотно сегмента: та же осевая линия и тот же профиль, что и в сцене, поэтому
   * колёса едут ровно по видимому асфальту. Пять мелких шагов на сегмент — дорога
   * для физики такая же гладкая, как для глаза.
   */
  function buildSegment(segment: number): RAPIER.Collider {
    const vertices: number[] = [];
    const indices: number[] = [];
    const from = segment * FINE_PER_SEGMENT;
    const first = line.at(from);
    const profileWidth = crossSection(first.halfWidth, first.verge).length;
    for (let k = 0; k <= FINE_PER_SEGMENT; k++) {
      const point = line.at(from + k);
      const nx = Math.cos(point.h);
      const nz = -Math.sin(point.h);
      for (const cut of crossSection(point.halfWidth, point.verge)) {
        vertices.push(point.x + nx * cut.lateral, point.y + cut.dy, point.z + nz * cut.lateral);
      }
    }
    for (let k = 0; k < FINE_PER_SEGMENT; k++) {
      for (let c = 0; c < profileWidth - 1; c++) {
        const a = k * profileWidth + c;
        const b = a + 1;
        const d = a + profileWidth;
        const e = d + 1;
        indices.push(a, d, b, b, d, e);
      }
    }
    return world.createCollider(
      R.ColliderDesc.trimesh(new Float32Array(vertices), new Uint32Array(indices)).setFriction(1),
    );
  }

  function syncGround(): void {
    const centre = Math.floor(s / (FINE_M * FINE_PER_SEGMENT));
    for (let segment = centre - COLLIDERS_BEHIND; segment <= centre + COLLIDERS_AHEAD; segment++) {
      if (!ground.has(segment)) ground.set(segment, buildSegment(segment));
    }
    for (const [segment, collider] of ground) {
      if (segment < centre - COLLIDERS_BEHIND || segment > centre + COLLIDERS_AHEAD) {
        world.removeCollider(collider, false);
        ground.delete(segment);
      }
    }
    line.trim(Math.max(0, (centre - COLLIDERS_BEHIND) * FINE_PER_SEGMENT - 60));
  }

  /** Путь и смещение от осевой: проекция кузова на ломаную возле прошлого места. */
  function locate(p: { x: number; z: number }): void {
    let best = fine;
    let bestDistance = Infinity;
    let bestT = 0;
    for (let candidate = fine - 4; candidate <= fine + 30; candidate++) {
      const a = line.at(candidate);
      const b = line.at(candidate + 1);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length2 = dx * dx + dz * dz;
      if (length2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2));
      const cx = a.x + dx * t;
      const cz = a.z + dz * t;
      const distance = (p.x - cx) * (p.x - cx) + (p.z - cz) * (p.z - cz);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
        bestT = t;
      }
    }
    fine = best;
    s = (best + bestT) * FINE_M;
    here = line.atDistance(s);
  }

  syncGround();

  return {
    step(dtS, controls) {
      accumulator += dtS;
      let steps = 0;
      while (accumulator >= PHYSICS_STEP_S && steps < MAX_STEPS_PER_TICK) {
        car.step(controls);
        world.step();
        accumulator -= PHYSICS_STEP_S;
        steps++;
      }
      if (steps === MAX_STEPS_PER_TICK) accumulator = 0;
      lived += steps * PHYSICS_STEP_S;
      locate(car.frame());
      syncGround();
    },

    frame() {
      const body = car.frame();
      return { ...body, t: lived, s, lateral: lateralOf(here, body.x, body.z), groundY: here.y };
    },

    save() {
      return { ...car.save(), s };
    },

    /**
     * Возврат на полосу. Скорость не обнуляется, а срезается: полная остановка в
     * одном кадре читается как телепорт, а заезд — сорок минут физиологии, и рвать
     * его нельзя. Половина от бывшей скорости, но не больше `RESPAWN_SPEED_MAX`, и
     * строго вдоль дороги: вернули на полосу, а не выпустили в занос.
     */
    respawn() {
      const was = Math.abs(car.frame().speedMs);
      car.place(line.atDistance(s), Math.min(was * 0.5, RESPAWN_SPEED_MAX));
    },

    setStamps(next) {
      if (next.length === stampCount) return;
      stampCount = next.length;
      line.applyStamps(next);
      // Форма меняется только далеко впереди, но уже построенные сегменты сетки
      // всё равно снимаются: дешевле пересобрать двадцать полотен, чем оставить
      // расхождение между тем, что видно, и тем, по чему едут колёса.
      for (const [segment, collider] of ground) {
        world.removeCollider(collider, false);
        ground.delete(segment);
      }
      syncGround();
    },

    dispose() {
      world.free();
    },
  };
}
