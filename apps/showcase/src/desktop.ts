import type { LoggedEvent } from "@gamespace/core";
import type { Protocol } from "@gamespace/protocol";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI__?: { core?: { invoke?: Invoke } };
  }
}

export interface DesktopProtocolFile {
  fileName: string;
  content: string;
  error: string | null;
}

export interface DesktopBootstrap {
  portableRoot: string;
  writable: boolean;
  storageError: string | null;
  protocols: DesktopProtocolFile[];
  interruptedSessions: number;
}

export interface LslStatus {
  ok: boolean;
  message: string;
  streamName: string;
  streamType: string;
  sourceId: string;
  hasConsumers: boolean;
}

export interface SessionStartRequest {
  participantId: string;
  protocolId: string;
  protocolTitle: string;
  protocolJson: Protocol;
  appVersion: string;
  seed: number;
  order: string[];
  input: unknown;
  theme: string;
  pace: string;
  gameVersions: Record<string, string>;
  codebookVersion: string;
  codebook: Record<string, number>;
}

interface SessionInfo {
  token: string;
  directory: string;
  sourceId: string;
}

const invoke: Invoke | null = window.__TAURI__?.core?.invoke ?? null;

export const desktop = invoke !== null;
export const experimentProduction = desktop && import.meta.env.MODE === "experiment";
export const experimentTools =
  desktop && import.meta.env.VITE_EXPERIMENT_PROFILE === "development";
export const labRecorderRequired =
  experimentProduction && import.meta.env.VITE_LABRECORDER_REQUIRED !== "false";

let boot: DesktopBootstrap | null = null;
let protocols: Protocol[] = [];
let files = new Map<string, string>();
let session: SessionInfo | null = null;
let queue = Promise.resolve();
let writeError: string | null = null;

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!invoke) throw new Error("desktop backend недоступен");
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (command !== "report_error") {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      void invoke("report_error", {
        source: `ipc.${command}`,
        message,
        stack,
      }).catch(() => undefined);
    }
    throw error;
  }
}

function loadProtocols(info: DesktopBootstrap): void {
  protocols = [];
  files = new Map();
  for (const file of info.protocols) {
    if (file.error || !file.content) continue;
    try {
      const protocol = JSON.parse(file.content) as Protocol;
      protocols.push(protocol);
      files.set(protocol.id, file.fileName);
    } catch {
      // Rust already reports malformed JSON. Structural protocol errors are
      // displayed by the same compiler that guards Start.
    }
  }
}

export const desktopReady: Promise<DesktopBootstrap | null> = desktop
  ? call<DesktopBootstrap>("bootstrap").then((info) => {
      boot = info;
      loadProtocols(info);
      return info;
    })
  : Promise.resolve(null);

export const desktopBootstrap = (): DesktopBootstrap | null => boot;
export const desktopProtocols = (): Protocol[] => protocols.map((p) => structuredClone(p));

export async function saveDesktopProtocol(protocol: Protocol): Promise<void> {
  const fileName = files.get(protocol.id) ?? `${protocol.id}.json`;
  files.set(protocol.id, fileName);
  const index = protocols.findIndex((p) => p.id === protocol.id);
  if (index >= 0) protocols[index] = structuredClone(protocol);
  else protocols.push(structuredClone(protocol));
  await call("save_protocol", {
    fileName,
    content: JSON.stringify(protocol, null, 2),
  });
}

export async function deleteDesktopProtocol(id: string): Promise<void> {
  const fileName = files.get(id) ?? `${id}.json`;
  files.delete(id);
  protocols = protocols.filter((p) => p.id !== id);
  await call("delete_protocol", { fileName });
}

export const runLslPreflight = (participantId: string, protocolId: string): Promise<LslStatus> =>
  call("lsl_preflight", { participantId, protocolId });

export const getLslStatus = (): Promise<LslStatus> => call("lsl_status");

export async function startDesktopSession(request: SessionStartRequest): Promise<SessionInfo | null> {
  if (!desktop) return null;
  if (session) throw new Error("desktop session уже активна");
  writeError = null;
  queue = Promise.resolve();
  session = await call<SessionInfo>("start_session", { request });
  return session;
}

export function appendDesktopEvent(event: LoggedEvent): void {
  if (!session || writeError) return;
  const token = session.token;
  queue = queue
    .then(() => call<void>("append_event", { token, event }))
    .catch((error) => {
      writeError = String((error as Error)?.message ?? error);
      window.dispatchEvent(new CustomEvent("reconnect-write-error", { detail: writeError }));
    });
}

export async function flushDesktopSession(): Promise<void> {
  if (!session) return;
  await queue;
  if (writeError) throw new Error(writeError);
  await call("flush_session", { token: session.token });
}

export async function finishDesktopSession(status: string, summary: unknown): Promise<string | null> {
  if (!session) return null;
  const active = session;
  await flushDesktopSession();
  const directory = await call<string>("finish_session", {
    token: active.token,
    status,
    summary,
  });
  session = null;
  return directory;
}

export async function abortDesktopSession(): Promise<string | null> {
  if (!desktop || !session) return null;
  try {
    await queue;
    return await call<string | null>("abort_session");
  } finally {
    session = null;
  }
}

export const desktopSessionActive = (): boolean => session !== null;
export const desktopSessionDirectory = (): string | null => session?.directory ?? null;
export const desktopWriteError = (): string | null => writeError;

export const readDesktopSessionFile = (name: string): Promise<string> =>
  call("read_session_file", { name });

export const openDesktopSessionFolder = (): Promise<void> => call("open_session_folder");
