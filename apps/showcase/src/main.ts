import "./styles.css";
import {
  AdaptiveStaircase,
  DEFAULT_CODEBOOK,
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
import {
  ProtocolError,
  SessionRunner,
  compileProtocol,
  pilotProtocol,
  terminationShape,
  type Protocol,
  type RunRecord,
  type Screen,
} from "@gamespace/protocol";
import { mountBuilder } from "./builder.js";
import {
  abortDesktopSession,
  appendDesktopEvent,
  desktop,
  desktopBootstrap,
  desktopProtocols,
  desktopReady,
  experimentProduction,
  experimentTools,
  finishDesktopSession,
  labRecorderRequired,
  openDesktopSessionFolder,
  readDesktopSessionFile,
  runLslPreflight,
  startDesktopSession,
  type LslStatus,
} from "./desktop.js";
import { forget, keep, stored } from "./store.js";

const games: Microgame<any, any>[] = protocolGames;

const registry = new GameRegistry();
for (const game of games) registry.register(game);

const app = document.getElementById("app")!;
/**
 * Витрина живёт тремя экранами, а не одним с флажками. Оператор всё выбирает до
 * старта; после старта на мониторе остаётся только то, что должен видеть
 * участник; сводка и выгрузка ждут конца сессии. Так операторские ручки не могут
 * попасть в поле зрения участника по недосмотру: их там просто нет.
 */
app.innerHTML = `
  <section class="setup" id="setup">
    <div class="setup-head">
      <h1>Подготовка сессии</h1>
      <div class="setup-tabs">
        <button class="tab is-active" id="tabProtocol" type="button">Сценарий</button>
        <button class="tab" id="tabBuilder" type="button">Конструктор</button>
        <button class="tab" id="tabModule" type="button">Отладка модуля</button>
      </div>
    </div>
    <div class="setup-body">
      <div class="setup-main">
        <div id="setupProtocol">
          <h3>Кого пишем</h3>
          <div class="param">
            <label for="participant">Участник</label>
            <input type="text" id="participant" value="p-001" />
          </div>
          <div class="param">
            <label for="scenario">Сценарий</label>
            <select id="scenario"></select>
          </div>
          <h3>Сколько идёт</h3>
          <div class="param">
            <label for="pace">Длительности</label>
            <select id="pace">
              <option value="full">Как в протоколе — полная сессия</option>
              <option value="short" selected>Репетиция — участки укорочены</option>
            </select>
          </div>
          <div class="param" id="compressRow">
            <label for="compress">Длительность участка, с <b id="compressValue">30</b></label>
            <input type="range" id="compress" min="10" max="300" step="10" value="30" />
          </div>
          <h3>Как показываем</h3>
          <div class="param">
            <label for="theme">Тема</label>
            <select id="theme">
              <option value="dark">Обычная</option>
              <option value="low-contrast">Низкий контраст</option>
            </select>
          </div>
          <div class="note" id="inputNote"></div>
          <div class="desktop-checks" id="desktopChecks" hidden>
            <h3>Готовность стенда</h3>
            <div class="desktop-check" id="portableStatus">Проверяем папку данных…</div>
            <div class="desktop-check" id="protocolStatus">Проверяем протокол…</div>
            <div class="desktop-check" id="lslStatus">LSL ещё не проверен.</div>
            <button class="btn" id="lslCheck" type="button">Проверить LSL</button>
            <label class="desktop-confirm">
              <input id="labRecorderConfirm" type="checkbox" />
              Рабочий поток виден в LabRecorder
            </label>
            <div class="note">Во время записи: Ctrl+Shift+Space — пауза/продолжение; Ctrl+Shift+End — аварийная остановка.</div>
          </div>
        </div>
        <div id="setupBuilder" hidden>
          <h3>Конструктор сценария</h3>
          <div class="builder" id="builder"></div>
        </div>
        <div id="setupModule" hidden>
          <h3>Модуль</h3>
          <div class="catalog-body" id="catalog"></div>
        </div>
      </div>
      <aside class="setup-aside" id="setupAside">
        <div id="setupSchedule">
          <h3>Что будет запущено</h3>
          <div id="schedule"></div>
        </div>
        <div id="setupDifficulty" hidden>
          <h3>Блок</h3>
          <div id="block"></div>
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
          <!-- Обучение — не уровень сложности, а другой режим прогона: правило до
               стимулов и разбор ошибки, который держится до нажатия. Проверять его
               целым сценарием дорого, поэтому он включается и здесь. -->
          <div class="param">
            <label for="trainingMode">Режим обучения</label>
            <input type="checkbox" id="trainingMode" />
          </div>
          <div id="params"></div>
          <h3>Манифест</h3>
          <div id="manifest"></div>
        </div>
      </aside>
    </div>
    <div class="setup-foot">
      <div class="note" id="launchNote"></div>
      <button class="btn is-primary is-big" id="launch">Начать сессию</button>
    </div>
  </section>

  <main class="port" id="run" hidden>
    <div class="port-head" id="head">
      <h2 id="title">—</h2>
      <span class="pill" id="version"></span>
      <div class="ops" id="ops">
        <button class="btn" id="stop">Стоп</button>
        <button class="btn" id="back">К настройке</button>
      </div>
      <div class="keycast" id="keycast"></div>
      <div class="task"><b id="taskLabel">Задание</b> · <span id="task"></span></div>
    </div>
    <div class="port-body">
      <div class="stage-wrap">
        <div class="stage-reminder" id="reminder"></div>
        <div class="interstitial" id="interstitial" hidden>
          <div class="interstitial-card">
            <div class="interstitial-pos" id="interstitialPos"></div>
            <h3 id="interstitialTitle"></h3>
            <div id="interstitialBody"></div>
            <div class="interstitial-foot" id="interstitialFoot"></div>
            <button class="btn is-primary" id="interstitialNext">Дальше</button>
          </div>
        </div>
        <div class="stage" id="stage"></div>
        <div id="banner"></div>
      </div>
      <div class="side" id="side">
        <h3>Журнал</h3>
        <div class="log" id="log"></div>
      </div>
    </div>
    <div class="foot" id="foot"></div>
  </main>

  <section class="debrief" id="debrief" hidden>
    <div class="debrief-card">
      <h1>Сессия закончена</h1>
      <div id="debriefSummary"></div>
      <div class="note" id="sessionPath"></div>
      <h3>Выгрузка</h3>
      <div class="debrief-exports">
        <button class="btn" id="exportJsonl">events.jsonl</button>
        <button class="btn" id="exportCsv">events.csv</button>
        <button class="btn" id="exportMarkers">markers.csv</button>
        <button class="btn" id="exportCodebook">codebook.csv</button>
        <button class="btn" id="openSessionFolder">Открыть папку сессии</button>
      </div>
      <div class="debrief-foot">
        <button class="btn is-primary" id="toSetup">К настройке</button>
      </div>
    </div>
  </section>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type ScreenName = "setup" | "run" | "debrief";

/**
 * Экран сессии — состояние всей витрины, а не оформление одного блока. На
 * прогоне сценария в разметке не остаётся ни одной операторской ручки: сцена
 * занимает монитор целиком, иначе стимул сдвинут влево на половину панели и
 * «центр экрана» из протокола — не центр.
 */
function showScreen(name: ScreenName): void {
  for (const id of ["setup", "run", "debrief"] as const) ($(id) as HTMLElement).hidden = id !== name;
  document.body.classList.toggle("is-running", name === "run");
  // Отладочный прогон оставляет оператору его обвязку: журнал, статистику и
  // подпись задания. Сессия участника — нет.
  document.body.classList.toggle("is-participant", name === "run" && mode === "protocol");
}

const stage = $("stage");
const surface = new DomSurface({
  stage,
  task: $("task"),
  taskLabel: $("taskLabel"),
  reminder: $("reminder"),
  stats: $("foot"),
});

// Тема — свойство стенда, а не прогона: множитель размера и палитра живут в
// переменных, поэтому переключение не пересобирает ни одну игру.
$("theme").addEventListener("change", (event) => {
  document.documentElement.dataset.theme = (event.target as HTMLSelectElement).value;
});

let current: Microgame<any, any> = games[0]!;
let instance: GameInstanceImpl | null = null;
let markers = new MarkerDispatcher(new NullMarkerSink());
let manualOverrides: Params = {};
/** Длина блока живёт отдельно от сложности: её оператор меняет при любой политике. */
let blockOverride: Params = {};
/** Режим витрины: одиночная игра, сценарий целиком или сборка сценария. */
let mode: "game" | "protocol" | "builder" = "protocol";
/**
 * Сценарий, который будет запущен. Пилот — один из документов, а не привилегия
 * витрины: собранный в конструкторе запускается тем же путём, иначе конструктор
 * проверялся бы не тем, чем работают.
 */
let doc: Protocol = pilotProtocol;
let session: SessionRunner | null = null;
let sessionSink: LoggedEvent[] | null = null;
let lslReady: LslStatus | null = null;
let desktopReadyForRun = !desktop;
let lastSessionDirectory = "";

/**
 * Отбивка перед участком. Пролистывает её оператор мышью: у участника руки на
 * `Q W E`, и любая клавиша промотала бы инструкцию, которую он ещё не прочёл.
 */
function present(screen: Screen, _index: number, proceed: () => void): void {
  const box = $("interstitial");
  // Подпись места приходит с экраном: витрина не пересчитывает расписание заново.
  // Прежде она подставляла номер участка любому экрану, и карточка правила задания
  // в обучении подписывалась «часть 1 из 4» — числом не про то, что на экране.
  $("interstitialPos").textContent = screen.position ?? "";
  $("interstitialTitle").textContent = screen.title;
  $("interstitialBody").replaceChildren(
    ...screen.body.map((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      return p;
    }),
  );
  $("interstitialFoot").textContent = screen.footer ?? "";
  const next = $("interstitialNext") as HTMLButtonElement;
  next.onclick = () => {
    box.hidden = true;
    next.onclick = null;
    proceed();
  };
  box.hidden = false;
}

function renderCatalog(): void {
  const catalog = $("catalog");
  catalog.replaceChildren(
    ...games.map((game) => {
      const button = document.createElement("button");
      button.className = `game-item${mode === "game" && game.manifest.id === current.manifest.id ? " is-active" : ""}`;
      button.innerHTML = `${game.manifest.title.ru}<small>${game.manifest.domains.join(" · ")}</small>`;
      button.addEventListener("click", () => select(game));
      return button;
    }),
  );
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

type ParamSpec = { type?: string; minimum?: number; maximum?: number; enum?: string[]; title?: string };

function schemaProps(): Record<string, ParamSpec> {
  return (current.manifest.parametersSchema.schema as { properties?: Record<string, ParamSpec> }).properties ?? {};
}

/** Сложность переопределяется только вручную, длина блока — при любой политике. */
function effectiveOverrides(): Params {
  const manual = ($("policy") as HTMLSelectElement).value === "manual";
  return { ...(manual ? manualOverrides : {}), ...blockOverride };
}

/**
 * Длина блока — расписание, а не нагрузка: уровень её не двигает, поэтому у неё
 * свой контрол, живой и в адаптивном режиме.
 */
function blockControl(): void {
  const host = $("block");
  const decl = current.manifest.blockLength;
  const spec = decl ? schemaProps()[decl.param] : undefined;
  if (!decl || !spec) {
    const note = document.createElement("div");
    note.style.cssText = "color:var(--muted);font-size:12px";
    note.textContent = "Длину блока задаёт сама задача: отдельного параметра нет.";
    host.replaceChildren(note);
    return;
  }

  const base = Number(current.paramsForLevel(Number(($("level") as HTMLInputElement).value))[decl.param]);
  const overridden = decl.param in blockOverride;
  const value = overridden ? Number(blockOverride[decl.param]) : base;
  const text = (v: number) => (decl.unit === "ms" ? `${Math.round(v / 1000)} с` : String(v));

  const wrap = document.createElement("div");
  wrap.className = "param";
  const label = document.createElement("label");
  label.innerHTML = `${spec.title ?? decl.param} <b>${text(value)}</b>`;

  const reset = document.createElement("button");
  reset.className = "btn";
  reset.textContent = "по уровню";
  reset.title = "Вернуть длину, которую задаёт текущий уровень";
  reset.disabled = !overridden;
  reset.addEventListener("click", () => {
    delete blockOverride[decl.param];
    instance?.difficulty.setOverrides(effectiveOverrides());
    blockControl();
  });

  const control = document.createElement("input");
  control.type = "range";
  control.min = String(spec.minimum ?? 0);
  control.max = String(spec.maximum ?? 100);
  control.step = decl.unit === "ms" ? "5000" : "1";
  control.value = String(value);
  control.addEventListener("input", () => {
    const next = Number(control.value);
    blockOverride[decl.param] = next;
    label.innerHTML = `${spec.title ?? decl.param} <b>${text(next)}</b>`;
    reset.disabled = false;
    instance?.difficulty.setOverrides(effectiveOverrides());
  });

  wrap.append(label, control);
  host.replaceChildren(wrap, reset);
}

function paramControls(): void {
  const host = $("params");
  const level = Number(($("level") as HTMLInputElement).value);
  const base = current.paramsForLevel(level);
  const manual = ($("policy") as HTMLSelectElement).value === "manual";
  // Длина блока показана выше отдельно: дублировать её среди осей сложности незачем.
  const entries = Object.entries(schemaProps()).filter(([key]) => key !== current.manifest.blockLength?.param);

  host.replaceChildren(
    ...entries.map(([key, spec]) => {
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
        instance?.difficulty.setOverrides(effectiveOverrides());
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

/** Репетиция укорачивает участки; полная сессия идёт по документу протокола. */
function rehearsing(): boolean {
  return ($("pace") as HTMLSelectElement).value === "short";
}

const mins = (ms: number) => `${Math.round(ms / 60000)} мин`;

/**
 * Чем кончится участок, словами. Обучение по умолчанию делает один проход;
 * критерий допуска там остаётся измерением, а не причиной повторить задачу.
 */
function lengthNote(
  section: { end: unknown; training?: boolean; repeat?: boolean; games: string[] },
  short: boolean,
  perSection: number,
): string {
  const shape = terminationShape(section.end as never);
  const attempt = short ? perSection : shape.attemptMs;
  if (shape.coverage) {
    const parts =
      section.training && section.repeat !== true
        ? [`один проход · заданий ${section.games.length}`]
        : ["по покрытию"];
    if (attempt !== null) parts.push(`попытка ≤ ${secs(attempt)}`);
    if (shape.capMs !== null) parts.push(`потолок ${mins(shape.capMs)}`);
    return parts.join(" · ");
  }
  if (shape.capMs === null) return shape.runs === null ? "по решению модуля" : `прогонов ${shape.runs}`;
  // Укорачивают только вниз: выбранные оператором полчаса не растянут паузу на
  // двадцать секунд, поэтому обещать здесь нужно меньшее из двух.
  const planned = short ? Math.min(shape.capMs, perSection) : shape.capMs;
  const shown = planned < 60_000 ? secs(planned) : mins(planned);
  return short && planned < shape.capMs ? `${shown} (в протоколе ${mins(shape.capMs)})` : shown;
}

/** Предпросмотр расписания до старта: оператор обязан видеть, что запустит. */
function renderSchedule(): void {
  const compiled = compile();
  const perSection = Number(($("compress") as HTMLInputElement).value) * 1000;
  const short = rehearsing();
  const rows = compiled.order.map((id, i) => {
    const source = doc.sections.find((s) => s.id === id)!;
    return `<div>${i + 1}. <b>${id}</b> · ${source.games.length === 1 ? source.games[0]!.replace("org.reconnect.", "") : `ротация ${source.games.length}`} · ${lengthNote(source, short, perSection)}</div>`;
  });
  // Оценка считается по тому же правилу, что и строки: участок по покрытию в
  // репетиции не укорачивается, и складывать его как «столько же, сколько
  // прочие» значило бы обещать репетицию короче, чем она бывает.
  const estimate = doc.sections.reduce((sum, s) => {
    const shape = terminationShape(s.end as never);
    if (shape.capMs === null) return sum;
    if (short && s.training && s.repeat !== true) {
      return sum + Math.min(shape.capMs, s.games.length * perSection);
    }
    return sum + (short && !shape.coverage ? Math.min(shape.capMs, perSection) : shape.capMs);
  }, 0);
  $("schedule").innerHTML = `
    <div class="schedule">${rows.join("")}</div>
    <div style="margin-top:8px" class="pill">сессия ${compiled.sessionId}</div>
    <div class="pill">seed ${compiled.seed}</div>
    <div class="pill">${short ? `репетиция ≤ ${mins(estimate)}` : `≈ ${mins(estimate)}`}</div>`;
  $("launchNote").textContent = short
    ? "Репетиция: участки укорочены, данные для анализа не годятся. Обучение идёт по покрытию — укорачивается попытка, а не участок."
    : "Полная сессия по документу протокола. Время участка отсчитывается с первого стимула: чтение отбивки в него не входит.";
}

function compile() {
  const perSection = Number(($("compress") as HTMLInputElement).value) * 1000;
  const durations = rehearsing()
    ? Object.fromEntries(doc.sections.map((s) => [s.id, perSection]))
    : {};
  return compileProtocol(doc, {
    participantId: ($("participant") as HTMLInputElement).value || "p-000",
    registry,
    durations,
  });
}

/** Раскладку ответа объявляет протокол — оператор её видит, но не выбирает. */
function renderInputNote(): void {
  const input = compile().input;
  const keys = input.keys.map((key) => keyLabel(key)).join(" ");
  $("inputNote").textContent =
    `Ответ клавишами ${keys}; указатель — ${input.pointer === "free" ? "везде, где нужен задаче" : "только там, где задача без него не работает"}.` +
    " Раскладку задаёт документ протокола, здесь её не меняют.";
}

function checkLine(id: string, ok: boolean, text: string): void {
  const line = $(id);
  line.textContent = `${ok ? "✓" : "×"} ${text}`;
  line.classList.toggle("is-ok", ok);
  line.classList.toggle("is-bad", !ok);
}

function resetLslGate(): void {
  if (!desktop) return;
  lslReady = null;
  ($("labRecorderConfirm") as HTMLInputElement).checked = false;
  checkLine("lslStatus", false, "LSL ещё не проверен.");
  refreshDesktopGate();
}

function refreshDesktopGate(): void {
  if (!desktop) return;
  let protocolOk = true;
  let protocolMessage = `Протокол «${doc.title}» принят.`;
  try {
    compile();
  } catch (error) {
    protocolOk = false;
    protocolMessage = String((error as Error).message ?? error);
  }
  checkLine("protocolStatus", protocolOk, protocolMessage);
  const confirmed = ($("labRecorderConfirm") as HTMLInputElement).checked;
  const blockers = [
    !desktopReadyForRun && "папка данных недоступна",
    !protocolOk && "протокол не принят",
    !lslReady?.ok && "нажмите «Проверить LSL»",
    labRecorderRequired && !confirmed && "подтвердите поток в LabRecorder",
  ].filter(Boolean);
  ($("launch") as HTMLButtonElement).disabled = mode === "protocol" && blockers.length > 0;
  if (mode === "protocol" && blockers.length > 0) {
    $("launchNote").textContent = `Чтобы начать сессию: ${blockers.join("; ")}.`;
  } else if (mode === "protocol") {
    renderSchedule();
  }
}

async function preflightLsl(): Promise<void> {
  if (!desktop) return;
  const button = $("lslCheck") as HTMLButtonElement;
  button.disabled = true;
  checkLine("lslStatus", false, "Идёт outlet → inlet self-test…");
  try {
    lslReady = await runLslPreflight(
      ($("participant") as HTMLInputElement).value || "p-000",
      doc.id,
    );
    checkLine(
      "lslStatus",
      true,
      `${lslReady.message}. Поток: ${lslReady.streamName}, source_id ${lslReady.sourceId}.`,
    );
  } catch (error) {
    lslReady = null;
    checkLine("lslStatus", false, String((error as Error).message ?? error));
  } finally {
    button.disabled = false;
    refreshDesktopGate();
  }
}

/**
 * Вкладка настройки. Их три, и у каждой своя работа: чем запускать сессию, из
 * чего собрать сценарий и чем проверить один модуль. Ручки блока показываются
 * только там, где им есть что настраивать.
 */
function showTab(name: "protocol" | "builder" | "module"): void {
  if (experimentProduction && !experimentTools && name !== "protocol") name = "protocol";
  $("setupProtocol").hidden = name !== "protocol";
  $("setupBuilder").hidden = name !== "builder";
  $("setupModule").hidden = name !== "module";
  $("setupSchedule").hidden = name !== "protocol";
  $("setupDifficulty").hidden = name !== "module";
  $("tabProtocol").classList.toggle("is-active", name === "protocol");
  $("tabBuilder").classList.toggle("is-active", name === "builder");
  $("tabModule").classList.toggle("is-active", name === "module");
  // Конструктору широко: блоки с текстами в колонку настройки не помещаются.
  $("setup").classList.toggle("is-wide", name === "builder");
}

function selectProtocol(): void {
  mode = "protocol";
  showTab("protocol");
  ($("launch") as HTMLButtonElement).textContent = "Начать сессию";
  renderSchedule();
  renderInputNote();
  refreshDesktopGate();
}

/** Конструктор ничего не запускает сам: он готовит документ и отдаёт его сценарию. */
function selectBuilder(): void {
  mode = "builder";
  showTab("builder");
  ($("launch") as HTMLButtonElement).textContent = "Начать сессию";
  $("launchNote").textContent = "Соберите сценарий и нажмите «Запустить» в конструкторе.";
  builder.render();
  refreshDesktopGate();
}

function select(game: Microgame<any, any>): void {
  mode = "game";
  showTab("module");
  ($("launch") as HTMLButtonElement).textContent = "Запустить модуль";
  current = game;
  refreshDesktopGate();
  manualOverrides = {};
  blockOverride = {};
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
  blockControl();
  paramControls();
}

/** Сессия дошла до конца: только теперь оператору есть что выгружать. */
let finished = false;
let operatorPaused = false;
/** Прогон в сводке подписан участком: сам `RunRecord` о своём участке не знает. */
type DoneRun = { section: string; record: RunRecord };
let summary = { participant: "", sessionId: "", runs: [] as DoneRun[], events: 0 };

async function stopRun(): Promise<void> {
  session?.abort();
  session = null;
  if (desktop && mode === "protocol") await abortDesktopSession();
  instance?.stop();
  instance = null;
  surface.clear();
  stage.classList.remove("is-finished");
  ($("interstitial") as HTMLElement).hidden = true;
  $("banner").replaceChildren();
  operatorPaused = false;
}

/** Возврат к настройке — операторский ход: он же прерывает прогон, если тот идёт. */
async function toSetup(): Promise<void> {
  await stopRun();
  finished = false;
  $("setupAside").append($("setupDifficulty"));
  showScreen("setup");
  if (mode === "protocol") renderSchedule();
}

/**
 * Сводка после сессии: она нужна оператору, а не участнику, поэтому ждёт
 * прощального экрана и отдельного действия, а не выскакивает на монитор сама.
 */
function showDebrief(): void {
  const rows = summary.runs.map(
    ({ section, record }) =>
      `<div>${section} · <b>${record.gameId.replace("org.reconnect.", "")}</b> ур.${record.level} · ${secs(
        record.endedMs - record.startedMs,
      )} · ${record.reason === "completed" ? "сам" : record.reason === "aborted" ? "оборван" : "по расписанию"}</div>`,
  );
  $("debriefSummary").innerHTML = `
    <div class="pill">участник ${summary.participant}</div>
    <div class="pill">сессия ${summary.sessionId}</div>
    <div class="pill">прогонов ${summary.runs.length}</div>
    <div class="pill">событий ${summary.events}</div>
    <div class="schedule" style="margin-top:10px">${rows.join("")}</div>`;
  $("sessionPath").textContent = lastSessionDirectory
    ? `Данные автоматически сохранены: ${lastSessionDirectory}`
    : "Веб-витрина: данные доступны кнопками выгрузки.";
  ($("openSessionFolder") as HTMLButtonElement).hidden = !desktop || !lastSessionDirectory;
  showScreen("debrief");
}

/** Прогон сценария: тот же runtime, но расписанием владеет раннер сессии. */
async function startProtocol(): Promise<void> {
  await stopRun();
  markers = new MarkerDispatcher(new NullMarkerSink());
  const compiled = compile();
  // Журнал общий на всю сессию: в него пишут все участки и все прогоны.
  const records: LoggedEvent[] = [];
  sessionSink = records;
  if (desktop) {
    const info = await startDesktopSession({
      participantId: ($("participant") as HTMLInputElement).value || "p-000",
      protocolId: doc.id,
      protocolTitle: doc.title,
      protocolJson: doc,
      appVersion: "0.1.0",
      seed: compiled.seed,
      order: compiled.order,
      input: compiled.input,
      theme: ($("theme") as HTMLSelectElement).value,
      pace: ($("pace") as HTMLSelectElement).value,
      gameVersions: Object.fromEntries(games.map((game) => [game.manifest.id, game.manifest.version])),
      codebookVersion: "1.0.0",
      codebook: DEFAULT_CODEBOOK,
    });
    lastSessionDirectory = info?.directory ?? "";
  }
  const wrapped: DurableSink = {
    append(record) {
      records.push(record);
      appendLog(record);
      appendDesktopEvent(record);
    },
    flush() {},
  };

  const runtime = new GameRuntime({
    registry,
    clock: new RealClock(),
    markers,
    sink: wrapped,
    capabilities: ["keyboard", "pointer", "audio-output", "canvas", "webgl"],
    t0WallMs: Date.now(),
  });
  $("log").replaceChildren();
  $("banner").replaceChildren();
  run = { timerId: "", count: 0, line: null };

  const done: DoneRun[] = [];
  finished = false;
  operatorPaused = false;
  summary = {
    participant: ($("participant") as HTMLInputElement).value || "p-000",
    sessionId: compiled.sessionId,
    runs: done,
    events: 0,
  };
  showScreen("run");
  session = new SessionRunner({
    runtime,
    surface,
    sessionId: compiled.sessionId,
    seed: compiled.seed,
    sections: compiled.sections,
    sink: wrapped,
    // Способ ответа объявлен документом протокола, а не выбран в витрине.
    input: compiled.input,
    policyFor: (gameId) => compiled.policyFor(gameId),
    present,
    onSectionStart: (section, index) => {
      $("title").textContent = `${doc.title} — ${section.id}`;
      $("version").textContent = `участок ${index + 1} из ${compiled.sections.length}`;
      // Итог прошлого участка не должен висеть под сценой следующего.
      $("banner").replaceChildren();
      stage.classList.remove("is-finished");
    },
    onSectionEnd: (section, records) => {
      done.push(...records.map((record) => ({ section: section.id, record })));
      banner(
        `<b>Участок ${section.id} завершён.</b> прогонов: ${records.length} · ${records
          .map((r) => `${r.gameId.replace("org.reconnect.", "")} ур.${r.level}`)
          .join(", ")}`,
      );
    },
    onDone: () => {
      summary.events = records.length;
      stage.classList.add("is-finished");
      // Прощальный экран не принадлежит участку: сессия к этому моменту кончилась.
      // Пока он на мониторе, участник видит только его; сводка открывается тем же
      // действием оператора, что и любой другой переход, — кнопкой на экране.
      const close = async (): Promise<void> => {
        const directory = await finishDesktopSession("completed", summary);
        if (directory) lastSessionDirectory = directory;
        finished = true;
        if (compiled.outro) present(compiled.outro, 0, showDebrief);
        else showDebrief();
      };
      void close().catch((error) => {
        banner(`<b>Ошибка записи данных.</b> ${String((error as Error).message ?? error)}`);
        void emergencyStop(`finalize-error: ${String((error as Error).message ?? error)}`);
      });
    },
  });
  session.start();
  stage.focus();
}

function banner(html: string): void {
  const box = document.createElement("div");
  box.className = "result";
  box.innerHTML = html;
  $("banner").replaceChildren(box);
}

/**
 * Отладочный прогон одного модуля. Ручки сложности переезжают со стенда
 * настройки на экран прогона одним узлом: разработчику они нужны живыми, а
 * второй их копии, расходящейся по состоянию, быть не должно.
 */
function startModule(): void {
  void stopRun();
  $("side").prepend($("setupDifficulty"));
  showScreen("run");
  markers = new MarkerDispatcher(new NullMarkerSink());
  const clock = new RealClock();
  const runtime = new GameRuntime({
    registry,
    clock,
    markers,
    capabilities: ["keyboard", "pointer", "audio-output", "canvas", "webgl"],
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
    overrides: effectiveOverrides(),
    ...(($("trainingMode") as HTMLInputElement).checked ? { training: true } : {}),
    onDifficultyChanged: (level) => {
      ($("level") as HTMLInputElement).value = String(level);
      $("levelValue").textContent = String(level);
      blockControl();
      paramControls();
    },
    onComplete: (result: Json) => {
      banner(
        `<b>Блок завершён.</b> ${Object.entries(result as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : fmt(v)}`)
          .join(" · ")}<br><span style="color:var(--muted)">«Ещё раз» — следующий блок того же модуля.</span>`,
      );
      // Поле гасится: продолжать нажимать после конца блока нельзя.
      stage.classList.add("is-finished");
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

$("launch").addEventListener("click", () => {
  if (mode !== "protocol") return startModule();
  void startProtocol().catch((error) => {
    checkLine("portableStatus", false, String((error as Error).message ?? error));
    showScreen("setup");
    refreshDesktopGate();
  });
});
// «Стоп» и возврат живут только на отладочном прогоне: у сессии участника
// операторских кнопок на экране нет вовсе.
$("stop").addEventListener("click", () => {
  void stopRun().then(() => {
    banner("<b>Прогон остановлен.</b> «Ещё раз» — новый блок того же модуля.");
  });
});
$("back").addEventListener("click", () => void toSetup());
$("toSetup").addEventListener("click", () => void toSetup());
$("tabProtocol").addEventListener("click", selectProtocol);
$("tabBuilder").addEventListener("click", selectBuilder);
$("tabModule").addEventListener("click", () => select(current));
$("pace").addEventListener("change", () => {
  $("compressRow").hidden = !rehearsing();
  renderSchedule();
});
document.addEventListener("keydown", (event) => {
  // Escape открывает сводку и только после конца сессии: во время прогона у
  // участника руки на клавиатуре, и случайное нажатие не должно уводить с экрана.
  if (event.key === "Escape" && finished && !$("run").hidden) showDebrief();
  if (
    desktop &&
    mode === "protocol" &&
    session &&
    event.ctrlKey &&
    event.shiftKey &&
    event.code === "Space"
  ) {
    event.preventDefault();
    operatorPaused = !operatorPaused;
    if (operatorPaused) session.pause();
    else session.resume();
  }
  if (
    desktop &&
    mode === "protocol" &&
    session &&
    event.ctrlKey &&
    event.shiftKey &&
    event.code === "End" &&
    window.confirm("Аварийно остановить сессию? Частичные данные будут сохранены.")
  ) {
    event.preventDefault();
    void emergencyStop("operator");
  }
});

async function emergencyStop(reason: string): Promise<void> {
  if (!session) return;
  session.note("emergency.stop", { reason });
  session.abort();
  session = null;
  summary.events = sessionSink?.length ?? summary.events;
  const directory = await abortDesktopSession();
  if (directory) lastSessionDirectory = directory;
  finished = true;
  showDebrief();
}

window.addEventListener("blur", () => {
  if (mode === "protocol" && session && !finished) session.note("window.blur", {});
});
window.addEventListener("focus", () => {
  if (mode === "protocol" && session && !finished) session.note("window.focus", {});
});
window.addEventListener("reconnect-write-error", (event) => {
  const message = (event as CustomEvent<string>).detail;
  void emergencyStop(`storage-error: ${message}`);
});
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
  blockControl();
  paramControls();
});
$("participant").addEventListener("input", () => {
  renderSchedule();
  resetLslGate();
});
$("compress").addEventListener("input", (e) => {
  $("compressValue").textContent = (e.target as HTMLInputElement).value;
  renderSchedule();
});
const exportFile = async (name: string, fallback: () => string): Promise<void> => {
  const content = desktop ? await readDesktopSessionFile(name) : fallback();
  download(name, content);
};
$("exportJsonl").addEventListener("click", () => void exportFile("events.jsonl", () => exportLog("jsonl")));
$("exportCsv").addEventListener("click", () => void exportFile("events.csv", () => exportLog("csv")));
$("exportMarkers").addEventListener("click", () => void exportFile("markers.csv", () => markers.toCsv()));
// Артинис не различает значения меток: расшифровка живёт отдельным файлом, и без
// выгрузки книги поток меток нечем читать.
$("exportCodebook").addEventListener("click", () => void exportFile("codebook.csv", () => markers.codebookCsv()));
$("openSessionFolder").addEventListener("click", () => void openDesktopSessionFolder());
$("lslCheck").addEventListener("click", () => void preflightLsl());
$("labRecorderConfirm").addEventListener("change", refreshDesktopGate);

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

