import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ListenerInput = {
  readonly onCommand: (transcript: string) => void | Promise<void>;
  readonly onSpeechStart?: () => boolean | void;
  readonly onStateChange?: (state: string) => void;
};

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  listenerInput: null as ListenerInput | null,
  listener: {
    pause: vi.fn(),
    resume: vi.fn(),
    sleep: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    unlock: vi.fn(),
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T>(callback: T) => callback,
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      harness.effects.push(effect);
    }),
    useRef: <T>(value: T) => ({ current: value }),
    useState: <T>(value: T) => [value, vi.fn()],
  };
});

vi.mock("./voiceWakePhrase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./voiceWakePhrase")>();
  return { ...actual, getVoiceWakePhraseMode: () => "local-audio" };
});

vi.mock("./voiceWakePhraseAudio", () => ({
  createLocalAudioWakePhraseListener: vi.fn((input: ListenerInput) => {
    harness.listenerInput = input;
    return harness.listener;
  }),
}));

import {
  isVoiceCapabilityUnavailable,
  resolveVoiceCaptureMode,
  shouldIgnoreVoiceListenerState,
  shouldAutoStartVoiceCapture,
  useVoiceSessionController,
} from "./useVoiceSessionController";

function createController(overrides?: {
  readonly phase?: "idle" | "transcribing" | "waiting" | "speaking";
  readonly onCaptureCancelled?: () => void;
  readonly onInterrupt?: () => void | Promise<void>;
  readonly onTranscript?: (transcript: string) => Promise<void>;
}) {
  return useVoiceSessionController({
    httpBaseUrl: "http://localhost",
    onCaptureCancelled: overrides?.onCaptureCancelled ?? vi.fn(),
    onInterrupt: overrides?.onInterrupt ?? vi.fn(),
    onPlaybackUnlock: vi.fn(async () => undefined),
    phase: overrides?.phase ?? "idle",
    onTranscript: overrides?.onTranscript ?? vi.fn(async () => undefined),
  });
}

describe("useVoiceSessionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.effects.length = 0;
    harness.listenerInput = null;
  });

  it("keeps microphone capture running during sleep but stops it for mic off", () => {
    const controller = createController();
    const cleanup = harness.effects[0]?.();

    controller.sleep();

    expect(harness.listener.sleep).toHaveBeenCalledOnce();
    expect(harness.listener.stop).not.toHaveBeenCalled();

    controller.micOff();

    expect(harness.listener.stop).toHaveBeenCalledOnce();
    cleanup?.();
    expect(harness.listener.stop).toHaveBeenCalledOnce();
  });

  it("interrupts playback before submitting a barge-in command", async () => {
    let finishInterrupt!: () => void;
    const order: string[] = [];
    const interruptFinished = new Promise<void>((resolve) => {
      finishInterrupt = () => {
        order.push("interrupt-finished");
        resolve();
      };
    });
    const controller = createController({
      phase: "speaking",
      onInterrupt: vi.fn(() => {
        order.push("interrupt-started");
        return interruptFinished;
      }),
      onTranscript: vi.fn(async () => {
        order.push("submitted");
      }),
    });
    harness.effects[0]?.();

    expect(harness.listenerInput?.onSpeechStart?.()).toBe(true);
    const command = Promise.resolve(harness.listenerInput?.onCommand("change direction"));

    expect(order).toEqual(["interrupt-started"]);
    finishInterrupt();
    await command;

    expect(order).toEqual(["interrupt-started", "interrupt-finished", "submitted"]);
    controller.micOff();
  });

  it("releases microphone resources on lifecycle cleanup", () => {
    createController();
    const cleanup = harness.effects[0]?.();

    cleanup?.();

    expect(harness.listener.stop).toHaveBeenCalledOnce();
  });

  it("never silently starts browser speech recognition fallback", () => {
    const mode = resolveVoiceCaptureMode("speech-recognition");

    expect(mode).toBe("browser-fallback");
    expect(shouldAutoStartVoiceCapture(mode)).toBe(false);
  });

  it("surfaces unsupported and permission-blocked capability states", () => {
    expect(isVoiceCapabilityUnavailable("unsupported", "unsupported")).toBe(true);
    expect(isVoiceCapabilityUnavailable("local-audio", "blocked")).toBe(true);
    expect(isVoiceCapabilityUnavailable("local-audio", "listening")).toBe(false);
    expect(shouldIgnoreVoiceListenerState(true, "off")).toBe(true);
    expect(shouldIgnoreVoiceListenerState(false, "off")).toBe(false);
  });
});
