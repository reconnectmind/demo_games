/**
 * Расстановка леса: где именно стоит каждое дерево в окне вокруг машины.
 *
 * Вынесено из сцены отдельно и без единой ссылки на Babylon по одной причине —
 * посадку надо проверять. Дерево, стоящее не на своей высоте, видно сразу: оно
 * либо висит над травой, либо уходит в неё по колено, — а поймать это глазами
 * можно только случайно, потому что лес растёт из хеша и дважды одинаковым не
 * бывает. Здесь же посадка — чистая функция от посева, и тест берёт сотню
 * деревьев и меряет каждое от земли.
 *
 * Всё считается от номера сегмента и стороны, поэтому дерево, уехавшее назад и
 * снова попавшее в окно, стоит на прежнем месте, а не переезжает.
 */

import { Centerline, SEGMENT_M, groundDy, hash01, lateralOffset } from "../track.js";
import { speciesAt } from "./species.js";
import type { TreeSpot } from "./trees.js";

/** Деревья через два сегмента и настолько вперёд, чтобы появляться уже в тумане. */
const TREE_EVERY = 2;
export const TREE_AHEAD = 45;
/** Длина шага расстановки, метры. */
const STEP_M = TREE_EVERY * SEGMENT_M;
/**
 * Сколько деревьев может стоять в окне.
 *
 * Это не украшательство, а бюджет треугольников: тонкие экземпляры делят одну
 * сетку, поэтому вызовов отрисовки от их числа не прибавляется, а вот вершин
 * прибавляется прямо пропорционально — по семь-восемь тысяч на взрослое дерево.
 * Двести деревьев в окне — это полтора миллиона треугольников на кадр, и это
 * потолок, на котором заезд ещё держит шестьдесят кадров на встроенной видеокарте.
 */
export const TREES = 220;
/**
 * Сколько деревьев ставится на шаг расстановки (двадцать метров) с одной стороны.
 * Первая версия давала в среднем меньше одного: лес читался не лесом, а редкими
 * саженцами вдоль пустого поля.
 */
const TREES_PER_STEP = 8;

/**
 * Заполнить список мест деревьев для окна, начинающегося с сегмента `fromSegment`.
 *
 * Лес растёт купами, а не рядами: густота — свой медленный шум по трассе, поэтому
 * в редколесье между купами видно даль, а в купе деревья стоят вплотную и разного
 * роста. Раньше на каждый второй сегмент приходилось не больше одного дерева на
 * сторону, и лес читался аллеей.
 *
 * Разброс вдоль трассы берётся своей точкой линии на своём расстоянии, а не сдвигом
 * по касательной от опорной точки. Разница не косметическая: на подъёме сдвиг по
 * касательной оставлял высоту опорной точки, и на два десятка метров разброса при
 * уклоне в шесть сотых дерево оказывалось почти на метр выше или ниже земли — то
 * самое «растёт из воздуха». На повороте тем же сдвигом дерево уезжало с дуги.
 */
export function plantTrees(
  out: TreeSpot[],
  line: Centerline,
  seed: number,
  fromSegment: number,
  toSegment: number,
  /** Номер варианта по имени породы: расстановка знает породы, а не индексы. */
  variantOf: (species: string) => number | undefined,
): void {
  out.length = 0;
  const first = Math.ceil(fromSegment / TREE_EVERY) * TREE_EVERY;
  for (let index = first; index <= toSegment; index += TREE_EVERY) {
    if (out.length >= TREES) break;
    for (const side of [-1, 1]) {
      const salt = side > 0 ? 11 : 12;
      // Густота меняется медленно, купами по сотне метров, а не от дерева к дереву.
      const density = hash01(seed, Math.floor(index / 10), salt + 30);
      const count = Math.floor(hash01(seed, index, salt) * TREES_PER_STEP * (0.4 + density));
      for (let n = 0; n < count; n++) {
        const pick = hash01(seed, index * 4 + n, salt + 12);
        const species = speciesAt(pick);
        const variant = variantOf(species.id);
        if (variant === undefined) continue;
        const along = hash01(seed, index * 4 + n, salt + 4) * STEP_M;
        const point = line.atDistance(index * SEGMENT_M + along);
        const spread = hash01(seed, index * 4 + n, salt + 2);
        const away = point.halfWidth + species.awayM[0] + spread * (species.awayM[1] - species.awayM[0]);
        const p = lateralOffset(point, away * side);
        const grow = hash01(seed, index * 4 + n, salt + 8);
        out.push({
          x: p.x,
          y: p.y + groundDy(point, away * side),
          z: p.z,
          rotationY: hash01(seed, index * 4 + n, salt + 6) * Math.PI * 2,
          heightM: species.heightM[0] + grow * (species.heightM[1] - species.heightM[0]),
          spread: species.spread[0] + hash01(seed, index * 4 + n, salt + 14) * (species.spread[1] - species.spread[0]),
          lean: (hash01(seed, index * 4 + n, salt + 16) - 0.5) * 0.12,
          variant,
        });
        if (out.length >= TREES) break;
      }
    }
  }
}
