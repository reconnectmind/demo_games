import Ajv from "ajv";
import {
  AdaptiveStaircase,
  FREE_INPUT,
  checkDifficultyFreedom,
  Fixed,
  Manual,
  Monotonic,
  type Bounds,
  type DifficultyPolicy,
  type GameRegistry,
  type InputProfile,
  type Params,
  type ValidationReport,
} from "@gamespace/core";
import schema from "../schema/protocol.schema.json" with { type: "json" };
import type { Difficulty, Protocol, Section, Termination } from "./protocol.types.js";
// Экран отбивки объявлен у раннера: тип из схемы совпадает с ним по строению,
// а два одноимённых экспорта из пакета сбивали бы с толку.
import type { Screen, SectionSpec } from "./runner.js";
import { byCoverage, byRuns, byTime, firstOf, runNoLongerThan, type TerminationPolicy } from "./termination.js";

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
  const keyCapacity = protocol.interaction?.keys?.length;
  for (const section of protocol.sections) {
    if (ids.has(section.id)) issues.push({ code: "manifest_invalid", message: `Участок ${section.id} объявлен дважды` });
    ids.add(section.id);
    for (const gameId of section.games) {
      if (registry && !registry.has(gameId)) {
        issues.push({ code: "child_missing", message: `Участок ${section.id}: игра ${gameId} не зарегистрирована` });
        continue;
      }
      if (!registry) continue;
      // Проверяется и сама игра участка, и её дочерние задачи: закрепление
      // «цветов строго три» относится к stroop, а в расписании стоит батарея.
      for (const id of withChildren(gameId, registry)) {
        const game = registry.resolve(id);
        const overrides = overridesFor(id, protocol.overrides, section.overrides);
        const bounds = boundsFor(id, protocol.bounds, section.bounds);
        issues.push(
          ...checkDifficultyFreedom({
            manifest: game.manifest,
            ...(game.presets ? { presets: game.presets } : {}),
            ...(overrides ? { overrides } : {}),
            ...(bounds ? { bounds } : {}),
            ...(keyCapacity === undefined ? {} : { keyCapacity }),
            where: `участок ${section.id}`,
          }).issues,
        );
      }
    }
  }
  for (const id of protocol.counterbalance?.swap ?? []) {
    if (!ids.has(id)) issues.push({ code: "manifest_invalid", message: `Контрбалансировка ссылается на участок ${id}, которого нет` });
  }
  return { ok: issues.length === 0, issues };
}

/** Модуль вместе со своими дочерними задачами: закрепления касаются и тех, и других. */
function withChildren(gameId: string, registry: GameRegistry, seen = new Set<string>()): string[] {
  if (seen.has(gameId) || !registry.has(gameId)) return [];
  seen.add(gameId);
  const children = registry.resolve(gameId).manifest.children ?? [];
  return [gameId, ...children.flatMap((child) => withChildren(child.id, registry, seen))];
}

