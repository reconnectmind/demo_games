import type { Json, Microgame, Params, Surface } from "./contracts.js";
import { VirtualClock } from "./clock.js";
import { inputsAfter, type DurableSink, type LoggedEvent } from "./events.js";
import type { MarkerDispatcher } from "./markers.js";
import type { DifficultyPolicy } from "./difficulty.js";
import { GameRegistry } from "./registry.js";
import { GameRuntime, type GameInstanceImpl, type MountOptions } from "./runtime.js";
import { SeededRng } from "./rng.js";

/** Поверхность без DOM: ядро и логика проверяются без браузера. */
export function headlessSurface(): Surface & {
  task: string;
  reminder: string;
  hint: string;
  stats: Array<[string, string | number]>;
} {
  const surface = {
    stage: { appendChild() {}, innerHTML: "" } as unknown as HTMLElement,
    task: "",
    reminder: "",
    hint: "",
    stats: [] as Array<[string, string | number]>,
    setTask(text: string) {
      surface.task = text;
      surface.reminder = text;
    },
    setReminder(text: string) {
      surface.reminder = text;
    },
    setHint(text: string) {
      surface.hint = text;
    },
    setStats(pairs: Array<[string, string | number]>) {
      surface.stats = pairs;
    },
    clear() {
      surface.task = "";
      surface.reminder = "";
      surface.hint = "";
      surface.stats = [];
    },
  };
  return surface;
}

export interface HeadlessRun {
  instance: GameInstanceImpl;
  clock: VirtualClock;
  runtime: GameRuntime;
  records(): LoggedEvent[];
  views: Json[];
}

export function headlessRun(
  games: Microgame<any, any>[],
  target: string,
  options: Partial<MountOptions> & {
    seed?: number;
    policy?: DifficultyPolicy;
    capabilities?: string[];
    sink?: DurableSink;
    markers?: MarkerDispatcher;
  } = {},
): HeadlessRun {
  const registry = new GameRegistry();
  for (const game of games) registry.register(game);
  const clock = new VirtualClock();
  const runtime = new GameRuntime({
    registry,
    clock,
    sink: options.sink,
    markers: options.markers,
    // Отрисовки в headless нет вовсе, поэтому canvas и webgl объявлены: они ничего не стоят.
    capabilities: options.capabilities ?? ["keyboard", "pointer", "audio-output", "canvas", "webgl"],
    t0WallMs: 1_700_000_000_000,
    wallNow: () => 1_700_000_000_000 + clock.now(),
  });
  const views: Json[] = [];
  const instance = runtime.mount(registry.ref(target), {
    surface: headlessSurface(),
    headless: true,
    seed: options.seed ?? 42,
    ...options,
    onRender: (view) => {
      views.push(view);
      options.onRender?.(view);
    },
  });
  return { instance, clock, runtime, records: () => instance.log.records(), views };
}

/**
 * Каноническая проекция запуска: состояние ядра и домённые события.
 * Побитово сравнивать журнал нельзя — в нём есть wall time и идентификаторы.
 */
export interface CanonicalProjection {
  coreState: Json;
  domain: Array<{ type: string; payload: Json }>;
  outcomes: Json[];
  level: number;
}

export function project(run: HeadlessRun): CanonicalProjection {
  const records = run.records();
  return {
    coreState: structuredClone(run.instance.state),
    domain: records.filter((r) => r.source === "domain").map((r) => ({ type: r.type, payload: r.payload })),
    outcomes: records.filter((r) => r.type === "trial.outcome").map((r) => r.payload),
    level: run.instance.difficulty.level(),
  };
}

export interface AutoDriveOptions {
  stepMs?: number;
  maxSteps?: number;
  /** Вероятность нажатия на шаге: имитирует не идеального участника. */
  pressRate?: number;
  seed?: number;
}

/**
 * Универсальный водитель: играет в любую игру, зная только манифест.
 * Нужен затем, что контрактные тесты обязаны быть одинаковыми для всех модулей.
 */
export function autoDrive(run: HeadlessRun, options: AutoDriveOptions = {}): void {
  const stepMs = options.stepMs ?? 120;
  const maxSteps = options.maxSteps ?? 4000;
  const pressRate = options.pressRate ?? 0.7;
  const rng = new SeededRng(options.seed ?? 99);
  /** Что зажато сейчас: удержание обязано закончиться, иначе игра застрянет. */
  const held: Array<{ target: GameInstanceImpl; actionId: string }> = [];
  for (let step = 0; step < maxSteps && run.instance.phase !== "completed" && run.instance.phase !== "aborted"; step++) {
    while (held.length > 0) {
      const release = held.pop();
      if (release) release.target.submitAction(release.actionId, { phase: "up" }, "keyboard");
    }
    // Ввод адресуется активной задаче: у оркестратора действий своих нет.
    const target = run.instance.activeInstance();
    const actions = run.runtime.registry.resolve(target.ref).manifest.interaction.actions;
    if (rng.next() < pressRate && actions.length > 0) {
      const action = rng.pick(actions);
      const last = run.views.at(-1) as { options?: unknown[] } | undefined;
      const optionCount = Array.isArray(last?.options) && target === run.instance ? last.options.length : 4;
      if (action.indexed) target.submitAction(action.id, { index: rng.int(0, optionCount - 1) }, "keyboard");
      else if (action.holdable) {
        target.submitAction(action.id, { phase: "down" }, "keyboard");
        held.push({ target, actionId: action.id });
      } else target.submitAction(action.id, { value: rng.next() }, "keyboard");
    }
    run.clock.advance(stepMs);
  }
  for (const release of held) release.target.submitAction(release.actionId, { phase: "up" }, "keyboard");
}

/** Повтор ядра по журналу: те же входы дают то же состояние. */
export function replayCore(
  game: Microgame<any, any>,
  records: LoggedEvent[],
  seed: number,
  cursor = 0,
  slot?: string,
): Json {
  const params: Params = game.paramsForLevel(1);
  let state = game.core.init({
    runId: "replay",
    seed,
    initialParams: params,
    training: false,
    locale: "ru",
  });
  for (const input of inputsAfter(records, cursor, slot)) {
    state = game.core.reduce(state, input).state;
  }
  return state as Json;
}
