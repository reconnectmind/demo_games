import { hash01, smoothstep, type SurfaceMix } from "@gamespace/env";

/**
 * Трасса процедурная: карт нет, ассетов нет, сеть не нужна. Форма сегмента —
 * чистая функция от seed и номера, поэтому и физика, и сцена спрашивают одно и
 * то же и получают один и тот же ответ, а повтор журнала едет по той же дороге.
 *
 * Осевая линия одна на всех и посчитана шагом два метра, а не десять. Раньше
 * геометрия строилась прямыми хордами по сегментам, и поворот читался как ломаная
 * из десятиметровых звеньев. Кривизна при этом всегда была гладкой — не хватало
 * только разрешения, поэтому лечится это шагом, а не новой математикой.
 *
 * Дорога — единственное место, которое знает, где какое покрытие лежит. Сами
 * покрытия и их свойства живут в среде (`@gamespace/env`): что такое гравий,
 * верно и вне этой трассы, а вот что он лежит полосой в пять метров от кромки —
 * устройство именно этого мира.
 */

/** Длина сегмента, метры: единица формы дороги, зачёта и коллайдеров. */
export const SEGMENT_M = 10;
/** Шаг геометрии, метры: и лента сцены, и коллизионная сетка идут по нему. */
export const FINE_M = 2;
export const FINE_PER_SEGMENT = SEGMENT_M / FINE_M;
/** Через сколько сегментов задаётся новая опорная точка формы дороги. */
export const CONTROL_SPAN = 12;
/** Сколько сегментов в зачётном секторе: единица исхода и запроса сложности. */
export const SECTOR_SEGMENTS = 25;
/**
 * Дорога существует и до нулевого метра: машина стоит на старте, а камера смотрит
 * на неё сзади. Восемьдесят метров позади старта хватает любому ракурсу.
 */
export const FINE_ORIGIN = -40;
/**
 * Смена формы дороги вступает в силу настолько сегментов впереди, чтобы затронуть
 * только то, чего ещё никто не построил: горизонт сцены — семьсот метров, поэтому
 * восемьсот. Иначе новая кривизна переписала бы участок, по которому машина уже
 * едет, и мир дёрнулся бы под колёсами — ровно то, что выглядело как сброс вида.
 */
export const STAMP_LEAD_SEGMENTS = 80;
/** Через сколько сегментов новая форма вступает в силу полностью. */
const BLEND_SEGMENTS = 8;

export interface TrackShape {
  /** Кривизна, 1/м: 0.02 — это поворот радиусом 50 м. */
  curveRate: number;
  /** Уклон как тангенс: 0.08 — это восемь процентов. */
  gradeMax: number;
}

export interface TrackSegment {
  curvature: number;
  grade: number;
}

/**
 * Форма дороги с такого-то сегмента. Уровень сложности не переписывает трассу
 * целиком, а дописывает историю: пройденное остаётся таким, каким его проехали.
 */
export interface ShapeStamp extends TrackShape {
  fromSegment: number;
  halfWidth: number;
}

export interface FinePoint {
  x: number;
  y: number;
  z: number;
  /** Курс в радианах. Тригонометрия тут законна: до бита её точность не нужна. */
  h: number;
  curvature: number;
  grade: number;
  halfWidth: number;
  /** Что творится по краям дороги в этом месте: канава, уровень травы, вал. */
  verge: Verge;
}

/**
 * Обочина в этом месте трассы, по стороне. Хранится в точке осевой линии, потому
 * что спрашивают её двое — коллизионная сетка и лента в сцене, — и разойтись им
 * нельзя: колёса поедут по невидимой земле.
 */
export interface Verge {
  left: VergeSide;
  right: VergeSide;
}

export interface VergeSide {
  /** Высота кромки гравия относительно асфальта: обочина всегда ниже полосы. */
  shoulderDy: number;
  /** Дно кюветa. */
  ditchDy: number;
  /** Уровень травы у подошвы вала. */
  grassDy: number;
  /** Гребень вала. */
  bermDy: number;
}

/**
 * Кусочно-гладкий шум: опорные точки через `CONTROL_SPAN` сегментов и сглаживание
 * t²(3−2t) между ними. Номер сегмента может быть дробным — тогда шум и есть та
 * непрерывная функция пути, по которой геометрия идёт мелким шагом.
 */
