import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOINT_FAR_M, JOINT_NEAR_M, LEAF_VERTS, SPECIES, jointDetail, leafPivots } from "@gamespace/flora";
// Испечённый лес и таблица пород: расстановка сводит их по имени породы, и
// разъезжаются они молча — на трассе просто не окажется четверти деревьев.
import treesAsset from "../packages/flora/src/assets/trees.json";

/**
 * Лес сам по себе: что напечатала печь и как это шевелится на ветру.
 *
 * Проверяется здесь только устройство растения — раскладка вершин, бюджет
 * треугольников, оси поворота листа, затухание мелких звеньев с расстоянием. Где
 * деревья стоят и что видно из машины — дело игры, и это в `race.test.ts`.
 */

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "flora", "src", "assets");

async function png() {
  const { decodePng } = await import("../packages/flora/tools/png.mjs");
  return decodePng;
}

describe("лес: печать деревьев", () => {
  it("на каждую породу леса испечено дерево, а на приметные — не одно", () => {
    const species = new Map<string, number>();
    for (const variant of treesAsset.variants) {
      species.set(variant.species, (species.get(variant.species) ?? 0) + 1);
      expect(variant.branches.triangles).toBeGreaterThan(0);
      expect(variant.leaves.triangles).toBeGreaterThan(0);
      expect(variant.height).toBeGreaterThan(0);
    }
    // Расстановка ищет строения по имени породы: породы без дерева обернутся тем,
    // что лес молча поредеет на четверть, и заметить это можно только глазами.
    for (const kind of SPECIES) expect(species.get(kind.id)).toBeGreaterThanOrEqual(1);
    // Куст и придорожные деревья видно в упор, и одно строение на породу читается
    // копипастой: у них обязаны быть разные силуэты.
    for (const kind of ["bush", "aspen", "ash", "oak", "pine"]) {
      expect(species.get(kind)).toBeGreaterThanOrEqual(2);
    }
  });

  it("лес не разъедается в мегабайты: печать держит бюджет треугольников", () => {
    // Ассет едет по сети целиком и парсится на старте заезда, поэтому бюджет тут не
    // про кадры, а про первый экран. Куст дешевле дерева не по важности, а по тому,
    // что его видно три метра: пресеты куста ветвистее дуба, и без этой границы
    // печать однажды уже выдала куст вчетверо дороже дерева.
    //
    // Верхняя граница поднята с десяти тысяч до восемнадцати, и это осознанная
    // плата за две вещи, которые дешевле не выходят: непрерывный обвод ствола
    // (сечения вдоль ветки — это его форма, а не детализация) и густое ветвление
    // в кроне (на редком скелете пучки листвы висят отдельными нашлёпками).
    // Считать эти треугольники за экономию нельзя: именно они отличают дерево от
    // коленчатой трубы с ботвой.
    for (const variant of treesAsset.variants) {
      const total = variant.branches.triangles + variant.leaves.triangles;
      const budget = variant.species === "bush" || variant.species === "sapling" ? 5000 : 18_000;
      expect(total, variant.id).toBeLessThanOrEqual(budget);
    }
  });

  it("лист — не плоскость: середина поднята над своими углами", () => {
    // Главная и самая живучая претензия к лесу — «листья лежат в одной плоскости».
    // На кваде она неустранима в принципе: на карточке нарисован не лист, а
    // полтора десятка листьев, и плоскость у них одна на всех, что бы ни лежало в
    // нормалях. Поэтому лист печатается веером из пяти вершин: четыре угла и
    // поднятая над ними середина. Тест сторожит ровно это — и раскладку, и то,
    // что подъём не выродился в ноль.
    for (const variant of treesAsset.variants) {
      const part = variant.leaves;
      expect(part.vertexCount % 5, variant.id).toBe(0);
      const leaves = part.vertexCount / 5;
      expect(part.triangles, variant.id).toBe(leaves * 4);

      const packed = Buffer.from(part.positions, "base64");
      const xyz = new Int16Array(packed.buffer, packed.byteOffset, packed.byteLength / 2);
      const at = (v: number, k: number) => (xyz[v * 3 + k]! * part.scale) / 32767;

      // Мерится не подъём в метрах, а то, ради чего он есть: расхождение нормалей
      // соседних граней. Плоскому листу оно ноль при любом размере, и свет по
      // нему идёт ровно — то самое, что глаз читает картонкой.
      let flat = 0;
      let folded = 0;
      for (let leaf = 0; leaf < leaves; leaf++) {
        const base = leaf * 5;
        const facets: number[][] = [];
        for (let i = 0; i < 4; i++) {
          const a = base + i;
          const b = base + ((i + 1) % 4);
          const u = [0, 1, 2].map((k) => at(b, k) - at(a, k));
          const w = [0, 1, 2].map((k) => at(base + 4, k) - at(a, k));
          const n = [
            u[1]! * w[2]! - u[2]! * w[1]!,
            u[2]! * w[0]! - u[0]! * w[2]!,
            u[0]! * w[1]! - u[1]! * w[0]!,
          ];
          const len = Math.hypot(...n);
          if (len > 1e-12) facets.push(n.map((v) => v / len));
        }
        if (facets.length < 4) continue;
        let widest = 0;
        for (let i = 0; i < 4; i++) {
          for (let j = i + 1; j < 4; j++) {
            const dot = facets[i]!.reduce((sum, v, k) => sum + v * facets[j]![k]!, 0);
            widest = Math.max(widest, Math.acos(Math.min(1, Math.abs(dot))));
          }
        }
        if (widest < 0.35) flat += 1;
        else folded += 1;
      }
      // Вырожденные листья генератор выдаёт всегда, но их единицы.
      expect(folded / (folded + flat), variant.id).toBeGreaterThan(0.95);
    }
  });

  it("у каждого ствола есть кора: развёртка на месте и указана картинка", () => {
    const barks = new Set(["birch", "oak", "pine"]);
    for (const variant of treesAsset.variants) {
      // Кора рисуется фотографией, а не заливкой, и без развёртки вся ветка возьмёт
      // один пиксель текстуры — то есть вернётся ровно к плоской заливке, только
      // случайного оттенка.
      expect(variant.bark, variant.id).toBeDefined();
      expect(barks.has(variant.bark), `${variant.id}: кора ${variant.bark}`).toBe(true);
      const uv = Buffer.from(variant.branches.uv, "base64");
      expect(uv.byteLength, variant.id).toBe(variant.branches.vertexCount);
      // Развёртка вдоль ветки лежит в старшем бите: если он всюду одинаков, сечения
      // склеились и фактура растянется по стволу в одну полосу.
      const along = new Set<number>();
      for (const byte of uv) along.add(byte >> 7);
      expect(along.size, variant.id).toBe(2);
    }
  });
});

