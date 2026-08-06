import { Material } from "@babylonjs/core/Materials/material.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
// Побочный импорт: без него у Mesh нет тонких экземпляров.
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import type { Wind } from "@gamespace/env";
import { LeafGlowPlugin } from "./foliage.js";
import { WindPlugin, SWAY_KIND, PIVOT_KIND } from "./wind.js";
import { LEAF_VERTS, leafPivots } from "./sway.js";
import birchBarkUrl from "./assets/bark-birch.jpg";
import oakBarkUrl from "./assets/bark-oak.jpg";
import pineBarkUrl from "./assets/bark-pine.jpg";
import aspenLeafUrl from "./assets/leaf-aspen.png";
import ashLeafUrl from "./assets/leaf-ash.png";
import oakLeafUrl from "./assets/leaf-oak.png";
import pineLeafUrl from "./assets/leaf-pine.png";
import aspenBumpUrl from "./assets/leaf-aspen-bump.png";
import ashBumpUrl from "./assets/leaf-ash-bump.png";
import oakBumpUrl from "./assets/leaf-oak-bump.png";
import pineBumpUrl from "./assets/leaf-pine-bump.png";
import treesUrl from "./assets/trees.json?url";

/**
 * Деревья пришли из ez-tree, но не как библиотека, а как испечённая геометрия:
 * ez-tree — генератор на Three.js, сцена у нас на Babylon, и сборка ez-tree весит
 * четыре мегабайта из-за вшитых текстур. Дерево же — это массив вершин, и
 * генератор нужен один раз, на машине разработчика (`tools/bake-trees.mjs`).
 *
 * Рисуются они тонкими экземплярами: два вызова отрисовки на вариант вместо
 * одного на дерево. Матрицы лежат в одном буфере на вариант, ветви и листва
 * делят его, потому что это одно и то же дерево.
 */

/**
 * Экземпляров одного строения в окне: с запасом к тому, что расставляет сцена.
 * Запас нужен не ради красоты — доли пород в лесу неровные, и на подрост с кустом
 * приходится больше трети всех деревьев. Переполнение слота выглядит как дыра в
 * лесу, а стоит слот шестнадцать чисел матрицы, то есть ничего.
 */
const CAPACITY = 72;

/**
 * Сколько света лист пропускает насквозь. Настоящий лист пропускает около десятой
 * доли, но у нас на квадах не лист, а пучок в несколько слоёв, и меряем мы не его
 * прозрачность, а то, насколько теневая сторона кроны светлее чёрного. Треть —
 * граница, за которой крона перестаёт быть телом и становится ровным фонарём.
 */
const LEAF_THROUGH = 0.32;

interface PackedPart {
  scale: number;
  vertexCount: number;
  triangles: number;
  positions: string;
  /** Развёртка коры: по байту на вершину, старший бит — вдоль ветки. */
  uv?: string;
  indices?: string;
}

interface PackedVariant {
  id: string;
  /** Порода: строений на неё бывает несколько, и все они — одно дерево в лесу. */
  species: string;
  /** Какой картинкой листва: у хвои и у широкого листа общего только прозрачность. */
  leaf: string;
  /** Какой корой ствол: белой берёзовой, бурой дубовой, рыжей сосновой. */
  bark: string;
  baseY: number;
  height: number;
  branches: PackedPart;
  leaves: PackedPart;
}

interface TreesAsset {
  variants: PackedVariant[];
  leafUv: number[];
}

/** Место дерева в мире: где его посадить — решает тот, кто сажает. */
export interface TreeSpot {
  x: number;
  y: number;
  z: number;
  /** Поворот вокруг вертикали: одинаковые деревья не должны читаться копиями. */
  rotationY: number;
  /** Высота в метрах: пресеты ez-tree ростом в десятки метров, их нормируем. */
  heightM: number;
  /**
   * Раскидистость: во сколько раз дерево шире своей нормальной пропорции. Одна
   * высота на всё делает из вариантов линейку одинаковых силуэтов, а лес — это в
   * первую очередь разные силуэты.
   */
  spread: number;
  /** Наклон ствола от вертикали, радианы: ровных деревьев в природе не бывает. */
  lean: number;
  /** Номер варианта; лишнее по модулю числа вариантов. */
  variant: number;
}

