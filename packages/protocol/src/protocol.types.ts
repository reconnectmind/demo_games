/* Сгенерировано из schema/protocol.schema.json. Не редактировать вручную: npm run gen:protocol-types */

export type Termination =
  | {
      by: "time";
      ms: number;
    }
  | {
      by: "runs";
      count: number;
    }
  | {
      by: "coverage";
    }
  | {
      by: "run-limit";
      ms: number;
    }
  | {
      by: "first";
      /**
       * @minItems 2
       */
      of: [Termination, Termination, ...Termination[]];
    };

/**
 * Сценарий эксперимента: что запускается, с какой сложностью и чем заканчивается. Приложение не содержит расписания, оно исполняет этот документ.
 */
export interface Protocol {
  protocolVersion: string;
  id: string;
  title: string;
  /**
   * Общий seed сессии; при отсутствии выводится из participantId
   */
  seed?: number;
  locale?: string;
  difficulty?: Difficulty;
  /**
   * Чем участник отвечает во всём протоколе. Ёмкость ответа — свойство стенда, а не модуля: из неё выводится и раздача клавиш, и предел по оси числа вариантов
   */
  interaction?: {
    /**
     * Клавиши ответа слева направо; при отсутствии действуют привязки из манифестов
     *
     * @minItems 1
     */
    keys?: [string, ...string[]];
    /**
     * task-only оставляет мышь только там, где указание — существо задачи (зрительный поиск)
     */
    pointer?: "free" | "task-only";
  };
  /**
   * Порядок двух участков назначается воспроизводимо по participantId, а не заново рандомизируется
   */
  counterbalance?: {
    /**
     * Идентификаторы участков, которые меняются местами у половины участников
     *
     * @minItems 2
     * @maxItems 2
     */
    swap: [string, string];
    pause?: Screen;
  };
  /**
   * Экраны сессии в целом. Тексты живут в документе протокола, а не в коде: их правит тот, кто ведёт эксперимент
   */
  interstitials?: {
    intro?: Screen;
    outro?: Screen;
  };
  /**
   * Закрепления на весь протокол по идентификатору модуля, в том числе для дочерних задач составных игр. Участок вправе их переопределить
   */
  overrides?: {
    [k: string]: {
      [k: string]: number | string | boolean;
    };
  };
  /**
   * @minItems 1
   */
  sections: [Section, ...Section[]];
}
export interface Difficulty {
  policy: "monotonic" | "adaptive" | "manual" | "fixed";
  /**
   * Нулевой уровень законен и означает обучающий: он объявлен в таблицах пресетов как шаг назад от первого
   */
  start?: number;
  min?: number;
  max?: number;
  successesToAdvance?: number;
}
/**
 * Отбивка: экран между блоками — что кончилось, что начинается, сколько займёт, как себя вести. Листает оператор, а не участник: случайное нажатие не должно проматывать инструкцию. Пауза контрбалансированной пары привязана к позиции, а не к участку, потому что какой из двух блоков идёт вторым, решает жребий по участнику
 */
export interface Screen {
  title: string;
  /**
   * @minItems 1
   */
  body: [string, ...string[]];
  /**
   * Строка про то, кто продолжает; по умолчанию про оператора
   */
  footer?: string;
}
export interface Section {
  id: string;
  /**
   * Одна игра или ротация: прогоны идут по кругу, пока участок не закончится
   *
   * @minItems 1
   */
  games: [string, ...string[]];
  end: Termination;
  interstitial?: Screen;
  training?: boolean;
  difficulty?: Difficulty;
  /**
   * Параметры поверх выданных политикой, по идентификатору игры
   */
  overrides?: {
    [k: string]: {
      [k: string]: number | string | boolean;
    };
  };
}
