import "./styles.css";
import {
  AdaptiveStaircase,
  Fixed,
  GameRegistry,
  GameRuntime,
  Manual,
  MarkerDispatcher,
  Monotonic,
  NullMarkerSink,
  RealClock,
  type DifficultyPolicy,
  type GameInstanceImpl,
  type Json,
  type LoggedEvent,
  type Microgame,
  type Params,
} from "@gamespace/core";
import type { DurableSink } from "@gamespace/core";
import { DomSurface, bindKeyboard, keyLabel } from "@gamespace/ui-web";
import { protocolGames } from "@gamespace/games";
import { SessionRunner, compileProtocol, pilotProtocol, plannedMs, type RunRecord } from "@gamespace/protocol";

const registry = new GameRegistry();
for (const game of protocolGames) registry.register(game);

const app = document.getElementById("app")!;
app.innerHTML = `
  <aside class="catalog">
    <div class="catalog-head">
      <button class="btn" id="toggle" title="Свернуть каталог">≡</button>
      <h1>Модули протокола</h1>
    </div>
    <div class="catalog-body" id="catalog"></div>
    <div class="catalog-head"><h1>Сценарий</h1></div>
    <div class="catalog-body" id="scenarios"></div>
  </aside>
  <main class="port">
    <div class="port-head">
      <h2 id="title">—</h2>
      <span class="pill" id="version"></span>
      <button class="btn is-primary" id="start">Старт</button>
      <button class="btn" id="stop" disabled>Стоп</button>
      <div class="keycast" id="keycast"></div>
      <div class="task"><b id="taskLabel">Задание</b> · <span id="task"></span></div>
    </div>
    <div class="port-body">
      <div class="stage-wrap">
        <div class="stage" id="stage"></div>
        <div id="banner"></div>
      </div>
      <div class="side">
        <div id="protocolPanel" style="display:none">
          <h3>Протокол</h3>
          <div class="param">
            <label for="participant">Участник</label>
            <input type="text" id="participant" value="p-001" />
          </div>
          <div class="param">
            <label for="compress">Длительность участка, с <b id="compressValue">30</b></label>
            <input type="range" id="compress" min="10" max="300" step="10" value="30" />
          </div>
          <div id="schedule"></div>
        </div>
        <div id="difficultyPanel">
        <h3>Сложность</h3>
        <div class="param">
          <label for="policy">Политика</label>
          <select id="policy">
            <option value="adaptive">Адаптивная 2-up/1-down</option>
            <option value="monotonic">Монотонная, только рост</option>
            <option value="manual">Ручная</option>
            <option value="fixed">Заморожена (probe)</option>
          </select>
        </div>
        <div class="param">
          <label for="level">Уровень <b id="levelValue">1</b></label>
          <input type="range" id="level" min="1" max="8" step="1" value="1" />
        </div>
        <div id="params"></div>
        <h3>Манифест</h3>
        <div id="manifest"></div>
        </div>
        <h3>Журнал</h3>
        <div class="log" id="log"></div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          <button class="btn" id="exportJsonl">events.jsonl</button>
          <button class="btn" id="exportCsv">events.csv</button>
          <button class="btn" id="exportMarkers">markers.csv</button>
        </div>
      </div>
    </div>
    <div class="foot" id="foot"></div>
  </main>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $("stage");
const surface = new DomSurface({
  stage,
  task: $("task"),
  taskLabel: $("taskLabel"),
  stats: $("foot"),
});

let current: Microgame<any, any> = protocolGames[0]!;
let instance: GameInstanceImpl | null = null;
let markers = new MarkerDispatcher(new NullMarkerSink());
let manualOverrides: Params = {};
/** Режим витрины: одиночная игра или сценарий целиком. */
let mode: "game" | "protocol" = "game";
let session: SessionRunner | null = null;
let sessionSink: LoggedEvent[] | null = null;

function renderCatalog(): void {
  const catalog = $("catalog");
  catalog.replaceChildren(
    ...protocolGames.map((game) => {
      const button = document.createElement("button");
      button.className = `game-item${mode === "game" && game.manifest.id === current.manifest.id ? " is-active" : ""}`;
      button.innerHTML = `${game.manifest.title.ru}<small>${game.manifest.domains.join(" · ")}</small>`;
      button.addEventListener("click", () => select(game));
      return button;
    }),
  );
  const scenarios = $("scenarios");
  const button = document.createElement("button");
  button.className = `game-item${mode === "protocol" ? " is-active" : ""}`;
  button.innerHTML = `${pilotProtocol.title}<small>${pilotProtocol.sections.length} участков · протокол ${pilotProtocol.protocolVersion}</small>`;
  button.addEventListener("click", selectProtocol);
  scenarios.replaceChildren(button);
}

/** Шаг ползунка под диапазон: грубый шаг расходится с подписью значения. */
function stepFor(min: number, max: number): number {
  const raw = Math.abs(max - min) / 100;
  return raw >= 1 ? Math.round(raw) : Number(raw.toPrecision(1));
}

/** Уровни дают дробные доли вроде 0.8500000000000001 — показываем осмысленно. */
function fmt(value: unknown): string {
  return typeof value === "number" && !Number.isInteger(value) ? String(Number(value.toFixed(3))) : String(value);
}

function isRunning(): boolean {
  return instance !== null && ["main", "intro", "paused"].includes(instance.phase);
}

function paramControls(): void {
  const host = $("params");
  const schema = current.manifest.parametersSchema.schema as {
    properties?: Record<string, { type?: string; minimum?: number; maximum?: number; enum?: string[]; title?: string }>;
  };
  const level = Number(($("level") as HTMLInputElement).value);
  const base = current.paramsForLevel(level);
  const manual = ($("policy") as HTMLSelectElement).value === "manual";

  host.replaceChildren(
    ...Object.entries(schema.properties ?? {}).map(([key, spec]) => {
      const wrap = document.createElement("div");
      wrap.className = "param";
      const value = manualOverrides[key] ?? base[key];
      const label = document.createElement("label");
      label.innerHTML = `${spec.title ?? key} <b>${fmt(value)}</b>`;
      wrap.append(label);

      let control: HTMLInputElement | HTMLSelectElement;
      if (spec.enum) {
        control = document.createElement("select");
        for (const option of spec.enum) {
          const el = document.createElement("option");
          el.value = option;
          el.textContent = option;
          el.selected = option === value;
          control.append(el);
        }
      } else if (spec.type === "boolean") {
        control = document.createElement("select");
        for (const option of ["false", "true"]) {
          const el = document.createElement("option");
          el.value = option;
          el.textContent = option === "true" ? "да" : "нет";
          el.selected = String(value) === option;
          control.append(el);
        }
      } else {
        control = document.createElement("input");
        control.type = "range";
        control.min = String(spec.minimum ?? 0);
        control.max = String(spec.maximum ?? 100);
        control.step = spec.type === "integer" ? "1" : String(stepFor(spec.minimum ?? 0, spec.maximum ?? 1));
        control.value = String(value);
      }
      // Ручное переопределение доступно только в ручной политике: иначе
      // оператор видел бы контролы, которые ни на что не влияют.
      control.disabled = !manual;
      control.addEventListener("input", () => {
        const raw = (control as HTMLInputElement).value;
        manualOverrides[key] = spec.type === "boolean" ? raw === "true" : spec.enum ? raw : Number(raw);
        label.innerHTML = `${spec.title ?? key} <b>${fmt(spec.type === "boolean" || spec.enum ? raw : Number(raw))}</b>`;
        instance?.difficulty.setOverrides(manualOverrides);
      });
      wrap.append(control);
      return wrap;
    }),
  );
}

/** Уровень задаётся до старта, а во время адаптивного прогона им владеет политика. */
function levelControl(): void {
  const manual = ($("policy") as HTMLSelectElement).value === "manual";
  ($("level") as HTMLInputElement).disabled = isRunning() && !manual;
}

function renderManifest(): void {
  const m = current.manifest;
  const children = m.children ?? [];
  $("manifest").innerHTML = `
    <div><span class="pill">runtime ${m.runtimeApi}</span><span class="pill">${m.levels.count} уровней</span>
    <span class="pill ${m.resumable ? "is-ok" : ""}">${m.resumable ? "resumable" : "без возврата"}</span>
    <span class="pill">${m.timing.profile}</span></div>
    <div style="margin-top:6px;color:var(--muted);font-size:12px">
      Действия: ${
        m.interaction.actions.map((a) => `${a.label} · ${a.indexed ? "1..9" : a.defaultBinding}`).join(", ") ||
        (children.length > 0 ? "свои действия у дочерних задач" : "нет")
      }<br>
      ${children.length > 0 ? `Дочерние модули: ${children.map((c) => c.id.replace("org.reconnect.", "")).join(", ")}<br>` : ""}
      Монотонные оси: ${m.levels.monotonicAxes.map((a) => `${a.param} ${a.direction === "increases" ? "↑" : "↓"}`).join(", ")}
    </div>`;
}

function makePolicy(): DifficultyPolicy {
  const kind = ($("policy") as HTMLSelectElement).value;
  const start = Number(($("level") as HTMLInputElement).value);
  const max = current.manifest.levels.count;
  if (kind === "monotonic") return new Monotonic({ start, max });
  if (kind === "manual") return new Manual({ start, max });
  if (kind === "fixed") return new Fixed(start);
  return new AdaptiveStaircase({ start, max });
}

let run = { timerId: "", count: 0, line: null as HTMLElement | null };

/**
 * Подряд идущие срабатывания одного таймера сворачиваются в счётчик: шаг
 * симуляции приходит десятки раз в секунду и иначе вытесняет из журнала всё
 * остальное. В файл экспорта попадает каждая запись — сворачивается только вид.
 */
function appendLog(record: LoggedEvent): void {
  const log = $("log");
  const timerId = record.type === "input.deadline" ? String((record.payload as { timerId?: string }).timerId ?? "") : "";
  if (timerId && timerId === run.timerId && run.line) {
    run.count += 1;
    run.line.textContent = `     ${timerId} ×${run.count}`;
    log.scrollTop = log.scrollHeight;
    return;
  }
  const line = document.createElement("div");
  // Номер сквозной на всю сессию, поэтому участок подписывается рядом с ним.
  const where = record.sectionId ? ` ${record.sectionId}#${record.runIndex ?? 0}` : "";
  line.textContent = `${String(record.seq).padStart(4, "0")}${where} ${record.tMs.toFixed(0).padStart(7)}ms ${record.type}`;
  log.append(line);
  run = timerId ? { timerId, count: 1, line } : { timerId: "", count: 0, line: null };
  log.scrollTop = log.scrollHeight;
}

