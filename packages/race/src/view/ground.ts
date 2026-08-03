import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";

/**
 * Земля и асфальт — рисованные текстуры, но не файлы: их считает процедура при
 * запуске сцены. Причина простая. Ровный зелёный цвет на траве не читается травой ни
 * при каком освещении: у него нет масштаба, и по нему не видно ни скорости, ни
 * расстояния — обочина выглядит крашеным полом. Годной фотографической текстуры травы
 * под свободной лицензией на пару мегапикселей мы платить не хотим, а шум нужного
 * вида умещается в сотню строк и полтораста килобайт в памяти.
 *
 * Каждая поверхность — это цвет и рельеф. Одного цвета мало: полотно земли — плоская
 * лента с одной нормалью, и без карты нормалей трава остаётся ровно закрашенной
 * плоскостью, сколько ни рисуй на ней пучков. С рельефом у неё появляется своя
 * светотень, а значит и направление солнца, и объём.
 *
 * Требование к шуму одно и жёсткое: он обязан замыкаться по краю. Полотно тянется на
 * десятки километров, текстура повторяется каждые несколько метров, и любой шов был бы
 * виден как сетка на всю обочину.
 */

/** Сторона текстуры в пикселях: около сорока пикселей на метр травы. */
const SIDE = 256;
/**
 * Шаг привязки развёртки к миру. Развёртка считается от начала окна, а не от начала
 * трассы: за сорок минут заезда мировые метры уходят за десятки тысяч, и точности
 * плавающего числа в интерполяторе уже не хватает — текстура начинает плыть. Но начало
 * окна нельзя брать где попало: сдвиг обязан быть целым числом плиток, иначе при каждом
 * перестроении узор дёргался бы на долю плитки. Двадцать четыре метра делятся и на
 * шесть, и на четыре, и на три.
 */
const UV_SNAP_M = 24;

/** Цвет, рельеф и размер плитки одной поверхности. */
export interface Surface {
  color: RawTexture;
  normal: RawTexture;
  /** Сколько метров земли занимает одна плитка. */
  tileM: number;
}

/** Хеш решётки: целые координаты в число от нуля до единицы. */
function lattice(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Шум по решётке с шагом `cells` на всю текстуру. Замыкается по краю, потому что узлы
 * решётки берутся по модулю числа клеток.
 */
function noise(px: number, py: number, cells: number, seed: number): number {
  const scale = cells / SIDE;
  const x = px * scale;
  const y = py * scale;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const wrap = (v: number) => ((v % cells) + cells) % cells;
  const a = lattice(wrap(x0), wrap(y0), seed);
  const b = lattice(wrap(x0 + 1), wrap(y0), seed);
  const c = lattice(wrap(x0), wrap(y0 + 1), seed);
  const d = lattice(wrap(x0 + 1), wrap(y0 + 1), seed);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Сумма нескольких масштабов шума: крупные пятна плюс мелкая рябь. */
function octaves(px: number, py: number, from: number, count: number, seed: number): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  for (let i = 0; i < count; i++) {
    sum += noise(px, py, from * 2 ** i, seed + i * 37) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
  }
  return sum / total;
}

function colorTexture(name: string, rgb: Uint8Array, scene: Scene): RawTexture {
  const raw = RawTexture.CreateRGBTexture(rgb, SIDE, SIDE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  raw.name = name;
  raw.wrapU = Texture.WRAP_ADDRESSMODE;
  raw.wrapV = Texture.WRAP_ADDRESSMODE;
  // Без анизотропии дальняя трава на скользящем взгляде превращается в кашу и
  // начинает мерцать при движении — на сорока минутах это утомляет отдельно.
  raw.anisotropicFilteringLevel = 8;
  return raw;
}

/**
 * Карта нормалей из поля высот: наклон считается разностью соседей, по кругу, чтобы
 * не завести шов на краю. Крутизна задаётся множителем — им и решается, рельеф это
 * травы по колено или шершавость асфальта.
 */
function normalTexture(name: string, height: Float32Array, steepness: number, scene: Scene): RawTexture {
  const rgb = new Uint8Array(SIDE * SIDE * 3);
  const at = (x: number, y: number) => height[((y + SIDE) % SIDE) * SIDE + ((x + SIDE) % SIDE)]!;
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * steepness;
      const dy = (at(x, y + 1) - at(x, y - 1)) * steepness;
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      const to = (y * SIDE + x) * 3;
      rgb[to] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      rgb[to + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      rgb[to + 2] = Math.round((1 / length) * 0.5 * 255 + 127);
    }
  }
  const raw = RawTexture.CreateRGBTexture(rgb, SIDE, SIDE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  raw.name = name;
  raw.wrapU = Texture.WRAP_ADDRESSMODE;
  raw.wrapV = Texture.WRAP_ADDRESSMODE;
  raw.anisotropicFilteringLevel = 8;
  return raw;
}

/**
 * Трава: крупные пятна сухого и сочного, поверх — рябь под пучки. Контраст намеренно
 * скромный: чем он резче, тем сильнее дальняя трава мерцает на мипах. Рельеф крутой,
 * трава — самая неровная поверхность на трассе.
 */
export function grassSurface(scene: Scene): Surface {
  const rgb = new Uint8Array(SIDE * SIDE * 3);
  const height = new Float32Array(SIDE * SIDE);
  const lush = [0x40, 0x68, 0x2c];
  const dry = [0x7d, 0x88, 0x40];
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const patch = octaves(x, y, 2, 3, 101);
      const blades = octaves(x, y, 24, 3, 202);
      const speck = lattice(x, y, 303);
      const t = Math.min(1, Math.max(0, (patch - 0.35) * 2.1));
      const shade = 0.74 + blades * 0.42 + speck * 0.12;
      const i = y * SIDE + x;
      height[i] = blades * 0.75 + speck * 0.25;
      for (let c = 0; c < 3; c++) {
        const base = lush[c]! + (dry[c]! - lush[c]!) * t;
        rgb[i * 3 + c] = Math.min(255, Math.round(base * shade));
      }
    }
  }
  return {
    color: colorTexture("race-grass", rgb, scene),
    normal: normalTexture("race-grass-n", height, 34, scene),
    tileM: 6,
  };
}

