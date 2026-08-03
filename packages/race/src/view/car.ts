import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import type { Scene } from "@babylonjs/core/scene.js";
import asset from "../assets/car.json";
import { BODY_SCALE } from "../geometry.js";

/**
 * Машина — модель Porsche Cayenne GTS, но не OBJ в рантайме, а испечённая
 * геометрия (`tools/bake-car.mjs`, исходник в `tools/source/cayenne.zip`).
 * Загрузчик стоил бы сотен килобайт разбора материалов и текстур ради сетки,
 * которая от заезда к заезду не меняется, а цвет у модели всё равно материальный:
 * при печати он снят в вершины, поэтому здесь обычный материал без единой текстуры.
 *
 * Сетка приходит вместе с кодом сцены, а не отдельным запросом: машина — не
 * украшение вроде деревьев, без неё заезд смысла не имеет, и ждать её нечего.
 */

interface PackedPart {
  scale: number;
  vertexCount: number;
  triangles: number;
  positions: string;
  normals: string;
  colors: string;
  indices: string;
}

export interface CarModel {
  /** Кузов: его вешают на узел машины и больше не трогают. */
  body: TransformNode;
  /** Колёса в порядке физики: передние левое-правое, потом задние. */
  wheels: TransformNode[];
  /**
   * Все сетки машины разом. Нужны сцене для теней, и нужны именно списком: колёса
   * не висят в иерархии кузова — их ставит подвеска, — и обход детей кузова их не
   * находит. Так они и остались без тени: машина роняла на дорогу силуэт без
   * колёс и оттого читалась висящей над ней.
   */
  meshes: Mesh[];
  /** Свет машины: габариты горят всегда, стоп и поворотник — по обстановке. */
  setLights(state: { brake: boolean; turn: number; timeS: number }): void;
  dispose(): void;
}

function bytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Распаковка сразу в метры: модель авторская игрушечного размера, и умножать её
 * узлом сцены значило бы возить масштаб через всю иерархию, включая колёса,
 * которые живут отдельно от кузова.
 */
function vertexDataOf(part: PackedPart): VertexData {
  const packedPositions = bytes(part.positions);
  const quantized = new Int16Array(packedPositions.buffer, 0, packedPositions.byteLength / 2);
  const positions = new Float32Array(quantized.length);
  const k = part.scale * BODY_SCALE;
  for (let i = 0; i < quantized.length; i++) positions[i] = quantized[i]! * k;

  const packedNormals = bytes(part.normals);
  const rawNormals = new Int8Array(packedNormals.buffer, 0, packedNormals.byteLength);
  const normals = new Float32Array(rawNormals.length);
  for (let i = 0; i < rawNormals.length; i++) normals[i] = rawNormals[i]! / 127;

  // Цвет вершины вместо текстуры: у палитры Kenney на всю машину два десятка
  // плашек, и держать ради них картинку на пол мегапикселя незачем.
  const rgb = bytes(part.colors);
  const colors = new Float32Array(part.vertexCount * 4);
  for (let i = 0; i < part.vertexCount; i++) {
    colors[i * 4] = rgb[i * 3]! / 255;
    colors[i * 4 + 1] = rgb[i * 3 + 1]! / 255;
    colors[i * 4 + 2] = rgb[i * 3 + 2]! / 255;
    colors[i * 4 + 3] = 1;
  }

  const packedIndices = bytes(part.indices);
  const indices = new Uint16Array(packedIndices.buffer, 0, packedIndices.byteLength / 2);

  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.colors = colors;
  data.indices = Array.from(indices);
  return data;
}

function meshOf(name: string, part: PackedPart, material: StandardMaterial, scene: Scene): Mesh {
  const mesh = new Mesh(name, scene);
  vertexDataOf(part).applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}