/**
 * Список сценариев: пилот и всё, что собрано в конструкторе. Выбор здесь —
 * единственное место, где решается, какой документ пойдёт в запись.
 */
function renderScenarios(): void {
  const box = $("scenario") as HTMLSelectElement;
  const saved = stored();
  const all = [
    ...(saved.some((protocol) => protocol.id === pilotProtocol.id) ? [] : [pilotProtocol as Protocol]),
    ...saved,
  ];
  const accepted = document.createElement("optgroup");
  accepted.label = "Готовы к запуску";
  const rejected = document.createElement("optgroup");
  rejected.label = "Ошибочные файлы — запуск запрещён";
  for (const protocol of all) {
    let error = "";
    try {
      compileProtocol(protocol, {
        participantId: ($("participant") as HTMLInputElement).value || "p-000",
        registry,
      });
    } catch (reason) {
      error = String((reason as Error).message ?? reason);
    }
    const option = document.createElement("option");
    option.value = protocol.id;
    option.textContent = error
      ? `${protocol.title} · НЕ ПРИНЯТ: ${error}`
      : `${protocol.title} · ${protocol.sections.length} блоков${
          protocol.id === pilotProtocol.id ? "" : " · файл"
        }`;
    option.selected = protocol.id === doc.id;
    option.disabled = Boolean(error);
    (error ? rejected : accepted).append(option);
  }
  for (const file of desktopBootstrap()?.protocols ?? []) {
    if (!file.error) continue;
    const option = document.createElement("option");
    option.disabled = true;
    option.textContent = `${file.fileName} · НЕ JSON: ${file.error}`;
    rejected.append(option);
  }
  box.replaceChildren(
    accepted,
    ...(rejected.children.length ? [rejected] : []),
  );
}