/**
 * Асфальт: тёмная крошка с редкими светлыми залысинами. Он нужен не ради красоты, а
 * ради скорости: по ровной серой плоскости не видно, как быстро ты едешь.
 *
 * Крошка — пиксельный шум, а не сглаженный: у сглаженного видна решётка, а мипы всё
 * равно усредняют пиксельный в ровный серый на дальнем плане. Плитка большая, шесть
 * метров: на четырёх повтор светлых залысин виден как узор через каждые два корпуса.
 */
export function asphaltSurface(scene: Scene): Surface {
  const rgb = new Uint8Array(SIDE * SIDE * 3);
  const height = new Float32Array(SIDE * SIDE);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const worn = octaves(x, y, 3, 2, 404);
      const grain = lattice(x, y, 505);
      const level = 50 + worn * 13 + grain * 17;
      const i = y * SIDE + x;
      height[i] = grain;
      rgb[i * 3] = Math.round(level * 1.02);
      rgb[i * 3 + 1] = Math.round(level);
      rgb[i * 3 + 2] = Math.round(level * 1.06);
    }
  }
  return {
    color: colorTexture("race-asphalt", rgb, scene),
    normal: normalTexture("race-asphalt-n", height, 3, scene),
    tileM: 6,
  };
}

/**
 * Гравий обочины: светлая крошка крупнее асфальтовой. Обочина от этого читается
 * полосой, а не просто другим оттенком зелёного, и кромка асфальта видна на скорости
 * даже там, где разметка стёрта.
 *
 * Крупную крошку нельзя рисовать сглаженным шумом с мелким шагом решётки: пять
 * пикселей на клетку дают ровную сетку бугров, и обочина читается кольчугой, а не
 * щебнем. Поэтому камни — пиксельный шум с редкими светлыми зёрнами поверх пятен
 * пыли, а размер зерна отдан плитке.
 */
export function gravelSurface(scene: Scene): Surface {
  const rgb = new Uint8Array(SIDE * SIDE * 3);
  const height = new Float32Array(SIDE * SIDE);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const dirt = octaves(x, y, 3, 2, 606);
      const clumps = octaves(x, y, 11, 2, 707);
      const grain = lattice(x, y, 808);
      // Редкие светлые камни: верхняя десятина шума, иначе крошка сливается в кашу.
      const stone = Math.max(0, grain - 0.82) * 5.5;
      const level = 92 + dirt * 20 + clumps * 14 + grain * 18 + stone * 22;
      const i = y * SIDE + x;
      height[i] = grain * 0.6 + stone * 0.4;
      rgb[i * 3] = Math.min(255, Math.round(level * 1.03));
      rgb[i * 3 + 1] = Math.min(255, Math.round(level));
      rgb[i * 3 + 2] = Math.min(255, Math.round(level * 0.88));
    }
  }
  return {
    color: colorTexture("race-gravel", rgb, scene),
    normal: normalTexture("race-gravel-n", height, 9, scene),
    tileM: 5,
  };
}

/** Начало развёртки для окна геометрии: целое число плиток, чтобы узор не дёргался. */
export function uvOrigin(x: number, z: number): [number, number] {
  return [Math.round(x / UV_SNAP_M) * UV_SNAP_M, Math.round(z / UV_SNAP_M) * UV_SNAP_M];
}

/**
 * Развёртка по мировым координатам, в метрах: масштаб плитки задаёт материал. Берётся
 * она из вершин самой сетки, а не из тех точек, по которым сетка построена, — так
 * порядок вершин остаётся заботой построителя ленты, а не нашей.
 *
 * Развёртка обязана быть мировой, а не по длине ленты: лента живёт окном и каждые
 * десять метров перестраивается на месте. Была бы развёртка по номеру точки — узор ехал
 * бы вместе с окном, то есть трава бежала бы навстречу машине.
 */
export function applyWorldUv(mesh: Mesh, originX: number, originZ: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;
  const count = positions.length / 3;
  const existing = mesh.getVerticesData(VertexBuffer.UVKind);
  const uv =
    existing instanceof Float32Array && existing.length === count * 2 ? existing : new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uv[i * 2] = positions[i * 3]! - originX;
    uv[i * 2 + 1] = positions[i * 3 + 2]! - originZ;
  }
  const buffer = mesh.getVertexBuffer(VertexBuffer.UVKind);
  if (buffer?.isUpdatable()) mesh.updateVerticesData(VertexBuffer.UVKind, uv);
  else mesh.setVerticesData(VertexBuffer.UVKind, uv, true);
}