function noiseAt(seed: number, index: number, salt: number, span = CONTROL_SPAN): number {
  const control = Math.floor(index / span);
  const t = (index - control * span) / span;
  const a = hash01(seed, control, salt) * 2 - 1;
  const b = hash01(seed, control + 1, salt) * 2 - 1;
  return a + (b - a) * smoothstep(t);
}

export function trackAt(seed: number, index: number, shape: TrackShape): TrackSegment {
  return {
    curvature: noiseAt(seed, index, 1) * shape.curveRate,
    grade: noiseAt(seed, index, 2) * shape.gradeMax,
  };
}

export function segmentIndexAt(distanceM: number): number {
  return Math.floor(distanceM / SEGMENT_M);
}

export function sectorIndexAt(distanceM: number): number {
  return Math.floor(segmentIndexAt(distanceM) / SECTOR_SEGMENTS);
}

/** Форма на дробном сегменте: между отметками она переходит плавно, а не ступенькой. */
export function shapeAt(stamps: readonly ShapeStamp[], segment: number): ShapeStamp {
  if (stamps.length === 0) return { fromSegment: 0, curveRate: 0, gradeMax: 0, halfWidth: 6 };
  let index = 0;
  for (let i = 0; i < stamps.length; i++) if (stamps[i]!.fromSegment <= segment) index = i;
  const current = stamps[index]!;
  if (index === 0) return current;
  const previous = stamps[index - 1]!;
  const t = Math.min(1, Math.max(0, (segment - current.fromSegment) / BLEND_SEGMENTS));
  const w = smoothstep(t);
  const mix = (a: number, b: number) => a + (b - a) * w;
  return {
    fromSegment: current.fromSegment,
    curveRate: mix(previous.curveRate, current.curveRate),
    gradeMax: mix(previous.gradeMax, current.gradeMax),
    halfWidth: mix(previous.halfWidth, current.halfWidth),
  };
}

/**
 * Осевая линия, посчитанная один раз и на всех: коллизионная сетка в ядре и лента
 * в сцене обязаны совпадать до метра, иначе колёса поедут по невидимому асфальту.
 * Точки считаются вперёд по требованию и выбрасываются позади: назад машина не
 * едет, поэтому память не растёт вместе с заездом.
 */
export class Centerline {
  private points: FinePoint[] = [];
  private first = FINE_ORIGIN;
  private stamps: ShapeStamp[] = [];

  constructor(private readonly seed: number) {}

  /**
   * История формы дороги. Отметка, попавшая в уже построенный участок, — это ошибка
   * вызывающего: она означала бы, что дорогу переписали под машиной. На всякий
   * случай такой случай обрабатывается пересчётом, а не молчаливым расхождением
   * геометрии между физикой и картинкой.
   */
  applyStamps(stamps: readonly ShapeStamp[]): void {
    const changedFrom = firstDifference(this.stamps, stamps);
    this.stamps = stamps.map((s) => ({ ...s }));
    if (changedFrom === null) return;
    const builtTo = this.first + this.points.length - 1;
    if (changedFrom * FINE_PER_SEGMENT <= builtTo) {
      this.points = [];
      this.first = FINE_ORIGIN;
    }
  }

  /** Точка осевой линии по номеру мелкого шага. Считается вперёд, если её ещё нет. */
  at(fine: number): FinePoint {
    const index = Math.max(FINE_ORIGIN, Math.floor(fine));
    if (this.points.length === 0) {
      this.first = FINE_ORIGIN;
      this.points.push(this.seedPoint(this.first));
    }
    while (this.first + this.points.length <= index) {
      const previous = this.points[this.points.length - 1]!;
      this.points.push(this.next(previous, this.first + this.points.length));
    }
    const slot = index - this.first;
    return this.points[Math.max(0, Math.min(slot, this.points.length - 1))]!;
  }

