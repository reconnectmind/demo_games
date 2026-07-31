import { describe, expect, it } from "vitest";
import { GameRegistry, GameRuntime, MemorySink, VirtualClock, headlessSurface, type DifficultyPolicy } from "@gamespace/core";
import { protocolGames } from "@gamespace/games";
import { SectionRunner, SessionRunner, byRuns, byTime, firstOf, type SectionSpec } from "@gamespace/protocol";

/** Политика-храповик: растёт каждые N исходов независимо от их качества. */
class Ratchet implements DifficultyPolicy {
  readonly id = "ratchet";
  private level = 1;
  private seen = 0;
  constructor(private readonly every = 10) {}
  current(): number {
    return this.level;
  }
  report(): void {
    if (++this.seen % this.every === 0) this.level = Math.min(8, this.level + 1);
  }
  set(level: number): void {
    this.level = level;
  }
}

function harness(sink = new MemorySink()) {
  const registry = new GameRegistry();
  for (const game of protocolGames) registry.register(game);
  const clock = new VirtualClock();
  const runtime = new GameRuntime({
    registry,
    clock,
    sink,
    capabilities: ["keyboard", "pointer", "audio-output", "canvas"],
    t0WallMs: 1_700_000_000_000,
    wallNow: () => 1_700_000_000_000 + clock.now(),
  });
  return { runtime, clock, sink };
}

function section(over: Partial<SectionSpec> = {}): SectionSpec {
  return { id: "s1", games: ["org.reconnect.stroop"], end: byRuns(2), ...over };
}

function runner(spec: SectionSpec, extra: Partial<ConstructorParameters<typeof SectionRunner>[0]> = {}) {
  const { runtime, clock, sink } = harness();
  const r = new SectionRunner({
    runtime,
    section: spec,
    surface: headlessSurface(),
    headless: true,
    seed: 5,
    sessionId: "sess-1",
    ...extra,
  });
  return { r, clock, sink, runtime };
}

