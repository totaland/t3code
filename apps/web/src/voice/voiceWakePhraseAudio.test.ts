import { describe, expect, it, vi } from "vitest";
import { createLocalAudioWakePhraseListener } from "./voiceWakePhraseAudio";
import type { VoiceWakePhraseState } from "./voiceWakePhrase";

class FakeAudioContext {
  static rejectResume = false;
  static processor: { onaudioprocess: ((event: AudioProcessingEvent) => void) | null } & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  readonly sampleRate = 16_000;
  readonly destination = {} as AudioDestinationNode;
  state: AudioContextState = "suspended";
  resume = vi.fn(async () => {
    if (FakeAudioContext.rejectResume)
      throw new DOMException("gesture required", "NotAllowedError");
    this.state = "running";
  });
  close = vi.fn(async () => undefined);
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  createScriptProcessor = vi.fn(() => {
    FakeAudioContext.processor = {
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    return FakeAudioContext.processor;
  });
  createGain = vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
}

function emitAudio(peak: number) {
  const samples = new Float32Array(4_096).fill(peak);
  FakeAudioContext.processor.onaudioprocess?.({
    inputBuffer: { getChannelData: () => samples },
  } as unknown as AudioProcessingEvent);
}

describe("local audio wake phrase", () => {
  it("keeps one microphone session from wake through silence-finalized command", async () => {
    FakeAudioContext.rejectResume = false;
    const scheduled: Array<() => void> = [];
    const states: VoiceWakePhraseState[] = [];
    const onWake = vi.fn();
    const onCommand = vi.fn();
    const onSpeechStart = vi.fn();
    const transcripts = ["Hey Mai", "open the current thread", "summarize it"];
    const onTranscribe = vi.fn(async () => transcripts.shift() ?? "");
    const stop = vi.fn();
    const getUserMedia = vi.fn(
      async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream,
    );
    const listener = createLocalAudioWakePhraseListener({
      audioContextConstructor: FakeAudioContext as unknown as new () => AudioContext,
      getUserMedia,
      onTranscribe,
      onCommand,
      onSpeechStart,
      onWake,
      onStateChange: (state) => states.push(state),
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancelScheduled: vi.fn(),
    });

    listener?.start();
    await vi.waitFor(() => expect(states).toEqual(["starting", "listening"]));
    emitAudio(0.1);
    scheduled.shift()?.();

    await vi.waitFor(() => expect(onWake).toHaveBeenCalledOnce());
    expect(states.at(-1)).toBe("awake");
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();

    emitAudio(0.1);
    emitAudio(0);
    emitAudio(0);
    emitAudio(0);

    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledWith("open the current thread"));
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(onTranscribe).toHaveBeenCalledTimes(2);
    expect(states).toContain("paused");
    expect(stop).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(states.at(-1)).toBe("awake"));
    expect(getUserMedia).toHaveBeenCalledOnce();

    emitAudio(0.1);
    emitAudio(0);
    emitAudio(0);
    emitAudio(0);

    await vi.waitFor(() => expect(onCommand).toHaveBeenLastCalledWith("summarize it"));
    expect(onWake).toHaveBeenCalledOnce();
    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    expect(onTranscribe).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(states.at(-1)).toBe("awake"));
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("goes back to wake-only listening without sending the sleep phrase", async () => {
    FakeAudioContext.rejectResume = false;
    const scheduled: Array<() => void> = [];
    const onCommand = vi.fn();
    const onSleep = vi.fn();
    const transcripts = ["Hey Mai", "go to sleep"];
    const listener = createLocalAudioWakePhraseListener({
      audioContextConstructor: FakeAudioContext as unknown as new () => AudioContext,
      getUserMedia: vi.fn(
        async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
      ),
      onTranscribe: vi.fn(async () => transcripts.shift() ?? ""),
      onCommand,
      onSleep,
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancelScheduled: vi.fn(),
    });

    listener?.start();
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    emitAudio(0.1);
    scheduled.shift()?.();
    await vi.waitFor(() => expect(scheduled).toHaveLength(0));

    emitAudio(0.1);
    emitAudio(0);
    emitAudio(0);
    emitAudio(0);

    await vi.waitFor(() => expect(onSleep).toHaveBeenCalledOnce());
    expect(onCommand).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
  });

  it("requires one user gesture before claiming iPhone audio is listening", async () => {
    FakeAudioContext.rejectResume = true;
    const states: VoiceWakePhraseState[] = [];
    const schedule = vi.fn(() => 1);
    const listener = createLocalAudioWakePhraseListener({
      audioContextConstructor: FakeAudioContext as unknown as new () => AudioContext,
      getUserMedia: vi.fn(
        async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
      ),
      onTranscribe: vi.fn(async () => ""),
      onCommand: vi.fn(),
      onStateChange: (state) => states.push(state),
      schedule,
    });

    listener?.start();
    await vi.waitFor(() => expect(states).toEqual(["starting", "needs-interaction"]));
    expect(schedule).not.toHaveBeenCalled();

    FakeAudioContext.rejectResume = false;
    listener?.unlock?.();
    await vi.waitFor(() => expect(states.at(-1)).toBe("listening"));
    expect(schedule).toHaveBeenCalledOnce();
  });
});