const secs = (ms: number) => `${Math.round(ms / 1000)} с`;

/** Предпросмотр расписания до старта: оператор обязан видеть, что запустит. */
function renderSchedule(): void {
  const compiled = compile();
  const perSection = Number(($("compress") as HTMLInputElement).value) * 1000;
  const rows = compiled.order.map((id, i) => {
    const source = pilotProtocol.sections.find((s) => s.id === id)!;
    const full = plannedMs(source.end as never);
    return `<div>${i + 1}. <b>${id}</b> · ${source.games.length === 1 ? source.games[0]!.replace("org.reconnect.", "") : `ротация ${source.games.length}`} · ${
      full === null ? "по числу прогонов" : `${secs(perSection)} (в протоколе ${Math.round(full / 60000)} мин)`
    }</div>`;
  });
  $("schedule").innerHTML = `
    <div style="font-size:12px;color:var(--muted);line-height:1.7">${rows.join("")}</div>
    <div style="margin-top:6px" class="pill">сессия ${compiled.sessionId}</div>
    <div class="pill">seed ${compiled.seed}</div>`;
}

function compile() {
  const perSection = Number(($("compress") as HTMLInputElement).value) * 1000;
  const durations = Object.fromEntries(pilotProtocol.sections.map((s) => [s.id, perSection]));
  return compileProtocol(pilotProtocol, {
    participantId: ($("participant") as HTMLInputElement).value || "p-000",
    registry,
    durations,
  });
}

