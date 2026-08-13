import { describe, expect, it, vi } from "vite-plus/test";
import { createVoiceRouteSession } from "./voiceRouteSession";

function fakeContext() {
  return {
    state: "running" as AudioContextState,
    close: vi.fn(async () => undefined),
  } as unknown as AudioContext;
}

describe("voice route session", () => {
  it("keeps gesture-primed playback alive across sibling route handoff", async () => {
    const context = fakeContext();
    const scheduled: Array<() => void> = [];
    const cancelled = new Set<() => void>();
    const session = createVoiceRouteSession({
      createAudioContext: () => context,
      primeAudioContext: vi.fn(async () => undefined),
      scheduleRelease: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancelRelease: (handle) => {
        cancelled.add(handle as () => void);
      },
    });
    const releaseTextRoute = session.retainPlayback();

    await expect(session.ensurePlayback()).resolves.toBe(context);
    releaseTextRoute();
    const releaseVoiceRoute = session.retainPlayback();
    for (const callback of scheduled) {
      if (!cancelled.has(callback)) callback();
    }

    expect(session.getPlayback()).toBe(context);
    expect(context.close).not.toHaveBeenCalled();

    releaseVoiceRoute();
    scheduled.at(-1)?.();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("keeps composer send state through StrictMode route handoff", () => {
    const scheduled: Array<() => void> = [];
    const cancelled = new Set<() => void>();
    const session = createVoiceRouteSession({
      createAudioContext: fakeContext,
      primeAudioContext: vi.fn(async () => undefined),
      scheduleRelease: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancelRelease: (handle) => {
        cancelled.add(handle as () => void);
      },
    });
    const sendContext = { providerAvailable: true };

    session.rememberSendContext("env:thread", sendContext as never);
    const releaseFirstMount = session.retainSendContext("env:thread");
    releaseFirstMount();
    const releaseSecondMount = session.retainSendContext("env:thread");
    for (const callback of scheduled) {
      if (!cancelled.has(callback)) callback();
    }

    expect(session.readSendContext("env:thread")).toBe(sendContext);

    releaseSecondMount();
    scheduled.at(-1)?.();
    expect(session.readSendContext("env:thread")).toBeNull();
  });
});
