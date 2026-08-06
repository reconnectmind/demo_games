import { describe, expect, it } from "vitest";
import {
  GameRegistry,
  GameRuntime,
  MarkerDispatcher,
  MemorySink,
  NullMarkerSink,
  VirtualClock,
  headlessSurface,
} from "@gamespace/core";
import { protocolGames } from "@gamespace/games";
import { ProtocolError, SessionRunner, compileProtocol, plannedMs, validateProtocol } from "@gamespace/protocol";
import pilot from "../packages/protocol/examples/reconnect-pilot.json" with { type: "json" };

function registry() {
  const r = new GameRegistry();
  for (const game of protocolGames) r.register(game);
  return r;
}

describe("протокол: проверка документа", () => {
  it("пилотный протокол проходит схему и ссылается на существующие игры", () => {
    expect(validateProtocol(pilot, registry()).issues).toEqual([]);
  });

  it("несуществующая игра отклоняется до старта", () => {
    const broken = { ...pilot, sections: [{ id: "x", games: ["org.reconnect.nope"], end: { by: "runs", count: 1 } }] };
    const report = validateProtocol(broken, registry());
    expect(report.ok).toBe(false);
    expect(report.issues[0]!.message).toContain("org.reconnect.nope");
  });

  it("неизвестная стратегия завершения не проходит схему", () => {
    const broken = { ...pilot, sections: [{ id: "x", games: ["org.reconnect.stroop"], end: { by: "vibes" } }] };
    expect(validateProtocol(broken, registry()).ok).toBe(false);
  });

  it("компиляция кидает понятную ошибку, а не падает в середине сессии", () => {
    expect(() => compileProtocol({ id: "x" }, { participantId: "p1", registry: registry() })).toThrow(ProtocolError);
  });

  it("длительность участка видна до запуска", () => {
    const total = pilot.sections.reduce((sum, s) => sum + (plannedMs(s.end as never) ?? 0), 0);
    expect(total).toBe(110 * 60_000);
  });
});

describe("протокол: контрбалансировка", () => {
  it("порядок участков воспроизводим по идентификатору участника", () => {
    const a = compileProtocol(pilot, { participantId: "p-001", registry: registry() });
    const again = compileProtocol(pilot, { participantId: "p-001", registry: registry() });
    expect(a.order).toEqual(again.order);
  });

  it("между участниками порядок AB и BA встречается оба раза", () => {
    const orders = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const compiled = compileProtocol(pilot, { participantId: `p-${i}`, registry: registry() });
      orders.add(compiled.order.join(">"));
    }
    expect(orders.size).toBe(2);
  });

  it("контрбалансировка меняет местами только объявленные участки", () => {
    const compiled = compileProtocol(pilot, { participantId: "p-1", registry: registry() });
    expect(compiled.order[0]).toBe("baseline-pre");
    expect(compiled.order[1]).toBe("training");
    expect(compiled.order.at(-1)).toBe("baseline-post");
    expect(compiled.order.slice(2, 4).sort()).toEqual(["battery", "interrupt"]);
  });
});

