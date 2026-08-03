// Импорты поштучные, а не из корня пакета: корневой `@babylonjs/core` тянет в
// бандл гауссовы сплаты, объёмный свет и прочее, чего в этой сцене нет, —
// полтора мегабайта в гзипе против примерно двухсот килобайт здесь.
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
// Побочные импорты: без них у MeshBuilder нет нужных фабрик.
import "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import "@babylonjs/core/Meshes/Builders/ribbonBuilder.js";
import {
  CUT_BERM_L,
  CUT_BERM_R,
  CUT_DITCH_L,
  CUT_DITCH_R,
  CUT_GRASS_L,
  CUT_GRASS_R,
  CUT_ROAD_L,
  CUT_ROAD_R,
  CUT_SHOULDER_L,
  CUT_SHOULDER_R,
  Centerline,
  FINE_PER_SEGMENT,
  apronWidth,
  crossSection,
  lateralOffset,
  segmentIndexAt,
  type FinePoint,
} from "../track.js";
import { RIDE_HEIGHT_M, WHEEL_MOUNTS } from "../sim.js";
import { MASS_KG, SUSPENSION_LOADED_M } from "../geometry.js";
import { TIRE_COLD_C } from "../tire.js";
import type { SimFrame } from "../sim.js";
import type { RaceView } from "../core.js";
import { createRaceAudio } from "./audio.js";
import { createCarModel, type CarModel } from "./car.js";
import { createTireMarks } from "./marks.js";
import { Playout } from "./playout.js";
import {
  applyWorldUv,
  asphaltSurface,
  grassSurface,
  gravelSurface,
  uvOrigin,
  type Surface,
} from "./ground.js";
import { cameraFollow } from "./follow.js";
import { createPlume } from "./plume.js";
import { createSky, type Sky } from "./sky.js";
import { TREE_AHEAD, plantTrees } from "./plant.js";
import { loadTreeField, type TreeField, type TreeSpot } from "./trees.js";

/**
 * Babylon отвечает только за картинку. Состоянием владеет ядро, поэтому сцену
 * можно выбросить и переписать, ничего не меняя в физике, журнале и тестах.
 * Главный цикл движку не отдан: `runRenderLoop` рисует последнее известное
 * состояние, а шаг симуляции идёт своим темпом в ядре.
 *
 * Геометрия идёт мелким шагом по той же осевой линии, что и коллизионная сетка в
 * физике: колёса едут ровно по видимому асфальту, а поворот больше не ломаная из
 * десятиметровых звеньев.
 */

/** Окно геометрии в сегментах: позади машины и впереди. */
const BEHIND = 6;
const AHEAD = 70;
const WINDOW = BEHIND + AHEAD;
/** Столбы через каждые пятьдесят метров, по чётным — с другой стороны. */
const POST_EVERY = 5;
const POSTS = Math.floor(WINDOW / POST_EVERY) + 1;
/** Камера висит на осевой линии в метрах позади машины и выше её. */
const CAM_BACK_M = 11;
const CAM_UP_M = 3.8;
/**
 * Дорожки лент земли: имя, точка поперечного профиля и — только у дальних краёв —
 * доля от ширины дали. Даль отдельным числом, потому что она одна не из профиля:
 * её край отодвигается тем дальше, чем прямее дорога.
 */
const LANES: { name: string; cut: number; apron?: number }[] = [
  { name: "apronL", cut: CUT_BERM_L, apron: -1 },
  { name: "bermL", cut: CUT_BERM_L },
  { name: "grassL", cut: CUT_GRASS_L },
  { name: "ditchL", cut: CUT_DITCH_L },
  { name: "gravelL", cut: CUT_SHOULDER_L },
  { name: "roadL", cut: CUT_ROAD_L },
  { name: "roadR", cut: CUT_ROAD_R },
  { name: "gravelR", cut: CUT_SHOULDER_R },
  { name: "ditchR", cut: CUT_DITCH_R },
  { name: "grassR", cut: CUT_GRASS_R },
  { name: "bermR", cut: CUT_BERM_R },
  { name: "apronR", cut: CUT_BERM_R, apron: 1 },
];
/** Постоянная времени сглаживания камеры: по времени, а не по числу кадров. */
const CAM_SMOOTH_S = 0.05;

