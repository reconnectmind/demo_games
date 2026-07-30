import type { CoreInput, DomainEvent, Json, PackageRef } from "./contracts.js";

export type LoggedEvent = {
  /** Порядок присваивается один раз в очереди; по нему же сшивается checkpoint. */
  seq: number;
  runId: string;
  /** Монотонное время от t0 запуска. */
  tMs: number;
  /** Абсолютное время: нужно, чтобы сопоставить журнал с записью Artinis. */
  wallMs: number;
  source: "input" | "domain" | "runtime";
  /** Кому принадлежит запись: корневому запуску или дочернему слоту. */
  slot?: string;
  /** Участок расписания и номер прогона внутри него: их присваивает протокол. */
  sectionId?: string;
  runIndex?: number;
  type: string;
  payload: Json;
};

/**
 * Порядковый номер общий на всю сессию, а не на запуск: иначе номера событий
 * повторяются в каждом блоке, и в общем журнале их нечем различить.
 */
export class SeqCounter {
  private value = 0;
  next(): number {
    return ++this.value;
  }
  current(): number {
    return this.value;
  }
}

export interface DurableSink {
  /** Обязана вернуть управление только после того, как запись пережила падение. */
  append(event: LoggedEvent): void;
  flush(): void;
}

/** Журнал в памяти: витрина и тесты. Для лаборатории подставляется файловый. */
export class MemorySink implements DurableSink {
  readonly records: LoggedEvent[] = [];
  append(event: LoggedEvent): void {
    this.records.push(event);
  }
  flush(): void {}
}

export interface EventLogOptions {
  runId: string;
  packageRef: PackageRef;
  t0WallMs: number;
  now: () => number;
  wallNow?: () => number;
  sink?: DurableSink;
  /** Общий счётчик сессии; без него журнал нумеруется от единицы. */
  seq?: SeqCounter;
  /** Контекст протокола: один запуск целиком принадлежит одному участку. */
  sectionId?: string;
  runIndex?: number;
}

/**
 * Единый журнал запуска. В него пишутся и входы, и домённые события,
 * причём вход пишется ДО применения — иначе после сбоя нельзя доказать,
 * что повтор даст то же состояние.
 */
export class EventLog {
  private readonly seq: SeqCounter;
  readonly sink: DurableSink;
  private readonly opts: EventLogOptions;

  constructor(opts: EventLogOptions) {
    this.opts = opts;
    this.sink = opts.sink ?? new MemorySink();
    this.seq = opts.seq ?? new SeqCounter();
  }

  get cursor(): number {
    return this.seq.current();
  }

  private write(source: LoggedEvent["source"], type: string, payload: Json, slot?: string): LoggedEvent {
    const wallNow = this.opts.wallNow ?? (() => this.opts.t0WallMs + this.opts.now());
    const event: LoggedEvent = {
      seq: this.seq.next(),
      runId: this.opts.runId,
      tMs: this.opts.now(),
      wallMs: wallNow(),
      source,
      ...(slot ? { slot } : {}),
      ...(this.opts.sectionId ? { sectionId: this.opts.sectionId } : {}),
      ...(this.opts.runIndex === undefined ? {} : { runIndex: this.opts.runIndex }),
      type,
      payload,
    };
    this.sink.append(event);
    return event;
  }

  input(input: CoreInput, slot?: string): LoggedEvent {
    return this.write("input", `input.${input.kind}`, input as unknown as Json, slot);
  }

  domain(event: DomainEvent, slot?: string): LoggedEvent {
    const { type, ...rest } = event;
    return this.write("domain", type, rest as Json, slot);
  }

  runtime(type: string, payload: Json = null, slot?: string): LoggedEvent {
    return this.write("runtime", type, payload, slot);
  }

  records(): LoggedEvent[] {
    const sink = this.sink as DurableSink & { records?: LoggedEvent[] };
    return sink.records ?? [];
  }

  toJsonl(): string {
    return this.records()
      .map((r) => JSON.stringify(r))
      .join("\n");
  }

  toCsv(): string {
    const head = "seq,run_id,section_id,run_index,t_ms,wall_ms,source,type,payload";
    const rows = this.records().map((r) =>
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
    );
    return [head, ...rows].join("\n");
  }
}

/**
 * Восстановление: входы после курсора, в исходном порядке. Журнал у составной
 * игры общий, поэтому отбирается ровно один участник — корень или конкретный слот.
 */
export function inputsAfter(records: LoggedEvent[], cursor: number, slot?: string): CoreInput[] {
  return records
    .filter((r) => r.source === "input" && r.seq > cursor && r.slot === slot)
    .sort((a, b) => a.seq - b.seq)
    .map((r) => r.payload as unknown as CoreInput);
}
