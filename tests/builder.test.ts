// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  GameRegistry,
  GameRuntime,
  Manual,
  MemorySink,
  Monotonic,
  THREE_KEYS,
  VirtualClock,
  childSet,
  clampParams,
  headlessSurface,
  isPinned,
  type LoggedEvent,
} from "@gamespace/core";
import { protocolGames } from "@gamespace/games";
import { compileProtocol, pilotProtocol, type Protocol } from "@gamespace/protocol";
import {
  BLOCK_TITLES,
  blockKind,
  capByKeys,
  emptyProtocol,
  makeBlock,
  mountBuilder,
} from "../apps/showcase/src/builder.js";

const registry = (): GameRegistry => {
  const box = new GameRegistry();
  for (const game of protocolGames) box.register(game);
  return box;
};

const manifests = protocolGames.map((game) => game.manifest);

describe("границы параметров", () => {
  it("значение не выходит за объявленный диапазон", () => {
    const params = { colorCount: 6, deadlineMs: 900 };
    expect(clampParams(params, { colorCount: { min: 3, max: 3 } })).toEqual({ colorCount: 3, deadlineMs: 900 });
    expect(clampParams(params, { deadlineMs: { min: 1000 } })).toEqual({ colorCount: 6, deadlineMs: 1000 });
  });

  it("нечисловой параметр границам не подчиняется", () => {
    // Границы — про нагрузку по оси, а не про подстановку значений: обрезать
    // строку или флаг нечем, и делать вид, что можно, опаснее, чем не трогать.
    expect(clampParams({ text: "покой" }, { text: { min: 0, max: 1 } })).toEqual({ text: "покой" });
  });

  it("сомкнутые границы означают закреплённую ось", () => {
    expect(isPinned({ min: 3, max: 3 })).toBe(true);
    expect(isPinned({ min: 3, max: 4 })).toBe(false);
    expect(isPinned({ min: 3 })).toBe(false);
  });

  it("рост уровня не выводит ось за границу, а уходит на свободные", () => {
    const runtime = new GameRuntime({
      registry: registry(),
      clock: new VirtualClock(),
      sink: new MemorySink(),
      capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
      t0WallMs: 0,
    });
    const policy = new Manual({ start: 1, max: 8 });
    const instance = runtime.mount("org.reconnect.stroop", {
      surface: headlessSurface(),
      headless: true,
      seed: 3,
      policy,
      input: THREE_KEYS,
      bounds: { colorCount: { min: 3, max: 3 } },
    });
    instance.start();
    const low = instance.difficulty.params();
    instance.difficulty.setLevel(8);
    const high = instance.difficulty.params();
    expect(low.colorCount).toBe(3);
    expect(high.colorCount).toBe(3);
    // Ось стоит, но нагрузка обязана вырасти: иначе уровень растёт впустую.
    expect(instance.difficulty.freedom().frozen).toContain("colorCount");
    expect(Number(high.deadlineMs)).toBeLessThan(Number(low.deadlineMs));
  });

  it("укороченный участок укорачивает и блок игры, которая сама себе отмеряет время", () => {
    // Иначе покой с таймером обещает участнику десять минут, а раннер закрывает
    // участок через тридцать секунд: на экране одно, в журнале другое.
    const compiled = compileProtocol(pilotProtocol, {
      participantId: "p-001",
      registry: registry(),
      durations: { "baseline-pre": 30_000 },
    });
    const baseline = compiled.sections.find((section) => section.id === "baseline-pre")!;
    expect(baseline.overrides?.["org.reconnect.baseline"]?.durationMs).toBe(30_000);
  });

  it("границы участка доходят до дочерней задачи составной игры", () => {
    const doc = {
      ...pilotProtocol,
      bounds: { "org.reconnect.stroop": { colorCount: { min: 3, max: 3 } } },
    } as unknown as Protocol;
    const compiled = compileProtocol(doc, { participantId: "p-001", registry: registry() });
    const battery = compiled.sections.find((section) => section.id === "battery")!;
    expect(battery.bounds?.["org.reconnect.stroop"]?.colorCount).toEqual({ min: 3, max: 3 });
  });
});