export interface RaceScene {
  update(view: RaceView): void;
  /**
   * Когда сцену уже можно показывать: машина собрана и её шейдеры скомпилированы.
   *
   * Раньше здесь стоял `scene.whenReadyAsync`, и это была не «более строгая»
   * проверка, а мёртвая петля. Готовность всей сцены — это готовность каждой
   * сетки, включая шаблоны деревьев; у шаблона в этот момент ноль тонких
   * экземпляров, поэтому он не рисуется, поэтому его шейдер не компилируется,
   * поэтому готовым он не станет никогда. Экземпляры ему проставляет первый же
   * `update`, а `update` приходил только после ожидания — круг замыкался, и
   * заглушка «сцена загружается…» висела до конца заезда. Держалось всё это
   * только на гонке: пока файл леса приезжал медленнее первой проверки,
   * готовность успевала случиться до появления шаблонов.
   */
  whenReady(): Promise<void>;
  resize(): void;
  /** Выключатель звука. Возвращает состояние после переключения. */
  toggleSound(): boolean;
  soundOn(): boolean;
  dispose(): void;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Промежуточное состояние между двумя шагами. Поворот — по короткой дуге, всё
 * остальное — линейно; накрученный угол колеса монотонен, поэтому его тоже можно
 * смешивать напрямую. Признак контакта берётся у свежего снимка: у него нет
 * промежуточных значений.
 */
/**
 * Куда смотрит машина: единичный вектор курса, положенный на землю. Нужен пыли —
 * облако из-под колеса летит назад по ходу, а где «назад», знает только кузов.
 */
function heading(frame: SimFrame): [number, number] {
  const forward = new Vector3(0, 0, 1).rotateByQuaternionToRef(
    new Quaternion(frame.qx, frame.qy, frame.qz, frame.qw),
    new Vector3(),
  );
  const flat = Math.hypot(forward.x, forward.z) || 1;
  return [forward.x / flat, forward.z / flat];
}

function mixFrames(a: SimFrame, b: SimFrame, t: number): SimFrame {
  const rotation = Quaternion.Slerp(
    new Quaternion(a.qx, a.qy, a.qz, a.qw),
    new Quaternion(b.qx, b.qy, b.qz, b.qw),
    t,
  );
  return {
    t: mix(a.t, b.t, t),
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t),
    z: mix(a.z, b.z, t),
    qx: rotation.x,
    qy: rotation.y,
    qz: rotation.z,
    qw: rotation.w,
    speedMs: mix(a.speedMs, b.speedMs, t),
    driveSpeedMs: mix(a.driveSpeedMs, b.driveSpeedMs, t),
    s: mix(a.s, b.s, t),
    lateral: mix(a.lateral, b.lateral, t),
    groundY: mix(a.groundY, b.groundY, t),
    upright: mix(a.upright, b.upright, t),
    wheels: b.wheels.map((wheel, i) => {
      const was = a.wheels[i] ?? wheel;
      return {
        suspension: mix(was.suspension, wheel.suspension, t),
        steer: mix(was.steer, wheel.steer, t),
        spin: mix(was.spin, wheel.spin, t),
        contact: wheel.contact,
        loadN: mix(was.loadN, wheel.loadN, t),
        slide: mix(was.slide, wheel.slide, t),
        tempC: mix(was.tempC, wheel.tempC, t),
        mark: mix(was.mark, wheel.mark, t),
        atX: mix(was.atX, wheel.atX, t),
        atY: mix(was.atY, wheel.atY, t),
        atZ: mix(was.atZ, wheel.atZ, t),
        sideX: mix(was.sideX, wheel.sideX, t),
        sideZ: mix(was.sideZ, wheel.sideZ, t),
        // Покрытие — не число, смешивать его нечем: берётся то, что уже приехало.
        surface: wheel.surface,
      };
    }),
  };
}