describe("лес: фактура листвы", () => {
  it("фактура листвы обесцвечена: цвет кроны задаёт порода, а не картинка", async () => {
    const decodePng = await png();
    for (const leaf of new Set(treesAsset.variants.map((variant) => variant.leaf))) {
      const { width, height, pixels } = decodePng(readFileSync(join(assetsDir, `leaf-${leaf}.png`)));
      let sum = 0;
      let chroma = 0;
      let count = 0;
      for (let i = 0; i < width * height; i++) {
        const at = i * 4;
        // Только то, что переживёт отсечение по альфе: за ним лежит растёкшаяся кайма.
        if (pixels[at + 3]! <= 77) continue;
        const r = pixels[at]!;
        const g = pixels[at + 1]!;
        const b = pixels[at + 2]!;
        sum += 0.299 * r + 0.587 * g + 0.114 * b;
        chroma += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        count++;
      }
      expect(count, leaf).toBeGreaterThan(0);
      // Светлая и почти серая: оттенок породы из `trees.ts` — множитель к ней, и
      // на крашеной картинке зелёное умножалось бы на зелёное, уходя в чёрную оливку.
      expect(sum / count / 255, leaf).toBeGreaterThan(0.7);
      expect(chroma / count, leaf).toBeLessThan(0.2);
    }
  });

  it("у пучка есть рельеф: листья на карточке смотрят в разные стороны", async () => {
    const decodePng = await png();
    for (const leaf of new Set(treesAsset.variants.map((variant) => variant.leaf))) {
      const color = decodePng(readFileSync(join(assetsDir, `leaf-${leaf}.png`)));
      const bump = decodePng(readFileSync(join(assetsDir, `leaf-${leaf}-bump.png`)));
      expect(bump.width, leaf).toBe(color.width);
      let spread = 0;
      let count = 0;
      for (let i = 0; i < bump.width * bump.height; i++) {
        // Смотрим только туда, где есть лист: пустое поле заведомо ровное.
        if (color.pixels[i * 4 + 3]! <= 77) continue;
        const dx = bump.pixels[i * 4]! - 128;
        const dy = bump.pixels[i * 4 + 1]! - 128;
        spread += Math.hypot(dx, dy) / 127;
        count++;
      }
      expect(count, leaf).toBeGreaterThan(0);
      // Без рельефа вся горсть освещается как одна плоскость — карточка у дуба
      // диагональю под два метра, и такой кусок кроны читается лоскутом картона.
      expect(spread / count, leaf).toBeGreaterThan(0.2);
    }
  });
});

