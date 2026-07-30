import type { DurableSink, LoggedEvent } from "./events.js";

/**
 * Файловый приёмник: строка дописывается синхронно, потому что вход обязан
 * пережить падение до того, как будет применён к ядру.
 */
export class JsonlFileSink implements DurableSink {
  private fd: number | null = null;
  readonly records: LoggedEvent[] = [];

  constructor(
    private readonly path: string,
    private readonly fs: {
      openSync(path: string, flags: string): number;
      writeSync(fd: number, data: string): number;
      fsyncSync(fd: number): void;
      closeSync(fd: number): void;
    },
  ) {}

  append(event: LoggedEvent): void {
    this.records.push(event);
    if (this.fd === null) this.fd = this.fs.openSync(this.path, "a");
    this.fs.writeSync(this.fd, `${JSON.stringify(event)}\n`);
  }

  flush(): void {
    if (this.fd !== null) this.fs.fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd === null) return;
    this.fs.fsyncSync(this.fd);
    this.fs.closeSync(this.fd);
    this.fd = null;
  }
}

/**
 * Браузерный приёмник: буфер сбрасывается пачками, но всегда до применения
 * следующего входа. Полной гарантии как у fsync здесь нет — витрине хватает,
 * лаборатории нет, поэтому эксперимент работает через файловый приёмник.
 */
export class LocalStorageSink implements DurableSink {
  readonly records: LoggedEvent[] = [];
  private buffer: LoggedEvent[] = [];

  constructor(
    private readonly key: string,
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
    private readonly batchSize = 20,
  ) {}

  append(event: LoggedEvent): void {
    this.records.push(event);
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const previous = this.storage.getItem(this.key) ?? "";
    this.storage.setItem(this.key, previous + this.buffer.map((r) => JSON.stringify(r)).join("\n") + "\n");
    this.buffer = [];
  }
}

/** Разбор журнала обратно в записи: вход в восстановление после сбоя. */
export function parseJsonl(content: string): LoggedEvent[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LoggedEvent);
}
