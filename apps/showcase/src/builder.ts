import type { Manifest, Params } from "@gamespace/core";
import type { Protocol, Section } from "@gamespace/protocol";

/**
 * Экран так, как его требует схема протокола: хотя бы один абзац. Раннеру
 * хватает обычного списка строк, но здесь мы правим документ, и слабее схемы
 * тип брать нельзя — иначе пустой экран уехал бы в файл и упал на компиляции.
 */
type Screen = NonNullable<Section["interstitial"]>;
type Body = Screen["body"];

const body = (lines: string[]): Body => (lines.length > 0 ? (lines as Body) : ([""] as Body));

/**
 * Схема требует у блока хотя бы один модуль. Пока исследователь выбирает состав,
 * блок законно бывает пустым: такой документ не проходит проверку, кнопка
 * запуска гаснет и жалоба видна на месте. Скрывать это состояние — значит
 * заставлять снимать последнюю галочку вслепую.
 */
function setGames(section: Section, ids: string[]): void {
  section.games = ids as Section["games"];
}

/**
 * Конструктор сценария. Исследователь собирает протокол из базовых блоков, а
 * результат остаётся обычным документом протокола: приложение по-прежнему
 * ничего не знает о расписании, оно исполняет то, что здесь собрано. Поэтому
 * редактор правит документ на месте, а не свою модель, которую потом пришлось
 * бы сводить с ним обратно.
 */
export type BlockKind = "baseline" | "training" | "game" | "pause" | "micro";

const BASELINE = "org.reconnect.baseline";
const short = (id: string): string => id.replace("org.reconnect.", "");
const long = (name: string): string => (name.includes(".") ? name : `org.reconnect.${name}`);

export const BLOCK_TITLES: Record<BlockKind, string> = {
  baseline: "Покой",
  training: "Обучение",
  game: "Блок-игра",
  pause: "Перерыв",
  micro: "Микропауза",
};

/**
 * Вид блока выводится из содержания, а не хранится рядом с ним. Отдельное поле
 * «тип» рано или поздно разошлось бы с тем, что в блоке на самом деле, и тогда
 * конструктор показывал бы одно, а сессия делала другое.
 *
 * Микропауза отличается от перерыва тем, что участнику про неё ничего не
 * говорят: отбивки нет, оператор ничего не листает, блок сам кончается через
 * объявленные секунды. Поэтому и в счёт частей сессии она не идёт.
 */
export function blockKind(section: Section): BlockKind {
  if (section.training) return "training";
  if (section.games.length === 1 && section.games[0] === BASELINE) {
    if (section.overrides?.[BASELINE]?.fixation !== false) return "baseline";
    return section.interstitial ? "pause" : "micro";
  }
  return "game";
}

const screen = (title: string, lines: string[]): Screen => ({
  title,
  body: body(lines),
  footer: "Оператор начнёт, когда вы будете готовы.",
});

/**
 * Заготовка блока: с текстами, которые есть смысл читать, а не с рыбой. Состав
 * модулей приходит снаружи: какие задачи вообще есть, знает каталог витрины, а
 * не эта функция.
 */
export function makeBlock(kind: BlockKind, id: string, games: string[] = []): Section {
  switch (kind) {
    case "baseline":
      return {
        id,
        games: [BASELINE],
        end: { by: "time", ms: 600_000 },
        interstitial: screen("Покой", [
          "Заданий не будет. На экране появится крестик в центре — смотрите на него и сидите спокойно.",
          "Постарайтесь не засыпать и не уходить в мысли о делах. Дышите как обычно, глаза держите открытыми.",
        ]),
        overrides: {
          [BASELINE]: {
            durationMs: 600_000,
            showTimer: false,
            fixation: true,
            text: "Сидите спокойно, смотрите в центр экрана. Ничего делать не нужно.",
          },
        },
      };
    case "pause":
      return {
        id,
        games: [BASELINE],
        end: { by: "time", ms: 120_000 },
        interstitial: screen("Перерыв", [
          "Блок закончен. Можно расслабить глаза, размять руку и задать вопросы — сейчас говорить можно.",
          "Со стула лучше не вставать и шапку не трогать: датчики стоят как надо, их положение нужно сохранить.",
        ]),
        overrides: {
          // Крестика в перерыве нет намеренно: отдых не должен превращаться в
          // ещё одно задание на удержание взгляда.
          [BASELINE]: { durationMs: 120_000, showTimer: true, fixation: false, text: "Перерыв. Можно отдохнуть." },
        },
      };
    case "micro":
      return {
        id,
        games: [BASELINE],
        end: { by: "time", ms: 20_000 },
        // Пауза сама себе отмеряет время, поэтому второй заход ей не нужен:
        // иначе время участка перекрывает объявленные секунды паузы.
        repeat: false,
        // Отбивки нет намеренно: это промежуток для оператора и техники, а не
        // часть сессии. Участнику остаётся строка и отсчёт, чтобы пауза не
        // выглядела зависшим экраном.
        overrides: {
          [BASELINE]: {
            durationMs: 20_000,
            showTimer: true,
            fixation: false,
            text: "Небольшая пауза. Ничего делать не нужно.",
          },
        },
      };
    case "training":
      return {
        id,
        games: games as Section["games"],
        training: true,
        difficulty: { policy: "fixed", start: 0 },
        end: {
          by: "first",
          of: [{ by: "coverage" }, { by: "time", ms: 600_000 }, { by: "run-limit", ms: 90_000 }],
        },
        interstitial: screen("Обучение", [
          "Сейчас вы по очереди познакомитесь со всеми заданиями. Перед каждым будет правило, пример и раскладка клавиш.",
          "Это единственная часть, где ошибаться полезно: тренировка на то и нужна, чтобы разобраться.",
        ]),
      };
    default:
      return {
        id,
        games: games as Section["games"],
        end: { by: "time", ms: 1_200_000 },
        interstitial: screen("Блок заданий", [
          "Отвечайте как можно быстрее, но не в ущерб точности. Задания будут постепенно становиться труднее — так задумано.",
          "Во время блока не разговаривайте и не меняйте посадку. Если случится что-то серьёзное — руку вверх, мы остановим.",
        ]),
      };
  }
}

