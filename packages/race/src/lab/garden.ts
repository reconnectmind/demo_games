import { Engine } from "@babylonjs/core/Engines/engine.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Scene } from "@babylonjs/core/scene.js";
import "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import "@babylonjs/core/Rendering/depthRendererSceneComponent.js";
import { applyWorldUv, asphaltSurface, grassSurface, gravelSurface, type Surface } from "../view/ground.js";
import { createSky, type Sky } from "../view/sky.js";
import { SPECIES } from "../view/species.js";
import { loadTreeField, type TreeField, type TreeSpot } from "../view/trees.js";

/**
 * Стенд для деревьев: та же дорога, то же небо, тот же лес, но без машины, без физики
 * и без случайности.
 *
 * Зачем он есть. Лес в заезде растёт из хеша: породы, рост, раскидистость и место —
 * всё функции посева, и одно и то же дерево дважды подряд не увидишь. Оценивать по
 * такой картинке нельзя: непонятно, стало лучше от правки или просто выпал другой
 * бросок. Здесь наоборот — сад по каждой породе, по обе стороны дороги, всегда один и
 * тот же: слева ряд одной породы от самого низкого до самого высокого, справа тот же
 * рост, но от узкого силуэта к раскидистому, за ними — купа на отдалении, чтобы видеть
 * породу массой, а не поштучно. Правка видна сравнением двух снимков одного кадра.
 *
 * Солнце, ветер и туман крутятся с клавиатуры: крона выглядит по-разному против света
 * и по свету, и половина претензий к деревьям — это на самом деле претензии к тому,
 * при каком солнце на них смотрели.
 */

/** Полоса и обочина как в заезде: масштаб дерева читается только рядом с дорогой. */
const ROAD_HALF_M = 5;
const SHOULDER_M = 1.6;
/** Шаг между садами вдоль дороги и длина всей аллеи. */
const BAY_M = 44;
const FIRST_BAY_M = 60;
/** Отступ рядов от кромки полосы: ближний ряд и дальняя купа. */
const NEAR_AWAY_M = 6;
const FAR_AWAY_M = 22;
/** Камера сада: те же одиннадцать метров позади и почти четыре метра выше, что в заезде. */
const CAM_UP_M = 3.8;
const CAM_BACK_M = 26;

const WIND_STEPS = [0, 0.45, 1, 1.7];
const FOG_DENSITY = 0.0035;

export interface Garden {
  /** Сцена наружу: стенд для того и нужен, чтобы в него можно было залезть руками. */
  scene: Scene;
  resize(): void;
  dispose(): void;
}

/** Хеш стенда: тот же вид арифметики, что и на трассе, но посев здесь постоянный. */
function hash01(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Сад одной породы: ближний ряд слева — рост от малого к большому, ближний ряд
 * справа — раскидистость от узкой к широкой при одном росте, дальняя купа — порода
 * массой. Всё считается от номера породы, никакого случая.
 */
function gardenSpots(species: (typeof SPECIES)[number], variant: number, z0: number): TreeSpot[] {
  const out: TreeSpot[] = [];
  const [hMin, hMax] = species.heightM;
  const [sMin, sMax] = species.spread;
  const away = ROAD_HALF_M + SHOULDER_M + NEAR_AWAY_M;

  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    out.push({
      x: -away,
      y: 0,
      z: z0 - 13 + i * 9,
      rotationY: t * Math.PI * 0.7,
      heightM: lerp(hMin, hMax, t),
      spread: (sMin + sMax) / 2,
      lean: 0,
      variant,
    });
    out.push({
      x: away,
      y: 0,
      z: z0 - 13 + i * 9,
      rotationY: Math.PI + t * Math.PI * 0.7,
      heightM: (hMin + hMax) / 2,
      spread: lerp(sMin, sMax, t),
      lean: (t - 0.5) * 0.16,
      variant,
    });
  }

  // Дальняя купа: тот же вид издали и вплотную друг к другу — так видно силуэт
  // породы и то, как кроны складываются в массу, а не стоят линейкой.
  for (let i = 0; i < 7; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const roll = hash01(variant * 31 + i, 7);
    out.push({
      x: side * (ROAD_HALF_M + SHOULDER_M + FAR_AWAY_M + hash01(variant * 31 + i, 3) * 12),
      y: 0,
      z: z0 - 16 + i * 5 + hash01(variant * 31 + i, 5) * 4,
      rotationY: roll * Math.PI * 2,
      heightM: lerp(hMin, hMax, hash01(variant * 31 + i, 11)),
      spread: lerp(sMin, sMax, hash01(variant * 31 + i, 13)),
      lean: (hash01(variant * 31 + i, 17) - 0.5) * 0.14,
      variant,
    });
  }
  return out;
}