/** Собирает машину: кузов одной сеткой и четыре колеса отдельными узлами. */
export function createCarModel(scene: Scene): CarModel {
  const paint = new StandardMaterial("race-car", scene);
  // Цвет берётся из вершин, поэтому диффузный множитель белый. Блик слабый и
  // широкий: кузов должен читаться кузовом, а не пластиковой игрушкой.
  paint.diffuseColor = Color3.White();
  paint.specularColor = new Color3(0.22, 0.22, 0.24);
  paint.specularPower = 48;

  const body = meshOf("race-car-body", asset.body, paint, scene);

  /**
   * Колёса не в иерархии кузова: их ставит подвеска, а не модель. Вариантов сетки
   * два — левый и правый борт, они зеркальны; порядок узлов тот же, что у физики.
   */
  const byside = new Map<number, PackedPart>(asset.wheels.map((wheel) => [wheel.side, wheel as PackedPart]));
  const right = byside.get(1) ?? (asset.wheels[0] as PackedPart);
  const left = byside.get(-1) ?? right;
  const wheels: TransformNode[] = [];
  const wheelMeshes: Mesh[] = [];
  for (const [index, part] of [left, right, left, right].entries()) {
    const mesh = meshOf(`race-car-wheel-${index}`, part, paint, scene);
    mesh.rotationQuaternion = null;
    wheelMeshes.push(mesh);
    wheels.push(mesh);
  }

  /**
   * Фонари — отдельные сетки из той же модели и отдельные материалы: гореть они
   * обязаны по отдельности. Свет здесь не украшение, а обратная связь. Габариты
   * держат машину читаемой в тени и в пыли, стоп-сигнал показывает торможение, а
   * поворотник — намерение, и именно намерение труднее всего увидеть со стороны:
   * руль в кадре не виден, а машина начинает уходить в сторону только через
   * полсекунды после того, как игрок нажал клавишу.
   *
   * Всё это делается яркостью свечения, а не источниками света: фонарь размером в
   * ладонь физически подсветил бы разве что собственное стекло, зато лишний
   * источник в сцене стоит перекомпиляции всех шейдеров.
   */
  const lampMats = new Map<string, StandardMaterial>();
  const lampMeshes: Mesh[] = [];
  for (const part of asset.lamps as Array<PackedPart & { id: string }>) {
    const material = new StandardMaterial(`race-lamp-${part.id}`, scene);
    material.diffuseColor = Color3.White();
    material.specularColor = new Color3(0.1, 0.1, 0.1);
    lampMats.set(part.id, material);
    const mesh = meshOf(`race-car-lamp-${part.id}`, part, material, scene);
    mesh.parent = body;
    lampMeshes.push(mesh);
  }

  /**
   * Мигает поворотник полтора раза в секунду — так же, как реле в машине. Скважность
   * не половина, а чуть больше: горящая фаза заметнее тёмной, и на глаз ровное
   * мигание выходит именно так.
   */
  const BLINK_HZ = 1.5;
  const glow = (id: string, hex: string) => lampMats.get(id)?.emissiveColor.copyFrom(Color3.FromHexString(hex));

  return {
    body,
    wheels,
    meshes: [body, ...wheelMeshes, ...lampMeshes],
    setLights: ({ brake, turn, timeS }) => {
      // Габарит сзади тлеет всегда, стоп-сигнал вспыхивает поверх него.
      glow("tail", brake ? "#ff3b30" : "#5e1410");
      // Верхний стоп-сигнал и отражатель в заднем фонаре: та же логика, слабее.
      glow("head-back", brake ? "#c22a20" : "#1c1c1e");
      // Спереди — дневные ходовые огни: белые и постоянные.
      glow("head-front", "#4a4740");
      const on = turn !== 0 && Math.sin(timeS * BLINK_HZ * 2 * Math.PI) > -0.25;
      glow("turn-left", on && turn < 0 ? "#ff9a1e" : "#2a1604");
      glow("turn-right", on && turn > 0 ? "#ff9a1e" : "#2a1604");
    },
    dispose: () => {
      for (const mesh of lampMeshes) mesh.dispose();
      for (const mesh of wheelMeshes) mesh.dispose();
      body.dispose();
      paint.dispose();
      for (const material of lampMats.values()) material.dispose();
    },
  };
}