export function emptyProtocol(): Protocol {
  return {
    protocolVersion: "1.0",
    id: "new-protocol",
    title: "Новый сценарий",
    locale: "ru",
    difficulty: { policy: "monotonic", start: 1, successesToAdvance: 2 },
    interaction: { keys: ["Q", "W", "E"], pointer: "task-only" },
    sections: [makeBlock("baseline", "baseline-pre")],
    interstitials: {
      intro: screen("Что будет дальше", [
        "Опишите здесь, из чего состоит сессия, сколько она займёт и чем участник отвечает.",
      ]),
      outro: { title: "Готово", body: body(["Сессия закончена, спасибо."]) },
    },
  };
}

/**
 * Ёмкость ответа объявлена клавишами, поэтому ось числа вариантов выше их
 * количества подниматься не может. Границу ставит конструктор и показывает её
 * среди диапазонов: узнавать о несовместимости из отказа компилятора после
 * сборки — значит узнавать поздно. Уже заданное сужение не трогаем: если
 * исследователь взял два варианта из трёх клавиш, это его решение.
 */
export function capByKeys(doc: Protocol, manifests: Manifest[]): void {
  const capacity = doc.interaction?.keys?.length;
  if (!capacity) return;
  const bounds = { ...(doc.bounds ?? {}) };
  for (const manifest of manifests) {
    const alternatives = manifest.responseAlternatives;
    if (alternatives?.addressedBy !== "keys" || !alternatives.param) continue;
    const forGame = { ...(bounds[manifest.id] ?? {}) };
    const bound = forGame[alternatives.param] ?? {};
    if (bound.max !== undefined && bound.max <= capacity) continue;
    forGame[alternatives.param] = { ...bound, max: capacity };
    bounds[manifest.id] = forGame;
  }
  if (Object.keys(bounds).length > 0) doc.bounds = bounds;
}

export interface BuilderDeps {
  /** Каталог модулей: в блок-игру можно поставить только то, что зарегистрировано. */
  manifests: Manifest[];
  /**
   * Документ, с которого конструктор открывается. Исследователь почти всегда
   * правит базовый протокол, а не сочиняет расписание заново, поэтому пустой
   * сценарий — это отдельное решение и отдельная кнопка.
   */
  base?(): Protocol;
  /** Претензии к документу от компилятора протокола; пустой список — можно запускать. */
  validate(doc: Protocol): string[];
  save(doc: Protocol): void;
  remove(id: string): void;
  saved(): Protocol[];
  run(doc: Protocol): void;
  download(name: string, content: string): void;
}

export interface BuilderHandle {
  doc(): Protocol;
  open(doc: Protocol): void;
  render(): void;
}

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...kids);
  return node;
};

const field = (label: string, control: HTMLElement): HTMLElement =>
  h("div", { class: "param" }, h("label", {}, label), control);

const mins = (ms: number): string => String(Math.round(ms / 60_000));

