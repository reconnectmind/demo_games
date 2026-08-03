/**
 * Габариты машины. Числа не выдуманы, а обмерены на самой модели при печати
 * (`tools/bake-car.mjs` пишет их в `assets/car.json`, раздел `model`), и тест
 * сверяет здешние литералы с тем файлом. Физика обязана совпадать с картинкой до
 * сантиметра: разъехавшись, колёса поедут рядом с арками или утонут в асфальте, и
 * никакой настройкой подвески это не лечится.
 *
 * Модуль ничего не импортирует: сюда смотрят и коробка, и физика, и сцена. Сама
 * модель здесь не нужна — сорок шесть килобайт сетки не место в пути ядра.
 */

/** Модель обмеряна в метрах и в натуральную величину: 4.79 м в длину. */
export const BODY_SCALE = 1;

/** Обмеры модели в метрах: копия раздела `model` из `car.json`. */
export const MODEL = {
  wheelRadius: 0.3699,
  /** Ось колеса над дорогой: у стоящей машины она равна радиусу. */
  hubY: 0.3699,
  /**
   * Оси от начала координат модели. База несимметрична, и это не мелочь: перед
   * вынесен вперёд сильнее, чем зад назад, и одним числом на обе оси колёса
   * встали бы мимо арок.
   */
  hubFrontZ: 1.4569,
  hubBackZ: 1.3931,
  /** Половина колеи: середина колеса по ширине машины. */
  wheelX: 0.85,
  bodyMin: [-1.1239, 0.1519, -2.3974],
  bodyMax: [1.1239, 1.7093, 2.3974],
  /** Полуширина кузова без зеркал: габарит с ними для коллайдера не годится. */
  hullX: 1.0114,
} as const;

export const WHEEL_RADIUS_M = MODEL.wheelRadius * BODY_SCALE;
export const WHEEL_X = MODEL.wheelX * BODY_SCALE;
export const WHEEL_FRONT_Z = MODEL.hubFrontZ * BODY_SCALE;
export const WHEEL_BACK_Z = MODEL.hubBackZ * BODY_SCALE;
/** Колёсная база: по ней считается предел руля, а не по половине габарита. */
export const WHEELBASE_M = WHEEL_FRONT_Z + WHEEL_BACK_Z;

/** Габарит кузова в метрах, считая от начала координат модели на уровне дороги. */
export const BODY_MIN_M = MODEL.bodyMin.map((v) => v * BODY_SCALE) as [number, number, number];
export const BODY_MAX_M = MODEL.bodyMax.map((v) => v * BODY_SCALE) as [number, number, number];

/** Снаряжённая масса Cayenne GTS — две с небольшим тонны, и физика об этом знает. */
export const MASS_KG = 2100;

/**
 * Начало координат кузова в физике — середина габаритной коробки модели. Отсюда и
 * высота посадки: это жёсткое смещение между телом физики и корнем модели, а не
 * положение подвески, поэтому оно не зависит от того, как машина просела.
 */
export const RIDE_HEIGHT_M = (BODY_MIN_M[1] + BODY_MAX_M[1]) / 2;

/**
 * Коллайдер кузова чуть меньше видимого силуэта: иначе машина цепляется за
 * рельеф раньше, чем этого ждёшь по картинке.
 */
const INSET_M = 0.06;
export const CHASSIS_HALF = {
  x: MODEL.hullX * BODY_SCALE - INSET_M,
  y: (BODY_MAX_M[1] - BODY_MIN_M[1]) / 2 - INSET_M,
  z: (BODY_MAX_M[2] - BODY_MIN_M[2]) / 2 - INSET_M,
};

/** Центр масс ниже геометрического: единственная дешёвая защита от кувырка. */
export const COM_DROP_M = 0.34;

/**
 * Длина подвески в равновесии под своим весом: обмерено на стоящей машине, тест
 * это и проверяет. Число нужно только для того, чтобы машина появлялась ровно на
 * дороге, а не роняла себя с полуметра на первом же шаге.
 */
export const SUSPENSION_REST_M = 0.35;
export const SUSPENSION_LOADED_M = 0.28;

/** Точка крепления подвески относительно начала координат кузова. */
export const MOUNT_Y = WHEEL_RADIUS_M + SUSPENSION_LOADED_M - RIDE_HEIGHT_M;

/**
 * Колёса в одном порядке у физики и у сцены: сначала передние (их и поворачивает
 * руль), потом задние. Знак X — сторона машины.
 */
export const WHEEL_MOUNTS: ReadonlyArray<readonly [number, number, number]> = [
  [-WHEEL_X, MOUNT_Y, WHEEL_FRONT_Z],
  [WHEEL_X, MOUNT_Y, WHEEL_FRONT_Z],
  [-WHEEL_X, MOUNT_Y, -WHEEL_BACK_Z],
  [WHEEL_X, MOUNT_Y, -WHEEL_BACK_Z],
];