export interface TreeField {
  /** Породы в том порядке, в каком их нумерует расстановка. */
  variants: readonly string[];
  /** Все сетки леса: сцене они нужны, чтобы записать их в отбрасывающие тень. */
  meshes: readonly Mesh[];
  place(spots: readonly TreeSpot[]): void;
  /**
   * Качание по ветру, который дует в мире прямо сейчас.
   *
   * Ветра лес не придумывает: и силу, и сторону, и фазу бегущей волны считает
   * среда (`@gamespace/env`). Раньше половина ветра была здесь — порывы и ход
   * волны жили в лесу, — и из этого выходило, что мир не мог сказать, дует ли,
   * спросить можно было только у деревьев. Лесу остаётся его собственное дело:
   * во сколько ему обходится единица ветра.
   */
  animate(wind: Wind): void;
  dispose(): void;
}

function bytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Позиции распаковываются сразу в нормированный вид: основание ствола в нуле,
 * высота единица. Тогда масштаб в матрице экземпляра — это прямо высота дерева
 * в метрах, и ни сцене, ни расстановке не надо знать про единицы ez-tree.
 */
function positionsOf(part: PackedPart, variant: PackedVariant): Float32Array {
  const packed = bytes(part.positions);
  const quantized = new Int16Array(packed.buffer, 0, packed.byteLength / 2);
  const out = new Float32Array(quantized.length);
  const k = part.scale / variant.height;
  const shift = variant.baseY / variant.height;
  for (let i = 0; i < quantized.length; i += 3) {
    out[i] = quantized[i]! * k;
    out[i + 1] = quantized[i + 1]! * k - shift;
    out[i + 2] = quantized[i + 2]! * k;
  }
  return out;
}

/**
 * Вес качания на вершину — то есть податливость этого места ветру.
 *
 * Первая версия считала вес одной высотой, и получалось ровно то, за что дереву и
 * прилетело: качался ствол, а листва ехала на нём как приклеенная. В жизни всё
 * наоборот. Ветер давит на листья — только у них есть площадь, — листья тянут
 * прутья, прутья гнут ветки, и до ствола доходит остаток. Значит и в весе главное
 * не высота, а удалённость от ствола: у комля дерево держит корень, у оси —
 * толщина, и подвижно только то, что торчит наружу.
 *
 * Толщины ветки в вершине нет, но её хорошо заменяет вылет от оси дерева,
 * отнесённый к ширине кроны: у ствола он около нуля, у крайнего прутика — единица.
 * Высота остаётся вторым множителем, иначе нижние сучья гуляли бы как верхушка.
 */
const SWAY_TRUNK = 0.12;

function swayWeights(positions: Float32Array, leaf: boolean): Float32Array {
  const count = positions.length / 3;
  let widest = 1e-3;
  for (let i = 0; i < count; i++) {
    widest = Math.max(widest, Math.hypot(positions[i * 3]!, positions[i * 3 + 2]!));
  }
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const y = Math.max(0, Math.min(1.2, positions[i * 3 + 1]!));
    const reach = Math.min(1, Math.hypot(positions[i * 3]!, positions[i * 3 + 2]!) / widest);
    // Плавный набор к краю кроны: линейный вылет собирает почти всё качание в
    // последней трети, и крона ходит рваным краем при неподвижной середине.
    const spread = SWAY_TRUNK + (1 - SWAY_TRUNK) * reach * (2 - reach);
    // Лист сидит на конце прута и ходит шире него: прут его ведёт, но своей
    // площадью лист добирает ещё столько же.
    out[i] = y * y * spread * (leaf ? 1.45 : 1);
  }
  return out;
}

function branchData(part: PackedPart, variant: PackedVariant): VertexData {
  const packed = bytes(part.indices!);
  const indices = new Uint16Array(packed.buffer, 0, packed.byteLength / 2);
  const data = new VertexData();
  data.positions = positionsOf(part, variant);
  data.indices = Array.from(indices);
  const normals: number[] = [];
  VertexData.ComputeNormals(data.positions, data.indices, normals);
  data.normals = normals;
  // Развёртка коры лежит по байту на вершину: младшие семь бит — доля оборота
  // вокруг ветки, старший — какое из двух соседних сечений. Раскладка описана в
  // печати (`tools/bake-trees.mjs`), здесь она только распаковывается.
  const uvBytes = bytes(part.uv!);
  const uvs = new Float32Array(part.vertexCount * 2);
  for (let i = 0; i < part.vertexCount; i++) {
    uvs[i * 2] = (uvBytes[i]! & 0x7f) / 127;
    uvs[i * 2 + 1] = uvBytes[i]! >> 7;
  }
  data.uvs = Array.from(uvs);
  return data;
}

/**
 * Листва — набор вееров по пять вершин, поэтому UV и индексы восстанавливаются
 * узором, а не читаются из файла: хранить арифметическую прогрессию значило бы
 * платить за неё сто с лишним килобайт. Узор задаёт печать, а не эта функция.
 */