function selectProtocol(): void {
  stop();
  mode = "protocol";
  $("protocolPanel").style.display = "";
  $("difficultyPanel").style.display = "none";
  $("title").textContent = pilotProtocol.title;
  $("version").textContent = `${pilotProtocol.id} · протокол ${pilotProtocol.protocolVersion}`;
  surface.setTask("Нажми «Старт»: участки пойдут по расписанию.", "Сценарий");
  surface.setStats([]);
  stage.replaceChildren();
  $("banner").replaceChildren();
  $("log").replaceChildren();
  renderCatalog();
  renderSchedule();
}

function select(game: Microgame<any, any>): void {
  stop();
  mode = "game";
  $("protocolPanel").style.display = "none";
  $("difficultyPanel").style.display = "";
  current = game;
  manualOverrides = {};
  const levelInput = $("level") as HTMLInputElement;
  levelInput.max = String(game.manifest.levels.count);
  levelInput.value = "1";
  $("levelValue").textContent = "1";
  $("title").textContent = game.manifest.title.ru;
  $("version").textContent = `${game.manifest.id} · ${game.manifest.version}`;
  surface.setTask("—", game.manifest.title.ru);
  surface.setStats([]);
  stage.replaceChildren();
  stage.classList.remove("is-finished");
  $("banner").replaceChildren();
  $("log").replaceChildren();
  renderCatalog();
  renderManifest();
  paramControls();
}

