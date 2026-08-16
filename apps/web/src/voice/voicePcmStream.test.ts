import { describe, expect, it, vi } from "vite-plus/test";
import { decodePcm16Le, readPcm16Chunks, VoicePcmStreamPlayer } from "./voicePcmStream";

it("signals when scheduled PCM becomes audible so barge-in can reopen", async () => {
  vi.useFakeTimers();
  try {
    let emitEnded!: () => void;
    const source = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn((_name: string, listener: () => void) => {
        emitEnded = listener;
      }),
      start: vi.fn(),
    };
    const context = {
      currentTime: 10,
      destination: {},
      resume: vi.fn(async () => undefined),
      createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => ({
        copyToChannel: vi.fn(),
        duration: length / sampleRate,
      })),
      createBufferSource: vi.fn(() => source),
    } as unknown as AudioContext;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(160));
        controller.close();
      },
    });
    const onPlaybackStart = vi.fn();
    const player = new VoicePcmStreamPlayer(context);

    const { playback } = await player.enqueue({
      backend: "step_audio_editx",
      body,
      onPlaybackStart,
      sampleRate: 1_000,
      signal: new AbortController().signal,
      shouldContinue: () => true,
    });

    expect(onPlaybackStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onPlaybackStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onPlaybackStart).toHaveBeenCalledOnce();

    emitEnded();
    await playback;
  } finally {
    vi.useRealTimers();
  }
});
describe("PCM16 streaming", () => {
  it("preserves samples split across odd network chunk boundaries", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5, 6, 7]));
        controller.close();
      },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of readPcm16Chunks(body, 2)) chunks.push(chunk);

    expect(chunks).toEqual([new Uint8Array([0, 1]), new Uint8Array([2, 3, 4, 5, 6, 7])]);
  });

  it("decodes little-endian PCM16 into normalized float samples", () => {
    expect(Array.from(decodePcm16Le(new Uint8Array([0, 128, 0, 0, 255, 127])))).toEqual([
      -1,
      0,
      32_767 / 32_768,
    ]);
  });
});
