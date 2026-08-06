/**
 * Следы шин: чёрные полосы, которые машина оставляет на асфальте.
 *
 * Решение о том, где и насколько черно, принимает шина (`markAt` в `tire.ts`):
 * стирается резина мощностью трения, а остаётся на дороге ровно та её доля,
 * которую размягчила температура. Здесь только укладка — как эти числа
 * превращаются в геометрию.
 *
 * Полоса — это лента: два ряда вершин по обе стороны от пятна контакта,
 * сшитые по мере движения колеса. Ленту нельзя строить из положения кузова —
 * колесо ходит по подвеске и повёрнуто рулём, и в заносе его пятно уезжает от
 * оси машины на полметра. Поэтому сцена берёт у физики само пятно и поперечную
 * ось колеса в нём.
 *
 * Память кольцевая и заранее выделенная. Заезд длится сорок минут, и след,
 * который никогда не стирается, — это неограниченно растущий буфер вершин;
 * кольцо снимает вопрос целиком, а заодно отвечает и по существу: резину с
 * асфальта уносит, и старые полосы в самом деле пропадают. Позади машины
 * дорога всё равно снимается вместе с коллизионной сеткой, так что до
 * переполнения кольца доживают только следы, на которые уже некому смотреть.
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";

/** Сколько звеньев ленты помнится на каждое колесо. */
const LINKS = 320;
/** Ширина полосы, метры: пятно контакта шире протектора не бывает. */
const WIDTH_M = 0.26;
/**
 * Насколько след приподнят над асфальтом, метры. Ноль означал бы, что лента и
 * дорога лежат в одной плоскости, а глубинный буфер решает такие ничьи как
 * попало: полоса мерцала бы вдоль всей длины. Миллиметр глазом не виден и
 * ничью снимает.
 */
const LIFT_M = 0.012;
/**
 * Дальше этого звено не тянут, метры: на скорости за кадр колесо уезжает на
 * полметра, и это нормально, а вот перескок через полкарты означает, что машину
 * вернули на полосу, — сшивать такое в ленту нельзя.
 */
const JUMP_M = 4;

export interface TireMarks {
  /**
   * Продолжить следы. `wheels` — пятна контакта на этот кадр в том же порядке,
   * что и колёса физики.
   */
  lay(wheels: ReadonlyArray<{ mark: number; contact: boolean; atX: number; atY: number; atZ: number; sideX: number; sideZ: number }>): void;
  /** Стереть всё: машину вернули на полосу, тянуть ленту неоткуда. */
  clear(): void;
  dispose(): void;
}

/** Одно звено на колесо: четыре вершины, два треугольника. */
const VERTS_PER_LINK = 4;

