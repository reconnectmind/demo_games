/**
 * `@gamespace/env` — среда, в которой всё происходит.
 *
 * Пакет отвечает на вопросы, которые ни машине, ни лесу не принадлежат, но
 * нужны обоим: какая погода, куда и как сильно дует, откуда светит солнце, куда
 * уходит дымка, какая бывает земля и как она выглядит. Игра берёт отсюда мир, а
 * машина и растения — условия, в которых они живут.
 *
 * Зависимостей на игру у пакета нет и быть не должно: среда ничего не знает ни
 * про дорогу, ни про заезд. Дорога — устройство конкретного мира, и лежит она в
 * игре; здесь только то, что было бы верно и для другого мира.
 */
export { hash01, smoothstep } from "./hash.js";
export { weatherFor } from "./weather.js";
export type { Weather } from "./weather.js";
export { CALM, windAt } from "./wind.js";
export type { Wind } from "./wind.js";
export { PHYSICS_STEP_S, createWorld, physicsReady, preparePhysics, rapier } from "./physics.js";
export { SURFACES, blendSurface, surfaceKindOf, surfaceOf } from "./surface.js";
export type { Surface, SurfaceKind, SurfaceMix } from "./surface.js";
export { createSky } from "./view/sky.js";
export type { Sky } from "./view/sky.js";
export { createShadows } from "./view/shadows.js";
export type { Shadows } from "./view/shadows.js";
export { applyWorldUv, asphaltSurface, grassSurface, gravelSurface, uvOrigin } from "./view/ground.js";
export type { SurfaceSkin } from "./view/ground.js";