  /** Точка по пройденному пути: между шагами линейно, шаг всего два метра. */
  atDistance(distanceM: number): FinePoint {
    const raw = distanceM / FINE_M;
    const index = Math.floor(raw);
    const t = raw - index;
    const a = this.at(index);
    const b = this.at(index + 1);
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      h: a.h + (b.h - a.h) * t,
      curvature: a.curvature,
      grade: a.grade,
      halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * t,
      verge: mixVerge(a.verge, b.verge, t),
    };
  }

  /** Забыть всё, что позади: заезд длинный, а вспоминать пройденное некому. */
  trim(keepFrom: number): void {
    const drop = keepFrom - this.first;
    if (drop < 500) return;
    this.points.splice(0, drop);
    this.first += drop;
  }

  private shapeFor(fine: number): ShapeStamp {
    return shapeAt(this.stamps, fine / FINE_PER_SEGMENT);
  }

  private seedPoint(fine: number): FinePoint {
    const shape = this.shapeFor(fine);
    const segment = trackAt(this.seed, fine / FINE_PER_SEGMENT, shape);
    return {
      x: 0,
      y: 0,
      z: fine * FINE_M,
      h: 0,
      curvature: segment.curvature,
      grade: segment.grade,
      halfWidth: shape.halfWidth,
      verge: vergeAt(this.seed, fine / FINE_PER_SEGMENT),
    };
  }

  /**
   * Шаг интегрирования. Курс поворачивается на кривизну, высота идёт за уклоном:
   * дорога получается той же, что и раньше, но с пятикратным разрешением, и
   * поворот перестаёт быть ломаной.
   */
  private next(previous: FinePoint, fine: number): FinePoint {
    const shape = this.shapeFor(fine);
    const segment = trackAt(this.seed, fine / FINE_PER_SEGMENT, shape);
    const h = previous.h + previous.curvature * FINE_M;
    return {
      x: previous.x + Math.sin(h) * FINE_M,
      y: previous.y + previous.grade * FINE_M,
      z: previous.z + Math.cos(h) * FINE_M,
      h,
      curvature: segment.curvature,
      grade: segment.grade,
      halfWidth: shape.halfWidth,
      verge: vergeAt(this.seed, fine / FINE_PER_SEGMENT),
    };
  }
}

function firstDifference(before: readonly ShapeStamp[], after: readonly ShapeStamp[]): number | null {
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const a = before[i];
    const b = after[i];
    if (!a || !b) return (b ?? a)!.fromSegment;
    if (a.fromSegment !== b.fromSegment || a.curveRate !== b.curveRate || a.gradeMax !== b.gradeMax || a.halfWidth !== b.halfWidth) {
      return b.fromSegment;
    }
  }
  return null;
}

/** Обочина: за полосой, но ещё едется. Дальше трава. */
export const SHOULDER_M = 5;
/** Сколько травы за обочиной до земляного вала. */
const GRASS_M = 10;
/** Где кювет: столько метров от кромки гравия в траву. */
const DITCH_AT_M = 3.5;
/**
 * Обочина по сторонам дороги.
 *
 * Обе обочины были одной ровной лентой с уклоном в полтора сантиметра на метр —
 * одинаковой слева и справа, одинаковой всю дорогу. На картинке это читается
 * газоном при коттедже, а не краем шоссе: настоящая обочина живёт своей жизнью,
 * у неё есть кювет, он то глубже, то мельче, трава за ним идёт волной, а вал по
 * сторонам поднимается неровно.
 *
 * Считается всё тем же гладким шумом, что и сама дорога, но на своей длине волны:
 * форма трассы меняется раз в сто двадцать метров, обочина — вчетверо чаще, иначе
 * на скорости её просто не видно. Стороны берут разные соли: одинаковые слева и
 * справа кюветы выглядели бы каналом, а не дорогой.
 *
 * Глубина кювета выбрана из того, что из него надо выезжать: полметра на три с
 * половиной — это уклон один к семи, машина такой берёт внатяг. Глубже — и съезд
 * с полосы перестал бы стоить скорости и начал бы стоить заезда.
 */
const VERGE_SPAN = 3;
const DITCH_MAX_M = 0.55;
const GRASS_WAVE_M = 0.45;
const BERM_WAVE_M = 0.7;

