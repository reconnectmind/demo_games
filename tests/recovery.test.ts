import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlFileSink,
  Manual,
  MarkerDispatcher,
  NullMarkerSink,
  autoDrive,
  headlessRun,
  inputsAfter,
  parseJsonl,
  replayCore,
} from "@gamespace/core";
import { protocolGames } from "@gamespace/games";
import { stroop, ruleSwitch } from "@gamespace/games";

describe("журнал и восстановление", () => {
  it("состояние в любой момент выводится из журнала", () => {
    const run = headlessRun(protocolGames, "org.reconnect.stroop", { seed: 17, policy: new Manual({ start: 2 }) });
    run.instance.start();
    autoDrive(run, { seed: 4, maxSteps: 120 });

    // Обрыв: применённых входов меньше, чем записанных, — берём то, что успело лечь на диск.
    const cutoff = Math.floor(run.records().length / 2);
    const partial = run.records().slice(0, cutoff);
    const recovered = replayCore(stroop, partial, 17);
    expect(recovered).toBeTruthy();

    const full = replayCore(stroop, run.records(), 17);
    expect(full).toEqual(run.instance.state);
  });

  it("вход записывается раньше, чем порождённое им доменное событие", () => {
    const run = headlessRun(protocolGames, "org.reconnect.stroop", { seed: 3 });
    run.instance.start();
    run.clock.advance(50);
    run.instance.submitAction("choose", { index: 0 });
    const records = run.records();
    const action = records.find((r) => r.type === "input.action")!;
    const response = records.find((r) => r.type === "response")!;
    expect(action.seq).toBeLessThan(response.seq);
  });

  it("файловый приёмник переживает перезапуск процесса", () => {
    const dir = mkdtempSync(join(tmpdir(), "gamespace-"));
    const path = join(dir, "events.jsonl");
    const sink = new JsonlFileSink(path, fs);
    const run = headlessRun(protocolGames, "org.reconnect.rule-switch", { seed: 21, sink });
    run.instance.start();
    autoDrive(run, { seed: 8, maxSteps: 150 });
    sink.close();

    const fromDisk = parseJsonl(readFileSync(path, "utf8"));
    expect(fromDisk.length).toBe(run.records().length);
    expect(replayCore(ruleSwitch, fromDisk, 21)).toEqual(run.instance.state);
    rmSync(dir, { recursive: true, force: true });
  });

  it("порядок меток совпадает с порядком в журнале и с порядком отправок", () => {
    const sink = new NullMarkerSink();
    const markers = new MarkerDispatcher(sink);
    const run = headlessRun(protocolGames, "org.reconnect.stroop", { seed: 5, markers });
    run.instance.start();
    autoDrive(run, { seed: 2, maxSteps: 200 });
    const seqs = markers.records.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs.length).toBeGreaterThan(0);
    // Проверять только свои записи недостаточно: разойтись могут именно они с
    // фактическими отправками, а сверить это можно лишь по приёмнику.
    expect(sink.published.map((r) => r.seq)).toEqual(seqs);
    expect(markers.records.every((r) => r.sent)).toBe(true);
  });

  it("неудачная отправка попадает в запись, а не теряется", () => {
    const markers = new MarkerDispatcher({
      publish: () => ({ sent: false, error: "outlet closed" }),
    });
    const run = headlessRun(protocolGames, "org.reconnect.stroop", { seed: 5, markers });
    run.instance.start();
    expect(markers.records.length).toBeGreaterThan(0);
    expect(markers.records.every((r) => !r.sent && r.error === "outlet closed")).toBe(true);
    expect(markers.toCsv().split("\n")[1]).toMatch(/,0,,outlet closed$/);
  });

  it("входы после курсора снимка — ровно хвост журнала", () => {
    const run = headlessRun(protocolGames, "org.reconnect.stroop", { seed: 9 });
    run.instance.start();
    autoDrive(run, { seed: 6, maxSteps: 40 });
    const snapshot = run.instance.snapshot();
    autoDrive(run, { seed: 7, maxSteps: 40 });
    const tail = inputsAfter(run.records(), snapshot.eventCursor);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((i) => typeof i.tMs === "number")).toBe(true);
  });
});