function flat(color: string, scene: Scene, glow = false): StandardMaterial {
  const material = new StandardMaterial(`m-${color}`, scene);
  material.diffuseColor = Color3.FromHexString(color);
  material.specularColor = Color3.Black();
  if (glow) material.emissiveColor = Color3.FromHexString(color).scale(0.35);
  return material;
}

/**
 * Выключенный звук переживает перезагрузку. Игру запускают в наушниках и без,
 * рядом с людьми и в одиночестве; заставлять выключать заново каждый заезд —
 * значит гарантировать, что первый же кадр однажды прозвучит некстати.
 */
const SOUND_KEY = "race.sound";

function soundWanted(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    // Приватный режим запрещает хранилище; звук по умолчанию есть.
    return true;
  }
}

function rememberSound(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    // Не запомнили — не беда: выключатель работает и без памяти.
  }
}

export function createRaceScene(canvas: HTMLCanvasElement): RaceScene {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
  // Плотность пикселей ограничена двойкой: на телефоне это разница между
  // сорока минутами игры и сорока минутами нагрева.
  const dpr = typeof devicePixelRatio === "number" ? Math.min(devicePixelRatio, 2) : 1;
  engine.setHardwareScalingLevel(1 / dpr);

  const scene = new Scene(engine);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.0035;

  const camera = new FreeCamera("race-cam", new Vector3(0, 6, -14), scene);
  camera.minZ = 0.4;
  camera.maxZ = 2200;
  camera.fov = 1.0;

  /**
   * Небо, солнце и облака ставятся при первом виде, а не здесь: погода заезда —
   * функция посева блока, а посев приходит с состоянием. До первого вида сцена всё
   * равно не рисуется.
   */
  let sky: Sky | null = null;

  /**
   * Звук создаётся вместе со сценой, но заговорит только после первого действия
   * человека: браузер не даёт запустить контекст раньше. Отсутствие Web Audio
   * — не ошибка, а тихий заезд.
   */
  const audio = createRaceAudio(!soundWanted());

  /** Чёрные полосы от сорванных шин: их кладёт кадр, а чернит физика шины. */
  const marks = createTireMarks(scene);
  /**
   * Пыль из-под колёс. Она принадлежит колесу, а не воздуху вообще: сколько её —
   * решает `dust.ts`, рисует облако `plume.ts`.
   */
  const plume = createPlume(scene);

  /**
   * Цвет земли теперь в текстурах, поэтому множитель материала белый. Тайлы — в
   * метрах: развёртка идёт по мировым координатам, и масштаб плитки — единственное,
   * что задаёт её размер на земле.
   */
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
  const groundMat = textured("race-ground", grassSurface(scene));
  // Обочина — не трава: полоса гравия у кромки видна и без разметки, а на скорости
  // именно по ней читается, где кончается асфальт.
  const shoulderMat = textured("race-shoulder", gravelSurface(scene));
  const roadMat = textured("race-road", asphaltSurface(scene));
  const edgeMat = flat("#e9eef2", scene);
  const postMat = flat("#f0883e", scene, true);

  let road: Mesh | null = null;
  let groundLeft: Mesh | null = null;
  let groundRight: Mesh | null = null;
  let shoulderLeft: Mesh | null = null;
  let shoulderRight: Mesh | null = null;
  let edgeLeft: Mesh | null = null;
  let edgeRight: Mesh | null = null;

  const postMaster = MeshBuilder.CreateBox("race-post-master", { width: 0.3, height: 1.2, depth: 0.3 }, scene);
  const posts: Mesh[] = [];
  for (let i = 0; i < POSTS; i++) {
    const post = postMaster.clone(`race-post-${i}`);
    post.material = postMat;
    posts.push(post);
  }
  postMaster.dispose();

  /** Машина едет вместе с кодом сцены: сетка лежит в бандле, ждать нечего. */
  const carRoot = new TransformNode("race-car", scene);
  carRoot.rotationQuaternion = Quaternion.Identity();
  const model: CarModel = createCarModel(scene);
  model.body.parent = carRoot;
  const wheelNodes: TransformNode[] = model.wheels;

  let line = new Centerline(0);
  let lineSeed = Number.NaN;
  let builtSegment = Number.NaN;
  let builtStamps = 0;
  let camPos = new Vector3(0, 6, -14);
  let camReady = false;
  let disposed = false;
  /** Последний известный вид: кадр рисуется по нему, а не по шагу ядра. */
  let latest: RaceView | null = null;
  /** Часы кадра: смешивают два последних состояния физики по её же времени. */
  const playout = new Playout<SimFrame>();
  /** Наигранное время блока в секундах: по нему плывут облака. */
  let playedS = 0;
  /** Время ветра: идёт по кадрам, а не по заезду, и на паузе лес не замирает. */
  let windS = 0;
  let shown: SimFrame | null = null;
  /** Лес приезжает отдельным файлом: до него сцена работает без деревьев. */
  let field: TreeField | null = null;
  const spots: TreeSpot[] = [];
  /** Порода по имени в номер варианта: расстановка знает породы, а не индексы. */
  const speciesIndex = new Map<string, number>();

  /**
   * Кто отбрасывает тень. Список пересобирается при каждой смене неба: солнце у
   * каждого заезда своё, а карта теней принадлежит именно ему и умирает вместе с
   * ним. Лес приезжает отдельным файлом и может успеть и до, и после неба —
   * поэтому вызывается с обеих сторон, а повторная запись безвредна.
   */
  function castShadows(now: Sky): void {
    for (const mesh of field?.meshes ?? []) now.shadows.cast(mesh);
    // Список от самой модели, а не обход детей узла: колёса в иерархию кузова не
    // входят — их ставит подвеска, — и обходом они не находились. Машина роняла на
    // дорогу силуэт без колёс и оттого читалась висящей над ней.
    for (const mesh of model.meshes) now.shadows.cast(mesh);
    for (const post of posts) now.shadows.cast(post);
  }

  /** Точки окна геометрии: мелкий шаг, абсолютные номера, один мир на весь заезд. */
  function windowPoints(fromSegment: number): FinePoint[] {
    const out: FinePoint[] = [];
    const from = fromSegment * FINE_PER_SEGMENT;
    for (let i = 0; i <= WINDOW * FINE_PER_SEGMENT; i++) out.push(line.at(from + i));
    return out;
  }

  function rebuild(fromSegment: number): void {
    builtSegment = fromSegment;
    const points = windowPoints(fromSegment);
    // Земля по сторонам идёт лентой в пять дорожек: даль, гребень вала, трава,
    // дно кювета, кромка гравия. Дорожек стало больше именно ради кювета — по
    // трём точкам обочина получается плоскостью, а плоская обочина и читалась
    // газоном при коттедже.
    const lanes = LANES.map(() => [] as Vector3[]);
    const edgeOuterL: Vector3[] = [];
    const edgeInnerL: Vector3[] = [];
    const edgeInnerR: Vector3[] = [];
    const edgeOuterR: Vector3[] = [];
    for (const point of points) {
      const cuts = crossSection(point.halfWidth, point.verge);
      const apron = apronWidth(point.halfWidth, point.curvature);
      const at = (lateral: number, dy: number, into: Vector3[]) => {
        const p = lateralOffset(point, lateral);
        into.push(new Vector3(p.x, p.y + dy, p.z));
      };
      for (let i = 0; i < LANES.length; i++) {
        const lane = LANES[i]!;
        const cut = cuts[lane.cut]!;
        at(lane.apron ? apron * lane.apron : cut.lateral, cut.dy, lanes[i]!);
      }
      at(-point.halfWidth, 0.02, edgeOuterL);
      at(-point.halfWidth + 0.35, 0.02, edgeInnerL);
      at(point.halfWidth - 0.35, 0.02, edgeInnerR);
      at(point.halfWidth, 0.02, edgeOuterR);
    }
    const lane = (name: string): Vector3[] => lanes[LANES.findIndex((l) => l.name === name)]!;
    const [originX, originZ] = uvOrigin(points[0]!.x, points[0]!.z);
    const ribbon = (name: string, paths: Vector3[][], previous: Mesh | null, material: StandardMaterial): Mesh => {
      const mesh = MeshBuilder.CreateRibbon(name, { pathArray: paths, updatable: true, instance: previous ?? undefined }, scene);
      mesh.material = material;
      mesh.receiveShadows = true;
      if (material.diffuseTexture) applyWorldUv(mesh, originX, originZ);
      return mesh;
    };
    groundLeft = ribbon(
      "race-ground-l",
      [lane("apronL"), lane("bermL"), lane("grassL"), lane("ditchL"), lane("gravelL")],
      groundLeft,
      groundMat,
    );
    groundRight = ribbon(
      "race-ground-r",
      [lane("gravelR"), lane("ditchR"), lane("grassR"), lane("bermR"), lane("apronR")],
      groundRight,
      groundMat,
    );
    shoulderLeft = ribbon("race-shoulder-l", [lane("gravelL"), lane("roadL")], shoulderLeft, shoulderMat);
    shoulderRight = ribbon("race-shoulder-r", [lane("roadR"), lane("gravelR")], shoulderRight, shoulderMat);
    road = ribbon("race-road", [lane("roadL"), lane("roadR")], road, roadMat);
    edgeLeft = ribbon("race-edge-l", [edgeOuterL, edgeInnerL], edgeLeft, edgeMat);
    edgeRight = ribbon("race-edge-r", [edgeInnerR, edgeOuterR], edgeRight, edgeMat);

    placePosts(fromSegment);
    placeTrees(fromSegment);
  }

  function placePosts(fromSegment: number): void {
    // Место столба — функция номера сегмента, а не номера в окне: иначе весь ряд
    // съезжает вдоль трассы при каждом перестроении, и это читается как сброс вида.
    const first = Math.ceil(fromSegment / POST_EVERY) * POST_EVERY;
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i]!;
      const index = first + i * POST_EVERY;
      if (index > fromSegment + WINDOW) {
        post.setEnabled(false);
        continue;
      }
      post.setEnabled(true);
      const point = line.at(index * FINE_PER_SEGMENT);
      const side = (index / POST_EVERY) % 2 === 0 ? 1 : -1;
      const p = lateralOffset(point, (point.halfWidth + 1.4) * side);
      post.position.set(p.x, p.y + 0.6, p.z);
      post.rotation.y = point.h;
    }
  }

  /** Лес считает `plant.ts`: сцена только отдаёт ему окно и породы, какие загрузились. */
  function placeTrees(fromSegment: number): void {
    if (!field) return;
    plantTrees(spots, line, lineSeed, fromSegment, fromSegment + BEHIND + TREE_AHEAD, (id) => speciesIndex.get(id));
    field.place(spots);
  }

  /**
   * Машина на старте, пока физика не сделала ни шага: мегабайт WASM едет по сети
   * секунду-другую, и всё это время в кадре была пустая дорога. Стоящая машина
   * считается из той же осевой линии, что и всё остальное, поэтому первый кадр
   * физики её не дёргает — он попадает туда же, где она уже стоит.
   */
  function restingFrame(view: RaceView): SimFrame {
    const point = line.atDistance(view.distanceM);
    const half = point.h / 2;
    return {
      // Физика ещё не жила: время нулевое, и первый настоящий кадр придёт позже
      // него, то есть встанет в пару к этому, а не отбросит его как из прошлого.
      t: 0,
      x: point.x,
      y: point.y + RIDE_HEIGHT_M,
      z: point.z,
      qx: 0,
      qy: Math.sin(half),
      qz: 0,
      qw: Math.cos(half),
      speedMs: 0,
      driveSpeedMs: 0,
      s: view.distanceM,
      lateral: 0,
      groundY: point.y,
      upright: 1,
      wheels: [0, 1, 2, 3].map(() => ({
        suspension: SUSPENSION_LOADED_M,
        steer: 0,
        spin: 0,
        contact: true,
        loadN: (MASS_KG * 9.81) / 4,
        slide: 0,
        tempC: TIRE_COLD_C,
        surface: "asphalt" as const,
        mark: 0,
        atX: point.x,
        atY: point.y,
        atZ: point.z,
        sideX: Math.cos(point.h),
        sideZ: -Math.sin(point.h),
      })),
    };
  }

  /** Машина ставится по кузову из физики, колёса — по ходу подвески и рулю. */
  function placeCar(frame: SimFrame): void {
    const q = new Quaternion(frame.qx, frame.qy, frame.qz, frame.qw);
    const centre = new Vector3(frame.x, frame.y, frame.z);
    const down = new Vector3(0, -RIDE_HEIGHT_M, 0);
    carRoot.rotationQuaternion = q;
    carRoot.position.copyFrom(centre.add(down.rotateByQuaternionToRef(q, new Vector3())));
    for (let i = 0; i < wheelNodes.length; i++) {
      const wheel = frame.wheels[i];
      const mount = WHEEL_MOUNTS[i];
      if (!wheel || !mount) continue;
      const local = new Vector3(mount[0], mount[1] - wheel.suspension, mount[2]);
      wheelNodes[i]!.position.copyFrom(centre.add(local.rotateByQuaternionToRef(q, new Vector3())));
      wheelNodes[i]!.rotationQuaternion = q
        .multiply(Quaternion.RotationAxis(new Vector3(0, 1, 0), wheel.steer))
        .multiply(Quaternion.RotationAxis(new Vector3(1, 0, 0), wheel.spin));
    }
  }

  /**
   * Камера. Считается не на шаге ядра, а на кадре, и сглаживание идёт по времени, а
   * не по числу вызовов: иначе на разной частоте кадров получается разная плавность.
   */
  function aimCamera(view: RaceView, frame: SimFrame, dtS: number): void {
    const distanceM = frame.s;
    /**
     * Камера идёт по осевой линии, а не за кузовом: она повторяет и кривизну, и
     * уклон дороги, и поэтому на спуске смотрит на дорогу, а не в небо. За крен и
     * рысканье кузова она не идёт вовсе: трясти кадр физикой — верный способ
     * укачать участника за сорок минут. Поперёк же камера держится за машину, и
     * прицел смещён на столько же: машина всегда в кадре, где бы она ни оказалась.
     */
    const follow = cameraFollow(frame.lateral, view.halfWidth);
    // Позади нуля дорога тоже есть (`FINE_ORIGIN`), и это важно: с ограничением
    // снизу камера на старте садилась ровно в машину, и первые метры в кадре была
    // пустая дорога, пока машина не отъедет от камеры.
    const behind = line.atDistance(distanceM - CAM_BACK_M);
    const behindAt = lateralOffset(behind, follow);
    const wanted = new Vector3(behindAt.x, behindAt.y + CAM_UP_M, behindAt.z);
    const smoothing = 1 - Math.exp(-dtS / CAM_SMOOTH_S);
    camPos = camReady ? Vector3.Lerp(camPos, wanted, smoothing) : wanted;
    camReady = true;
    camera.position.copyFrom(camPos);

    // Прицел — смесь точки на дороге впереди и направления самой машины. Чистая
    // точка на дороге в вираже уносит машину к краю кадра.
    const point = line.atDistance(distanceM);
    const here = lateralOffset(point, follow);
    const lookAheadM = 20 + Math.min(16, view.speedKmh / 6);
    const aheadPoint = line.atDistance(distanceM + lookAheadM);
    const aheadAt = lateralOffset(aheadPoint, follow);
    const ahead = new Vector3(aheadAt.x, aheadAt.y, aheadAt.z);
    const straight = new Vector3(here.x, here.y, here.z).add(
      new Vector3(Math.sin(point.h), 0, Math.cos(point.h)).scale(lookAheadM),
    );
    camera.setTarget(Vector3.Lerp(straight, ahead, 0.6).add(new Vector3(0, 1.6, 0)));
  }

  function update(view: RaceView): void {
    if (view.seed !== lineSeed) {
      line = new Centerline(view.seed);
      lineSeed = view.seed;
      builtSegment = Number.NaN;
      builtStamps = 0;
      // Погода — от посева блока: у каждого заезда своя высота солнца, своя мутность
      // воздуха и своя облачность.
      sky?.dispose();
      sky = createSky(scene, view.seed);
      field?.setWind(sky.weather.wind, sky.weather.windRad);
      castShadows(sky);
      // Новый заезд — новая дорога: следы от прошлой висели бы в пустоте.
      marks.clear();
      plume.clear();
    }
    if (view.stamps.length !== builtStamps) {
      line.applyStamps(view.stamps);
      builtStamps = view.stamps.length;
      builtSegment = Number.NaN;
    }
    // Перестроение раз в сегмент, то есть каждые десять метров: обстановка и
    // полотно едут вместе с машиной непрерывно. Раньше окно двигалось партиями по
    // сто двадцать метров, и партия деревьев появлялась в одном кадре — это и был
    // «периодический ререндер».
    const from = segmentIndexAt(view.distanceM) - BEHIND;
    if (from !== builtSegment) {
      rebuild(from);
      line.trim(Math.max(0, (from - 2) * FINE_PER_SEGMENT));
    }

    playedS = view.progress.playedMs / 1000;
    latest = view;
    const frame = view.frame ?? restingFrame(view);
    playout.arrive(frame, frame.t);
  }

  /**
   * Кадр рисуется по кадровому таймеру браузера, а не на шаге ядра, и показывает
   * не последнее состояние, а промежуточное между двумя последними.
   *
   * Причина обе разом: и шаг ядра идёт от таймера в шестнадцать миллисекунд, и сама
   * физика подвигается только целыми шагами в одну шестидесятую. Обновление экрана
   * при этом идёт своим темпом, поэтому на кадр приходилось то два шага, то ни
   * одного, и машина ехала лестницей — то самое дрожание раз в секунду, при том что
   * физика гладкая до четвёртого знака. Задержка от смешивания — один шаг ядра,
   * шестнадцать миллисекунд, и её никто не замечает; лестницу замечают все.
   *
   * Плата за кадровый таймер ровно одна: в неактивной вкладке он замолкает, и
   * картинка замирает на последнем кадре. Смотреть на неё там всё равно некому, а
   * приборы и журнал живут своим темпом в ядре.
   */
  function drawFrame(dt?: number): void {
    if (disposed || !latest) return;
    const dtS = dt ?? Math.min(engine.getDeltaTime() / 1000, 0.1);
    const blend = playout.at(dtS);
    if (!blend) return;
    const frame = blend.alpha <= 0 ? blend.from : mixFrames(blend.from, blend.to, blend.alpha);
    // Дальше по кадру время берётся сглаженное, а не измеренное: измеренное
    // шумит на пятую часть, и камера с ветром внесли бы этот шум обратно в
    // картинку, из которой его только что убрали часы (`playout.ts`).
    const paceS = playout.pace() || dtS;
    shown = frame;
    placeCar(frame);
    // След кладётся по показанному кадру, а не по последнему шагу физики: он
    // обязан лежать ровно под тем колесом, которое видно, иначе на скорости
    // лента отстаёт от машины на полметра.
    marks.lay(frame.wheels);
    // Пыль — оттуда же, откуда след: от пятна контакта показанного кадра. Курс
    // берётся у кузова, чтобы облако летело назад по ходу, а не куда попало.
    plume.raise(frame.wheels, frame.speedMs, ...heading(frame));
    // Свет — на кадре, а не на шаге ядра: поворотник мигает по своим часам, и на
    // шестнадцатимиллисекундной сетке ядра его фаза дёргалась бы.
    model.setLights({ brake: latest.braking, turn: latest.steer, timeS: windS });
    aimCamera(latest, frame, paceS);
    sky?.drift(playedS);
    // Лес качается по своим часам, а не по времени заезда: на паузе ветер стихать
    // не должен, иначе пауза читается стоп-кадром.
    windS += paceS;
    field?.animate(windS);
    // Звук — от показанного кадра, а не от последнего вида: слышно должно быть
    // ровно то, что видно, иначе визг придёт раньше, чем машину развернёт.
    audio?.update(
      {
        rpm: latest.rpm,
        rpmMax: latest.rpmMax,
        throttle: latest.throttle,
        speedMs: frame.speedMs,
        wheels: frame.wheels,
      },
      paceS,
    );
    scene.render();
  }

  /**
   * Ожидание машины. Опрос по таймеру, а не по кадру: сам вопрос «готова ли
   * сетка» и запускает компиляцию её шейдера, поэтому ответа можно дождаться, ни
   * разу не нарисовав сцену. Привязка к кадру была бы хуже незаметно: в неактивной
   * вкладке кадров нет вовсе, и заезд там не начался бы никогда.
   *
   * Срок ожидания ограничен: неготовая машина — повод показать заезд без неё, а
   * не повод не показать заезд. Пустая дорога хотя бы едет.
   */
  const carShown = new Promise<void>((resolve) => {
    const deadline = Date.now() + 8000;
    const check = (): void => {
      if (disposed || Date.now() > deadline || model.meshes.every((mesh) => mesh.isReady(true))) resolve();
      else setTimeout(check, 16);
    };
    check();
  });

  engine.runRenderLoop(drawFrame);

  // Лес приезжает отдельным файлом и заезд не задерживает: сцена показывается
  // сразу, а деревья появляются, когда придут.
  void loadTreeField(scene)
    .then((loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      field = loaded;
      if (sky) {
        loaded.setWind(sky.weather.wind, sky.weather.windRad);
        castShadows(sky);
      }
      loaded.variants.forEach((id, index) => speciesIndex.set(id, index));
      if (Number.isFinite(builtSegment)) placeTrees(builtSegment);
    })
    .catch((error) => console.warn("race: лес не загрузился", error));

  (globalThis as unknown as { __race: unknown }).__race = {
    scene,
    camera,
    line: () => line,
    view: () => latest,
    frame: () => shown,
    sound: () => audio?.probe() ?? null,
    step: drawFrame,
  };

  return {
    update,
    whenReady: () => carShown,
    resize: () => engine.resize(),
    toggleSound: () => {
      if (!audio) return false;
      const on = audio.muted();
      audio.setMuted(!on);
      rememberSound(on);
      return on;
    },
    soundOn: () => !(audio?.muted() ?? true),
    dispose: () => {
      disposed = true;
      engine.stopRenderLoop();
      audio?.dispose();
      marks.dispose();
      plume.dispose();
      sky?.dispose();
      field?.dispose();
      model.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}
