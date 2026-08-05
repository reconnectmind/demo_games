import type { DifficultyPolicy, DurableSink, GameRuntime, InputProfile, Surface } from "@gamespace/core";
import { SectionRunner, type RunRecord, type Screen, type SectionSnapshot, type SectionSpec } from "./runner.js";

export interface SessionOptions {
  runtime: GameRuntime;
  sections: SectionSpec[];
  surface: Surface;
  sessionId: string;
  seed?: number;
  tickMs?: number;
  sink?: DurableSink;
  headless?: boolean;
  /** Профиль ввода протокола: один на всю сессию, менять его между участками нельзя. */
  input?: InputProfile;
  /** Показ отбивок: тот же обработчик на все участки, листает оператор. */
  present?(screen: Screen, index: number, proceed: () => void): void;
  /**
   * Политики сложности общие на всю сессию: уровень задачи переживает не только
   * перезапуск блока, но и переход между участками расписания.
   */
  policyFor?(gameId: string): DifficultyPolicy;
  onSectionStart?(section: SectionSpec, index: number): void;
  onSectionEnd?(section: SectionSpec, records: RunRecord[]): void;
  onDone?(): void;
}

export interface SessionSnapshot {
  sessionId: string;
  sectionIndex: number;
  section: SectionSnapshot;
}

/** Последовательность участков: baseline, обучение, игры, baseline. */
export class SessionRunner {
  private index = -1;
  private runner: SectionRunner | null = null;
  private readonly shared = new Map<string, DifficultyPolicy>();
  private done = false;

  constructor(private readonly opts: SessionOptions) {}

  get sectionIndex(): number {
    return this.index;
  }

  get finished(): boolean {
    return this.done;
  }

  current(): SectionRunner | null {
    return this.runner;
  }

  start(): void {
    this.advance();
  }

  private policyFor(gameId: string): DifficultyPolicy | undefined {
    if (!this.opts.policyFor) return undefined;
    let policy = this.shared.get(gameId);
    if (!policy) {
      policy = this.opts.policyFor(gameId);
      this.shared.set(gameId, policy);
    }
    return policy;
  }

  private advance(): void {
    this.index += 1;
    const section = this.opts.sections[this.index];
    if (!section) {
      this.done = true;
      this.runner = null;
      this.opts.onDone?.();
      return;
    }
    this.runner = new SectionRunner({
      runtime: this.opts.runtime,
      section,
      surface: this.opts.surface,
      seed: (this.opts.seed ?? 1) + this.index * 7919,
      sessionId: this.opts.sessionId,
      tickMs: this.opts.tickMs,
      sink: this.opts.sink,
      headless: this.opts.headless,
      ...(this.opts.input ? { input: this.opts.input } : {}),
      ...(this.opts.present ? { present: this.opts.present } : {}),
      ...(this.opts.policyFor ? { policyFor: (id: string) => this.policyFor(id)! } : {}),
      onDone: (records) => {
        this.opts.onSectionEnd?.(section, records);
        this.advance();
      },
    });
    this.opts.onSectionStart?.(section, this.index);
    this.runner.start();
  }

  pause(): void {
    this.runner?.pause();
  }

  resume(): void {
    this.runner?.resume();
  }

  /** Аварийное завершение: текущий участок закрывается, остальные не запускаются. */
  abort(): void {
    this.done = true;
    this.runner?.abort();
    this.runner = null;
  }

  snapshot(): SessionSnapshot | null {
    if (!this.runner) return null;
    return { sessionId: this.opts.sessionId, sectionIndex: this.index, section: this.runner.snapshot() };
  }
}
