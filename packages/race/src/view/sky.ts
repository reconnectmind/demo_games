import { SkyMaterial } from "@babylonjs/materials/sky/skyMaterial.js";
import { createShadows, type Shadows } from "./shadows.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
// Побочные импорты: без них у MeshBuilder нет фабрик сферы и плоскости.
import "@babylonjs/core/Meshes/Builders/sphereBuilder.js";
import "@babylonjs/core/Meshes/Builders/planeBuilder.js";
import { hash01 } from "../track.js";

/**
 * Небо, солнце и облака.
 *
 * Небо считает `SkyMaterial` — модель рассеяния Прита: по высоте солнца сама
 * получается и синева в зените, и белёсая дымка у горизонта, и тёплый диск на своём
 * месте. Раньше небо было одним ровным цветом заливки, и от этого весь заезд
 * выглядел нарисованным на серой бумаге: смотреть сорок минут не на что, а солнца
 * не было вовсе — тени падали от ниоткуда.
 *
 * Облака `SkyMaterial` не умеет и уметь не должен: рассеяние — про воздух, а не про
 * воду. Они здесь отдельным слоем над сценой, как это и делают в Babylon: полотно с
 * прозрачностью из процедурного шума, приколотое к камере, с развёрткой от мировых
 * координат. Небо и облака заведомо дальше тумана и его не получают, иначе оба
 * сливались бы с ним в одну серую стену.
 *
 * Погода — от посева блока: высота солнца, его сторона, мутность воздуха и
 * облачность. Каждый заезд получает своё время дня, и сорок минут смотреть на дорогу
 * становится чуть менее одинаково.
 */

/** Радиус купола: внутри дальней плоскости камеры, но за всей геометрией трассы. */
const DOME_R = 2000;
/** Радиус облачного купола: чуть внутри неба, чтобы лежать перед ним. */
const CLOUD_R = 1900;
/** Сколько плиток текстуры укладывается вокруг горизонта и от горизонта к зениту. */
const CLOUD_TILES_AROUND = 6;
const CLOUD_TILES_UP = 3;
/** Угол, ниже которого облаков нет: у самого горизонта они смазывались в полосу. */
const CLOUD_FADE_FROM = 3 * (Math.PI / 180);
const CLOUD_FADE_TO = 13 * (Math.PI / 180);
/** Ход облаков при полном ветре: градусов неба в секунду. */
const CLOUD_WIND_DEG_S = 0.35;
const CLOUD_SIDE = 256;

export interface Sky {
  /** Солнце сцены: его направление задаёт небо, а не наоборот. */
  sun: DirectionalLight;
  /** Тени от этого солнца: живут ровно столько же, сколько оно само. */
  shadows: Shadows;
  /** Цвет, в который уходит туман: горизонт неба этой погоды. */
  hazeColor: Color3;
  /** Погода целиком: сцене от неё нужен ещё и ветер — по нему качается лес. */
  weather: Weather;
  /** Ход облаков по ветру: единственное, что в небе меняется за заезд. */
  drift(elapsedS: number): void;
  dispose(): void;
}

