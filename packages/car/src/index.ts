/**
 * `@gamespace/car` — машина целиком: физика, привод, руль, шины, вид и звук.
 *
 * Пакет отвечает за автомобиль и только за него. Он не знает, где едет, зачем
 * едет и по каким правилам: дорога отвечает ему на единственный вопрос — что
 * под колесом (`CarGround`), — а всё остальное он считает сам. Поэтому его можно
 * поставить в другую игру, не разбирая: заезд с зачётом по КПД, гараж со стендом
 * или площадка без правил получат ту же машину.
 *
 * Внутри разделение такое: `geometry` — размеры и массы, `drivetrain` — мотор с
 * коробкой, `steering` — руль, `tire` — пятно контакта, `car` — кузов и колёса в
 * физическом мире, `view/*` — модель, следы, пыль и звук.
 */
export { createCar } from "./car.js";
export type { Car, CarControls, CarFrame, CarGround, CarPose, CarSave, WheelFrame } from "./car.js";
export {
  FINAL_DRIVE,
  GEAR_NEUTRAL,
  GEAR_REVERSE,
  REVERSE_RATIO,
  RPM_IDLE,
  RPM_MAX,
  RPM_PEAK,
  RPM_STALL,
  TORQUE_PEAK_NM,
  drivelineInertia,
  engineSettle,
  engineStep,
  geometricRpm,
  pumpingNm,
  ratioFor,
  ratiosFor,
  torqueAt,
} from "./drivetrain.js";
export type { Engine, EngineIn } from "./drivetrain.js";
export {
  BODY_SCALE,
  CHASSIS_HALF,
  MASS_KG,
  MODEL,
  RIDE_HEIGHT_M,
  SUSPENSION_LOADED_M,
  WHEELBASE_M,
  WHEEL_BACK_Z,
  WHEEL_FRONT_Z,
  WHEEL_MOUNTS,
  WHEEL_RADIUS_M,
  WHEEL_X,
} from "./geometry.js";
export { STEER_LOCK, steerLimit, steerNeutral, steerStep } from "./steering.js";
export {
  TIRE_COLD_C,
  WHEEL_INERTIA,
  flashC,
  heatStep,
  loadFactor,
  markAt,
  slideShare,
  smearAt,
  tempFactor,
  tireCurve,
  tireSlope,
  tireStep,
} from "./tire.js";
export type { TireOut, TireStep } from "./tire.js";
export { createCarModel } from "./view/model.js";
export type { CarModel } from "./view/model.js";
export { createTireMarks } from "./view/marks.js";
export type { TireMarks } from "./view/marks.js";
export { PUFFS, RATE_MAX, dustRate } from "./view/dust.js";
export type { Puff } from "./view/dust.js";
export { createPlume } from "./view/plume.js";
export type { Plume, WheelPlume } from "./view/plume.js";
export { createCarAudio } from "./view/audio.js";
export type { CarAudio } from "./view/audio.js";
export { CABIN, SILENCE, cabinLoss, easeSound, soundMix } from "./view/sound.js";
export type { SoundIn, SoundMix, WheelVoice } from "./view/sound.js";