function stop(): void {
  session?.abort();
  session = null;
  instance?.stop();
  instance = null;
  surface.clear();
  surface.setTask("—", mode === "protocol" ? pilotProtocol.title : current.manifest.title.ru);
  stage.classList.remove("is-finished");
  levelControl();
  ($("start") as HTMLButtonElement).disabled = false;
  ($("stop") as HTMLButtonElement).disabled = true;
}

/** Прогон сценария: тот же runtime, но расписанием владеет раннер сессии. */
function startProtocol(): void {
  stop();
  markers = new MarkerDispatcher(new NullMarkerSink());
  const compiled = compile();
  // Журнал общий на всю сессию: в него пишут все участки и все прогоны.
  const records: LoggedEvent[] = [];
  sessionSink = records;
  const wrapped: DurableSink = {
    append(record) {
      records.push(record);
      appendLog(record);
    },
    flush() {},
  };

  const runtime = new GameRuntime({
    registry,
    clock: new RealClock(),
    markers,
    sink: wrapped,
    capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
    t0WallMs: Date.now(),
  });
  $("log").replaceChildren();
  $("banner").replaceChildren();
  run = { timerId: "", count: 0, line: null };

  const done: RunRecord[] = [];
  session = new SessionRunner({
    runtime,
    surface,
    sessionId: compiled.sessionId,
    seed: compiled.seed,
    sections: compiled.sections,
    sink: wrapped,
    policyFor: (gameId) => compiled.policyFor(gameId),
    onSectionStart: (section, index) => {
      $("title").textContent = `${pilotProtocol.title} — ${section.id}`;
      $("version").textContent = `участок ${index + 1} из ${compiled.sections.length}`;
      stage.classList.remove("is-finished");
    },
    onSectionEnd: (section, records) => {
      done.push(...records);
      banner(
        `<b>Участок ${section.id} завершён.</b> прогонов: ${records.length} · ${records
          .map((r) => `${r.gameId.replace("org.reconnect.", "")} ур.${r.level}`)
          .join(", ")}`,
      );
    },
    onDone: () => {
      banner(`<b>Сценарий пройден.</b> прогонов всего: ${done.length}. Журнал можно выгрузить.`);
      stage.classList.add("is-finished");
      ($("start") as HTMLButtonElement).disabled = false;
      ($("stop") as HTMLButtonElement).disabled = true;
    },
  });
  session.start();
  ($("start") as HTMLButtonElement).disabled = true;
  ($("stop") as HTMLButtonElement).disabled = false;
  stage.focus();
}

function banner(html: string): void {
  const box = document.createElement("div");
  box.className = "result";
  box.innerHTML = html;
  $("banner").replaceChildren(box);
}

