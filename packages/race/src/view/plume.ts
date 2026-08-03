/**
 * Шлейф из-под колёс: частицы, которыми рисуется пыль и дым.
 *
 * Сколько её поднимается и какого она цвета, решает `dust.ts`; здесь только
 * рисование — по системе частиц на колесо, с эмиттером в пятне контакта. Пятно
 * берётся у показанного кадра, а не у последнего шага физики: облако обязано
 * выходить из-под того колеса, которое видно.
 */

import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { SurfaceKind } from "../track.js";
import { PUFFS, RATE_MAX, dustRate, type Puff } from "./dust.js";

/** Сколько частиц на колесо держится в памяти: срок жизни на полный шаг, с запасом. */
const CAPACITY = 110;
/** Доля скорости машины, которую облачко уносит с собой, прежде чем зависнуть. */
const CARRY = 0.25;
/**
 * Оседание, м/с². Взвесь тяжелее воздуха, но лёгкая: падает она много медленнее
 * камня, и настоящие девять и восемь означали бы, что пыль уходит в землю за
 * первую же десятую секунды.
 */
const SETTLE = 0.9;

/** Мягкое пятно с прозрачностью: без него частица — квадрат. */
function puffTexture(scene: Scene): RawTexture {
  const side = 64;
  const data = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const dx = (x + 0.5) / side - 0.5;
      const dy = (y + 0.5) / side - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      // Спад к краю по косинусу: у диска с резкой кромкой видно кромку.
      const soft = r >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * r);
      const at = (y * side + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = Math.round(255 * soft * soft);
    }
  }
  const texture = RawTexture.CreateRGBATexture(data, side, side, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
  texture.name = "race-puff";
  return texture;
}

export interface WheelPlume {
  contact: boolean;
  slide: number;
  surface: SurfaceKind;
  atX: number;
  atY: number;
  atZ: number;
}

export interface Plume {
  /** Поднять пыль по показанному кадру: пятна контакта, скорость и курс машины. */
  raise(wheels: ReadonlyArray<WheelPlume>, speedMs: number, headingX: number, headingZ: number): void;
  /** Убрать всё: машину вернули на полосу, и облако над пустым местом не висит. */
  clear(): void;
  dispose(): void;
}

export function createPlume(scene: Scene, wheels = 4): Plume {
  const texture = puffTexture(scene);
  const systems = Array.from({ length: wheels }, (_, i) => {
    const system = new ParticleSystem(`race-dust-${i}`, CAPACITY, scene);
    system.particleTexture = texture;
    system.emitter = new Vector3(0, 0, 0);
    // Облачко рождается не в точке, а в пятне размером с сам след.
    system.minEmitBox = new Vector3(-0.12, 0, -0.12);
    system.maxEmitBox = new Vector3(0.12, 0.1, 0.12);
    system.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    system.minAngularSpeed = -1.2;
    system.maxAngularSpeed = 1.2;
    system.minInitialRotation = -Math.PI;
    system.maxInitialRotation = Math.PI;
    system.gravity = new Vector3(0, -SETTLE, 0);
    system.emitRate = 0;
    system.disposeOnStop = false;
    system.start();
    return system;
  });

  function aim(system: ParticleSystem, puff: Puff, speedMs: number, headingX: number, headingZ: number): void {
    // Из-под колеса летит назад по ходу и вверх. Вся скорость машины облачку не
    // достаётся: воздух гасит её за доли секунды, и шлейф остаётся стоять там, где
    // его подняли, — потому он и тянется за машиной, а не едет вместе с ней.
    const carry = -CARRY * speedMs;
    const bx = headingX * carry;
    const bz = headingZ * carry;
    system.direction1 = new Vector3(bx - 0.7, puff.riseMs * 0.6, bz - 0.7);
    system.direction2 = new Vector3(bx + 0.7, puff.riseMs * 1.6, bz + 0.7);
  }

  return {
    raise(frame, speedMs, headingX, headingZ): void {
      for (let i = 0; i < systems.length; i++) {
        const system = systems[i]!;
        const wheel = frame[i];
        const puff = wheel ? PUFFS[wheel.surface] : undefined;
        if (!wheel || !puff || !wheel.contact) {
          system.emitRate = 0;
          continue;
        }
        const rate = dustRate(puff, wheel.slide, speedMs);
        system.emitRate = rate;
        if (rate <= 0) continue;
        (system.emitter as Vector3).set(wheel.atX, wheel.atY, wheel.atZ);
        // Редкая пыль ещё и бледнее: облако тем плотнее, чем больше его поднимают.
        const thick = 0.35 + 0.45 * Math.min(1, rate / RATE_MAX);
        const [r, g, b] = puff.color;
        system.color1 = new Color4(r, g, b, thick);
        system.color2 = new Color4(r * 0.88, g * 0.88, b * 0.88, thick * 0.7);
        system.colorDead = new Color4(r, g, b, 0);
        system.minSize = puff.size[0];
        system.maxSize = puff.size[1];
        system.minLifeTime = puff.lifeS * 0.6;
        system.maxLifeTime = puff.lifeS;
        aim(system, puff, speedMs, headingX, headingZ);
      }
    },

    clear(): void {
      for (const system of systems) {
        system.emitRate = 0;
        system.reset();
      }
    },

    dispose(): void {
      for (const system of systems) system.dispose();
      texture.dispose();
    },
  };
}