export function createTireMarks(scene: Scene, wheels = 4): TireMarks {
  const links = wheels * LINKS;
  const positions = new Float32Array(links * VERTS_PER_LINK * 3);
  const colors = new Float32Array(links * VERTS_PER_LINK * 4);
  const indices = new Uint32Array(links * 6);
  for (let link = 0; link < links; link++) {
    const at = link * VERTS_PER_LINK;
    const to = link * 6;
    indices[to] = at;
    indices[to + 1] = at + 2;
    indices[to + 2] = at + 1;
    indices[to + 3] = at + 1;
    indices[to + 4] = at + 2;
    indices[to + 5] = at + 3;
  }

  const mesh = new Mesh("tire-marks", scene);
  const data = new VertexData();
  data.positions = positions as unknown as number[];
  data.colors = colors as unknown as number[];
  data.indices = indices as unknown as number[];
  data.applyToMesh(mesh, true);
  mesh.hasVertexAlpha = true;
  // Лента лежит на дороге и ничего не загораживает: ни тени от неё, ни выбора
  // мышью, ни отсечения по объёму — она всегда рядом с машиной.
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.receiveShadows = false;

  const material = new StandardMaterial("tire-marks", scene);
  // Резина не блестит и не светится: она только затемняет то, что под ней.
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = Color3.Black();
  material.disableLighting = true;
  material.backFaceCulling = false;
  material.zOffset = -2;
  mesh.material = material;

  /** Куда пишется следующее звено каждого колеса. */
  const head = new Array<number>(wheels).fill(0);
  /** Где было пятно в прошлый раз и клали ли тогда след. */
  const last = Array.from({ length: wheels }, () => ({ x: 0, y: 0, z: 0, live: false, mark: 0 }));
  let dirty = false;

  function writeLink(wheel: number, from: { x: number; y: number; z: number }, fromMark: number, to: { x: number; y: number; z: number }, toMark: number, sideX: number, sideZ: number): void {
    const slot = wheel * LINKS + head[wheel]!;
    head[wheel] = (head[wheel]! + 1) % LINKS;
    const half = WIDTH_M / 2;
    const ox = sideX * half;
    const oz = sideZ * half;
    const corners = [
      [from.x - ox, from.y + LIFT_M, from.z - oz, fromMark],
      [from.x + ox, from.y + LIFT_M, from.z + oz, fromMark],
      [to.x - ox, to.y + LIFT_M, to.z - oz, toMark],
      [to.x + ox, to.y + LIFT_M, to.z + oz, toMark],
    ];
    for (let i = 0; i < VERTS_PER_LINK; i++) {
      const corner = corners[i]!;
      const p = (slot * VERTS_PER_LINK + i) * 3;
      positions[p] = corner[0]!;
      positions[p + 1] = corner[1]!;
      positions[p + 2] = corner[2]!;
      const c = (slot * VERTS_PER_LINK + i) * 4;
      colors[c] = 0;
      colors[c + 1] = 0;
      colors[c + 2] = 0;
      colors[c + 3] = corner[3]!;
    }
    dirty = true;
  }

  function blank(wheel: number): void {
    // Звено сворачивается в точку с нулевой прозрачностью: убирать треугольники
    // из готового буфера нечем, а вырожденный треугольник ничего не рисует.
    const slot = wheel * LINKS + head[wheel]!;
    head[wheel] = (head[wheel]! + 1) % LINKS;
    for (let i = 0; i < VERTS_PER_LINK; i++) {
      const p = (slot * VERTS_PER_LINK + i) * 3;
      positions[p] = 0;
      positions[p + 1] = 0;
      positions[p + 2] = 0;
      colors[(slot * VERTS_PER_LINK + i) * 4 + 3] = 0;
    }
    dirty = true;
  }

  return {
    lay(frame): void {
      for (let i = 0; i < wheels && i < frame.length; i++) {
        const wheel = frame[i]!;
        const was = last[i]!;
        const live = wheel.contact && wheel.mark > 0;
        const moved = was.live ? Math.hypot(wheel.atX - was.x, wheel.atY - was.y, wheel.atZ - was.z) : 0;
        if (live && was.live && moved > 1e-3 && moved < JUMP_M) {
          writeLink(i, was, was.mark, { x: wheel.atX, y: wheel.atY, z: wheel.atZ }, wheel.mark, wheel.sideX, wheel.sideZ);
        }
        was.x = wheel.atX;
        was.y = wheel.atY;
        was.z = wheel.atZ;
        was.mark = wheel.mark;
        was.live = live;
      }
      if (!dirty) return;
      dirty = false;
      mesh.updateVerticesData(VertexBuffer.PositionKind, positions as unknown as number[]);
      mesh.updateVerticesData(VertexBuffer.ColorKind, colors as unknown as number[]);
    },

    clear(): void {
      for (let i = 0; i < wheels; i++) {
        last[i]!.live = false;
        for (let link = 0; link < LINKS; link++) blank(i);
      }
      mesh.updateVerticesData(VertexBuffer.PositionKind, positions as unknown as number[]);
      mesh.updateVerticesData(VertexBuffer.ColorKind, colors as unknown as number[]);
      dirty = false;
    },

    dispose(): void {
      mesh.dispose();
      material.dispose();
    },
  };
}