export function terminationOf(spec: Termination): TerminationPolicy {
  switch (spec.by) {
    case "time":
      return byTime(spec.ms);
    case "runs":
      return byRuns(spec.count);
    case "coverage":
      return byCoverage();
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
  /** Чем отвечает участник: из документа протокола, а не из настройки витрины. */
  input: InputProfile;
  sections: SectionSpec[];
  /** Порядок участков после контрбалансировки: показывается оператору до старта. */
  order: string[];
  /** Прощальный экран: участок его не показывает, сессия к этому моменту кончилась. */
  outro?: Screen;
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

  const outro = protocol.interstitials?.outro;
  return {
    protocol,
    sessionId: `${protocol.id}-${options.participantId}`,
    seed: protocol.seed ?? hashString(`${protocol.id}:${options.participantId}`) % 1_000_000,
    input: inputProfileOf(protocol),
    order: sections.map((s) => s.id),
    ...(outro ? { outro } : {}),
    sections: sections.map((section, index) =>
      toSpec(
        section,
        protocol,
        options.durations?.[section.id],
        screensFor(protocol, sections, section, index),
        options.registry,
      ),
    ),
    policyFor,
  };
}

/**
 * Экраны перед участком в порядке показа. Вводный экран сессии достаётся первому
 * участку, а пауза контрбалансированной пары — тому её блоку, который по жребию
 * оказался вторым: сама пауза принадлежит позиции в расписании, а не участку, и
 * приписать её в документе к `battery` или `interrupt` было бы неверно у половины
 * участников.
 */
function screensFor(protocol: Protocol, order: Section[], section: Section, index: number): Screen[] {
  const screens: Screen[] = [];
  if (index === 0 && protocol.interstitials?.intro) screens.push(protocol.interstitials.intro);
  const pause = protocol.counterbalance?.pause;
  const swap: string[] = protocol.counterbalance?.swap ?? [];
  if (pause && swap.includes(section.id)) {
    const firstOfPair = order.findIndex((s) => swap.includes(s.id));
    if (index > firstOfPair) screens.push(pause);
  }
  if (section.interstitial) {
    // Частями сессии считаются участки, у которых есть что сказать участнику.
    // Микропауза — не часть: участнику о ней не сообщают, и включать её в счёт
    // значило бы обещать пять частей там, где их четыре.
    const parts = order.filter((s) => s.interstitial);
    const place = parts.indexOf(section);
    screens.push(
      parts.length > 1
        ? { ...section.interstitial, position: `Часть ${place + 1} из ${parts.length}` }
        : section.interstitial,
    );
  }
  return screens;
}

/**
 * Закрепления протокола и участка на один модуль. Участок старше: он уточняет
 * общее правило, а не спорит с ним.
 */
export function overridesFor(
  gameId: string,
  root: Protocol["overrides"],
  section: Section["overrides"],
): Params | undefined {
  const merged = { ...(root?.[gameId] ?? {}), ...(section?.[gameId] ?? {}) };
  return Object.keys(merged).length > 0 ? (merged as Params) : undefined;
}

/**
 * Границы протокола и участка на один модуль. Правило то же, что у закреплений:
 * участок уточняет общее, причём по каждой оси отдельно — сузить одну ось,
 * оставив прочие как в протоколе, должно быть можно.
 */
export function boundsFor(
  gameId: string,
  root: Protocol["bounds"],
  section: Section["bounds"],
): Bounds | undefined {
  const axes = new Set([...Object.keys(root?.[gameId] ?? {}), ...Object.keys(section?.[gameId] ?? {})]);
  const merged: Bounds = {};
  for (const axis of axes) {
    merged[axis] = { ...(root?.[gameId]?.[axis] ?? {}), ...(section?.[gameId]?.[axis] ?? {}) };
  }
  return axes.size > 0 ? merged : undefined;
}

/**
 * Профиль ввода протокола. Без объявленной ёмкости остаётся свободная сборка:
 * это законно для витрины и одиночных запусков, но лабораторный протокол ёмкость
 * объявляет — иначе способ ответа задавали бы манифесты, каждый по-своему.
 */
export function inputProfileOf(protocol: Protocol): InputProfile {
  const keys = protocol.interaction?.keys ?? [];
  if (keys.length === 0) return FREE_INPUT;
  return {
    id: keys.join(""),
    keys: keys.map((k) => k.toUpperCase()),
    pointer: protocol.interaction?.pointer ?? "task-only",
  };
}

function toSpec(
  section: Section,
  root: Protocol,
  durationMs: number | undefined,
  screens: Screen[],
  registry?: GameRegistry,
): SectionSpec {
  const coverage = coversAll(section.end);
  const end = durationMs === undefined ? section.end : withDuration(section.end, durationMs, coverage);
  const ids = new Set([...Object.keys(root.overrides ?? {}), ...Object.keys(section.overrides ?? {})]);
  const overrides: Record<string, Params> = {};
  for (const id of ids) {
    const merged = overridesFor(id, root.overrides, section.overrides);
    if (merged) overrides[id] = merged;
  }
  // Укоротив участок, оператор укорачивает и блок игры, которая сама себе
  // отмеряет время. Иначе покой с таймером обещает участнику две минуты, а
  // расписание закрывает участок через тридцать секунд: на экране одно, в
  // журнале другое.
  if (durationMs !== undefined && registry) {
    for (const gameId of section.games) {
      const declared = registry.has(gameId) ? registry.resolve(gameId).manifest.blockLength : undefined;
      if (declared?.unit !== "ms") continue;
      const own = overrides[gameId]?.[declared.param];
      if (typeof own !== "number" || own <= durationMs) continue;
      overrides[gameId] = { ...overrides[gameId], [declared.param]: durationMs };
    }
  }
  const boundIds = new Set([...Object.keys(root.bounds ?? {}), ...Object.keys(section.bounds ?? {})]);
  const bounds: Record<string, Bounds> = {};
  for (const id of boundIds) {
    const merged = boundsFor(id, root.bounds, section.bounds);
    if (merged) bounds[id] = merged;
  }
  return {
    id: section.id,
    games: section.games,
    end: endPolicy(section, end),
    ...(coverage ? { coverage: true } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(Object.keys(bounds).length > 0 ? { bounds } : {}),
    ...(screens.length > 0 ? { screens } : {}),
    ...(section.training === undefined ? {} : { training: section.training }),
  };
}

/**
 * Завершение участка с поправкой на повтор. Блок без повтора кончается вместе со
 * своими модулями: один проход по списку. Иначе время участка перекрывает время
 * блока — пауза на десять секунд внутри тридцатисекундного участка проходит
 * трижды и перестаёт быть паузой на десять секунд.
 */
function endPolicy(section: Section, end: Termination): TerminationPolicy {
  const policy = terminationOf(end);
  if (section.repeat !== false) return policy;
  // Проход — это по разу на каждый объявленный модуль: у ротации из двух задач
  // один проход честно означает два прогона, а не один.
  return firstOf(byRuns(section.games.length), policy);
}

/**
 * Участок идёт по покрытию, если так сказано в его завершении — в том числе внутри
 * `first`: обучение разумно ограничить и покрытием, и потолком по времени.
 */
function coversAll(spec: Termination): boolean {
  if (spec.by === "coverage") return true;
  return spec.by === "first" && spec.of.some(coversAll);
}

/**
 * Оператор правит длительность участка, а не его структуру. У участка по
 * покрытию правится, однако, не потолок целиком, а одна попытка: покрытие
 * обязано закрыться, а укороченный общий потолок закрывал участок на первой же
 * задаче — репетиция обучения показывала арифметику и кончалась, хотя в блоке
 * объявлено шесть задач. Потолок участка при этом остаётся как в документе:
 * он страховка от зависания, а не расписание.
 *
 * Укорачивать — только вниз: обещано, что участки станут короче, а не что все
 * они станут одной длины. Иначе микропауза на десять секунд растянулась бы до
 * получаса репетиции просто потому, что оператор выбрал полчаса.
 */
function withDuration(spec: Termination, ms: number, perAttempt: boolean): Termination {
  if (spec.by === "time") return perAttempt ? spec : { by: "time", ms: Math.min(spec.ms, ms) };
  if (spec.by === "run-limit") return perAttempt ? { by: "run-limit", ms } : spec;
  if (spec.by === "first") {
    const of = spec.of.map((x) => withDuration(x, ms, perAttempt));
    // Покрытие без потолка на попытку укорачивать нечем: тогда потолок появляется,
    // иначе репетиция шла бы полным временем участка и оператор ждал бы впустую.
    if (perAttempt && !of.some((part) => part.by === "run-limit")) of.push({ by: "run-limit", ms });
    return { by: "first", of: of as typeof spec.of };
  }
  return spec;
}

/**
 * Из чего сложено завершение участка. Нужно предпросмотру: у участка по покрытию
 * время — это страховка от зависания, а не расписание, и обещать его как
 * длительность нельзя. Разбор живёт здесь, рядом с `withDuration`, чтобы витрина
 * не описывала завершение своими словами и не разошлась с тем, что исполняется.
 */
export interface TerminationShape {
  /** Участок кончается покрытием: время у него потолок, а не длительность. */
  coverage: boolean;
  /** Объявленное время участка, мс; `null` — времени участку не назначено. */
  capMs: number | null;
  /** Потолок одной попытки, мс; `null` — не объявлен. */
  attemptMs: number | null;
  /** Объявленное число прогонов; `null` — не объявлено. */
  runs: number | null;
}

export function terminationShape(spec: Termination): TerminationShape {
  const shape: TerminationShape = { coverage: coversAll(spec), capMs: null, attemptMs: null, runs: null };
  const walk = (part: Termination): void => {
    if (part.by === "time") shape.capMs = shape.capMs === null ? part.ms : Math.min(shape.capMs, part.ms);
    else if (part.by === "run-limit") shape.attemptMs = shape.attemptMs === null ? part.ms : Math.min(shape.attemptMs, part.ms);
    else if (part.by === "runs") shape.runs = shape.runs === null ? part.count : Math.min(shape.runs, part.count);
    else if (part.by === "first") part.of.forEach(walk);
  };
  walk(spec);
  return shape;
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