export async function mountGarden(canvas: HTMLCanvasElement, hud: HTMLElement): Promise<Garden> {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
  const dpr = typeof devicePixelRatio === "number" ? Math.min(devicePixelRatio, 2) : 1;
  engine.setHardwareScalingLevel(1 / dpr);

  const scene = new Scene(engine);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = FOG_DENSITY;

  const camera = new FreeCamera("garden-cam", new Vector3(0, CAM_UP_M, 0), scene);
  camera.minZ = 0.4;
  camera.maxZ = 2200;
  camera.fov = 1.0;

  const textured = (name: string, surface: Surface): StandardMaterial => {
    const material = new StandardMaterial(name, scene);
    material.diffuseColor = Color3.White();
    material.specularColor = Color3.Black();
    for (const texture of [surface.color, surface.normal]) {
      texture.uScale = 1 / surface.tileM;
      texture.vScale = 1 / surface.tileM;
    }
    material.diffuseTexture = surface.color;
    material.bumpTexture = surface.normal;
    return material;
  };

  const lastBayZ = FIRST_BAY_M + (SPECIES.length - 1) * BAY_M;
  const alleyLength = lastBayZ + 120;
  const strip = (name: string, halfWidth: number, y: number, surface: Surface): Mesh => {
    const mesh = MeshBuilder.CreateGround(name, { width: halfWidth * 2, height: alleyLength, subdivisions: 1 }, scene);
    mesh.position.z = alleyLength / 2 - 40;
    mesh.position.y = y;
    mesh.material = textured(`${name}-mat`, surface);
    mesh.receiveShadows = true;
    applyWorldUv(mesh, 0, 0);
    return mesh;
  };

  const ground = strip("garden-ground", 160, 0, grassSurface(scene));
  const shoulder = strip("garden-shoulder", ROAD_HALF_M + SHOULDER_M, 0.01, gravelSurface(scene));
  const road = strip("garden-road", ROAD_HALF_M, 0.02, asphaltSurface(scene));

  /** Погода стенда: постоянная, и меняется только руками. */
  const weather = { elevation: 42 * (Math.PI / 180), azimuth: 2.4, turbidity: 3, cover: 0.22 };
  let sky: Sky = createSky(scene, 1, weather);

  let field: TreeField | null = null;
  let station = 0;
  let windStep = 1;
  let closeUp = false;
  let fog = true;

  function stationZ(index: number): number {
    return FIRST_BAY_M + (index - 1) * BAY_M;
  }

  function placeCamera(): void {
    if (station === 0) {
      // Аллея: весь стенд насквозь. По ней видно, как порода читается вдали и как
      // крона переживает туман и мипы — то, что на близком плане незаметно.
      camera.position.set(0, CAM_UP_M + 1.4, 0);
      camera.setTarget(new Vector3(0, 6, lastBayZ));
      return;
    }
    const z = stationZ(station);
    const back = closeUp ? 13 : CAM_BACK_M;
    const up = closeUp ? 1.8 : CAM_UP_M;
    camera.position.set(0, up, z - back);
    camera.setTarget(new Vector3(0, closeUp ? 3 : 5, z + 4));
  }

  function relight(): void {
    sky.dispose();
    sky = createSky(scene, 1, weather);
    // Карта теней принадлежит солнцу и умирает вместе с ним, поэтому список
    // отбрасывающих собирается заново при каждой смене света.
    for (const mesh of field?.meshes ?? []) sky.shadows.cast(mesh);
    scene.fogDensity = fog ? FOG_DENSITY : 0;
    scene.fogColor = sky.hazeColor;
  }

  function report(): void {
    const name = station === 0 ? "аллея целиком" : SPECIES[station - 1]!.id;
    const deg = (rad: number) => `${Math.round(rad * (180 / Math.PI))}°`;
    hud.innerHTML = [
      `<b>${name}</b>${station === 0 ? "" : ` · ${station}/${SPECIES.length}`}`,
      `солнце ${deg(weather.elevation)} над горизонтом, ${deg(weather.azimuth)} по сторонам`,
      `ветер ${WIND_STEPS[windStep]!.toFixed(2)} · туман ${fog ? "есть" : "нет"} · план ${closeUp ? "ближний" : "дорожный"}`,
      `<span class="keys">← → порода · ↑ ↓ солнце выше-ниже · A D солнце вокруг · W ветер · C план · F туман</span>`,
    ].join("<br>");
  }

  function onKey(event: KeyboardEvent): void {
    const step = 5 * (Math.PI / 180);
    switch (event.key) {
      case "ArrowRight":
        station = (station + 1) % (SPECIES.length + 1);
        placeCamera();
        break;
      case "ArrowLeft":
        station = (station + SPECIES.length) % (SPECIES.length + 1);
        placeCamera();
        break;
      case "ArrowUp":
        weather.elevation = Math.min(85 * (Math.PI / 180), weather.elevation + step);
        relight();
        break;
      case "ArrowDown":
        weather.elevation = Math.max(3 * (Math.PI / 180), weather.elevation - step);
        relight();
        break;
      case "a":
      case "A":
      case "ф":
      case "Ф":
        weather.azimuth -= 3 * step;
        relight();
        break;
      case "d":
      case "D":
      case "в":
      case "В":
        weather.azimuth += 3 * step;
        relight();
        break;
      case "w":
      case "W":
      case "ц":
      case "Ц":
        windStep = (windStep + 1) % WIND_STEPS.length;
        field?.setWind(WIND_STEPS[windStep]!, 0.7);
        break;
      case "c":
      case "C":
      case "с":
      case "С":
        closeUp = !closeUp;
        placeCamera();
        break;
      case "f":
      case "F":
      case "а":
      case "А":
        fog = !fog;
        scene.fogDensity = fog ? FOG_DENSITY : 0;
        break;
      default:
        return;
    }
    event.preventDefault();
    report();
  }
  window.addEventListener("keydown", onKey);

  placeCamera();
  report();

  const started = performance.now();
  const drawFrame = (): void => {
    const elapsedS = (performance.now() - started) / 1000;
    sky.drift(elapsedS);
    field?.animate(elapsedS);
    scene.render();
  };
  engine.runRenderLoop(drawFrame);
  // Стенд смотрят не только глазами: снимок из консоли снимается при неактивном окне,
  // а тогда браузер придерживает кадры и на холсте остаётся пустота. Ручной кадр
  // нужен ровно для этого.
  (globalThis as Record<string, unknown>).__garden = { scene, camera, step: drawFrame };

  field = await loadTreeField(scene);
  const spots: TreeSpot[] = [];
  SPECIES.forEach((species, index) => {
    const variant = field!.variants.indexOf(species.id);
    if (variant < 0) return;
    spots.push(...gardenSpots(species, variant, stationZ(index + 1)));
  });
  field.place(spots);
  for (const mesh of field.meshes) sky.shadows.cast(mesh);
  field.setWind(WIND_STEPS[windStep]!, 0.7);
  report();

  return {
    scene,
    resize: () => engine.resize(),
    dispose: () => {
      window.removeEventListener("keydown", onKey);
      field?.dispose();
      sky.dispose();
      road.dispose();
      shoulder.dispose();
      ground.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}