function leafData(part: PackedPart, variant: PackedVariant, leafUv: number[]): VertexData {
  const positions = positionsOf(part, variant);
  const leaves = part.vertexCount / LEAF_VERTS;
  const uvs = new Float32Array(part.vertexCount * 2);
  const indices: number[] = [];
  for (let leaf = 0; leaf < leaves; leaf++) {
    for (let i = 0; i < LEAF_VERTS * 2; i++) uvs[leaf * LEAF_VERTS * 2 + i] = leafUv[i]!;
    const base = leaf * LEAF_VERTS;
    for (let i = 0; i < 4; i++) indices.push(base + i, base + ((i + 1) % 4), base + 4);
  }
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = Array.from(uvs);
  data.normals = Array.from(canopyNormals(positions, leaves));
  data.colors = Array.from(canopyShade(positions, leaves));
  return data;
}

/**
 * Затенение кроны и разнобой листа — два множителя цвета, оба в вершинах.
 *
 * Затенение: внутрь кроны свет не проходит, и настоящее дерево там почти чёрное. У
 * нас же каждый лист освещён так, будто вокруг него пусто, и крона выходит ровной
 * зелёной массой без глубины — тот самый вид пластмассы, за который к деревьям и
 * претензии. Честное решение — считать проходимость света, дешёвое и почти
 * неотличимое — взять глубину листа в кроне: чем ближе лист к середине, тем темнее.
 *
 * Разнобой: настоящая крона состоит из листьев разного возраста и разного поворота к
 * солнцу, поэтому в ней нет двух одинаковых пятен. Множитель на лист — те же
 * несколько процентов яркости и чуть жёлтого, и крона перестаёт быть заливкой.
 */
function canopyShade(positions: Float32Array, leaves: number): Float32Array {
  const count = leaves * LEAF_VERTS;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let v = 0; v < count; v++) {
    cx += positions[v * 3]!;
    cy += positions[v * 3 + 1]!;
    cz += positions[v * 3 + 2]!;
  }
  cx /= count;
  cy /= count;
  cz /= count;

  let far = 1e-4;
  const radii = new Float32Array(leaves);
  for (let leaf = 0; leaf < leaves; leaf++) {
    // Середина листа лежит пятой вершиной: считать её заново по углам незачем.
    const mid = (leaf * LEAF_VERTS + 4) * 3;
    const r = Math.hypot(positions[mid]! - cx, positions[mid + 1]! - cy, positions[mid + 2]! - cz);
    radii[leaf] = r;
    far = Math.max(far, r);
  }

  const colors = new Float32Array(count * 4);
  for (let leaf = 0; leaf < leaves; leaf++) {
    const depth = radii[leaf]! / far;
    // Верхняя граница ниже единицы: солнце и небо вместе дают на листе больше
    // единицы, и без запаса самые освещённые пучки выгорают в белый.
    const shade = 0.42 + 0.46 * Math.sqrt(depth);
    // Разнобой берётся от места листа, а не от счётчика: тогда он не меняется от
    // печати к печати и не зависит от порядка вершин.
    const base = leaf * LEAF_VERTS;
    const jitter = Math.abs(Math.sin(positions[base * 3]! * 91.7 + positions[base * 3 + 2]! * 47.3)) - 0.5;
    // Яркость соседних пучков разводится ощутимо, а не на проценты. Пучки в кроне
    // стоят вплотную, и одинаково светлые сливаются в одно пятно — ту самую
    // плоскую зону, за которую крону и ругают. Настоящая крона так не выглядит
    // никогда: один пучок в тени соседнего, другой на просвет, третий с изнанки.
    const tone = 1 + jitter * 0.34;
    const r = shade * tone * (1 + jitter * 0.09);
    const g = shade * tone * (1 + jitter * 0.05);
    const b = shade * tone * (1 - jitter * 0.07);
    for (let i = 0; i < LEAF_VERTS; i++) {
      colors[(base + i) * 4] = r;
      colors[(base + i) * 4 + 1] = g;
      colors[(base + i) * 4 + 2] = b;
      colors[(base + i) * 4 + 3] = 1;
    }
  }
  return colors;
}

