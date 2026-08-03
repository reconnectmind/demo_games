import { describe, expect, it } from "vitest";
import { Centerline, FINE_M, SEGMENT_M, groundDy, lateralOf, type FinePoint } from "../packages/race/src/track.js";
import { TREES, plantTrees } from "../packages/race/src/view/plant.js";
import type { TreeSpot } from "../packages/race/src/view/trees.js";

/**
 * Посадка леса проверяется одним свойством: дерево стоит на земле.
 *
 * Свойство звучит banально, но именно оно и ломалось, причём незаметно. Место
 * дерева считалось от опорной точки шага расстановки, а разброс вдоль трассы
 * добавлялся сдвигом по касательной — высоту при этом брали прежнюю, от опорной
 * точки. На ровном месте разницы нет, на подъёме в шесть сотых и разбросе в
 * двадцать метров дерево оказывается больше чем на метр выше или ниже земли. В
 * заезде это читается как «дерево растёт из воздуха», и поймать это глазами
 * можно только случайно: лес растёт из хеша и дважды одинаковым не бывает.
 *
 * Проверка идёт от обратного и не повторяет расчёт посадки: место дерева
 * проецируется обратно на осевую линию, и высота земли считается уже там.
 */

/** Уклон и вираж взяты предельные: на ровной прямой ошибка посадки не видна. */
const STAMPS = [{ fromSegment: 0, curveRate: 0.006, gradeMax: 0.06, halfWidth: 6 }];
const SEED = 20260802;

function planted(seed = SEED): TreeSpot[] {
  const line = new Centerline(seed);
  line.applyStamps(STAMPS);
  const out: TreeSpot[] = [];
  plantTrees(out, line, seed, 0, 120, () => 0);
  return out;
}

/** Ближайшая точка осевой линии к месту на земле: сначала грубо, потом мелко. */
function nearest(line: Centerline, x: number, z: number, untilM: number): FinePoint {
  const away = (d: number): number => {
    const p = line.atDistance(d);
    return Math.hypot(p.x - x, p.z - z);
  };
  let best = 0;
  for (let d = 0; d <= untilM; d += SEGMENT_M) if (away(d) < away(best)) best = d;
  for (let d = Math.max(0, best - SEGMENT_M); d <= best + SEGMENT_M; d += FINE_M / 20) {
    if (away(d) < away(best)) best = d;
  }
  return line.atDistance(best);
}

describe("посадка леса", () => {
  it("каждое дерево стоит на земле, а не над ней и не в ней", () => {
    const line = new Centerline(SEED);
    line.applyStamps(STAMPS);
    const spots = planted();
    expect(spots.length).toBeGreaterThan(50);

    let worst = 0;
    for (const spot of spots) {
      const point = nearest(line, spot.x, spot.z, 140 * SEGMENT_M);
      const ground = point.y + groundDy(point, lateralOf(point, spot.x, spot.z));
      worst = Math.max(worst, Math.abs(spot.y - ground));
    }
    // Пять сантиметров — это уже неточность самой проекции на линию, а не посадки.
    // Прежняя расстановка давала на этой трассе больше метра.
    expect(worst).toBeLessThan(0.05);
  });

  it("проверка не вырождена: лес и правда стоит на разной высоте", () => {
    const heights = planted().map((spot) => spot.y);
    // Иначе первый тест прошёл бы и на идеально плоской земле, ничего не проверив.
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(5);
  });

  it("ни одно дерево не растёт на асфальте", () => {
    const line = new Centerline(SEED);
    line.applyStamps(STAMPS);
    for (const spot of planted()) {
      const point = nearest(line, spot.x, spot.z, 140 * SEGMENT_M);
      expect(Math.abs(lateralOf(point, spot.x, spot.z))).toBeGreaterThan(point.halfWidth);
    }
  });

  it("дерево, уехавшее назад и вернувшееся в окно, стоит на прежнем месте", () => {
    const line = new Centerline(SEED);
    line.applyStamps(STAMPS);
    const wide: TreeSpot[] = [];
    plantTrees(wide, line, SEED, 20, 60, () => 0);
    const later: TreeSpot[] = [];
    plantTrees(later, line, SEED, 30, 60, () => 0);
    const same = wide.filter((spot) => later.some((other) => other.x === spot.x && other.z === spot.z));
    // Окна пересекаются на тридцати сегментах: общая часть обязана совпасть точно.
    expect(same.length).toBeGreaterThan(20);
  });

  it("в окно попадает не больше леса, чем тянет видеокарта", () => {
    const line = new Centerline(SEED);
    line.applyStamps(STAMPS);
    const out: TreeSpot[] = [];
    plantTrees(out, line, SEED, 0, 4000, () => 0);
    expect(out.length).toBe(TREES);
  });
});
