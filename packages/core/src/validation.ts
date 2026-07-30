import Ajv from "ajv";
import manifestSchema from "../schema/manifest.schema.json" with { type: "json" };
import { RUNTIME_API_VERSION, type Manifest, type Params } from "./contracts.js";

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