describe("раннер участка: стратегии завершения", () => {
  it("по количеству прогонов запускает игру ровно столько раз", () => {
    const { r, clock } = runner(section({ end: byRuns(3) }));
    r.start();
    clock.advance(20 * 60_000);
    expect(r.records.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(r.records.every((x) => x.reason === "completed")).toBe(true);
    expect(r.finished).toBe(true);
  });

  it("по времени добивает участок перезапусками и закрывает последний блок командой", () => {
    // Блок сквоша короче участка, поэтому участок добивается перезапусками, а
    // последний блок попадает под обрезку по времени.
    const { r, clock } = runner(
      section({
        end: byTime(90_000),
        games: ["org.reconnect.squash"],
        overrides: { "org.reconnect.squash": { blockMs: 25_000 } },
      }),
    );
    r.start();
    clock.advance(120_000);

    expect(r.finished).toBe(true);
    expect(r.records.length).toBeGreaterThan(1);
    // Участок не тянется дольше заявленного: хвост обрезан командой, а не таймаутом.
    expect(r.records.at(-1)!.endedMs).toBeLessThan(95_000);
    expect(r.records.at(-1)!.reason).toBe("finished-by-protocol");
    // Обрывов быть не должно: игра закрывает блок сама и отдаёт сводку.
    expect(r.records.some((x) => x.reason === "aborted")).toBe(false);
    expect(r.records.at(-1)!.summary).not.toBeNull();
  });

  it("ротация игр идёт по кругу", () => {
    const { r, clock } = runner(
      section({ games: ["org.reconnect.stroop", "org.reconnect.arithmetic"], end: byRuns(4) }),
    );
    r.start();
    clock.advance(30 * 60_000);
    expect(r.records.map((x) => x.gameId)).toEqual([
      "org.reconnect.stroop",
      "org.reconnect.arithmetic",
      "org.reconnect.stroop",
      "org.reconnect.arithmetic",
    ]);
  });

  it("firstOf закрывает участок по тому, что наступит раньше", () => {
    const { r, clock } = runner(section({ end: firstOf(byRuns(50), byTime(40_000)) }));
    r.start();
    clock.advance(10 * 60_000);
    expect(r.finished).toBe(true);
    expect(r.records.length).toBeLessThan(50);
    expect(r.records.at(-1)!.endedMs).toBeLessThan(45_000);
  });
});

describe("раннер участка: сохранность состояния", () => {
  it("уровень задачи переживает перезапуски внутри участка", () => {
    let created = 0;
    const { r, clock } = runner(section({ end: byRuns(4) }), {
      policyFor: () => {
        created += 1;
        return new Ratchet();
      },
    });
    r.start();
    clock.advance(30 * 60_000);

    const levels = r.records.map((x) => x.level);
    // Политика создаётся один раз на задачу, поэтому уровень только растёт.
    expect(created).toBe(1);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(levels.at(-1)!).toBeGreaterThan(levels[0]!);
    expect(r.levels()["org.reconnect.stroop"]).toBe(levels.at(-1));
  });

  it("номера событий не повторяются между прогонами", () => {
    const { r, clock, sink } = runner(section({ end: byRuns(3) }));
    r.start();
    clock.advance(30 * 60_000);

    const seqs = sink.records.map((x) => x.seq);
    expect(seqs.length).toBeGreaterThan(50);
    expect(new Set(seqs).size).toBe(seqs.length);
    // Нумерация ещё и монотонна: журнал сессии читается как один поток.
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("записи журнала помечены участком и номером прогона", () => {
    const { r, clock, sink } = runner(section({ end: byRuns(2) }));
    r.start();
    clock.advance(10 * 60_000);

    const runIndices = new Set(sink.records.filter((x) => x.sectionId === "s1" && x.runIndex !== undefined).map((x) => x.runIndex));
    expect([...runIndices].sort()).toEqual([0, 1]);
    expect(sink.records.some((x) => x.type === "section.start")).toBe(true);
    expect(sink.records.some((x) => x.type === "section.end")).toBe(true);
  });

  it("аварийная остановка закрывает блок и не запускает следующий", () => {
    const { r, clock } = runner(section({ end: byRuns(10) }));
    r.start();
    clock.advance(3000);
    r.abort();
    const after = r.records.length;
    clock.advance(10 * 60_000);

    expect(r.finished).toBe(true);
    expect(r.records.length).toBe(after);
    expect(r.current()).toBeNull();
    // Незавершённый блок закрыт командой, а не потерян: сводка есть.
    expect(r.records.at(-1)!.reason).toBe("finished-by-protocol");
  });

  it("пауза не расходует время участка", () => {
    const { r, clock } = runner(section({ end: byTime(30_000), games: ["org.reconnect.squash"] }));
    r.start();
    clock.advance(10_000);
    r.pause();
    clock.advance(120_000);
    r.resume();
    expect(r.finished).toBe(false);
    clock.advance(25_000);
    expect(r.finished).toBe(true);
  });

  it("снимок и восстановление продолжают участок, а не начинают заново", () => {
    const { r, clock } = runner(section({ end: byTime(60_000), games: ["org.reconnect.squash"] }));
    r.start();
    clock.advance(20_000);
    const saved = r.snapshot();
    expect(saved.current).toBeDefined();
    const runsBefore = saved.runs;

    const revived = runner(section({ end: byTime(60_000), games: ["org.reconnect.squash"] }));
    revived.r.restore(saved);
    revived.clock.advance(60_000);

    expect(revived.r.finished).toBe(true);
    // Оставшегося времени участка меньше полного: восстановление не обнулило часы.
    expect(revived.r.state.elapsedMs).toBeGreaterThanOrEqual(60_000);
    expect(revived.r.records.at(-1)!.index).toBeGreaterThanOrEqual(runsBefore);
  });
});

describe("раннер сессии", () => {
  it("проходит участки по порядку и заканчивает сессию", () => {
    const { runtime, clock } = harness();
    const order: string[] = [];
    const session = new SessionRunner({
      runtime,
      surface: headlessSurface(),
      headless: true,
      sessionId: "sess-2",
      seed: 3,
      sections: [
        { id: "training", games: ["org.reconnect.stroop"], end: byRuns(1), training: true },
        { id: "main", games: ["org.reconnect.arithmetic"], end: byTime(60_000) },
      ],
      onSectionStart: (s) => order.push(s.id),
    });
    session.start();
    clock.advance(30 * 60_000);

    expect(order).toEqual(["training", "main"]);
    expect(session.finished).toBe(true);
  });

  it("уровень задачи переживает переход между участками", () => {
    const { runtime, clock } = harness();
    const session = new SessionRunner({
      runtime,
      surface: headlessSurface(),
      headless: true,
      sessionId: "sess-3",
      seed: 3,
      policyFor: () => new Ratchet(),
      sections: [
        { id: "a", games: ["org.reconnect.stroop"], end: byRuns(2) },
        { id: "b", games: ["org.reconnect.stroop"], end: byRuns(1) },
      ],
      onSectionEnd: (spec, records) => byId.set(spec.id, records.at(-1)!.level),
    });
    const byId = new Map<string, number>();
    session.start();
    clock.advance(30 * 60_000);

    expect(session.finished).toBe(true);
    expect(byId.get("a")!).toBeGreaterThan(1);
    // Второй участок продолжает с уровня, добытого в первом, а не с единицы.
    expect(byId.get("b")!).toBeGreaterThanOrEqual(byId.get("a")!);
  });
});
