// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("desktop bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
  });

  it("loads filesystem protocols and preserves event order across async IPC", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    let releaseFirst: (() => void) | undefined;
    const invoke = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      if (command === "bootstrap") {
        return {
          portableRoot: "/portable",
          writable: true,
          storageError: null,
          interruptedSessions: 0,
          protocols: [
            {
              fileName: "pilot.json",
              content: JSON.stringify({ id: "pilot", title: "Pilot", sections: [] }),
              error: null,
            },
          ],
        };
      }
      if (command === "start_session") {
        return { token: "token", directory: "/portable/data/p-1/run", sourceId: "source" };
      }
      if (command === "append_event" && (args.event as { seq: number }).seq === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return undefined;
    });
    window.__TAURI__ = {
      core: {
        invoke: <T>(command: string, args?: Record<string, unknown>) =>
          invoke(command, args) as Promise<T>,
      },
    };

    const bridge = await import("../apps/showcase/src/desktop.js");
    await bridge.desktopReady;
    expect(bridge.desktopProtocols().map((protocol) => protocol.id)).toEqual(["pilot"]);
    await bridge.startDesktopSession({
      participantId: "p-1",
      protocolId: "pilot",
      protocolTitle: "Pilot",
      protocolJson: { id: "pilot", title: "Pilot", sections: [] } as never,
      appVersion: "test",
      seed: 1,
      order: [],
      input: {},
      theme: "dark",
      pace: "full",
      gameVersions: {},
      codebookVersion: "1",
      codebook: {},
    });
    bridge.appendDesktopEvent({ seq: 1 } as never);
    bridge.appendDesktopEvent({ seq: 2 } as never);
    await Promise.resolve();
    expect(calls.filter((call) => call.command === "append_event")).toHaveLength(1);
    releaseFirst?.();
    await bridge.flushDesktopSession();
    expect(
      calls
        .filter((call) => call.command === "append_event")
        .map((call) => (call.args.event as { seq: number }).seq),
    ).toEqual([1, 2]);
  });
});