function vergeSide(seed: number, index: number, salt: number): VergeSide {
  const shoulderDy = -0.06 - 0.04 * (noiseAt(seed, index, salt, VERGE_SPAN) + 1);
  // Кювет есть не везде: на половине трассы шум ниже нуля, и там просто понижение.
  const dig = Math.max(0, noiseAt(seed, index, salt + 1, VERGE_SPAN));
  const ditchDy = shoulderDy - 0.12 - DITCH_MAX_M * dig;
  const grassDy = -0.15 + GRASS_WAVE_M * noiseAt(seed, index, salt + 2, VERGE_SPAN);
  const bermDy = BERM_H + BERM_WAVE_M * noiseAt(seed, index, salt + 3, VERGE_SPAN);
  return { shoulderDy, ditchDy, grassDy, bermDy };
}

export function vergeAt(seed: number, index: number): Verge {
  return { left: vergeSide(seed, index, 41), right: vergeSide(seed, index, 51) };
}

function mixSide(a: VergeSide, b: VergeSide, t: number): VergeSide {
  return {
    shoulderDy: a.shoulderDy + (b.shoulderDy - a.shoulderDy) * t,
    ditchDy: a.ditchDy + (b.ditchDy - a.ditchDy) * t,
    grassDy: a.grassDy + (b.grassDy - a.grassDy) * t,
    bermDy: a.bermDy + (b.bermDy - a.bermDy) * t,
  };
}

function mixVerge(a: Verge, b: Verge, t: number): Verge {
  return { left: mixSide(a.left, b.left, t), right: mixSide(a.right, b.right, t) };
}
/**
 * Вал по краям коридора: он и держит машину в мире вместо отбойника. Склон
 * пологий — примерно один к четырём. Раньше вал поднимался на три метра за шесть
 * и стоял вплотную к обочине: машина влетала в него как в трамплин и кувыркалась,
 * а вылет с полосы превращался из потери скорости в конец заезда.
 */
const BERM_M = 6;
const BERM_H = 2;
/** Плоская даль за валом: только для картинки, колёса туда не доезжают. */
const APRON_M = 90;
/**
 * Лента рельефа складывается сама на себя, если её полуширина больше радиуса
 * поворота: крылья соседних сечений пересекаются, и на уклоне трава из сегмента
 * впереди оказывается выше асфальта под машиной — так и появлялся зелёный клин,
 * перерезавший полотно. Поэтому дальний край ограничен долей местного радиуса.
 * Проезжая часть коридора под это ограничение не попадает никогда: она уже вала.
 */
const TERRAIN_SAFETY = 0.7;

export interface CrossCut {
  lateral: number;
  dy: number;
}

/**
 * Поперечный профиль дороги. Одна и та же функция даёт и коллизионную сетку в
 * физике, и ленты в сцене — иначе колёса поедут по невидимому асфальту, а видимая
 * трава окажется выше настоящей.
 *
 * Раскладка постоянная, от левого гребня к правому, и сцена берёт точки по номеру:
 * гребень вала, трава у подошвы, дно кювета, кромка гравия, кромка асфальта — и
 * то же самое зеркально. Постоянство тут не украшение: по этому же массиву
 * строится треугольная сетка коллайдера, а у неё ширина полосы вершин задана раз
 * на сегмент.
 */
export const CUT_BERM_L = 0;
export const CUT_GRASS_L = 1;
export const CUT_DITCH_L = 2;
export const CUT_SHOULDER_L = 3;
export const CUT_ROAD_L = 4;
export const CUT_ROAD_R = 5;
export const CUT_SHOULDER_R = 6;
export const CUT_DITCH_R = 7;
export const CUT_GRASS_R = 8;
export const CUT_BERM_R = 9;

export function crossSection(halfWidth: number, verge: Verge): CrossCut[] {
  const gravel = halfWidth + SHOULDER_M;
  const ditch = gravel + DITCH_AT_M;
  const off = halfWidth + SHOULDER_M + GRASS_M;
  const berm = off + BERM_M;
  const { left, right } = verge;
  return [
    { lateral: -berm, dy: left.bermDy },
    { lateral: -off, dy: left.grassDy },
    { lateral: -ditch, dy: left.ditchDy },
    { lateral: -gravel, dy: left.shoulderDy },
    { lateral: -halfWidth, dy: 0 },
    { lateral: halfWidth, dy: 0 },
    { lateral: gravel, dy: right.shoulderDy },
    { lateral: ditch, dy: right.ditchDy },
    { lateral: off, dy: right.grassDy },
    { lateral: berm, dy: right.bermDy },
  ];
}

