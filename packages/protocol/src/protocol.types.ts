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
  };
  /**
   * @minItems 1
   */
  sections: [Section, ...Section[]];
}
export interface Difficulty {
  policy: "monotonic" | "adaptive" | "manual" | "fixed";
  start?: number;
  min?: number;
  max?: number;
  successesToAdvance?: number;
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