function start(): void {
  if (mode === "protocol") return startProtocol();
  stop();
  markers = new MarkerDispatcher(new NullMarkerSink());
  const clock = new RealClock();
  const runtime = new GameRuntime({
    registry,
    clock,
    markers,
    capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
    t0WallMs: Date.now(),
  });
  $("log").replaceChildren();
  $("banner").replaceChildren();
  run = { timerId: "", count: 0, line: null };

  const policy = makePolicy();
  instance = runtime.mount(registry.ref(current.manifest.id), {
    surface,
    seed: Math.floor(Math.random() * 1e6),
    policy,
    overrides: ($("policy") as HTMLSelectElement).value === "manual" ? manualOverrides : {},
    onDifficultyChanged: (level) => {
      ($("level") as HTMLInputElement).value = String(level);
      $("levelValue").textContent = String(level);
      paramControls();
    },
    onComplete: (summary: Json) => {
      const box = document.createElement("div");
      box.className = "result";
      box.innerHTML = `<b>Блок завершён.</b> ${Object.entries(summary as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : fmt(v)}`)
        .join(" · ")}<br><span style="color:var(--muted)">Нажми «Старт» для следующего блока.</span>`;
      $("banner").replaceChildren(box);
      // Поле гасится: продолжать нажимать после конца блока нельзя.
      stage.classList.add("is-finished");
      ($("start") as HTMLButtonElement).disabled = false;
      ($("stop") as HTMLButtonElement).disabled = true;
      levelControl();
    },
  });

  // Журнал показываем живьём: это же то, что уедет в экспорт.
  const sink = instance.log.sink as { append(record: LoggedEvent): void };
  const original = sink.append.bind(sink);
  sink.append = (record: LoggedEvent) => {
    original(record);
    appendLog(record);
  };

  stage.classList.remove("is-finished");
  instance.start();
  ($("start") as HTMLButtonElement).disabled = true;
  ($("stop") as HTMLButtonElement).disabled = false;
  levelControl();
  stage.focus();
}

function keycast(key: string, accepted: boolean): void {
  const host = $("keycast");
  const kbd = document.createElement("kbd");
  // Клавиша называется так же, как подписана на кнопке игры.
  kbd.textContent = keyLabel(key);
  if (!accepted) kbd.className = "is-rejected";
  host.append(kbd);
  setTimeout(() => kbd.remove(), 700);
}

/** В режиме сценария журнал общий на всю сессию, а не на один запуск. */
function exportLog(kind: "jsonl" | "csv"): string {
  const records = sessionSink;
  if (mode === "protocol" && records) {
    if (kind === "jsonl") return records.map((r) => JSON.stringify(r)).join("\n");
    const head = "seq,run_id,section_id,run_index,t_ms,wall_ms,source,type,payload";
    return [
      head,
      ...records.map((r) =>
        [
          r.seq,
          r.runId,
          r.sectionId ?? "",
          r.runIndex ?? "",
          r.tMs.toFixed(3),
          r.wallMs.toFixed(0),
          r.source,
          r.type,
          JSON.stringify(JSON.stringify(r.payload)),
        ].join(","),
      ),
    ].join("\n");
  }
  return kind === "jsonl" ? (instance?.log.toJsonl() ?? "") : (instance?.log.toCsv() ?? "");
}

function download(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

$("start").addEventListener("click", start);
$("stop").addEventListener("click", stop);
$("toggle").addEventListener("click", () => app.classList.toggle("is-collapsed"));
$("policy").addEventListener("change", () => {
  // Политику можно перехватить посреди блока: уровень при этом сохраняется.
  if (isRunning() && instance) instance.difficulty.setPolicy(makePolicy());
  paramControls();
  levelControl();
});
$("level").addEventListener("input", (e) => {
  const value = (e.target as HTMLInputElement).value;
  $("levelValue").textContent = value;
  if (isRunning() && instance) instance.difficulty.setLevel(Number(value));
  paramControls();
});
$("participant").addEventListener("input", renderSchedule);
$("compress").addEventListener("input", (e) => {
  $("compressValue").textContent = (e.target as HTMLInputElement).value;
  renderSchedule();
});
$("exportJsonl").addEventListener("click", () => download("events.jsonl", exportLog("jsonl")));
$("exportCsv").addEventListener("click", () => download("events.csv", exportLog("csv")));
$("exportMarkers").addEventListener("click", () => download("markers.csv", markers.toCsv()));

/** Ввод адресуется активной задаче: у сценария это игра текущего участка. */
function activeInput() {
  const live = mode === "protocol" ? (session?.current()?.current() ?? null) : isRunning() ? instance : null;
  return live ? live.activeInstance().input : protocolInputStub;
}

bindKeyboard(activeInput, {
  scope: document.body,
  onKeyVisual: keycast,
});

/** Игра не запущена: клавиши некому отдавать, но хост всё равно их спрашивает. */
const protocolInputStub = { handleKey: () => false, handleKeyUp: () => false, releaseAll: () => {} } as never;

select(protocolGames[0]!);