describe("протокол: исполнение", () => {
  it("сжатый пилот проходит целиком на виртуальном времени", () => {
    const reg = registry();
    const clock = new VirtualClock();
    const sink = new MemorySink();
    const runtime = new GameRuntime({
      registry: reg,
      clock,
      sink,
      capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
      t0WallMs: 1_700_000_000_000,
      wallNow: () => 1_700_000_000_000 + clock.now(),
    });
    // Те же участки, но по 30 секунд: проверяется расписание, а не выносливость.
    const durations = Object.fromEntries(pilot.sections.map((s) => [s.id, 30_000]));
    const compiled = compileProtocol(pilot, { participantId: "p-7", registry: reg, durations });

    const started: string[] = [];
    const session = new SessionRunner({
      runtime,
      surface: headlessSurface(),
      headless: true,
      sessionId: compiled.sessionId,
      seed: compiled.seed,
      sections: compiled.sections,
      policyFor: (gameId) => compiled.policyFor(gameId),
      onSectionStart: (section) => started.push(section.id),
    });
    session.start();
    clock.advance(15 * 60_000);

    expect(session.finished).toBe(true);
    expect(started).toEqual(compiled.order);
    // Каждый участок оставил в журнале свои границы.
    for (const id of compiled.order) {
      expect(sink.records.some((r) => r.type === "section.start" && (r.payload as { section: string }).section === id)).toBe(true);
      expect(sink.records.some((r) => r.type === "section.end" && (r.payload as { section: string }).section === id)).toBe(true);
    }
  });

  it("полный 110-минутный сценарий укладывается в заявленное время", () => {
    const reg = registry();
    const clock = new VirtualClock();
    const runtime = new GameRuntime({
      registry: reg,
      clock,
      capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
      t0WallMs: 1_700_000_000_000,
      wallNow: () => 1_700_000_000_000 + clock.now(),
    });
    const compiled = compileProtocol(pilot, { participantId: "p-42", registry: reg });
    let finishedAtMs = 0;
    const session = new SessionRunner({
      runtime,
      surface: headlessSurface(),
      headless: true,
      sessionId: compiled.sessionId,
      seed: compiled.seed,
      sections: compiled.sections,
      policyFor: (gameId) => compiled.policyFor(gameId),
      onDone: () => (finishedAtMs = clock.now()),
    });
    session.start();
    clock.advance(115 * 60_000);

    expect(session.finished).toBe(true);
    // Сессия не растянулась и не схлопнулась: пять участков по расписанию.
    expect(finishedAtMs).toBeGreaterThanOrEqual(110 * 60_000);
    expect(finishedAtMs).toBeLessThan(111 * 60_000);
  });

  it("метки идут только по границам и укладываются в бюджет плотности", () => {
    const reg = registry();
    const clock = new VirtualClock();
    const sink = new NullMarkerSink();
    const markers = new MarkerDispatcher(sink);
    const runtime = new GameRuntime({
      registry: reg,
      clock,
      markers,
      capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
      t0WallMs: 1_700_000_000_000,
      wallNow: () => 1_700_000_000_000 + clock.now(),
    });
    const compiled = compileProtocol(pilot, { participantId: "p-11", registry: reg });
    const session = new SessionRunner({
      runtime,
      surface: headlessSurface(),
      headless: true,
      sessionId: compiled.sessionId,
      seed: compiled.seed,
      sections: compiled.sections,
      input: compiled.input,
      policyFor: (gameId) => compiled.policyFor(gameId),
    });
    session.start();
    clock.advance(115 * 60_000);

    // Границы фаз доходят до потока: раньше это было невозможно структурно —
    // участок писал в свой журнал, а диспетчер меток слушал только инстанс игры.
    const labels = new Set(markers.records.map((r) => r.label));
    expect(labels.has("section.start")).toBe(true);
    expect(labels.has("section.end")).toBe(true);
    expect(labels.has("run.start")).toBe(true);
    // Стимулы, ответы, исходы проб и смены уровня в поток не идут.
    for (const dropped of ["stimulus.presented", "response", "trial.outcome", "difficulty.changed", "block.start"]) {
      expect(labels.has(dropped), `${dropped} не должен становиться меткой`).toBe(false);
    }

    // Бюджет: Артинис видит таймстемпы, и поток обязан оставаться разреженным.
    // Для одного stroop прежняя книга давала 65–160 меток в минуту.
    const perMinute = markers.records.length / (clock.now() / 60_000);
    expect(perMinute).toBeLessThan(20);
    expect(sink.published.length).toBe(markers.records.length);
  });

  it("участок покоя завершается по времени и отдаёт сводку", () => {
    const reg = registry();
    const clock = new VirtualClock();
    const runtime = new GameRuntime({
      registry: reg,
      clock,
      capabilities: [],
      t0WallMs: 1_700_000_000_000,
      wallNow: () => 1_700_000_000_000 + clock.now(),
    });
    const compiled = compileProtocol(pilot, {
      participantId: "p-9",
      registry: reg,
      durations: { "baseline-pre": 20_000 },
    });
    const summaries: unknown[] = [];
    const session = new SessionRunner({
      runtime,
      surface: headlessSurface(),
      headless: true,
      sessionId: "s",
      seed: 1,
      sections: [compiled.sections.find((s) => s.id === "baseline-pre")!],
      onSectionEnd: (_s, records) => summaries.push(records.at(-1)!.summary),
    });
    session.start();
    clock.advance(60_000);

    expect(session.finished).toBe(true);
    // Покой длится столько, сколько задал протокол, а не сколько задано в игре.
    expect(summaries[0]).toMatchObject({ completed: false });
    expect((summaries[0] as { actualMs: number }).actualMs).toBeGreaterThanOrEqual(19_000);
  });
});