describe("лес: качание на ветру", () => {
  it("лист поворачивается вокруг своей оси, а не вокруг чужой", () => {
    // Вблизи лист обязан жить сам по себе: качаться вместе с веткой и оставаться
    // к ней приклеенным — ровно то, что читается искусственным. Поворот делает
    // шейдер, и проверить его нельзя, но ось поворота считается здесь, и от неё
    // зависит всё: одна ось на лист — лист ходит целиком; разные оси у его
    // вершин — лист разорвёт на месте.
    for (const variant of treesAsset.variants) {
      const part = variant.leaves;
      const packed = Buffer.from(part.positions, "base64");
      const xyz = new Int16Array(packed.buffer, packed.byteOffset, packed.byteLength / 2);
      const positions = new Float32Array(part.vertexCount * 3);
      for (let i = 0; i < positions.length; i++) positions[i] = (xyz[i]! * part.scale) / 32767;

      const pivots = leafPivots(positions);
      expect(pivots.length, variant.id).toBe(positions.length);

      let widest = 0;
      for (let leaf = 0; leaf < part.vertexCount / LEAF_VERTS; leaf++) {
        const base = leaf * LEAF_VERTS * 3;
        // Все пять вершин листа обязаны получить одну и ту же ось.
        for (let i = 1; i < LEAF_VERTS; i++) {
          for (let k = 0; k < 3; k++) expect(pivots[base + i * 3 + k]).toBe(pivots[base + k]);
        }
        // И эта ось обязана лежать в самом листе: поворот вокруг точки в стороне
        // не крутил бы лист, а возил бы его по кроне, и крона бы поплыла.
        for (let i = 0; i < LEAF_VERTS; i++) {
          const at = base + i * 3;
          widest = Math.max(
            widest,
            Math.hypot(positions[at]! - pivots[at]!, positions[at + 1]! - pivots[at + 1]!, positions[at + 2]! - pivots[at + 2]!),
          );
        }
      }
      // Радиус листа — сантиметры при дереве в высоту единица; полдесятой доли
      // высоты означало бы, что за ось взяли что-то не из этого листа.
      expect(widest, variant.id).toBeGreaterThan(0);
      expect(widest, variant.id).toBeLessThan(0.05);
    }
  });

  it("подвижность мелких звеньев растёт при приближении и гаснет вдали", () => {
    // Вдали лист меньше пикселя, и собственный его ход виден не движением, а
    // мерцанием: вершина скачет между соседними пикселями и крона начинает
    // шипеть. Поэтому мелкие звенья гасятся расстоянием — но гасятся гладко,
    // иначе вокруг машины будет видно кольцо, внутри которого лес оживает.
    expect(jointDetail(0)).toBe(1);
    expect(jointDetail(JOINT_NEAR_M)).toBe(1);
    expect(jointDetail(JOINT_FAR_M)).toBe(0);
    expect(jointDetail(200)).toBe(0);

    let previous = 1;
    for (let m = 0; m <= JOINT_FAR_M + 5; m += 0.5) {
      const now = jointDetail(m);
      expect(now).toBeLessThanOrEqual(previous + 1e-9);
      previous = now;
    }

    // Гладкость: у краёв кривая ложится на полку, а не втыкается в неё углом.
    const step = 0.5;
    const atNear = jointDetail(JOINT_NEAR_M) - jointDetail(JOINT_NEAR_M + step);
    const atFar = jointDetail(JOINT_FAR_M - step) - jointDetail(JOINT_FAR_M);
    const middle = JOINT_NEAR_M + (JOINT_FAR_M - JOINT_NEAR_M) / 2;
    const atMid = jointDetail(middle - step / 2) - jointDetail(middle + step / 2);
    expect(atNear).toBeLessThan(atMid / 4);
    expect(atFar).toBeLessThan(atMid / 4);
  });
});