/**
 * Высота земли на заданном отступе от осевой: тот же профиль, но между его точками.
 * Нужна всему, что стоит на земле, а не на асфальте: без неё придорожная обстановка
 * ставится с поправкой «на глаз», и на склоне вала деревья висят в воздухе или тонут
 * в земле.
 */
export function groundDy(point: FinePoint, lateral: number): number {
  const cuts = crossSection(point.halfWidth, point.verge);
  if (lateral <= cuts[0]!.lateral) return cuts[0]!.dy;
  for (let i = 1; i < cuts.length; i++) {
    const from = cuts[i - 1]!;
    const to = cuts[i]!;
    if (lateral > to.lateral) continue;
    const span = to.lateral - from.lateral;
    const t = span < 1e-6 ? 0 : (lateral - from.lateral) / span;
    return from.dy + (to.dy - from.dy) * t;
  }
  return cuts[cuts.length - 1]!.dy;
}

/**
 * Покрытие на заданном отступе от осевой.
 *
 * До сих пор профиль знал только высоту, а из чего сделана земля, знала одна
 * сцена — по номерам точек профиля она выбирала текстуру. Физике доставалось
 * единственное число «насколько машина вне полосы», посчитанное по середине
 * кузова, и оно решало всё: машина, стоящая правыми колёсами на асфальте, а
 * левыми в траве, считалась наполовину в траве всеми четырьмя.
 *
 * Теперь покрытие спрашивают под каждым колесом, и разница видна сразу: съезд на
 * обочину одной стороной разворачивает машину, потому что на этой стороне
 * держат хуже. Именно так это и работает на настоящей дороге, и это первое, что
 * узнаёшь, зацепив обочину.
 *
 * Границы намеренно размыты (`BLEND_M`): кромка асфальта в жизни не нож, а
 * полметра выкрошенного края, и скачок сцепления в одном сантиметре дал бы не
 * реализм, а дребезг на границе.
 */
/** Ширина перехода между покрытиями, метры. */
const BLEND_M = 0.5;

export function surfaceAt(point: FinePoint, lateral: number): SurfaceMix {
  const away = Math.abs(lateral);
  const edge = point.halfWidth;
  const gravel = edge + SHOULDER_M;
  const ramp = (at: number): number => (away - (at - BLEND_M)) / (2 * BLEND_M);
  if (away < edge - BLEND_M) return { kind: "asphalt", next: "asphalt", blend: 0 };
  if (away < edge + BLEND_M) return { kind: "asphalt", next: "gravel", blend: ramp(edge) };
  if (away < gravel - BLEND_M) return { kind: "gravel", next: "gravel", blend: 0 };
  if (away < gravel + BLEND_M) return { kind: "gravel", next: "grass", blend: ramp(gravel) };
  return { kind: "grass", next: "grass", blend: 0 };
}

/**
 * Граница мира: гребень вала. Дальше земли нет ни в физике, ни в картинке — там
 * только далёкая подложка для глаза, и машине туда нельзя. Ядро по этому числу
 * возвращает уехавшую машину на дорогу, не дожидаясь, пока она куда-то упадёт.
 */
export function corridorHalfWidth(halfWidth: number): number {
  return halfWidth + SHOULDER_M + GRASS_M + BERM_M;
}

/** Насколько далеко видно землю за валом: на вираже меньше, иначе лента себя перекроет. */
export function apronWidth(halfWidth: number, curvature: number): number {
  const berm = halfWidth + SHOULDER_M + GRASS_M + BERM_M;
  return Math.max(berm + 1, Math.min(APRON_M, TERRAIN_SAFETY / Math.max(Math.abs(curvature), 1e-4)));
}

/** Поперечное смещение точки от осевой линии: нормаль к курсу, высота не участвует. */
export function lateralOffset(point: FinePoint, lateral: number): { x: number; y: number; z: number } {
  return { x: point.x + Math.cos(point.h) * lateral, y: point.y, z: point.z - Math.sin(point.h) * lateral };
}

/** Поперечное положение мировой точки относительно осевой: знак — сторона дороги. */
export function lateralOf(point: FinePoint, x: number, z: number): number {
  return (x - point.x) * Math.cos(point.h) - (z - point.z) * Math.sin(point.h);
}