const builder = mountBuilder($("builder"), {
  manifests: games.map((game) => game.manifest),
  // Конструктор открывается копией базового протокола: расписание пилота — это
  // то, что правят, а не то, что набирают заново. Копией, а не самим пилотом:
  // иначе правка увела бы за собой готовый документ, с которым сравнивают.
  base: () => {
    const copy = structuredClone(pilotProtocol) as Protocol;
    copy.id = `${pilotProtocol.id}-copy`;
    copy.title = `${pilotProtocol.title} (копия)`;
    return copy;
  },
  // Годность сценария проверяет тот же компилятор, что и запуск: второй,
  // «мягкой» проверки в конструкторе быть не должно — она разошлась бы с первой.
  validate: (candidate) => {
    try {
      compileProtocol(candidate, { participantId: "p-000", registry });
      return [];
    } catch (error) {
      if (error instanceof ProtocolError) return error.report.issues.map((issue) => issue.message);
      return [String((error as Error).message ?? error)];
    }
  },
  save: (candidate) => {
    if (
      desktop &&
      stored().some((protocol) => protocol.id === candidate.id) &&
      !window.confirm(`Файл сценария «${candidate.title}» уже существует. Заменить его?`)
    ) {
      return;
    }
    keep(candidate);
    // Правка обязана дойти до запуска. Прежде сохранение писало сценарий в
    // хранилище, а выбранный документ оставался тем, который открыли: оператор
    // менял порядок блоков и длительности, нажимал «Начать сессию» — и сессия
    // шла по прошлой версии, ничем на экране от новой не отличимой.
    if (doc.id === candidate.id) doc = structuredClone(candidate);
    renderScenarios();
  },
  remove: (id) => {
    forget(id);
    renderScenarios();
  },
  saved: stored,
  download,
  run: (candidate) => {
    doc = candidate;
    renderScenarios();
    selectProtocol();
    void startProtocol().catch((error) => {
      checkLine("portableStatus", false, String((error as Error).message ?? error));
      showTab("protocol");
      showScreen("setup");
      refreshDesktopGate();
    });
  },
});