describe("состав дочерних задач составной игры", () => {
  const pool = [
    { id: "org.reconnect.arithmetic" },
    { id: "org.reconnect.n-back" },
    { id: "org.reconnect.stroop" },
  ];

  it("без объявленного состава действует прежнее правило пула", () => {
    expect(childSet(pool, "", 2)).toEqual(["org.reconnect.arithmetic", "org.reconnect.n-back"]);
  });

  it("состав задаётся именами и в объявленном порядке", () => {
    expect(childSet(pool, "stroop, arithmetic", 2)).toEqual([
      "org.reconnect.stroop",
      "org.reconnect.arithmetic",
    ]);
  });

  it("неизвестное имя — отказ, а не молчаливый пропуск", () => {
    // Молча выкинутая задача обнаружилась бы только в записи, когда переделывать
    // сессию уже поздно.
    expect(() => childSet(pool, "stroop,тетрис", 3)).toThrow(/тетрис/);
  });

  it("батарея берёт задачи из объявленного состава", () => {
    const clock = new VirtualClock();
    const sink = new MemorySink();
    const runtime = new GameRuntime({
      registry: registry(),
      clock,
      sink,
      capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
      t0WallMs: 0,
      wallNow: () => clock.now(),
    });
    const instance = runtime.mount("org.reconnect.adaptive-battery", {
      surface: headlessSurface(),
      headless: true,
      seed: 5,
      policy: new Monotonic({ start: 1 }),
      input: THREE_KEYS,
      overrides: { tasks: "stroop,n-back", blocks: 4, restMs: 500, switchEveryMs: 8000 },
    });
    instance.start();
    clock.advance(40_000);
    const tasks = new Set(
      sink.records
        .filter((r: LoggedEvent) => r.type === "block.start")
        .map((r) => (r.payload as { task?: string }).task)
        .filter(Boolean),
    );
    expect(tasks.size).toBeGreaterThan(0);
    for (const task of tasks) expect(["org.reconnect.stroop", "org.reconnect.n-back"]).toContain(task);
  });
});