/**
 * Нормали кроны, а не листа. Это главное, что отличает лес от вороха мусора в
 * воздухе, и объяснение простое: настоящая нормаль плоского квада смотрит туда,
 * куда его повернул генератор, поэтому каждый лист освещается сам по себе. Крона
 * из таких листьев — россыпь независимо горящих чешуек: половина к солнцу и
 * пересвечена, половина от солнца и черна, объёма нет ни на одном кадре.
 *
 * Живая крона освещается как шар: снаружи светлее, изнутри темнее. Поэтому нормаль
 * листа берётся от середины кроны к самому листу, с примесью настоящей нормали
 * поверхности — чтобы соседние листья всё же отличались и крона не стала гладким
 * шаром.
 *
 * Настоящая нормаль здесь и правда настоящая. Лист теперь не квад, а веер из
 * четырёх граней вокруг поднятой середины (`domeLeaves` в печати), и у каждой
 * грани своя нормаль, расходящаяся с соседней на десятки градусов. Вершине
 * достаётся среднее по граням, которые в ней сходятся: у угла их две, у середины
 * все четыре. Раньше на этом месте была подделка — нормали разводили веером от
 * середины к углам, потому что разводить было нечего: поверхность-то была одна и
 * плоская. Подделка убирала ровную заливку, но свет по карточке всё равно шёл
 * линейно, и горсть листьев загоралась разом. Теперь не загорается.
 */
function canopyNormals(positions: Float32Array, leaves: number): Float32Array {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const count = leaves * LEAF_VERTS;
  for (let v = 0; v < count; v++) {
    cx += positions[v * 3]!;
    cy += positions[v * 3 + 1]!;
    cz += positions[v * 3 + 2]!;
  }
  cx /= count;
  cy /= count;
  cz /= count;

  const normals = new Float32Array(count * 3);
  const facet = new Float32Array(12);
  for (let leaf = 0; leaf < leaves; leaf++) {
    const base = leaf * LEAF_VERTS;
    const mid = (base + 4) * 3;
    const lx = positions[mid]!;
    const ly = positions[mid + 1]!;
    const lz = positions[mid + 2]!;

    // Нормаль купола в целом: по диагоналям между углами. От неё гранями и
    // отсчитывается сторона, иначе половина граней светилась бы изнанкой.
    const d1x = positions[(base + 2) * 3]! - positions[base * 3]!;
    const d1y = positions[(base + 2) * 3 + 1]! - positions[base * 3 + 1]!;
    const d1z = positions[(base + 2) * 3 + 2]! - positions[base * 3 + 2]!;
    const d2x = positions[(base + 3) * 3]! - positions[(base + 1) * 3]!;
    const d2y = positions[(base + 3) * 3 + 1]! - positions[(base + 1) * 3 + 1]!;
    const d2z = positions[(base + 3) * 3 + 2]! - positions[(base + 1) * 3 + 2]!;
    let fx = d1y * d2z - d1z * d2y;
    let fy = d1z * d2x - d1x * d2z;
    let fz = d1x * d2y - d1y * d2x;
    const flen = Math.hypot(fx, fy, fz) || 1;
    fx /= flen;
    fy /= flen;
    fz /= flen;

    for (let i = 0; i < 4; i++) {
      const a = (base + i) * 3;
      const b = (base + ((i + 1) % 4)) * 3;
      const ux = positions[b]! - positions[a]!;
      const uy = positions[b + 1]! - positions[a + 1]!;
      const uz = positions[b + 2]! - positions[a + 2]!;
      const wx = lx - positions[a]!;
      const wy = ly - positions[a + 1]!;
      const wz = lz - positions[a + 2]!;
      let gx = uy * wz - uz * wy;
      let gy = uz * wx - ux * wz;
      let gz = ux * wy - uy * wx;
      const glen = Math.hypot(gx, gy, gz);
      // Вырожденная грань бывает: генератор изредка выдаёт лист-иглу нулевой ширины.
      if (glen < 1e-9) {
        gx = fx;
        gy = fy;
        gz = fz;
      } else {
        gx /= glen;
        gy /= glen;
        gz /= glen;
        if (gx * fx + gy * fy + gz * fz < 0) {
          gx = -gx;
          gy = -gy;
          gz = -gz;
        }
      }
      facet[i * 3] = gx;
      facet[i * 3 + 1] = gy;
      facet[i * 3 + 2] = gz;
    }

    let ox = lx - cx;
    let oy = ly - cy;
    let oz = lz - cz;
    const olen = Math.hypot(ox, oy, oz);
    if (olen < 1e-4) {
      ox = fx;
      oy = fy;
      oz = fz;
    } else {
      ox /= olen;
      oy /= olen;
      oz /= olen;
    }

    for (let i = 0; i < LEAF_VERTS; i++) {
      const at = (base + i) * 3;
      // Углу достаются две грани, сходящиеся в нём; середине — все четыре.
      let sx = 0;
      let sy = 0;
      let sz = 0;
      if (i === 4) {
        for (let k = 0; k < 4; k++) {
          sx += facet[k * 3]!;
          sy += facet[k * 3 + 1]!;
          sz += facet[k * 3 + 2]!;
        }
      } else {
        for (const k of [(i + 3) % 4, i]) {
          sx += facet[k * 3]!;
          sy += facet[k * 3 + 1]!;
          sz += facet[k * 3 + 2]!;
        }
      }
      const slen = Math.hypot(sx, sy, sz) || 1;
      const bx = ox * CANOPY_W + (sx / slen) * FACE_W;
      const by = oy * CANOPY_W + (sy / slen) * FACE_W;
      const bz = oz * CANOPY_W + (sz / slen) * FACE_W;
      const blen = Math.hypot(bx, by, bz) || 1;
      normals[at] = bx / blen;
      normals[at + 1] = by / blen;
      normals[at + 2] = bz / blen;
    }
  }
  return normals;
}