function lattice(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise(px: number, py: number, cells: number, seed: number): number {
  const scale = cells / CLOUD_SIDE;
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

/**
 * Облачное полотно: белое, а вся форма — в прозрачности.
 *
 * Порог плотности берётся не числом, а квантилью самого поля: сумма шумов
 * распределена узко, вокруг половины, и любой порог «на глаз» даёт либо ясное небо,
 * либо сплошную пелену — ровно на этом первая попытка и провалилась, небо осталось
 * пустым. С квантилью облачность значит буквально долю затянутого неба.
 */
function cloudTexture(scene: Scene, cover: number, seed: number): RawTexture {
  const pixels = CLOUD_SIDE * CLOUD_SIDE;
  const density = new Float32Array(pixels);
  for (let y = 0; y < CLOUD_SIDE; y++) {
    for (let x = 0; x < CLOUD_SIDE; x++) {
      let sum = 0;
      let amplitude = 1;
      let total = 0;
      for (let i = 0; i < 5; i++) {
        sum += noise(x, y, 2 * 2 ** i, seed + i * 53) * amplitude;
        total += amplitude;
        amplitude *= 0.55;
      }
      density[y * CLOUD_SIDE + x] = sum / total;
    }
  }
  const sorted = Float32Array.from(density).sort();
  const gate = sorted[Math.min(pixels - 1, Math.floor((1 - cover) * pixels))]!;

  const data = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    // Край мягкий, иначе облака выглядят вырезанными ножницами.
    const alpha = Math.min(1, Math.max(0, (density[i]! - gate) / 0.06));
    const at = i * 4;
    // Плотное ярче рыхлого: без этого облака читаются плоскими пятнами белил.
    const level = Math.round(206 + Math.min(1, alpha * 1.4) * 46);
    data[at] = level;
    data[at + 1] = level;
    data[at + 2] = Math.min(255, level + 6);
    data[at + 3] = Math.round(alpha * 232);
  }
  const raw = RawTexture.CreateRGBATexture(
    data,
    CLOUD_SIDE,
    CLOUD_SIDE,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  raw.name = "race-clouds";
  raw.wrapU = Texture.WRAP_ADDRESSMODE;
  raw.wrapV = Texture.WRAP_ADDRESSMODE;
  raw.uScale = CLOUD_TILES_AROUND;
  raw.vScale = CLOUD_TILES_UP;
  raw.hasAlpha = true;
  return raw;
}

/**
 * Прозрачность у горизонта — в вершинах купола, а не в текстуре: текстура повторяется
 * и по кругу, и по высоте, и вписать в неё «низ неба» нельзя. У самого горизонта
 * облака гасятся полностью: там любая плитка вырождается в полосу, и слой читается
 * тем, чем он и является — куском геометрии.
 */
function fadeAtHorizon(mesh: Mesh): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;
  const count = positions.length / 3;
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const y = positions[i * 3 + 1]!;
    const x = positions[i * 3]!;
    const z = positions[i * 3 + 2]!;
    const elevation = Math.atan2(y, Math.sqrt(x * x + z * z));
    const t = Math.min(1, Math.max(0, (elevation - CLOUD_FADE_FROM) / (CLOUD_FADE_TO - CLOUD_FADE_FROM)));
    colors[i * 4] = 1;
    colors[i * 4 + 1] = 1;
    colors[i * 4 + 2] = 1;
    colors[i * 4 + 3] = t * t * (3 - 2 * t);
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors, false);
  mesh.hasVertexAlpha = true;
}

/**
 * Погода заезда из посева: солнце не ниже двадцати и не выше шестидесяти градусов
 * (ниже — дорога тонет в контрасте, выше — исчезают тени и с ними объём), сторона
 * любая, мутность от прозрачного дня до летнего пекла, облачность от редких клочков
 * до сплошной пелены.
 */
export interface Weather {
  /** Высота солнца над горизонтом, радианы. */
  elevation: number;
  /** Сторона света, радианы. */
  azimuth: number;
  /** Мутность воздуха: от прозрачного дня до летнего пекла. */
  turbidity: number;
  /** Доля закрытого облаками неба. */
  cover: number;
  /** Сила ветра: от штиля до свежего, доля от полной амплитуды качания. */
  wind: number;
  /** Куда дует, радианы: тот же отсчёт, что у стороны света. */
  windRad: number;
}

function weatherFor(seed: number): Weather {
  return {
    elevation: (25 + hash01(seed, 0, 91) * 34) * (Math.PI / 180),
    azimuth: hash01(seed, 0, 92) * Math.PI * 2,
    turbidity: 2 + hash01(seed, 0, 93) * 8,
    // Небо не должно затягивать: за облаками пропадает и солнце, и с ним весь объём
    // сцены. Половина неба открытой — верхняя граница, а не середина вилки.
    cover: 0.1 + hash01(seed, 0, 94) * 0.32,
    // Ветер — часть погоды, а не отдельная настройка деревьев: по нему идут и облака,
    // и крона. Полного штиля не бывает: неподвижный лес выглядит нарисованным.
    wind: 0.45 + hash01(seed, 0, 95) * 0.75,
    windRad: hash01(seed, 0, 96) * Math.PI * 2,
  };
}