describe("протокол: повтор внутри участка", () => {
  /** Пауза на пять секунд внутри участка на тридцать: разница и проверяется. */
  const doc = (over: Record<string, unknown> = {}) => ({
    protocolVersion: "1.0",
    id: "pause-doc",
    title: "Пауза",
    locale: "ru",
    difficulty: { policy: "fixed", start: 1 },
    sections: [
      {
        id: "micro",
        games: ["org.reconnect.baseline"],
        end: { by: "time", ms: 30_000 },
        overrides: {
          "org.reconnect.baseline": { durationMs: 5000, showTimer: true, fixation: false, text: "Пауза." },
        },
        ...over,
      },
    ],
  });

  const play = (protocol: unknown, durations?: Record<string, number>) => {
    const reg = registry();
    const clock = new VirtualClock();
    const runtime = new GameRuntime({
      registry: reg,
      clock,
      capabilities: [],
      t0WallMs: 1_700_000_000_000,
      wallNow: () => 1_700_000_000_000 + clock.now(),
    });
    const compiled = compileProtocol(protocol, { participantId: "p-3", registry: reg, ...(durations ? { durations } : {}) });
    let endedAtMs = 0;
    let runs = 0;
    const session = new SessionRunner({
      runtime,
      surface: headlessSurface(),
      headless: true,
      sessionId: "s",
      seed: 1,
      sections: compiled.sections,
      onSectionEnd: (_s, records) => (runs = records.length),
      onDone: () => (endedAtMs = clock.now()),
    });
    session.start();
    clock.advance(90_000);
    return { compiled, session, endedAtMs, runs };
  };

  it("блок с повтором добивает время участка перезапусками", () => {
    // Это поведение по умолчанию и оно осмысленно для зачётного блока: игра
    // короче участка, значит идёт следующий блок той же игры.
    const { session, runs } = play(doc());
    expect(session.finished).toBe(true);
    expect(runs).toBeGreaterThan(1);
  });

  it("блок без повтора кончается вместе со своим модулем", () => {
    // Пауза сама себе отмеряет время: без этого свойства время участка
    // перекрывало объявленные секунды и пауза на пять секунд шла шесть раз.
    const { session, endedAtMs, runs } = play(doc({ repeat: false }));
    expect(session.finished).toBe(true);
    expect(runs).toBe(1);
    expect(endedAtMs).toBeGreaterThanOrEqual(5000);
    expect(endedAtMs).toBeLessThan(8000);
  });

  it("репетиция участки укорачивает, а не выравнивает по себе", () => {
    // Оператор обещал «участки укорочены»: пятисекундная пауза не обязана
    // растягиваться до выбранных тридцати секунд.
    const { compiled } = play(doc({ repeat: false, end: { by: "time", ms: 5000 } }), { micro: 30_000 });
    expect(compiled.sections[0]!.end.id).toContain("by-time:5000");
    expect(compiled.sections[0]!.end.id).not.toContain("by-time:30000");
  });
});