/** Доля кроны в нормали листа: она и делает крону шаром, а не россыпью чешуек. */
const CANOPY_W = 0.62;
/**
 * Доля собственной нормали поверхности. Больше прежней вдвое — и это не подкрутка
 * вкуса: раньше здесь стояла выдуманная нормаль плоского квада, и давать ей вес
 * значило превращать крону в россыпь одинаково горящих чешуек. Теперь это нормаль
 * настоящей грани купола, и её вес работает ровно на то, ради чего он есть.
 */
const FACE_W = 0.34;

/**
 * Оттенок экземпляра: множитель цвета на всё дерево целиком, и кора, и листва.
 *
 * Породы у нас шесть, а деревьев в кадре под сотню, и без этого множителя каждая
 * шестая крона — точная копия по цвету. В лесу же двух одинаковых деревьев не
 * бывает: одно посветлее и желтее, другое темнее и холоднее. Разброс берётся от
 * места дерева, поэтому уехавшее назад и снова попавшее в окно дерево того же
 * цвета, что и было.
 *
 * По яркости разброс намеренно узкий, а по теплоте — нет. Пока теней не было,
 * яркость гуляла на четверть, и это читалось не разнообразием, а случайностью:
 * соседние деревья в одном свете отличались светлотой без всякой причины. Теперь
 * светлоту задаёт тень — своя, соседского дерева, кроны над головой, — и
 * подмешивать к ней ещё и случайную незачем. Остаётся то, что и правда своё у
 * каждого дерева: оттенок листвы.
 */
function tintOf(spot: TreeSpot, out: Float32Array, at: number): void {
  const roll = Math.abs(Math.sin(spot.x * 12.9898 + spot.z * 78.233)) % 1;
  const warm = Math.abs(Math.sin(spot.x * 41.7 + spot.z * 17.3)) % 1;
  const light = 0.93 + roll * 0.1;
  out[at] = light * (0.97 + warm * 0.07);
  out[at + 1] = light;
  out[at + 2] = light * (1.02 - warm * 0.08);
  out[at + 3] = 1;
}

/**
 * Кора и листва по породам.
 *
 * И то, и другое — оттенок поверх общей фактуры, а не сам цвет пикселя: картинок у
 * нас три на кору и четыре на листву, а пород восемь, и порода узнаётся именно
 * оттенком. Обе фактуры для этого приведены к нейтральному светлому: кора — тем,
 * что фотография коры и так почти серая, листва — обесцвечиванием при печати
 * (`tools/bake-trees.mjs`). Поэтому числа здесь читаются как настоящий цвет:
 * освещённая сторона кроны выйдет примерно такой, как записано.
 *
 * До обесцвечивания было иначе, и это стоило нам всей правдоподобности цвета: у
 * ez-tree листва уже покрашена, зелёный оттенок ложился на зелёную картинку,
 * произведение уходило вдвое темнее любого из сомножителей, и крона получалась
 * чёрно-оливковой. У осины картинка и вовсе осенняя, жёлто-бурая, — там зелёный
 * оттенок давал кислый хаки, и его носили три породы из восьми.
 *
 * Разница между породами держится тоном, а не яркостью: осина и берёза уходят в
 * жёлтый, ясень в чистый зелёный, дуб в оливковый, хвойные в холодный сине-зелёный.
 */
