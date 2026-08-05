import Ajv from "ajv";
import manifestSchema from "../schema/manifest.schema.json" with { type: "json" };
import { RUNTIME_API_VERSION, type Manifest, type Params } from "./contracts.js";
import { freeAxes, presetParams, type PresetTable } from "./presets.js";

export type PreflightCode =
  | "child_missing"
  | "manifest_invalid"
  | "schema_version_unsupported"
  | "runtime_update_required"
  | "capability_missing"
  | "parameters_invalid"
  | "asset_missing"
  | "not_resumable";

export interface ValidationIssue {
  code: PreflightCode;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

export const SUPPORTED_MANIFEST_SCHEMA_VERSION = 1;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateManifestSchema = ajv.compile(manifestSchema as object);

const ok: ValidationReport = { ok: true, issues: [] };
const fail = (issues: ValidationIssue[]): ValidationReport => ({ ok: issues.length === 0, issues });

/** Диапазон вида ">=1.0 <2" против версии API runtime. */
export function runtimeApiSatisfied(range: string, api = RUNTIME_API_VERSION): boolean {
  const m = /^>=(\d+)\.(\d+) <(\d+)$/.exec(range);
  if (!m) return false;
  const [, lowMajor, lowMinor, highMajor] = m.map(Number) as [number, number, number, number];
  const [major, minor] = api.split(".").map(Number) as [number, number];
  if (major < lowMajor || (major === lowMajor && minor < lowMinor)) return false;
  return major < highMajor;
}

export function validateManifest(manifest: unknown): ValidationReport {
  if (!validateManifestSchema(manifest)) {
    return fail(
      (validateManifestSchema.errors ?? []).map((e) => ({
        code: "manifest_invalid" as const,
        message: `${e.instancePath || "/"} ${e.message ?? "не проходит схему"}`,
      })),
    );
  }
  const m = manifest as Manifest;
  const issues: ValidationIssue[] = [];
  if (m.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA_VERSION) {
    issues.push({
      code: "schema_version_unsupported",
      message: `Манифест схемы v${m.schemaVersion}, runtime понимает v${SUPPORTED_MANIFEST_SCHEMA_VERSION}`,
    });
  }
  if (!runtimeApiSatisfied(m.runtimeApi)) {
    issues.push({
      code: "runtime_update_required",
      message: `Требуется runtime ${m.runtimeApi}, установлен ${RUNTIME_API_VERSION}`,
    });
  }
  return fail(issues);
}

/**
 * Полная проверка перед стартом: несовместимость обязана обнаружиться здесь,
 * а не в середине сорокаминутного запуска.
 */
export function preflight(input: {
  manifest: Manifest;
  params: Params;
  capabilities: string[];
  requireResumable?: boolean;
}): ValidationReport {
  const issues: ValidationIssue[] = [...validateManifest(input.manifest).issues];

  for (const cap of input.manifest.requiredCapabilities) {
    if (!input.capabilities.includes(cap)) {
      issues.push({ code: "capability_missing", message: `Нет обязательной capability: ${cap}` });
    }
  }

  if (input.requireResumable && !input.manifest.resumable) {
    issues.push({
      code: "not_resumable",
      message: `${input.manifest.id} объявлен resumable: false и не может быть дочерней задачей с возвратом`,
    });
  }

  issues.push(...validateParams(input.manifest, input.params).issues);
  return fail(issues);
}

/** Единственный законный способ превратить JSON в Manifest: с проверкой. */
export function asManifest(data: unknown): Manifest {
  const report = validateManifest(data);
  if (!report.ok) {
    throw new Error(`Манифест не проходит схему: ${report.issues.map((i) => i.message).join("; ")}`);
  }
  return data as Manifest;
}

/**
 * Оркестратор нельзя запускать, если его дети не зарегистрированы или не умеют
 * восстанавливаться: иначе прерывание провалится в середине сессии.
 */
export function preflightChildren(
  manifest: Manifest,
  lookup: (id: string, version: string) => Manifest | null,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  for (const child of manifest.children ?? []) {
    const childManifest = lookup(child.id, child.version);
    if (!childManifest) {
      issues.push({ code: "child_missing", message: `Дочерний модуль не зарегистрирован: ${child.id}@${child.version}` });
      continue;
    }
    if (child.requiresResume && !childManifest.resumable) {
      issues.push({
        code: "not_resumable",
        message: `${child.id} прерывается и возобновляется, но объявлен resumable: false`,
      });
    }
  }
  return fail(issues);
}

export function validateParams(manifest: Manifest, params: Params): ValidationReport {
  const validate = ajv.compile(manifest.parametersSchema.schema as object);
  if (validate(params)) return ok;
  return fail(
    (validate.errors ?? []).map((e) => ({
      code: "parameters_invalid" as const,
      message: `${e.instancePath || "/"} ${e.message ?? "недопустимо"}`,
    })),
  );
}

/**
 * Что протокол сделал со сложностью модуля: закрепил ли ось, влезает ли число
 * вариантов в объявленную ёмкость ответа и осталось ли чем расти. Всё это
 * обязано выясниться до старта сессии, а не через полчаса после начала.
 */
export function checkDifficultyFreedom(input: {
  manifest: Manifest;
  presets?: PresetTable;
  overrides?: Params;
  /** Сколько клавиш объявил протокол; без объявления ограничения нет. */
  keyCapacity?: number;
  /** Где это закрепление объявлено: попадёт в текст ошибки. */
  where?: string;
}): ValidationReport {
  const { manifest, presets, overrides = {}, keyCapacity, where } = input;
  const at = where ? `${where}: ` : "";
  const issues: ValidationIssue[] = [];
  const alternatives = manifest.responseAlternatives;

  // Ёмкость проверяется и без пресетов: число вариантов может быть постоянным.
  if (alternatives?.addressedBy === "keys" && keyCapacity !== undefined) {
    const pinned = alternatives.param ? overrides[alternatives.param] : undefined;
    const counts =
      typeof pinned === "number"
        ? [pinned]
        : alternatives.param && presets?.axes[alternatives.param]
          ? levelsOf(presets).map((level) => presetParams(presets, level)[alternatives.param!])
          : [alternatives.count ?? 1];
    for (const count of counts) {
      if (typeof count === "number" && count > keyCapacity) {
        issues.push({
          code: "parameters_invalid",
          message: `${at}${manifest.id}: вариантов ответа ${count}, а клавиш объявлено ${keyCapacity}`,
        });
        break;
      }
    }
  }

  if (!presets) return fail(issues);

  const frozen = Object.keys(overrides).filter((axis) => presets.axes[axis]);
  const free = freeAxes(presets, frozen);
  const loadAxes = freeAxes(presets, []);

  if (loadAxes.length > 0 && free.length === 0) {
    issues.push({
      code: "parameters_invalid",
      message: `${at}${manifest.id}: закреплены все оси нагрузки, уровень перестал что-либо значить`,
    });
  }

  // Уровень обязан менять хотя бы одну свободную ось: иначе политика повышает
  // его, журнал это записывает, а участник ничего не замечает.
  const levels = levelsOf(presets);
  for (let i = 1; i < levels.length; i++) {
    const before = presetParams(presets, levels[i - 1]!, frozen);
    const after = presetParams(presets, levels[i]!, frozen);
    if (free.length > 0 && free.every((axis) => before[axis] === after[axis])) {
      issues.push({
        code: "parameters_invalid",
        message: `${at}${manifest.id}: уровни ${levels[i - 1]} и ${levels[i]} не отличаются ни по одной свободной оси`,
      });
    }
  }

  // Монотонность закреплённой оси проверять нечего: её значение задано протоколом.
  for (const axis of manifest.levels.monotonicAxes) {
    if (frozen.includes(axis.param)) continue;
    const report = checkMonotonicAxes(
      { ...manifest, levels: { ...manifest.levels, monotonicAxes: [axis] } },
      (level) => presetParams(presets, level, frozen),
    );
    issues.push(...report.issues.map((issue) => ({ ...issue, message: `${at}${manifest.id}: ${issue.message}` })));
  }

  for (const level of levels) {
    const params = { ...presetParams(presets, level, frozen), ...overrides };
    issues.push(
      ...validateParams(manifest, params).issues.map((issue) => ({
        ...issue,
        message: `${at}${manifest.id} уровень ${level}: ${issue.message}`,
      })),
    );
  }

  return fail(issues);
}

function levelsOf(presets: PresetTable): number[] {
  const out: number[] = [];
  for (let level = presets.levels.min; level <= presets.levels.max; level++) out.push(level);
  return out;
}

/**
 * Монотонность проверяема только относительно объявленных осей: без них
 * рост уровня мог бы уменьшать отдельный параметр незаметно.
 */
export function checkMonotonicAxes(manifest: Manifest, paramsForLevel: (level: number) => Params): ValidationReport {
  const issues: ValidationIssue[] = [];
  for (const axis of manifest.levels.monotonicAxes) {
    let previous: number | null = null;
    for (let level = 1; level <= manifest.levels.count; level++) {
      const raw = paramsForLevel(level)[axis.param];
      if (typeof raw !== "number") {
        issues.push({ code: "parameters_invalid", message: `Ось ${axis.param} не число на уровне ${level}` });
        break;
      }
      if (previous !== null) {
        const grew = raw >= previous;
        const shrank = raw <= previous;
        const okStep = axis.direction === "increases" ? grew : shrank;
        if (!okStep) {
          issues.push({
            code: "parameters_invalid",
            message: `Ось ${axis.param} (${axis.direction}) нарушена между уровнями ${level - 1} и ${level}: ${previous} → ${raw}`,
          });
          break;
        }
      }
      previous = raw;
    }
  }
  return fail(issues);
}
