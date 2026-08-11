import Ajv from "ajv";
import presetsSchema from "../schema/presets.schema.json" with { type: "json" };
import type { Params } from "./contracts.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(presetsSchema as object);

/**
 * Чем ось нагружает участника. Роль важна не для красоты: когда протокол
 * закрепляет число вариантов ответа, расти обязаны именно остальные роли, и без
 * этого различения «степени свободы» — не определённое множество.
 */
export type ParamRole = "alternatives" | "speed" | "conflict" | "depth" | "duration";

/** Длина блока меняется по уровням, но нагрузкой не является: рост ею не оправдывается. */
export const LOAD_ROLES: ParamRole[] = ["alternatives", "speed", "conflict", "depth"];

export interface AxisPreset {
  role: ParamRole;
  /** Кривые по уровням: значение берётся по индексу `level - levels.min`. */
  curves: Record<string, Array<number | boolean>>;
}

export interface CompensationRule {
  whenFrozen: string;
  use: Record<string, string>;
}

export interface PresetTable {
  schemaVersion: number;
  levels: { min: number; max: number };
  constants?: Params;
  axes: Record<string, AxisPreset>;
  compensation?: CompensationRule[];
}

export function asPresets(data: unknown): PresetTable {
  if (!validate(data)) {
    const issues = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "недопустимо"}`);
    throw new Error(`Пресеты не проходят схему: ${issues.join("; ")}`);
  }
  const table = data as PresetTable;
  const span = table.levels.max - table.levels.min + 1;
  for (const [axis, preset] of Object.entries(table.axes)) {
    for (const [name, curve] of Object.entries(preset.curves)) {
      if (curve.length !== span) {
        throw new Error(`Кривая ${axis}.${name}: ${curve.length} значений на ${span} уровней`);
      }
    }
  }
  return table;
}

/**
 * Какие оси остаются свободными, если протокол закрепил перечисленные. Пустое
 * множество — не курьёз, а ошибка: уровень тогда не значит ничего, хотя политика
 * продолжает его повышать, а журнал — писать `difficulty.changed`.
 */
/**
 * Состав дочерних задач составной игры. Параметры протокола скалярны, поэтому
 * список приходит строкой имён через запятую и тем же путём, что все прочие
 * закрепления, — иначе для него пришлось бы заводить второй канал настройки.
 * Пустая строка означает весь состав из манифеста: «ничего не выбрано» и
 * «выбрано всё» для исследователя одно и то же, а прежнее усечение до первых
 * нескольких давало обратное — в конструкторе стояли все галочки, а в блоке шли
 * две задачи.
 * Неизвестное имя — ошибка на месте: молча выкинуть задачу из состава хуже, чем
 * не запуститься, потому что расхождение обнаружится только в записи.
 */
export function childSet(pool: readonly { id: string }[], tasks: string | undefined): string[] {
  const names = (tasks ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) return pool.map((child) => child.id);
  return names.map((name) => {
    const found = pool.find((child) => child.id === name || child.id.endsWith(`.${name}`));
    if (!found) throw new Error(`Задача «${name}» не объявлена дочерней у этого модуля`);
    return found.id;
  });
}

export function freeAxes(table: PresetTable, frozen: readonly string[]): string[] {
  return Object.keys(table.axes).filter(
    (axis) => !frozen.includes(axis) && LOAD_ROLES.includes(table.axes[axis]!.role),
  );
}

/** Какая кривая действует на каждой оси при этих закреплённых осях. */
export function curvesInUse(table: PresetTable, frozen: readonly string[]): Record<string, string> {
  const chosen: Record<string, string> = {};
  for (const axis of Object.keys(table.axes)) chosen[axis] = "base";
  for (const rule of table.compensation ?? []) {
    if (!frozen.includes(rule.whenFrozen)) continue;
    for (const [axis, curve] of Object.entries(rule.use)) {
      if (table.axes[axis]?.curves[curve]) chosen[axis] = curve;
    }
  }
  return chosen;
}

/**
 * Параметры уровня из таблицы. Закреплённые протоколом оси меняют не значение
 * своей оси — его всё равно перекроет `overrides`, — а то, какими кривыми идут
 * остальные: рост, потерянный на закреплённой оси, объявлен в таблице
 * компенсаций, а не вычислен на ходу.
 */
export function presetParams(table: PresetTable, level: number, frozen: readonly string[] = []): Params {
  const clamped = Math.min(table.levels.max, Math.max(table.levels.min, Math.round(level)));
  const index = clamped - table.levels.min;
  const chosen = curvesInUse(table, frozen);
  const params: Params = { ...(table.constants ?? {}) };
  for (const [axis, preset] of Object.entries(table.axes)) {
    const curve = preset.curves[chosen[axis] ?? "base"] ?? preset.curves.base!;
    params[axis] = curve[index]!;
  }
  return params;
}