const TINTS: Record<string, { bark: string; leaf: string }> = {
  aspen: { bark: "#b6bba4", leaf: "#87a84e" },
  birch: { bark: "#e9e7de", leaf: "#90b155" },
  ash: { bark: "#a2937f", leaf: "#6e9542" },
  pine: { bark: "#b0865f", leaf: "#4c7c50" },
  spruce: { bark: "#8a7057", leaf: "#3f6c4b" },
  oak: { bark: "#9c8a72", leaf: "#719044" },
  sapling: { bark: "#cbc9b7", leaf: "#95b45a" },
  bush: { bark: "#8f8168", leaf: "#6d9143" },
};

/** Картинки листвы: по одной на породу листа, а не на вариант дерева. */
const LEAF_URLS: Record<string, string> = {
  aspen: aspenLeafUrl,
  ash: ashLeafUrl,
  oak: oakLeafUrl,
  pine: pineLeafUrl,
};

/** Рельеф пучка: по листу на нормаль, печётся вместе с картинкой листвы. */
const BUMP_URLS: Record<string, string> = {
  aspen: aspenBumpUrl,
  ash: ashBumpUrl,
  oak: oakBumpUrl,
  pine: pineBumpUrl,
};

/**
 * Насколько рельеф пучка вмешивается в свет.
 *
 * Единица — как нарисовано, то есть лист отворачивается от плоскости карточки до
 * сорока градусов, и это слишком: рельеф пересиливает нормаль кроны, крона теряет
 * светотень и становится ровным светлым пятном. Дело не только в силе наклона —
 * случайные нормали ещё и подсвечивают теневую сторону, потому что свет считается
 * по неотрицательному косинусу и разброс всегда играет в плюс. Треть оставляет
 * объём кроны за нормалью кроны, а рельефу — разницу между соседними листьями.
 */
const BUMP_LEVEL = 0.3;

/** Картинки коры: три фактуры на все породы, остальное делает оттенок. */
const BARK_URLS: Record<string, string> = {
  birch: birchBarkUrl,
  oak: oakBarkUrl,
  pine: pineBarkUrl,
};

/**
 * Сколько раз фактура коры укладывается вокруг ствола и вдоль одного сечения ветки.
 * Вдоль — два, потому что сечения у нас редкие: с одним укладом фотография
 * растягивается на несколько метров ствола и перестаёт читаться корой.
 */
const BARK_AROUND = 1;
const BARK_ALONG = 2;

function meshFor(
  name: string,
  data: VertexData,
  material: Material,
  buffers: { matrices: Float32Array; colors: Float32Array },
  sway: Float32Array,
  pivots: Float32Array | null,
  scene: Scene,
): Mesh {
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh);
  mesh.material = material;
  // Дерево не только роняет тень, но и принимает: тень соседнего дерева на кроне —
  // ровно то, что отличает лес от расставленных по траве отдельных деревьев.
  mesh.receiveShadows = true;
  // Отбор по объёму тут только мешает: объём считается по самой сетке, а стоят
  // деревья далеко от неё, и любая ошибка отбора видна как исчезающий лес.
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.isPickable = false;
  mesh.setVerticesData(SWAY_KIND, sway, false, 1);
  if (pivots) mesh.setVerticesData(PIVOT_KIND, pivots, false, 3);
  mesh.thinInstanceSetBuffer("matrix", buffers.matrices, 16, false);
  mesh.thinInstanceSetBuffer("color", buffers.colors, 4, false);
  mesh.thinInstanceCount = 0;
  return mesh;
}

/**
 * Грузит испечённые деревья и возвращает поле, которому сцена сообщает места.
 * Ассет тянется отдельным файлом, поэтому сцена показывается сразу, а лес
 * появляется, когда приедет: деревья — украшение, ждать их незачем.
 */