// Витрина открывается настройкой сессии: сценарий — то, ради чего она нужна,
// конструктор и отладка модуля — соседние вкладки.
renderScenarios();
$("scenario").addEventListener("change", (event) => {
  const id = (event.target as HTMLSelectElement).value;
  doc = stored().find((p) => p.id === id) ?? (pilotProtocol as Protocol);
  renderSchedule();
  renderInputNote();
  resetLslGate();
});
renderCatalog();
select(games[0]!);
selectProtocol();
showScreen("setup");

if (desktop) {
  $("desktopChecks").hidden = false;
  ($("launch") as HTMLButtonElement).disabled = true;
  if (experimentProduction && !experimentTools) {
    $("tabBuilder").hidden = true;
    $("tabModule").hidden = true;
  }
  void desktopReady
    .then((info) => {
      desktopReadyForRun = info?.writable ?? false;
      checkLine(
        "portableStatus",
        desktopReadyForRun,
        desktopReadyForRun
          ? `Portable-root доступен для записи: ${info!.portableRoot}${
              info!.interruptedSessions
                ? `. Найдено незавершённых сессий: ${info!.interruptedSessions}`
                : ""
            }`
          : (info?.storageError ?? "portable-root недоступен"),
      );
      const diskProtocols = desktopProtocols();
      doc =
        diskProtocols.find((protocol) => protocol.id === doc.id) ??
        diskProtocols[0] ??
        (pilotProtocol as Protocol);
      renderScenarios();
      renderSchedule();
      renderInputNote();
      refreshDesktopGate();
    })
    .catch((error) => {
      desktopReadyForRun = false;
      checkLine("portableStatus", false, String((error as Error).message ?? error));
      refreshDesktopGate();
    });
}