describe("конструктор сценария", () => {
  const deps = (overrides: Partial<Parameters<typeof mountBuilder>[1]> = {}) => ({
    manifests,
    validate: (doc: Protocol) => {
      try {
        compileProtocol(doc, { participantId: "p-000", registry: registry() });
        return [];
      } catch (error) {
        return [String((error as Error).message)];
      }
    },
    save: () => {},
    remove: () => {},
    saved: () => [] as Protocol[],
    run: () => {},
    download: () => {},
    ...overrides,
  });

  const host = (): HTMLElement => {
    const box = document.createElement("div");
    document.body.replaceChildren(box);
    return box;
  };

  it("вид блока читается из содержания, а не хранится отдельно", () => {
    // Отдельное поле «тип» рано или поздно разошлось бы с содержанием блока, и
    // конструктор показывал бы одно, а сессия делала другое.
    expect(blockKind(makeBlock("baseline", "b"))).toBe("baseline");
    expect(blockKind(makeBlock("pause", "p"))).toBe("pause");
    expect(blockKind(makeBlock("training", "t", ["org.reconnect.stroop"]))).toBe("training");
    expect(blockKind(makeBlock("game", "g", ["org.reconnect.stroop"]))).toBe("game");
  });

  it("перерыв отличается от покоя отсутствием крестика", () => {
    const pause = makeBlock("pause", "p");
    expect(pause.overrides?.["org.reconnect.baseline"]?.fixation).toBe(false);
    expect(makeBlock("baseline", "b").overrides?.["org.reconnect.baseline"]?.fixation).toBe(true);
  });

  it("сценарий из заготовок компилируется", () => {
    const doc = emptyProtocol();
    doc.sections.push(makeBlock("training", "training", ["org.reconnect.stroop"]));
    doc.sections.push(makeBlock("game", "load", ["org.reconnect.adaptive-battery"]));
    doc.sections.push(makeBlock("pause", "pause-1"));
    // Три клавиши — три варианта: без этой границы модуль на четырёх цветах
    // законно не проходит проверку. Конструктор ставит её сам при открытии.
    expect(() => compileProtocol(doc, { participantId: "p-000", registry: registry() })).toThrow(/вариантов ответа/);
    capByKeys(doc, manifests);
    expect(() => compileProtocol(doc, { participantId: "p-000", registry: registry() })).not.toThrow();
  });

  it("объявленные клавиши ограничивают ось числа вариантов", () => {
    const doc = emptyProtocol();
    capByKeys(doc, manifests);
    expect(doc.bounds?.["org.reconnect.stroop"]?.colorCount).toEqual({ max: 3 });
    // Уже заданное сужение не расширяется: два варианта из трёх клавиш — тоже
    // решение исследователя, и переписывать его конструктор не вправе.
    doc.bounds!["org.reconnect.stroop"]!.colorCount = { min: 2, max: 2 };
    capByKeys(doc, manifests);
    expect(doc.bounds?.["org.reconnect.stroop"]?.colorCount).toEqual({ min: 2, max: 2 });
  });

  it("на карточке блока правится текст, который увидит участник", () => {
    const box = host();
    const builder = mountBuilder(box, deps());
    const areas = box.querySelectorAll("textarea");
    expect(areas.length).toBeGreaterThan(0);
    const first = areas[0] as HTMLTextAreaElement;
    first.value = "Первый абзац\n\nВторой абзац";
    first.dispatchEvent(new Event("change"));
    const screen = builder.doc().sections[0]!.interstitial!;
    expect(screen.body).toEqual(["Первый абзац", "Второй абзац"]);
  });

  it("диапазон параметра пишется в границы блока и виден как закрепление", () => {
    const box = host();
    const builder = mountBuilder(box, deps());
    builder.open({ ...emptyProtocol(), sections: [makeBlock("game", "load", ["org.reconnect.stroop"])] });
    const rows = box.querySelectorAll(".builder-bound");
    expect(rows.length).toBeGreaterThan(0);
    const row = [...rows].find((r) => r.textContent?.includes("цвет") || r.textContent?.includes("Цвет")) ?? rows[0]!;
    const [min, max] = row.querySelectorAll("input");
    min!.value = "3";
    min!.dispatchEvent(new Event("change"));
    max!.value = "3";
    max!.dispatchEvent(new Event("change"));
    const bounds = builder.doc().sections[0]!.bounds?.["org.reconnect.stroop"];
    expect(bounds).toBeTruthy();
    const bound = Object.values(bounds!)[0]!;
    expect(bound).toEqual({ min: 3, max: 3 });
    expect(row.textContent).toContain("закреплено");
  });

  it("у составной игры свой конструктор состава", () => {
    const box = host();
    const builder = mountBuilder(box, deps());
    builder.open({
      ...emptyProtocol(),
      sections: [makeBlock("game", "load", ["org.reconnect.adaptive-battery"])],
    });
    const checks = [...box.querySelectorAll(".builder-children input")] as HTMLInputElement[];
    expect(checks.length).toBeGreaterThan(1);
    // Снимаем всё, кроме первых двух: состав блока — решение исследователя, а не
    // порядок объявления в манифесте.
    for (const check of checks.slice(2)) {
      check.checked = false;
      check.dispatchEvent(new Event("change"));
    }
    const tasks = String(builder.doc().sections[0]!.overrides?.["org.reconnect.adaptive-battery"]?.tasks ?? "");
    expect(tasks.split(",")).toHaveLength(2);
  });

  it("блок без модулей не запускается, и это сказано на месте", () => {
    const box = host();
    const builder = mountBuilder(box, deps());
    builder.open({ ...emptyProtocol(), sections: [makeBlock("game", "load", [])] });
    const status = box.querySelector(".builder-status")!;
    expect(status.className).toContain("is-bad");
    expect((box.querySelector(".btn.is-primary") as HTMLButtonElement).disabled).toBe(true);
  });

  it("собранный сценарий уходит на запуск целиком", () => {
    const box = host();
    let started: Protocol | null = null;
    const builder = mountBuilder(box, deps({ run: (doc: Protocol) => (started = doc) }));
    builder.open({
      ...emptyProtocol(),
      sections: [makeBlock("game", "load", ["org.reconnect.stroop"])],
    });
    (box.querySelector(".btn.is-primary") as HTMLButtonElement).click();
    expect(started).not.toBeNull();
    expect((started as unknown as Protocol).sections).toHaveLength(1);
  });

  it("открывается базовым протоколом, а пустой сценарий — отдельное решение", () => {
    const box = host();
    const builder = mountBuilder(box, deps({ base: () => structuredClone(pilotProtocol) as Protocol }));
    expect(builder.doc().sections.map((s) => s.id)).toEqual(pilotProtocol.sections.map((s) => s.id));
    const scratch = [...box.querySelectorAll(".builder-bar .btn")].find((b) => b.textContent === "С нуля")!;
    (scratch as HTMLButtonElement).click();
    expect(builder.doc().sections).toHaveLength(1);
  });

  it("слева видно всё расписание, справа — ручки одного блока", () => {
    const box = host();
    const builder = mountBuilder(box, deps({ base: () => structuredClone(pilotProtocol) as Protocol }));
    const rows = [...box.querySelectorAll(".builder-list .builder-row")];
    // Сессия целиком плюс каждый блок: расписание читается сразу, а не листанием.
    expect(rows).toHaveLength(pilotProtocol.sections.length + 1);
    expect(box.querySelectorAll(".builder-panel .builder-block")).toHaveLength(1);

    const second = builder.doc().sections[1]!;
    (rows[2] as HTMLElement).click();
    const head = box.querySelector(".builder-panel .builder-block-head input") as HTMLInputElement;
    expect(head.value).toBe(second.id);

    (box.querySelector(".builder-row.is-session") as HTMLElement).click();
    expect(box.querySelector(".builder-panel .builder-session")).toBeTruthy();
    expect(box.querySelector(".builder-panel .builder-block")).toBeNull();
  });

  it("панель встаёт напротив выбранного блока, а не в начало полосы", () => {
    // Раскладку jsdom не считает, поэтому высота строк подставлена: проверяется
    // правило «панель на высоте своей строки», а не движок вёрстки.
    const layout = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.classList.contains("builder-row")) return 0;
        return [...(this.parentElement?.children ?? [])].indexOf(this) * 40;
      },
    });
    try {
      const box = host();
      mountBuilder(box, deps({ base: () => structuredClone(pilotProtocol) as Protocol }));
      const rows = [...box.querySelectorAll(".builder-list .builder-row")] as HTMLElement[];
      const panel = () => box.querySelector(".builder-panel") as HTMLElement;
      rows[3]!.click();
      expect(panel().style.marginTop).toBe("120px");
      // Сессия целиком — первая строка: смещать панель от неё некуда.
      (box.querySelector(".builder-row.is-session") as HTMLElement).click();
      expect(panel().style.marginTop).toBe("");
    } finally {
      if (layout) Object.defineProperty(HTMLElement.prototype, "offsetTop", layout);
    }
  });

  it("убранный блок не остаётся открытым справа", () => {
    const box = host();
    const builder = mountBuilder(box, deps({ base: () => structuredClone(pilotProtocol) as Protocol }));
    const first = builder.doc().sections[0]!;
    const kill = box.querySelector(".builder-row .builder-row-ops .btn:last-child") as HTMLButtonElement;
    kill.click();
    expect(builder.doc().sections).not.toContain(first);
    const head = box.querySelector(".builder-panel .builder-block-head input") as HTMLInputElement;
    expect(head.value).toBe(builder.doc().sections[0]!.id);
  });

  it("переименование блока ведёт за собой контрбалансировку", () => {
    const box = host();
    const builder = mountBuilder(box, deps({ base: () => structuredClone(pilotProtocol) as Protocol }));
    const pair = builder.doc().counterbalance!.swap;
    const target = builder.doc().sections.find((s) => s.id === pair[0])!;
    const row = [...box.querySelectorAll(".builder-list .builder-row")].find((r) =>
      r.querySelector(".builder-row-id")?.textContent === target.id,
    ) as HTMLElement;
    row.click();
    const head = box.querySelector(".builder-panel .builder-block-head input") as HTMLInputElement;
    head.value = "battery-a";
    head.dispatchEvent(new Event("change"));
    expect(builder.doc().counterbalance!.swap).toEqual(["battery-a", pair[1]]);
    // Проверка на повисшую ссылку не ослаблена: собираться должно и после правки.
    expect(() =>
      compileProtocol(builder.doc(), { participantId: "p-000", registry: registry() }),
    ).not.toThrow();
  });

  it("убранный блок пары отменяет контрбалансировку, а не ломает сценарий", () => {
    const box = host();
    const builder = mountBuilder(box, deps({ base: () => structuredClone(pilotProtocol) as Protocol }));
    const pair = builder.doc().counterbalance!.swap;
    const rows = [...box.querySelectorAll(".builder-list .builder-row")];
    const row = rows.find((r) => r.querySelector(".builder-row-id")?.textContent === pair[0])!;
    (row.querySelector(".builder-row-ops .btn:last-child") as HTMLButtonElement).click();
    // Пары из одного блока не бывает: половина настройки хуже, чем её отсутствие.
    expect(builder.doc().counterbalance).toBeUndefined();
    expect(() =>
      compileProtocol(builder.doc(), { participantId: "p-000", registry: registry() }),
    ).not.toThrow();
  });

  it("повтор внутри блока переключается у любого блока", () => {
    const box = host();
    const builder = mountBuilder(box, deps({ base: () => structuredClone(pilotProtocol) as Protocol }));
    const rows = [...box.querySelectorAll(".builder-list .builder-row")] as HTMLElement[];
    rows[3]!.click();
    const label = [...box.querySelectorAll(".builder-panel .param label")].find((l) =>
      l.textContent?.includes("Повтор внутри блока"),
    )!;
    const pick = label.nextElementSibling as HTMLSelectElement;
    expect(pick.value).toBe("true");
    pick.value = "false";
    pick.dispatchEvent(new Event("change"));
    expect(builder.doc().sections[2]!.repeat).toBe(false);
  });

  it("названия блоков в конструкторе те же, что в бэклоге", () => {
    expect(Object.keys(BLOCK_TITLES).sort()).toEqual(["baseline", "game", "micro", "pause", "training"]);
  });

  it("микропауза измеряется секундами и участнику ничего не обещает", () => {
    const micro = makeBlock("micro", "micro-1");
    expect(blockKind(micro)).toBe("micro");
    // Отбивки нет — этим она и отличается от перерыва: листать её оператору
    // незачем, а участнику про технику знать нечего.
    expect(micro.interstitial).toBeUndefined();
    expect(micro.end).toEqual({ by: "time", ms: 20_000 });
    expect(micro.overrides?.["org.reconnect.baseline"]).toMatchObject({ durationMs: 20_000, fixation: false });
    // Без повтора: пауза сама себе отмеряет время, и второй заход означал бы,
    // что время участка перекрыло объявленные секунды паузы.
    expect(micro.repeat).toBe(false);

    const doc = emptyProtocol();
    doc.sections.push(micro);
    expect(() => compileProtocol(doc, { participantId: "p-000", registry: registry() })).not.toThrow();
  });

  it("микропауза бывает совсем короткой: секунда — уже пауза", () => {
    // Нижний порог в пять секунд остался от блока покоя, где короче и правда
    // незачем. Микропаузе он мешал: промежуток между блоками бывает в секунду.
    const box = host();
    const builder = mountBuilder(box, deps());
    builder.open({ ...emptyProtocol(), sections: [makeBlock("micro", "micro-1")] });
    const input = [...box.querySelectorAll(".builder-panel .param label")]
      .find((l) => l.textContent?.includes("Длительность"))!
      .nextElementSibling as HTMLInputElement;
    input.value = "1";
    input.dispatchEvent(new Event("change"));
    expect(builder.doc().sections[0]!.end).toEqual({ by: "time", ms: 1000 });
    expect(() =>
      compileProtocol(builder.doc(), { participantId: "p-000", registry: registry() }),
    ).not.toThrow();
  });

  it("длительность микропаузы правится в секундах", () => {
    const box = host();
    const builder = mountBuilder(box, deps());
    builder.open({ ...emptyProtocol(), sections: [makeBlock("micro", "micro-1")] });
    const label = [...box.querySelectorAll(".builder-panel .param label")].find((l) =>
      l.textContent?.includes("Длительность"),
    )!;
    expect(label.textContent).toContain("с");
    const input = label.nextElementSibling as HTMLInputElement;
    input.value = "45";
    input.dispatchEvent(new Event("change"));
    const section = builder.doc().sections[0]!;
    expect(section.end).toEqual({ by: "time", ms: 45_000 });
    // Блок сам себе отмеряет время, поэтому длительность живёт в двух местах
    // сразу — и они обязаны совпадать, иначе таймер обещает не то.
    expect(section.overrides?.["org.reconnect.baseline"]?.durationMs).toBe(45_000);
  });

  it("тип блока-игры выбирается списком, а состав составного — галочками под ним", () => {
    const box = host();
    const builder = mountBuilder(box, deps());
    builder.open({ ...emptyProtocol(), sections: [makeBlock("game", "load", ["org.reconnect.stroop"])] });
    const heads = () => [...box.querySelectorAll(".builder-panel h5")].map((x) => x.textContent ?? "");
    const pick = [...box.querySelectorAll(".builder-panel .param")]
      .find((p) => p.textContent?.includes("Тип блока"))!
      .querySelector("select") as HTMLSelectElement;

    expect(pick.value).toBe("org.reconnect.stroop");
    // Одиночный блок занят одной задачей: выбирать в нём состав нечего.
    expect(box.querySelector(".builder-children")).toBeNull();
    expect(heads()).toContain("Диапазоны: Stroop");

    pick.value = "org.reconnect.adaptive-battery";
    pick.dispatchEvent(new Event("change"));
    expect(builder.doc().sections[0]!.games).toEqual(["org.reconnect.adaptive-battery"]);
    // Составной блок сразу показывает, из чего он складывается.
    const boxes = [...box.querySelectorAll(".builder-children input[type=checkbox]")];
    expect(boxes.length).toBeGreaterThan(1);
    expect(heads()).toContain("Диапазоны: Адаптивная батарея");
  });

  it("в составной игре у каждой дочерней задачи свои диапазоны", () => {
    const box = host();
    const builder = mountBuilder(box, deps());
    builder.open({
      ...emptyProtocol(),
      sections: [makeBlock("game", "load", ["org.reconnect.adaptive-battery"])],
    });
    const child = [...box.querySelectorAll(".builder-children .builder-row.is-task")].find((r) =>
      r.textContent?.includes("Stroop"),
    ) as HTMLElement;
    child.click();
    expect([...box.querySelectorAll(".builder-panel h5")].map((x) => x.textContent)).toContain("Диапазоны: Stroop");

    const row = [...box.querySelectorAll(".builder-bound")].find((r) => r.textContent?.includes("цвет"))!;
    const [min, max] = row.querySelectorAll("input");
    min!.value = "3";
    min!.dispatchEvent(new Event("change"));
    max!.value = "3";
    max!.dispatchEvent(new Event("change"));
    // Границы дочерней задачи стоят в блоке рядом с границами самой батареи:
    // «цветов строго три» — это про stroop, а в расписании стоит батарея.
    expect(builder.doc().sections[0]!.bounds?.["org.reconnect.stroop"]?.colorCount).toEqual({ min: 3, max: 3 });
  });
});