export function createSky(scene: Scene, seed: number, fixed?: Partial<Weather>): Sky {
  const weather = { ...weatherFor(seed), ...fixed };

  /**
   * Положение солнца задаётся вектором, а не парой «высота и азимут». Так у него
   * ровно один хозяин: то же направление уходит и в небо, и в свет сцены, и тень
   * гарантированно падает от того диска, который видно на небе. Считает эти углы
   * материал точно так же, но только на отрисовке, и прочитать их до первого кадра
   * нельзя.
   */
  const sunPosition = new Vector3(
    Math.cos(weather.azimuth) * Math.cos(weather.elevation),
    Math.sin(weather.elevation),
    Math.sin(weather.azimuth) * Math.cos(weather.elevation),
  );

  const material = new SkyMaterial("race-sky", scene);
  material.backFaceCulling = false;
  material.useSunPosition = true;
  material.sunPosition = sunPosition.scale(material.distance);
  material.turbidity = weather.turbidity;
  material.luminance = 1;
  material.rayleigh = 2;
  material.mieCoefficient = 0.005;
  material.mieDirectionalG = 0.82;

  const dome = MeshBuilder.CreateSphere("race-dome", { diameter: DOME_R * 2, segments: 16 }, scene);
  dome.material = material;
  dome.isPickable = false;
  dome.applyFog = false;
  dome.infiniteDistance = true;

  const sun = new DirectionalLight("race-sun", sunPosition.scale(-1), scene);
  // Чем ниже солнце, тем длиннее путь света в воздухе: свет слабее и заметно теплее.
  const height = Math.sin(weather.elevation);
  /**
   * Сумма солнца и неба на горизонтальной поверхности держится около единицы. Это не
   * вкусовщина: у обычного материала Babylon свет не тонируется, всё сверх единицы
   * просто обрезается в белый, и первая же попытка это показала — крыша машины стала
   * белым прямоугольником, а трава выцвела в серую.
   */
  sun.intensity = 0.9 + height * 0.3;
  sun.diffuse = new Color3(1, 0.93 + height * 0.05, 0.8 + height * 0.15);

  const hemi = new HemisphericLight("race-hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.28 + weather.cover * 0.22;
  hemi.diffuse = new Color3(0.83, 0.89, 0.96);
  hemi.groundColor = Color3.FromHexString("#43502f");

  /**
   * Цвет дымки — небо у горизонта той же погоды, посчитанное по той же формуле, что
   * и в шейдере, но грубо: важно не совпасть в точности, а не разъехаться. Иначе
   * дальний край травы упирается в стену другого цвета, чем небо над ней.
   */
  const haze = new Color3(0.62, 0.7, 0.78)
    .scale(1 - weather.turbidity * 0.012)
    .add(new Color3(0.12, 0.09, 0.05).scale(1 - height));
  const hazeColor = new Color3(Math.min(1, haze.r), Math.min(1, haze.g), Math.min(1, haze.b));

  /**
   * Облака живут на своём куполе внутри неба, а не на полотне над машиной. Полотно
   * было первым решением, и у него ровно та беда, которую видно сразу: плоский слой
   * под скользящим углом сплющивается в мазок, а поднять его выше нельзя — упирается
   * в дальнюю плоскость камеры. На куполе облака и у горизонта ложатся полосами, как
   * им и положено, и никакой дальней плоскости не касаются.
   *
   * Плата: облака бесконечно далеко и от езды не сдвигаются, двигает их только ветер.
   * Для облаков в километрах над дорогой это ближе к правде, чем к вранью.
   */
  const clouds = MeshBuilder.CreateSphere("race-clouds", { diameter: CLOUD_R * 2, segments: 24 }, scene);
  clouds.isPickable = false;
  clouds.applyFog = false;
  clouds.infiniteDistance = true;
  fadeAtHorizon(clouds);
  const cloudMat = new StandardMaterial("race-cloud-mat", scene);
  const cloudTex = cloudTexture(scene, weather.cover, seed);
  /**
   * Цвет облаков — свечение, а не отражение: слой смотрит вверх, а мы на него снизу,
   * и от единственного источника света он получался бы чёрным. Прозрачность — из
   * альфы той же текстуры, ей и нарисована вся форма.
   */
  cloudMat.emissiveTexture = cloudTex;
  cloudMat.emissiveColor = Color3.White().scale(0.62 + height * 0.38);
  cloudMat.opacityTexture = cloudTex;
  cloudMat.diffuseColor = Color3.Black();
  cloudMat.specularColor = Color3.Black();
  cloudMat.disableLighting = true;
  cloudMat.backFaceCulling = false;
  clouds.material = cloudMat;

  scene.clearColor = new Color4(hazeColor.r, hazeColor.g, hazeColor.b, 1);
  scene.fogColor = hazeColor;
  scene.ambientColor = new Color3(0.45, 0.5, 0.56);

  const shadows = createShadows(sun);

  return {
    sun,
    shadows,
    hazeColor,
    weather,
    drift: (elapsedS) => {
      clouds.rotation.y = weather.azimuth + elapsedS * CLOUD_WIND_DEG_S * weather.wind * (Math.PI / 180);
    },
    dispose: () => {
      clouds.dispose();
      cloudMat.dispose();
      cloudTex.dispose();
      dome.dispose();
      material.dispose();
      shadows.dispose();
      sun.dispose();
      hemi.dispose();
    },
  };
}
