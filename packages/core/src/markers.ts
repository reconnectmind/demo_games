import type { LoggedEvent } from "./events.js";

export interface MarkerRecord {
  seq: number;
  code: number;
  label: string;
  tMs: number;
  wallMs: number;
}

export interface MarkerSink {
  /** Публикация метки. В лаборатории — LSL outlet, в витрине — заглушка. */
  publish(record: MarkerRecord): void;
}

export class NullMarkerSink implements MarkerSink {
  readonly published: MarkerRecord[] = [];
  publish(record: MarkerRecord): void {
    this.published.push(record);
  }
}

/** Какие типы событий вообще становятся метками протокола. */
export const DEFAULT_CODEBOOK: Record<string, number> = {
  "run.start": 10,
  "run.end": 11,
  "phase.enter": 20,
  "phase.leave": 21,
  "block.start": 30,
  "block.end": 31,
  "interruption.start": 40,
  "interruption.end": 41,
  "resume": 42,
  "stimulus.presented": 50,
  "response": 51,
  "trial.outcome": 52,
  "difficulty.changed": 60,
};

/**
 * Метки — не отдельный канал, а проекция подмножества журнала. Порядок берётся
 * из seq и потому не может разойтись с порядком отправки.
 */
export class MarkerDispatcher {
  readonly records: MarkerRecord[] = [];

  constructor(
    private readonly sink: MarkerSink,
    private readonly codebook: Record<string, number> = DEFAULT_CODEBOOK,
  ) {}

  consider(event: LoggedEvent): void {
    const code = this.codebook[event.type];
    if (code === undefined) return;
    const record: MarkerRecord = {
      seq: event.seq,
      code,
      label: event.type,
      tMs: event.tMs,
      wallMs: event.wallMs,
    };
    this.records.push(record);
    this.sink.publish(record);
  }

  toCsv(): string {
    return ["seq,code,label,t_ms,wall_ms", ...this.records.map((r) => `${r.seq},${r.code},${r.label},${r.tMs.toFixed(3)},${r.wallMs.toFixed(0)}`)].join("\n");
  }

  codebookCsv(): string {
    return ["code,label", ...Object.entries(this.codebook).map(([label, code]) => `${code},${label}`)].join("\n");
  }
}
