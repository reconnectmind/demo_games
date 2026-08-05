/* Сгенерировано из schema/manifest.schema.json. Не редактировать вручную: npm run gen:manifest-types */

/**
 * Декларация микроигры. Источник истины: типы генерируются отсюда, а не наоборот.
 */
export interface Manifest {
  id: string;
  version: string;
  schemaVersion: number;
  title: {
    ru: string;
    en?: string;
  };
  domains: string[];
  /**
   * Диапазон совместимости с runtime, например '>=1.0 <2'
   */
  runtimeApi: string;
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  parametersSchema: SchemaRef;
  eventsSchema: SchemaRef;
  resultSchema: SchemaRef;
  interaction: {
    schemaVersion: number;
    actions: ActionSpec[];
    signals: SignalSpec[];
  };
  timing: {
    profile: "relaxed" | "standard" | "strict";
    criticalOnsets: boolean;
    toleranceMs: number;
  };
  levels: {
    count: number;
    /**
     * Оси, по которым paramsForLevel обязана не убывать с ростом уровня
     */
    monotonicAxes: MonotonicAxis[];
  };
  /**
   * Какой параметр задаёт длину блока. Это расписание, а не сложность: хост показывает его отдельно и разрешает менять при любой политике
   */
  blockLength?: {
    /**
     * Имя свойства из parametersSchema
     */
    param: string;
    /**
     * ms — блок кончается по времени, count — по числу проб, эпизодов или подблоков
     */
    unit: "ms" | "count";
  };
  responseAlternatives?: ResponseAlternatives;
  resumable: boolean;
  training: {
    available: boolean;
    /**
     * Тот же критерий словами, для оператора и для отбивки
     */
    admissionCriterion?: string;
    admission?: Admission;
    rule?: Rule;
  };
  assets: {
    id: string;
    kind: "image" | "audio" | "font" | "data";
    path: string;
    sha256?: string;
  }[];
  locales: string[];
  integrity?: {
    manifestSha256: string;
    bundleSha256: string;
  };
  /**
   * Дочерние модули оркестратора. Пусто у обычных механик.
   */
  children?: {
    id: string;
    version: string;
    /**
     * Задачу будут прерывать и возвращать: она обязана быть resumable
     */
    requiresResume?: boolean;
  }[];
}
export interface SchemaRef {
  schemaVersion: number;
  schema: {};
}
export interface ActionSpec {
  id: string;
  label: string;
  defaultBinding: string;
  /**
   * Действие с выбором из списка: клавиши раздаёт хост, номер приходит в payload
   */
  indexed?: boolean;
  /**
   * Порядок клавиш для indexed-действия. letters-first нужен там, где сами варианты подписаны цифрами
   */
  indexKeyset?: "digits-first" | "letters-first";
  /**
   * Действие удерживается: хост присылает phase down и up, ядро само интегрирует удержание
   */
  holdable?: boolean;
  source?: "participant" | "signal-trigger";
}
export interface SignalSpec {
  id: string;
  unit: string;
  expectedHz: number;
  required: boolean;
  fallback?: "simulated" | "none";
}
export interface MonotonicAxis {
  param: string;
  /**
   * Куда движется параметр при росте уровня: увеличение или уменьшение нагрузки
   */
  direction: "increases" | "decreases";
}
/**
 * Сколько вариантов ответа у модуля и чем они адресуются. Ёмкость ответа объявляет протокол, поэтому модуль обязан сказать, какая его ось этой ёмкостью ограничена
 */
export interface ResponseAlternatives {
  /**
   * Имя свойства из parametersSchema, задающего число вариантов
   */
  param?: string;
  /**
   * Постоянное число вариантов, когда параметра для него нет
   */
  count?: number;
  /**
   * keys — вариант выбирается клавишей из объявленной ёмкости, pointer — указанием: ёмкость клавиш к таким вариантам не относится
   */
  addressedBy: "keys" | "pointer";
}
/**
 * Критерий допуска в проверяемом виде. Прозой он неисполним: нужно знать, что считается попыткой, сколько последних попыток берём и сколько из них должно быть верными
 */
export interface Admission {
  /**
   * Сколько последних зачётных исходов прогона берётся в окно
   */
  window: number;
  /**
   * Сколько из них должно быть верными. Проверяется по исходам, а не по сводке модуля
   */
  minCorrect: number;
  /**
   * Что считается попыткой: отдельная проба или эпизод механики — последовательность, блок, прерывание. Должно совпадать с зачётной единицей, которую модуль отдаёт исходом
   */
  counts?: "trial" | "episode";
  /**
   * При какой точности эпизод считается пройденным. Нужен там, где попытка — эпизод: у него нет «верно/неверно», есть доля
   */
  minAccuracy?: number;
  /**
   * Сколько прогонов даётся на выполнение критерия. Дальше обучение идёт вперёд, а участок помечает задачу как непройденную: держать участника на одной задаче до победы нельзя
   */
  maxAttempts: number;
}
/**
 * Экран правила перед первым стимулом обучения. Раскладку ответов дописывает хост: клавиши принадлежат протоколу, а не модулю
 */
export interface Rule {
  /**
   * Само правило, одной-двумя фразами
   */
  summary: string;
  /**
   * Пример стимула и правильного ответа
   */
  example: string;
  /**
   * Типичная ошибка, которую стоит назвать заранее
   */
  mistake?: string;
}
