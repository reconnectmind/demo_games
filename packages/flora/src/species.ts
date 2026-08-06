/**
 * Что где растёт.
 *
 * Порода задаёт не только сетку, но и место: кусты и подрост стоят у самой обочины,
 * взрослый лес — за валом. Обратный порядок сразу читается декорацией: дуб в трёх
 * метрах от полосы бывает только там, где его поставил художник.
 *
 * Таблица общая для заезда и для стенда (`lab/garden.ts`): стенд показывает ровно те
 * породы, ровно тех размеров, какие потом встретятся на трассе, иначе смотреть на него
 * незачем.
 */

export interface Species {
  id: string;
  /** Доля породы в лесу: суммируются в единицу. */
  share: number;
  /** Отступ от кромки полосы, метры. */
  awayM: [number, number];
  heightM: [number, number];
  /** Раскидистость: множитель к ширине при той же высоте. */
  spread: [number, number];
}

export const SPECIES: Species[] = [
  { id: "bush", share: 0.24, awayM: [6, 15], heightM: [1.1, 2.4], spread: [1, 1.5] },
  { id: "sapling", share: 0.14, awayM: [12, 26], heightM: [3.5, 6.5], spread: [0.7, 1] },
  { id: "aspen", share: 0.13, awayM: [17, 42], heightM: [9, 16], spread: [0.55, 0.8] },
  // Берёза выше и тоньше осины: этим она и узнаётся на просвет, ещё до коры.
  { id: "birch", share: 0.13, awayM: [16, 42], heightM: [11, 19], spread: [0.45, 0.65] },
  { id: "ash", share: 0.11, awayM: [17, 42], heightM: [10, 18], spread: [0.6, 0.9] },
  { id: "oak", share: 0.1, awayM: [19, 42], heightM: [8, 14], spread: [0.85, 1.2] },
  { id: "pine", share: 0.09, awayM: [19, 46], heightM: [12, 21], spread: [0.7, 0.95] },
  // Ель — самая узкая и тёмная: держит дальний план и не спорит с сосной по силуэту.
  { id: "spruce", share: 0.06, awayM: [21, 46], heightM: [13, 22], spread: [0.62, 0.85] },
];

export function speciesAt(roll: number): Species {
  let seen = 0;
  for (const species of SPECIES) {
    seen += species.share;
    if (roll < seen) return species;
  }
  return SPECIES[SPECIES.length - 1]!;
}
