import { describe, expect, it, vi } from "vite-plus/test";
import { primeVoicePlaybackContext } from "./voicePlayback";

describe("voice playback unlock", () => {
  it("starts a priming buffer synchronously with the resume request", async () => {
    const order: string[] = [];
    const endedListeners: Array<() => void> = [];
    const channelData = new Float32Array(2_400);
    const source = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(() => order.push("connect")),
      disconnect: vi.fn(() => order.push("disconnect")),
      addEventListener: vi.fn((_name: string, listener: () => void) => {
        endedListeners.push(listener);
      }),
      start: vi.fn(() => order.push("start")),
    };
    const context = {
      sampleRate: 48_000,
      destination: {},
      resume: vi.fn(() => {
        order.push("resume");
        return Promise.resolve();
      }),
      createBuffer: vi.fn(() => ({
        getChannelData: () => channelData,
      })),
      createBufferSource: vi.fn(() => source),
    } as unknown as AudioContext;

    const primed = primeVoicePlaybackContext(context);

    expect(order).toEqual(["resume", "connect", "start"]);
    expect(channelData[0]).toBeGreaterThan(0);
    await primed;

    endedListeners[0]?.();
    expect(source.disconnect).toHaveBeenCalledOnce();
  });
});