export async function loadTreeField(scene: Scene): Promise<TreeField> {
  const response = await fetch(treesUrl);
  if (!response.ok) throw new Error(`деревья не загрузились: ${response.status}`);
  const asset = (await response.json()) as TreesAsset;

  const barkTextures = new Map<string, Texture>();
  const barkTextureFor = (name: string): Texture => {
    const cached = barkTextures.get(name);
    if (cached) return cached;
    const texture = new Texture(BARK_URLS[name] ?? oakBarkUrl, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
    texture.uScale = BARK_AROUND;
    texture.vScale = BARK_ALONG;
    barkTextures.set(name, texture);
    return texture;
  };

  const leafTextures = new Map<string, Texture>();
  const leafTextureFor = (name: string): Texture => {
    const cached = leafTextures.get(name);
    if (cached) return cached;
    const url = LEAF_URLS[name] ?? aspenLeafUrl;
    const texture = new Texture(url, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
    texture.hasAlpha = true;
    leafTextures.set(name, texture);
    return texture;
  };

  const bumpTextures = new Map<string, Texture>();
  const bumpTextureFor = (name: string): Texture => {
    const cached = bumpTextures.get(name);
    if (cached) return cached;
    const url = BUMP_URLS[name] ?? aspenBumpUrl;
    // Рельеф — не картинка для глаза, а числа: гамма-коррекция их перекосит.
    const texture = new Texture(url, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
    texture.gammaSpace = false;
    bumpTextures.set(name, texture);
    return texture;
  };

  interface Form {
    branches: Mesh;
    leaves: Mesh;
    matrices: Float32Array;
    colors: Float32Array;
    count: number;
  }
  /** Порода — это несколько строений одного вида; расстановка знает только породу. */
  const species: { id: string; forms: Form[] }[] = [];
  const winds: WindPlugin[] = [];
  const glows: LeafGlowPlugin[] = [];
  for (const variant of asset.variants) {
    const tint = TINTS[variant.species] ?? TINTS.aspen!;
    const barkMat = new StandardMaterial(`tree-bark-${variant.id}`, scene);
    barkMat.diffuseTexture = barkTextureFor(variant.bark);
    barkMat.diffuseColor = Color3.FromHexString(tint.bark);
    barkMat.specularColor = Color3.Black();

    const leafMat = new StandardMaterial(`tree-leaf-${variant.id}`, scene);
    leafMat.diffuseTexture = leafTextureFor(variant.leaf);
    leafMat.diffuseColor = Color3.FromHexString(tint.leaf);
    leafMat.specularColor = Color3.Black();
    // Рельеф пучка. Он и разбивает карточку на отдельные листья: сама она у дуба
    // диагональю под два метра, и без рельефа такой кусок кроны освещён ровно —
    // читается плоским лоскутом, сколько его ни поворачивай и ни выгибай.
    leafMat.bumpTexture = bumpTextureFor(variant.leaf);
    leafMat.bumpTexture.level = BUMP_LEVEL;
    // Развёртка у листа своя, а касательных в вершинах нет: пусть шейдер берёт
    // систему координат из производных — для квада с честной развёрткой это точно.
    leafMat.invertNormalMapX = false;
    leafMat.invertNormalMapY = false;
    // Лист — плоский квад, поэтому видна и обратная сторона; прозрачность через
    // отсечение по альфе, а не смешивание: сортировать тысячи квадов незачем,
    // а с отсечением они едут в обычном непрозрачном проходе с глубиной.
    leafMat.backFaceCulling = false;
    leafMat.transparencyMode = Material.MATERIAL_ALPHATEST;
    leafMat.useAlphaFromDiffuseTexture = true;
    // Нормаль листа не переворачивается к зрителю. Переворот был здесь долго и
    // держался на здравом доводе — иначе отвёрнутая половина кроны стоит чёрной, —
    // но он же и давал те неестественные блики, ради которых написан просвет ниже:
    // лист собран крестом, при проезде каждый квад по очереди меняет сторону, и
    // крона идёт вспыхивающими пятнами. Нормаль у нас и так не квадовая, а
    // кроновая — от середины кроны наружу; переворачивать её к камере значит
    // делать освещение зависящим от того, откуда смотрят.
    leafMat.twoSidedLighting = false;
    // Порог отсечения ниже обычного: с расстоянием мипы усредняют альфу, и на
    // стандартных четырёх десятых дальняя крона осыпается до голых веток.
    leafMat.alphaCutOff = 0.3;
    // Немного собственного свечения — вместо честного вторичного света в глубине
    // кроны. Раньше его было столько, что оно съедало светотень целиком.
    leafMat.emissiveColor = Color3.FromHexString(tint.leaf).scale(0.05);

    // Ветер — свой плагин на материал: у коры и листвы он один и тот же, но лист
    // ещё и трепещет, а ствол только гнётся.
    winds.push(new WindPlugin(barkMat, 0), new WindPlugin(leafMat, 1));
    // Просвет: свет, прошедший лист насквозь. Он и заменяет собой переворот
    // нормали — теневая сторона кроны светится, но светится изнутри и одинаково с
    // любой точки, а не вспыхивает от движения камеры.
    const glow = new LeafGlowPlugin(leafMat);
    const through = Color3.FromHexString(tint.leaf);
    // Прошедший свет желтее и светлее отражённого: хлорофилл пропускает зелёное и
    // жёлтое, а синее съедает. Взять тот же цвет, что у отражения, — значит
    // получить не просвет, а равномерную добавку яркости.
    glow.r = Math.min(1, through.r * 1.25 + 0.06);
    glow.g = Math.min(1, through.g * 1.15 + 0.06);
    glow.b = Math.min(1, through.b * 0.7);
    glow.strength = LEAF_THROUGH;
    glows.push(glow);

    const buffers = {
      matrices: new Float32Array(CAPACITY * 16),
      colors: new Float32Array(CAPACITY * 4).fill(1),
    };
    const branches = branchData(variant.branches, variant);
    const leaves = leafData(variant.leaves, variant, asset.leafUv);
    const form: Form = {
      branches: meshFor(
        `tree-br-${variant.id}`,
        branches,
        barkMat,
        buffers,
        swayWeights(branches.positions as Float32Array, false),
        null,
        scene,
      ),
      leaves: meshFor(
        `tree-lf-${variant.id}`,
        leaves,
        leafMat,
        buffers,
        swayWeights(leaves.positions as Float32Array, true),
        leafPivots(leaves.positions as Float32Array),
        scene,
      ),
      ...buffers,
      count: 0,
    };
    const known = species.find((entry) => entry.id === variant.species);
    if (known) known.forms.push(form);
    else species.push({ id: variant.species, forms: [form] });
  }

  const scaling = new Vector3(1, 1, 1);
  const rotation = new Quaternion();
  const translation = new Vector3();
  const matrix = new Matrix();

  function place(spots: readonly TreeSpot[]): void {
    for (const entry of species) for (const form of entry.forms) form.count = 0;
    for (const spot of spots) {
      const index = ((spot.variant % species.length) + species.length) % species.length;
      const forms = species[index]!.forms;
      // Строение выбирается местом дерева, а не порядком в списке: дерево, уехавшее
      // назад и снова попавшее в окно, должно оказаться тем же самым деревом.
      const pick = Math.abs(Math.round(spot.x * 7.13 + spot.z * 3.71)) % forms.length;
      const form = forms[pick]!;
      const slot = form.count;
      if (slot >= CAPACITY) continue;
      scaling.set(spot.heightM * spot.spread, spot.heightM, spot.heightM * spot.spread);
      Quaternion.RotationYawPitchRollToRef(spot.rotationY, spot.lean, 0, rotation);
      translation.set(spot.x, spot.y, spot.z);
      Matrix.ComposeToRef(scaling, rotation, translation, matrix);
      matrix.copyToArray(form.matrices, slot * 16);
      tintOf(spot, form.colors, slot * 4);
      form.count = slot + 1;
    }
    for (const entry of species) {
      for (const form of entry.forms) {
        form.branches.thinInstanceCount = form.count;
        form.leaves.thinInstanceCount = form.count;
        form.branches.thinInstanceBufferUpdated("matrix");
        form.leaves.thinInstanceBufferUpdated("matrix");
        form.branches.thinInstanceBufferUpdated("color");
        form.leaves.thinInstanceBufferUpdated("color");
      }
    }
  }

  /**
   * Во что обходится единица ветра: доля высоты дерева, на которую уходит вершина.
   * Пять сотых — это метр у пятнадцатиметрового дерева на сильном порыве. Две с
   * половиной сотых, с которых начинали, честнее физически, но с дороги такое
   * качание не читается вовсе: мимо леса едут на ста километрах в час, и на этом
   * фоне полуметровый ход кроны неотличим от неподвижного дерева. Взятая напрямую
   * единица — другая крайность: крона уезжает в сторону целиком, и лес выглядит не
   * качающимся, а поваленным.
   */
  const WIND_BEND = 0.05;

  function animate(wind: Wind): void {
    // Камера нужна шейдеру, чтобы решить, насколько мелкие звенья дерева стоит
    // шевелить: вдали хватает ветки, вблизи оживают прутья и лист (`sway.ts`).
    const eye = scene.activeCamera?.globalPosition;
    for (const uniform of winds) {
      uniform.phase = wind.phase;
      uniform.strength = wind.force * WIND_BEND;
      uniform.live = wind.force;
      uniform.dirX = wind.dirX;
      uniform.dirZ = wind.dirZ;
      if (eye) {
        uniform.eyeX = eye.x;
        uniform.eyeY = eye.y;
        uniform.eyeZ = eye.z;
      }
    }
  }

  return {
    variants: species.map((entry) => entry.id),
    meshes: species.flatMap((entry) => entry.forms.flatMap((form) => [form.branches, form.leaves])),
    place,
    animate,
    dispose: () => {
      for (const entry of species) {
        for (const form of entry.forms) {
          form.branches.dispose();
          form.leaves.dispose();
        }
      }
      for (const texture of leafTextures.values()) texture.dispose();
    },
  };
}
