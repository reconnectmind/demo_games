import type { LoggedEvent } from "./events.js";

export interface MarkerRecord {
  seq: number;
  code: number;
  label: string;
  tMs: number;
  wallMs: number;
  /** Дошла ли метка до приёмника: без этого поля запись говорит только о намерении. */
  sent: boolean;
  /** Время приёмника, если он его вернул: в лаборатории это часы LSL. */
  sinkTimeS: number | null;
  /** Почему не ушла. */
  error: string | null;
}

/** Что приёмник знает об отправке. Молчание считается успехом без своего времени. */
export interface MarkerReceipt {
  sent: boolean;
  sinkTimeS?: number;
  error?: string;
}

export interface MarkerSink {
  /** Публикация метки. В лаборатории — LSL outlet, в витрине — заглушка. */
  publish(record: Omit<MarkerRecord, "sent" | "sinkTimeS" | "error">): MarkerReceipt | void;
}

export class NullMarkerSink implements MarkerSink {
  readonly published: MarkerRecord[] = [];
  publish(record: Omit<MarkerRecord, "sent" | "sinkTimeS" | "error">): MarkerReceipt {
    this.published.push({ ...record, sent: true, sinkTimeS: null, error: null });
    return { sent: true };
  }
}

/**
 * Что становится меткой протокола: границы фаз расписания и границы задач внутри
 * них. Стимулы, ответы, исходы проб и смены уровня в поток не идут — они
 * остаются в журнале.
 *
 * Дело не только в пропускной способности Артиниса. Он вообще не различает
 * значения меток: для него это таймстемпы, а расшифровка живёт отдельным файлом
 * и сводится по порядку. Чем меньше метка несёт смысла, тем меньше в этом потоке
 * смысла терять — поэтому в него идёт только то, по чему режут запись.
 */
export const DEFAULT_CODEBOOK: Record<string, number> = {
  "section.start": 1,
  "section.end": 2,
  "run.start": 10,
  "run.end": 11,
  "interruption.start": 40,
  "interruption.end": 41,
  resume: 42,
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
    const head = { seq: event.seq, code, label: event.type, tMs: event.tMs, wallMs: event.wallMs };
    const receipt = this.sink.publish(head) ?? { sent: true };
    this.records.push({
      ...head,
      sent: receipt.sent,
      sinkTimeS: receipt.sinkTimeS ?? null,
      error: receipt.error ?? null,
    });
  }

  toCsv(): string {
    return [
      "seq,code,label,t_ms,wall_ms,sent,sink_time_s,error",
      ...this.records.map(
        (r) =>
          `${r.seq},${r.code},${r.label},${r.tMs.toFixed(3)},${r.wallMs.toFixed(0)},${r.sent ? 1 : 0},` +
          `${r.sinkTimeS === null ? "" : r.sinkTimeS.toFixed(6)},${r.error ?? ""}`,
      ),
    ].join("\n");
  }

  codebookCsv(): string {
    return ["code,label", ...Object.entries(this.codebook).map(([label, code]) => `${code},${label}`)].join("\n");
  }
}
