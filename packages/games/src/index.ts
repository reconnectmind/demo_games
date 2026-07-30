import type { Microgame } from "@gamespace/core";
import { stroop } from "./stroop/index.js";
import { ruleSwitch } from "./rule-switch/index.js";
import { arithmetic } from "./arithmetic/index.js";
import { nback } from "./n-back/index.js";
import { dualLoad } from "./dual-load/index.js";
import { numberSequence } from "./number-sequence/index.js";
import { squash } from "./squash/index.js";
import { baseline } from "./baseline/index.js";
import { adaptiveBattery } from "./adaptive-battery/index.js";
import { interruptResume } from "./interrupt-resume/index.js";

/**
 * Десять модулей протокола: шесть базовых механик, фоновая задача, покой и два
 * оркестратора. Общий каталог витрины переезжает отдельной фазой.
 */
export const protocolGames: Microgame<any, any>[] = [
  arithmetic,
  nback,
  stroop,
  ruleSwitch,
  dualLoad,
  numberSequence,
  squash,
  baseline,
  adaptiveBattery,
  interruptResume,
];

export {
  stroop,
  ruleSwitch,
  arithmetic,
  nback,
  dualLoad,
  numberSequence,
  squash,
  baseline,
  adaptiveBattery,
  interruptResume,
};