/** Длительность для списка: у микропауз в минутах нечего показывать. */
const span = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} с` : `${Math.round(ms / 60_000)} мин`);

type ParamSpec = { type?: string; minimum?: number; maximum?: number; enum?: string[]; title?: string };

const propsOf = (manifest: Manifest): Record<string, ParamSpec> =>
  ((manifest.parametersSchema.schema as { properties?: Record<string, ParamSpec> }).properties ?? {});

/** Длительность блока живёт в двух местах сразу — держим их в согласии. */
function setDuration(section: Section, ms: number): void {
  section.end = { by: "time", ms };
  if (section.games[0] === BASELINE) {
    section.overrides = { ...section.overrides, [BASELINE]: { ...section.overrides?.[BASELINE], durationMs: ms } };
  }
}

/**
 * Контрбалансировка называет пару участков по именам, поэтому переименование и
 * удаление блока обязаны вести её за собой. Компилятор не прощает повисшую
 * ссылку, и правильно: молча не поменявшаяся местами пара означала бы, что
 * половина участников прошла не тот план, который задуман, и никто об этом не
 * узнал. Так что ссылку правим здесь, а не ослабляем проверку там.
 */
export function followSections(doc: Protocol, rename?: { from: string; to: string }): void {
  const swap = doc.counterbalance?.swap;
  if (!swap) return;
  const ids = new Set(doc.sections.map((s) => s.id));
  const next = swap
    .map((id) => (rename && id === rename.from ? rename.to : id))
    .filter((id) => ids.has(id));
  // Пары без второго участника не бывает: остался один блок — контрбалансировать
  // нечего, и держать половину настройки хуже, чем убрать её целиком.
  if (next.length === 2) doc.counterbalance = { ...doc.counterbalance!, swap: next as [string, string] };
  else delete doc.counterbalance;
}

/** Ограничение времени внутри `first`: у обучения потолок, а не длительность. */
function setCap(section: Section, ms: number): void {
  if (section.end.by !== "first") return;
  section.end = {
    by: "first",
    of: section.end.of.map((part) => (part.by === "time" ? { by: "time", ms } : part)) as typeof section.end.of,
  };
}

function capOf(section: Section): number {
  if (section.end.by === "time") return section.end.ms;
  if (section.end.by === "first") {
    const timed = section.end.of.find((part) => part.by === "time");
    if (timed && timed.by === "time") return timed.ms;
  }
  return 0;
}

export function mountBuilder(host: HTMLElement, deps: BuilderDeps): BuilderHandle {
  let doc: Protocol = deps.base ? deps.base() : emptyProtocol();
  /**
   * Что открыто справа. Слева — весь список блоков сразу: расписание сессии
   * видно целиком, а ручки не растягивают его на несколько экранов. Выбор
   * хранится ссылкой на блок, а не номером: блоки двигаются, и номер уехал бы
   * на соседа.
   */
  let picked: Section | "session" = doc.sections[0] ?? "session";
  /**
   * Какой модуль блока открыт: у блока их бывает несколько, а у составной игры —
   * ещё и дочерние задачи, и у каждой свои диапазоны. Показывать все подряд —
   * это простыня, в которой не видно, чьи параметры правишь.
   */
  let pickedTask: string | null = null;

  const byId = (id: string): Manifest | undefined => deps.manifests.find((m) => m.id === id);
  const playable = deps.manifests.filter((m) => m.id !== BASELINE);
  // Составные игры собираются из своих детей и в обучение не ставятся: правило
  // учат по одной задаче, а не по оркестратору поверх них.
  const simple = playable.filter((m) => (m.children ?? []).length === 0);

  const textArea = (value: string[], onChange: (lines: string[]) => void): HTMLTextAreaElement => {
    const area = h("textarea", { rows: "4" }) as HTMLTextAreaElement;
    area.value = value.join("\n\n");
    // Правка текста не перерисовывает конструктор: иначе абзац терял бы фокус
    // на каждом нажатии. Перерисовка нужна только смене состава блоков.
    area.addEventListener("change", () => onChange(area.value.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)));
    return area;
  };

  const text = (value: string, onChange: (value: string) => void): HTMLInputElement => {
    const input = h("input", { type: "text" }) as HTMLInputElement;
    input.value = value;
    input.addEventListener("change", () => onChange(input.value));
    return input;
  };

  const number = (value: number, onChange: (value: number) => void, attrs: Record<string, string> = {}) => {
    const input = h("input", { type: "number", ...attrs }) as HTMLInputElement;
    input.value = String(value);
    input.addEventListener("change", () => onChange(Number(input.value)));
    return input;
  };

  const select = (
    options: [string, string][],
    value: string,
    onChange: (value: string) => void,
  ): HTMLSelectElement => {
    const box = h("select") as HTMLSelectElement;
    for (const [key, label] of options) {
      const option = h("option", { value: key }, label) as HTMLOptionElement;
      option.selected = key === value;
      box.append(option);
    }
    box.addEventListener("change", () => onChange(box.value));
    return box;
  };

  /** Экран блока: текст, который увидит участник, — такой же параметр, как темп. */
  function screenEditor(title: string, value: Screen | undefined, set: (next: Screen) => void): HTMLElement {
    const current: Screen = value ?? { title: "", body: body([]) };
    return h(
      "div",
      { class: "builder-screen" },
      h("h5", {}, title),
      field("Заголовок", text(current.title, (v) => set({ ...current, title: v }))),
      field(
        "Текст, абзацы через пустую строку",
        textArea(current.body, (lines) => set({ ...current, body: body(lines) })),
      ),
      field("Подпись внизу", text(current.footer ?? "", (v) => set({ ...current, footer: v }))),
    );
  }

  /**
   * Диапазоны параметров модуля. Границы — это то, что исследователь разрешает
   * политике: она двигает ось внутри них. Совпавшие границы означают
   * закреплённую ось, и рост уходит на свободные, а не пропадает молча.
   */
  function boundsEditor(section: Section, manifest: Manifest): HTMLElement {
    const rows = Object.entries(propsOf(manifest))
      .filter(([, spec]) => spec.type === "integer" || spec.type === "number")
      .map(([key, spec]) => {
        const bound = section.bounds?.[manifest.id]?.[key] ?? {};
        const write = (edge: "min" | "max", raw: string): void => {
          const bounds = { ...(section.bounds ?? {}) };
          const forGame = { ...(bounds[manifest.id] ?? {}) };
          const next = { ...(forGame[key] ?? {}) };
          if (raw === "") delete next[edge];
          else next[edge] = Number(raw);
          if (Object.keys(next).length === 0) delete forGame[key];
          else forGame[key] = next;
          if (Object.keys(forGame).length === 0) delete bounds[manifest.id];
          else bounds[manifest.id] = forGame;
          if (Object.keys(bounds).length === 0) delete section.bounds;
          else section.bounds = bounds;
          pinned.textContent = isPinnedNow() ? "закреплено" : "";
        };
        const edge = (name: "min" | "max"): HTMLInputElement => {
          const input = h("input", {
            type: "number",
            placeholder: String(name === "min" ? (spec.minimum ?? "") : (spec.maximum ?? "")),
          }) as HTMLInputElement;
          input.value = bound[name] === undefined ? "" : String(bound[name]);
          input.addEventListener("change", () => write(name, input.value));
          return input;
        };
        const isPinnedNow = (): boolean => {
          const now = section.bounds?.[manifest.id]?.[key];
          return now?.min !== undefined && now.min === now.max;
        };
        const pinned = h("span", { class: "pill" }, isPinnedNow() ? "закреплено" : "");
        return h(
          "div",
          { class: "builder-bound" },
          h("label", {}, spec.title ?? key),
          edge("min"),
          h("span", {}, "…"),
          edge("max"),
          pinned,
        );
      });
    return h("div", { class: "builder-bounds" }, ...rows);
  }

  /**
   * Задача списком: галочка решает, входит ли она в блок, а щелчок по строке
   * открывает её параметры. Одна строка на задачу, а не галочки отдельно и
   * параметры отдельно: иначе непонятно, чьи диапазоны сейчас правишь.
   */
  function taskRow(opts: {
    label: string;
    hint: string;
    included: boolean;
    fixed?: boolean;
    focused: boolean;
    toggle(): void;
    focus(): void;
  }): HTMLElement {
    const box = h("input", { type: "checkbox" }) as HTMLInputElement;
    box.checked = opts.included;
    box.disabled = Boolean(opts.fixed);
    box.addEventListener("click", (event) => event.stopPropagation());
    box.addEventListener("change", () => opts.toggle());
    const row = h(
      "div",
      { class: `builder-row is-task${opts.focused ? " is-picked" : ""}` },
      box,
      h("b", {}, opts.label),
      h("span", { class: "builder-row-id" }, opts.hint),
    );
    row.addEventListener("click", () => opts.focus());
    return row;
  }

  /** Выбор модулей блока: одна игра или ротация. Фокус открывает её диапазоны. */
  function gamesEditor(section: Section, pool: Manifest[]): HTMLElement {
    return h(
      "div",
      { class: "builder-tasks" },
      ...pool.map((manifest) =>
        taskRow({
          label: manifest.title.ru,
          hint: short(manifest.id),
          included: section.games.includes(manifest.id),
          focused: focusOf(section).module?.id === manifest.id,
          toggle: () => {
            const included = section.games.includes(manifest.id);
            setGames(
              section,
              included ? section.games.filter((id) => id !== manifest.id) : [...section.games, manifest.id],
            );
            if (!included) pickedTask = manifest.id;
            render();
          },
          focus: () => {
            pickedTask = manifest.id;
            render();
          },
        }),
      ),
    );
  }

  /**
   * Тип блока-игры выбирается списком: блок занят одной задачей, и это не
   * ограничение, а различение. Чередование задач внутри блока — отдельное
   * явление со своим расписанием, и им заняты составные игры; набор галочек на
   * равных с ними прятал бы разницу между «блок Струпа» и «блок, в котором
   * Струп чередуется с чем-то ещё».
   */
  function moduleEditor(section: Section, pool: Manifest[]): HTMLElement {
    const current = section.games[0] ?? "";
    const options: Array<[string, string]> = pool.map((manifest) => [
      manifest.id,
      (manifest.children ?? []).length > 0 ? `${manifest.title.ru} — составной` : manifest.title.ru,
    ]);
    return field(
      "Тип блока",
      select(options, current, (v) => {
        setGames(section, [v]);
        pickedTask = v;
        render();
      }),
    );
  }

  /**
   * Составная игра — тоже расписание, только внутри блока: из каких задач она
   * складывается, решает исследователь, а не порядок объявления в манифесте. И
   * каждая дочерняя задача открывается так же, как модуль блока: у неё свои оси.
   */
  function childrenEditor(section: Section, manifest: Manifest): HTMLElement {
    const children = manifest.children ?? [];
    const raw = String(section.overrides?.[manifest.id]?.tasks ?? "");
    const declared = raw.split(",").map((s) => s.trim()).filter(Boolean).map(long);
    // Прерывания устроены иначе батареи: первая дочерняя задача — фоновая, она
    // обязана уметь возобновляться, и выбирать там нечего.
    const fixedBackground = children.some((child) => child.requiresResume);
    const choosable = fixedBackground ? children.slice(1) : children;
    // Несказанный состав означает «все»: в наборе он должен выглядеть так же,
    // иначе снятие первой галочки не с чего вычитать и состав не меняется.
    const chosen = new Set(declared.length > 0 ? declared : choosable.map((child) => child.id));

    const write = (): void => {
      const list = choosable.filter((child) => chosen.has(child.id)).map((child) => short(child.id));
      const overrides = { ...(section.overrides ?? {}) };
      const forGame: Params = { ...(overrides[manifest.id] ?? {}) };
      if (list.length === 0 || list.length === choosable.length) delete forGame.tasks;
      else forGame.tasks = list.join(",");
      if (Object.keys(forGame).length === 0) delete overrides[manifest.id];
      else overrides[manifest.id] = forGame;
      if (Object.keys(overrides).length === 0) delete section.overrides;
      else section.overrides = overrides;
    };

    const focused = focusOf(section);
    const rows = children.map((child) =>
      taskRow({
        label: byId(child.id)?.title.ru ?? short(child.id),
        hint: fixedBackground && child === children[0] ? "фоновая задача" : short(child.id),
        included: fixedBackground && child === children[0] ? true : chosen.has(child.id),
        fixed: fixedBackground && child === children[0],
        focused: focused.child?.id === child.id,
        toggle: () => {
          if (chosen.has(child.id)) chosen.delete(child.id);
          else chosen.add(child.id);
          // Пустой выбор равнозначен «все»: блока без единой задачи не бывает.
          if (chosen.size === 0) for (const c of choosable) chosen.add(c.id);
          write();
          render();
        },
        focus: () => {
          pickedTask = child.id;
          render();
        },
      }),
    );

    return h(
      "div",
      { class: "builder-children" },
      h("h5", {}, "Состав составной игры"),
      h(
        "div",
        { class: "note" },
        fixedBackground
          ? "Первая задача идёт фоном и не выключается: она одна умеет возобновляться после прерывания. Остальные — прерыватели."
          : "Задачи чередуются внутри блока. Щёлкните по задаче, чтобы задать её диапазоны.",
      ),
      h("div", { class: "builder-tasks" }, ...rows),
    );
  }

  /** Политика роста сложности блока: чем именно двигается уровень и в каких пределах. */
  function difficultyEditor(section: Section): HTMLElement {
    const value = section.difficulty ?? doc.difficulty ?? { policy: "monotonic" as const };
    const set = (patch: Partial<typeof value>): void => {
      section.difficulty = { ...value, ...patch };
    };
    return h(
      "div",
      { class: "builder-difficulty" },
      field(
        "Политика роста",
        select(
          [
            ["monotonic", "Монотонная: только рост"],
            ["adaptive", "Адаптивная 2-up/1-down"],
            ["manual", "Ручная: уровень держит оператор"],
            ["fixed", "Заморожена: нагрузка не меняется"],
          ],
          value.policy,
          (v) => {
            set({ policy: v as typeof value.policy });
            render();
          },
        ),
      ),
      field("Стартовый уровень", number(value.start ?? 1, (v) => set({ start: v }), { min: "0" })),
      field("Нижний уровень", number(value.min ?? 1, (v) => set({ min: v }), { min: "0" })),
      field("Верхний уровень", number(value.max ?? 8, (v) => set({ max: v }), { min: "1" })),
      ...(value.policy === "monotonic"
        ? [
            field(
              "Успехов до повышения",
              number(value.successesToAdvance ?? 2, (v) => set({ successesToAdvance: v }), { min: "1" }),
            ),
          ]
        : []),
    );
  }

  function baselineEditor(section: Section, kind: BlockKind): HTMLElement {
    const params = (section.overrides?.[BASELINE] ?? {}) as Params;
    const set = (patch: Params): void => {
      section.overrides = { ...section.overrides, [BASELINE]: { ...params, ...patch } };
    };
    return h(
      "div",
      {},
      field(
        "Текст на экране участника",
        text(String(params.text ?? ""), (v) => set({ text: v })),
      ),
      field(
        "Таймер обратного отсчёта",
        select(
          [
            ["false", "не показывать"],
            ["true", "показывать"],
          ],
          String(params.showTimer ?? false),
          (v) => set({ showTimer: v === "true" }),
        ),
      ),
      // У микропаузы крестика нет по определению: закреплять взгляд там, где
      // участнику ничего не сказали, значит требовать от него работы молча.
      // Поэтому выбор показывается только у покоя и перерыва.
      ...(kind === "micro"
        ? []
        : [
            field(
              "Крестик в центре",
              select(
                [
                  ["true", "есть: взгляд закреплён"],
                  ["false", "нет: можно отвести глаза"],
                ],
                String(params.fixation ?? kind === "baseline"),
                (v) => {
                  set({ fixation: v === "true" });
                  // Вид блока выводится из содержания, поэтому крестик меняет и заголовок.
                  render();
                },
              ),
            ),
          ]),
    );
  }

  /**
   * Что открыто внутри блока: модуль и, если он составной, его дочерняя задача.
   * Выбор запоминается идентификатором, но сверяется с составом блока: сняли
   * галочку — откроется первый оставшийся модуль, а не пустое место. У составной
   * игры задача открыта всегда: её оси — то, ради чего блок собирают, и пустая
   * колонка на месте параметров означала бы, что настраивать нечего.
   */
  function focusOf(section: Section): { module?: Manifest; child?: Manifest } {
    const modules = section.games.map(byId).filter((m): m is Manifest => Boolean(m));
    const owner = modules.find((m) => m.id === pickedTask || (m.children ?? []).some((c) => c.id === pickedTask));
    const module = owner ?? modules[0];
    const children = module?.children ?? [];
    const child = children.find((c) => c.id === pickedTask) ?? children[0];
    const childManifest = child ? byId(child.id) : undefined;
    return { ...(module ? { module } : {}), ...(childManifest ? { child: childManifest } : {}) };
  }

  /**
   * Задача, чьи параметры открыты справа. У составной игры это её дочерняя
   * задача, у одиночного блока — сам модуль: то и другое настраивается одними и
   * теми же осями, и различать их в третьей колонке незачем. Оси самой составной
   * игры остаются при блоке: чередование — это его расписание, а не задача.
   */
  function taskOf(section: Section): Manifest | undefined {
    // Покой, перерыв и микропауза заняты одним модулем без нагрузки: его
    // длительность и текст правятся полями блока, и колонка осей повторяла бы
    // их вторым способом.
    if (section.games.length === 1 && section.games[0] === BASELINE) return undefined;
    const focus = focusOf(section);
    if (focus.child) return focus.child;
    return (focus.module?.children ?? []).length > 0 ? undefined : focus.module;
  }

  /**
   * Третья колонка: уточнение течёт слева направо. Слева расписание сессии,
   * в середине блок и его состав, справа — оси той задачи, на которую сейчас
   * смотрят. Раньше диапазоны лежали в подвале средней панели, и у составной
   * игры выбор задачи и её параметры оказывались в одном столбце друг под
   * другом: непонятно, чьи оси правишь.
   */
  function taskPanel(section: Section, task: Manifest): HTMLElement {
    const owner = focusOf(section).module;
    const inside = owner && owner.id !== task.id ? `внутри блока: ${owner.title.ru}` : short(task.id);
    return h(
      "div",
      { class: "builder-focus" },
      h(
        "div",
        { class: "builder-block-head" },
        h("b", {}, task.title.ru),
        h("span", { class: "builder-row-id" }, inside),
      ),
      h("h5", {}, `Диапазоны: ${task.title.ru}`),
      h(
        "div",
        { class: "note" },
        "Внутри границ уровень двигает политика роста. Сомкнутые границы закрепляют ось, и рост уходит на свободные.",
      ),
      boundsEditor(section, task),
    );
  }

  /**
   * Строка расписания. Здесь только то, что нужно, чтобы узнать блок и
   * подвинуть его: чем он занят и сколько идёт. Ручки — справа, по выбору.
   */
  function blockRow(section: Section, index: number): HTMLElement {
    const kind = blockKind(section);
    const move = (delta: number): void => {
      const to = index + delta;
      if (to < 0 || to >= doc.sections.length) return;
      const [moved] = doc.sections.splice(index, 1);
      doc.sections.splice(to, 0, moved!);
      render();
    };
    const remove = (): void => {
      doc.sections.splice(index, 1);
      followSections(doc);
      if (picked === section) picked = doc.sections[index] ?? doc.sections[index - 1] ?? "session";
      render();
    };

    const op = (label: string, title: string, onClick: () => void): HTMLElement => {
      const button = h("button", { class: "btn", type: "button", title }, label);
      button.addEventListener("click", (event) => {
        // Порядок и удаление — про строку, а не про выбор: без этого нажатие на
        // крестик заодно открывало бы справа блок, которого уже нет.
        event.stopPropagation();
        onClick();
      });
      return button;
    };

    const row = h(
      "div",
      { class: `builder-row is-${kind}${picked === section ? " is-picked" : ""}` },
      h("span", { class: "pill" }, `${index + 1}`),
      h("b", {}, BLOCK_TITLES[kind]),
      h("span", { class: "builder-row-id" }, section.id),
      h("span", { class: "builder-row-time" }, span(capOf(section))),
      h(
        "div",
        { class: "builder-row-ops" },
        op("↑", "Выше", () => move(-1)),
        op("↓", "Ниже", () => move(1)),
        op("×", "Убрать блок", remove),
      ),
    );
    row.addEventListener("click", () => {
      // Открыли другой блок — фокус внутри начинается заново: задача прошлого
      // блока к этому отношения не имеет.
      if (picked !== section) pickedTask = null;
      picked = section;
      render();
    });
    return row;
  }

  /**
   * Длительность в минутах. Перерисовка обязательна: то же время написано в
   * строке расписания слева, и без неё список обещает одно, а панель другое.
   */
  const minutes = (section: Section, value: number): void => {
    setDuration(section, Math.max(1, value) * 60_000);
    render();
  };

  /**
   * Повторять ли прогоны, пока идёт участок. Модуль, который сам себе отмеряет
   * время, повтора не хочет: время участка тогда перекрывает время блока, и
   * пауза на десять секунд внутри тридцатисекундного участка идёт трижды.
   */
  function repeatField(section: Section): HTMLElement {
    return field(
      "Повтор внутри блока",
      select(
        [
          ["true", "перезапускать, пока идёт блок"],
          ["false", "один проход: блок кончается вместе с модулями"],
        ],
        String(section.repeat !== false),
        (v) => {
          if (v === "false") section.repeat = false;
          else delete section.repeat;
          render();
        },
      ),
    );
  }

  /** Ручки выбранного блока. Открыты всегда только у одного: их много. */
  function blockPanel(section: Section): HTMLElement {
    const kind = blockKind(section);
    const panel = h("div", { class: `builder-block is-${kind}` });

    panel.append(
      h(
        "div",
        { class: "builder-block-head" },
        h("b", {}, BLOCK_TITLES[kind]),
        text(section.id, (v) => {
          const was = section.id;
          section.id = v;
          // Имя участка — то, чем на него ссылаются: контрбалансировка идёт за
          // переименованием сама, иначе её ссылка повиснет на прежнем имени.
          followSections(doc, { from: was, to: v });
          render();
        }),
      ),
    );

    if (kind === "micro") {
      // Отбивки у микропаузы нет намеренно, и её редактора тоже: появившийся
      // текст сделал бы из промежутка перерыв, то есть часть сессии.
      panel.append(
        h(
          "div",
          { class: "note" },
          "Промежуток для оператора и техники: отбивки нет, листать нечего, блок кончается сам. В счёт частей сессии не идёт.",
        ),
        field(
          "Длительность, с",
          number(
            Math.round(capOf(section) / 1000),
            (v) => {
              setDuration(section, Math.max(1, v) * 1000);
              render();
            },
            { min: "1" },
          ),
        ),
        repeatField(section),
        baselineEditor(section, kind),
      );
      return panel;
    }

    panel.append(
      screenEditor("Отбивка перед блоком", section.interstitial, (next) => {
        section.interstitial = next;
      }),
    );

    if (kind === "baseline" || kind === "pause") {
      panel.append(
        field(
          "Длительность, мин",
          number(Number(mins(capOf(section))), (v) => minutes(section, v), { min: "1" }),
        ),
        repeatField(section),
        baselineEditor(section, kind),
      );
      return panel;
    }

    if (kind === "training") {
      panel.append(
        h("h5", {}, "Задания обучения"),
        h(
          "div",
          { class: "note" },
          "Участок кончается по покрытию: каждое задание идёт, пока не пройдёт критерий допуска из своего манифеста.",
        ),
        gamesEditor(section, simple),
        field(
          "Потолок по времени, мин",
          number(
            Number(mins(capOf(section))),
            (v) => {
              setCap(section, Math.max(1, v) * 60_000);
              render();
            },
            { min: "1" },
          ),
        ),
        difficultyEditor(section),
      );
    } else {
      panel.append(moduleEditor(section, playable));
      // Состав — сразу под типом: у составного блока это часть выбора задачи, а
      // не настройка после неё.
      const module = focusOf(section).module;
      if (module && (module.children ?? []).length > 0) panel.append(childrenEditor(section, module));
      panel.append(
        field("Длительность, мин", number(Number(mins(capOf(section))), (v) => minutes(section, v), { min: "1" })),
        repeatField(section),
        difficultyEditor(section),
      );
    }

    // Оси самой составной игры — это расписание блока: сколько блоков, какая
    // пауза, как часто меняются задачи. Они остаются здесь, при блоке, а оси
    // отдельной задачи уходят в колонку справа.
    const module = focusOf(section).module;
    if (module && (module.children ?? []).length > 0) {
      panel.append(h("h5", {}, `Диапазоны: ${module.title.ru}`), boundsEditor(section, module));
    }
    return panel;
  }

  function sessionCard(): HTMLElement {
    const box = h("div", { class: "builder-session" });
    const swap = doc.counterbalance?.swap ?? [];
    box.append(
      h("h4", {}, "Сессия целиком"),
      field("Название", text(doc.title, (v) => {
        doc.title = v;
      })),
      field("Идентификатор", text(doc.id, (v) => {
        doc.id = v;
      })),
      field(
        "Клавиши ответа",
        text((doc.interaction?.keys ?? []).join(" "), (v) => {
          const keys = v.split(/\s+/).filter(Boolean).map((k) => k.toUpperCase());
          // Ёмкость ответа — свойство стенда: из неё выводится и раздача клавиш
          // по задачам, и предел по оси числа вариантов.
          doc.interaction = { ...doc.interaction, keys: keys as NonNullable<Protocol["interaction"]>["keys"] };
          capByKeys(doc, deps.manifests);
          render();
        }),
      ),
      field(
        "Указатель",
        select(
          [
            ["task-only", "только там, где задача без него не работает"],
            ["free", "везде"],
          ],
          doc.interaction?.pointer ?? "task-only",
          (v) => {
            doc.interaction = { ...doc.interaction, pointer: v as "free" | "task-only" };
          },
        ),
      ),
      screenEditor("Вступление сессии", doc.interstitials?.intro, (next) => {
        doc.interstitials = { ...doc.interstitials, intro: next };
      }),
      screenEditor("Прощание", doc.interstitials?.outro, (next) => {
        doc.interstitials = { ...doc.interstitials, outro: next };
      }),
      h("h5", {}, "Контрбалансировка"),
      h(
        "div",
        { class: "note" },
        "Два блока меняются местами у половины участников. Порядок назначается по идентификатору участника, а не жребием на месте.",
      ),
    );
    const options: [string, string][] = [["", "—"], ...doc.sections.map((s) => [s.id, s.id] as [string, string])];
    const pick = (position: 0 | 1) =>
      select(options, swap[position] ?? "", (v) => {
        const next = [swap[0] ?? "", swap[1] ?? ""];
        next[position] = v;
        const both = next.filter(Boolean);
        if (both.length === 2) {
          doc.counterbalance = {
            swap: both as [string, string],
            pause:
              doc.counterbalance?.pause ??
              screen("Короткая пауза", [
                "Первый блок закончен. Можно расслабить глаза и задать вопросы — сейчас говорить можно.",
                "Следующий блок такой же длины, но с другой работой.",
              ]),
          };
        } else delete doc.counterbalance;
        render();
      });
    box.append(field("Первый блок пары", pick(0)), field("Второй блок пары", pick(1)));
    if (doc.counterbalance) {
      box.append(
        screenEditor("Пауза между блоками пары", doc.counterbalance.pause, (next) => {
          doc.counterbalance = { swap: doc.counterbalance!.swap, pause: next };
        }),
      );
    }
    return box;
  }

  function toolbar(): HTMLElement {
    const stored = deps.saved();
    const open = select(
      [["", "— открыть сохранённый —"], ...stored.map((p) => [p.id, `${p.title} · ${p.sections.length} бл.`] as [string, string])],
      "",
      (id) => {
        const found = stored.find((p) => p.id === id);
        if (found) handle.open(structuredClone(found));
      },
    );

    const mk = (label: string, onClick: () => void, cls = "btn"): HTMLElement => {
      const button = h("button", { class: cls, type: "button" }, label);
      button.addEventListener("click", onClick);
      return button;
    };

    const issues = deps.validate(doc);
    const status = h(
      "div",
      { class: `builder-status${issues.length > 0 ? " is-bad" : " is-ok"}` },
      issues.length > 0 ? `Не принят: ${issues.join("; ")}` : "Сценарий принимается компилятором протокола.",
    );

    const runButton = mk("Запустить", () => deps.run(doc), "btn is-primary");
    (runButton as HTMLButtonElement).disabled = issues.length > 0;

    return h(
      "div",
      { class: "builder-bar" },
      open,
      ...(deps.base ? [mk("Базовый", () => handle.open(deps.base!()))] : []),
      mk("С нуля", () => handle.open(emptyProtocol())),
      mk("Сохранить", () => {
        deps.save(structuredClone(doc));
        render();
      }),
      mk("Забыть", () => {
        deps.remove(doc.id);
        render();
      }),
      mk("Выгрузить JSON", () => deps.download(`${doc.id}.json`, JSON.stringify(doc, null, 2))),
      runButton,
      status,
    );
  }

  /** Строка списка, за которой стоят настройки всей сессии, а не одного блока. */
  function sessionRow(): HTMLElement {
    const row = h(
      "div",
      { class: `builder-row is-session${picked === "session" ? " is-picked" : ""}` },
      h("span", { class: "pill" }, "∑"),
      h("b", {}, "Сессия целиком"),
      h("span", { class: "builder-row-id" }, doc.title),
      h("span", { class: "builder-row-time" }, span(doc.sections.reduce((sum, s) => sum + capOf(s), 0))),
    );
    row.addEventListener("click", () => {
      picked = "session";
      render();
    });
    return row;
  }

  function render(): void {
    const add = (kind: BlockKind): HTMLElement => {
      const button = h("button", { class: "btn", type: "button" }, `+ ${BLOCK_TITLES[kind]}`);
      button.addEventListener("click", () => {
        // Обучение по смыслу покрывает все задачи, поэтому заводится полным;
        // блок-игру исследователь собирает сам — за него угадывать нечего.
        const preset = kind === "training" ? simple.map((manifest) => manifest.id) : [];
        const section = makeBlock(kind, `${kind}-${doc.sections.length + 1}`, preset);
        doc.sections.push(section);
        // Добавленный блок сразу открыт: его всё равно нужно настроить.
        picked = section;
        pickedTask = null;
        render();
      });
      return button;
    };

    // Выбранный блок мог уехать из документа — например, вместе с открытием
    // другого сценария. Тогда справа показываем первый, а не пустоту.
    if (picked !== "session" && !doc.sections.includes(picked)) picked = doc.sections[0] ?? "session";

    const list = h(
      "div",
      { class: "builder-list" },
      sessionRow(),
      ...doc.sections.map((section, index) => blockRow(section, index)),
      h(
        "div",
        { class: "builder-add" },
        add("baseline"),
        add("training"),
        add("game"),
        add("pause"),
        add("micro"),
      ),
    );
    const panel = h("div", { class: "builder-panel" }, picked === "session" ? sessionCard() : blockPanel(picked));
    const task = picked === "session" ? undefined : taskOf(picked);
    const focus = picked !== "session" && task ? taskPanel(picked, task) : null;
    const body = h(
      "div",
      { class: `builder-body${focus ? " is-deep" : ""}` },
      list,
      panel,
      ...(focus ? [focus] : []),
    );
    // Колонки начинаются с одной высоты. Панель, встающая напротив своей строки,
    // читалась как связь с ней, но платой был прыгающий верх: у восьмого блока
    // настройки уезжали под сгиб, а на длинном списке — и вовсе за экран.
    host.replaceChildren(toolbar(), body);
  }

  const handle: BuilderHandle = {
    doc: () => doc,
    open(next: Protocol) {
      doc = next;
      picked = doc.sections[0] ?? "session";
      capByKeys(doc, deps.manifests);
      render();
    },
    render,
  };
  capByKeys(doc, deps.manifests);
  render();
  return handle;
}
