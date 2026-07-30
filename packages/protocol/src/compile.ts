import Ajv from "ajv";
import {
  AdaptiveStaircase,
  Fixed,
  Manual,
  Monotonic,
  type DifficultyPolicy,
  type GameRegistry,
  type Params,
  type ValidationReport,
} from "@gamespace/core";
import schema from "../schema/protocol.schema.json" with { type: "json" };
import type { Difficulty, Protocol, Section, Termination } from "./protocol.types.js";
import type { SectionSpec } from "./runner.js";
import { byRuns, byTime, firstOf, runNoLongerThan, type TerminationPolicy } from "./termination.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema as object);

/**
 * Протокол проверяется целиком до старта: несуществующая игра, параметр вне
 * схемы или неизвестная стратегия обязаны всплыть на экране оператора, а не
 * через полчаса после начала сессии.
 */
export function validateProtocol(doc: unknown, registry?: GameRegistry): ValidationReport {
  if (!validateSchema(doc)) {
    return {
      ok: false,
      issues: (validateSchema.errors ?? []).map((e) => ({
        code: "manifest_invalid" as const,
        message: `${e.instancePath || "/"} ${e.message ?? "не проходит схему"}`,
      })),
    };
  }
  const protocol = doc as Protocol;
  const issues: ValidationReport["issues"] = [];
  const ids = new Set<string>();
  for (const section of protocol.sections) {
    if (ids.has(section.id)) issues.push({ code: "manifest_invalid", message: `Участок ${section.id} объявлен дважды` });
    ids.add(section.id);
    for (const gameId of section.games) {
      if (registry && !registry.has(gameId)) {
        issues.push({ code: "child_missing", message: `Участок ${section.id}: игра ${gameId} не зарегистрирована` });
      }
    }
  }
  for (const id of protocol.counterbalance?.swap ?? []) {
    if (!ids.has(id)) issues.push({ code: "manifest_invalid", message: `Контрбалансировка ссылается на участок ${id}, которого нет` });
  }
  return { ok: issues.length === 0, issues };
}

export function terminationOf(spec: Termination): TerminationPolicy {
  switch (spec.by) {
    case "time":
      return byTime(spec.ms);
    case "runs":
      return byRuns(spec.count);
    case "run-limit":
      return runNoLongerThan(spec.ms);
    case "first":
      return firstOf(...spec.of.map(terminationOf));
  }
}

export function policyOf(spec: Difficulty | undefined, maxLevel: number): DifficultyPolicy {
  const max = spec?.max ?? maxLevel;
  const base = { start: spec?.start ?? 1, min: spec?.min ?? 1, max };
  switch (spec?.policy) {
    case "adaptive":
      return new AdaptiveStaircase(base);
    case "manual":
      return new Manual(base);
    case "fixed":
      return new Fixed(spec.start ?? 1);
    case "monotonic":
    default:
      return new Monotonic({ ...base, successesToAdvance: spec?.successesToAdvance ?? 2 });
  }
}

/** Устойчивый хеш строки: порядок участков обязан повторяться от запуска к запуску. */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export interface CompiledProtocol {
  protocol: Protocol;
  sessionId: string;
  seed: number;
  sections: SectionSpec[];
  /** Порядок участков после контрбалансировки: показывается оператору до старта. */
  order: string[];
  policyFor(gameId: string, sectionId?: string): DifficultyPolicy;
}

export interface CompileOptions {
  participantId: string;
  registry: GameRegistry;
  /** Переопределение времени участков оператором: id участка → миллисекунды. */
  durations?: Record<string, number>;
}

export class ProtocolError extends Error {
  constructor(readonly report: ValidationReport) {
    super(`Протокол не принят: ${report.issues.map((i) => i.message).join("; ")}`);
    this.name = "ProtocolError";
  }
}

/**
 * Документ протокола превращается в список участков для раннера. Здесь же
 * решается порядок AB/BA — по идентификатору участника, а не броском монеты,
 * иначе баланс между участниками не воспроизвести.
 */
export function compileProtocol(doc: unknown, options: CompileOptions): CompiledProtocol {
  const report = validateProtocol(doc, options.registry);
  if (!report.ok) throw new ProtocolError(report);
  const protocol = doc as Protocol;

  const sections = [...protocol.sections];
  const swap = protocol.counterbalance?.swap;
  if (swap) {
    const [a, b] = swap as [string, string];
    const ia = sections.findIndex((s) => s.id === a);
    const ib = sections.findIndex((s) => s.id === b);
    if (ia >= 0 && ib >= 0 && hashString(`${protocol.id}:${options.participantId}`) % 2 === 1) {
      [sections[ia], sections[ib]] = [sections[ib]!, sections[ia]!];
    }
  }

  const policies = new Map<string, DifficultyPolicy>();
  const policyFor = (gameId: string, sectionId?: string): DifficultyPolicy => {
    const sectionSpec = sections.find((s) => s.id === sectionId)?.difficulty;
    // Уровень принадлежит задаче, а не участку: он переживает переходы.
    const key = sectionSpec ? `${sectionId}:${gameId}` : gameId;
    let policy = policies.get(key);
    if (!policy) {
      const levels = options.registry.resolve(gameId).manifest.levels.count;
      policy = policyOf(sectionSpec ?? protocol.difficulty, levels);
      policies.set(key, policy);
    }
    return policy;
  };

  return {
    protocol,
    sessionId: `${protocol.id}-${options.participantId}`,
    seed: protocol.seed ?? hashString(`${protocol.id}:${options.participantId}`) % 1_000_000,
    order: sections.map((s) => s.id),
    sections: sections.map((section) => toSpec(section, options.durations?.[section.id])),
    policyFor,
  };
}

function toSpec(section: Section, durationMs?: number): SectionSpec {
  const end = durationMs === undefined ? section.end : withDuration(section.end, durationMs);
  return {
    id: section.id,
    games: section.games,
    end: terminationOf(end),
    ...(section.overrides ? { overrides: section.overrides as Record<string, Params> } : {}),
    ...(section.training === undefined ? {} : { training: section.training }),
  };
}

/** Оператор правит длительность участка, а не его структуру. */
function withDuration(spec: Termination, ms: number): Termination {
  if (spec.by === "time") return { by: "time", ms };
  if (spec.by === "first") return { by: "first", of: spec.of.map((x) => withDuration(x, ms)) as typeof spec.of };
  return spec;
}

/** Ожидаемая длительность участка: для предпросмотра расписания оператору. */
export function plannedMs(spec: Termination): number | null {
  switch (spec.by) {
    case "time":
      return spec.ms;
    case "first": {
      const known = spec.of.map(plannedMs).filter((x): x is number => x !== null);
      return known.length > 0 ? Math.min(...known) : null;
    }
    default:
      return null;
  }
}
