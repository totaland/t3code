import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceFetch } from "./voiceClient";
type ListenerInput = {
  readonly onCommand: (transcript: string) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly onNoCommand?: () => void;
  readonly onSpeechStart?: () => boolean | void;
  readonly onStateChange?: (state: string) => void;
  readonly onTranscribe?: (wav: Blob, signal: AbortSignal) => Promise<string>;
  readonly onTranscript?: (transcript: string) => void;
};

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  browserSupported: false,
  listenerInput: null as ListenerInput | null,
  stateSetters: [] as Array<ReturnType<typeof vi.fn>>,
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
    useState: <T>(value: T) => {
      const setter = vi.fn();
      harness.stateSetters.push(setter);
      return [value, setter];
    },
  };
});

vi.mock("./voiceWakePhrase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./voiceWakePhrase")>();
  return {
    ...actual,
    getVoiceWakePhraseMode: () => "local-audio",
    isBrowserSpeechRecognitionSupported: () => harness.browserSupported,
  };
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
  shouldRecoverLocalVoiceGateway,
  useVoiceSessionController,
} from "./useVoiceSessionController";

function createController(overrides?: {
  readonly disabled?: boolean;
  readonly fetchImplementation?: VoiceFetch;
  readonly httpBaseUrl?: string | null;
  readonly phase?: "idle" | "transcribing" | "waiting" | "speaking";
  readonly onCaptureCancelled?: () => void;
  readonly onInterrupt?: () => void | Promise<void>;
  readonly onTranscript?: (transcript: string) => Promise<void>;
}) {
  return useVoiceSessionController({
    disabled: overrides?.disabled,
    httpBaseUrl:
      overrides && "httpBaseUrl" in overrides
        ? (overrides.httpBaseUrl ?? null)
        : "http://localhost",
    fetchImplementation: overrides?.fetchImplementation ?? vi.fn(async () => new Response()),
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
    harness.browserSupported = false;
    harness.listenerInput = null;
    harness.stateSetters.length = 0;
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

  it("releases an interrupted route hold when transcription is empty", async () => {
    let finishInterrupt!: () => void;
    const interruptFinished = new Promise<void>((resolve) => {
      finishInterrupt = resolve;
    });
    const onCaptureCancelled = vi.fn();
    createController({
      fetchImplementation: vi.fn(async () => Response.json({ text: "" })),
      phase: "speaking",
      onCaptureCancelled,
      onInterrupt: () => interruptFinished,
    });
    harness.effects[0]?.();

    expect(harness.listenerInput?.onSpeechStart?.()).toBe(true);
    const transcription = harness.listenerInput?.onTranscribe?.(
      new Blob(),
      new AbortController().signal,
    );
    finishInterrupt();

    await expect(transcription).resolves.toBe("");
    expect(onCaptureCancelled).toHaveBeenCalledOnce();
  });

  it("releases a browser fallback barge-in with no final command", async () => {
    let finishInterrupt!: () => void;
    const interruptFinished = new Promise<void>((resolve) => {
      finishInterrupt = resolve;
    });
    const onCaptureCancelled = vi.fn();
    createController({
      phase: "speaking",
      onCaptureCancelled,
      onInterrupt: () => interruptFinished,
    });
    harness.effects[0]?.();

    expect(harness.listenerInput?.onSpeechStart?.()).toBe(true);
    harness.listenerInput?.onNoCommand?.();
    finishInterrupt();

    await vi.waitFor(() => expect(onCaptureCancelled).toHaveBeenCalledOnce());
  });
  it("does not submit a pending command after microphone shutdown", async () => {
    let finishInterrupt!: () => void;
    const interruptFinished = new Promise<void>((resolve) => {
      finishInterrupt = resolve;
    });
    const onTranscript = vi.fn(async () => undefined);
    const controller = createController({
      phase: "speaking",
      onInterrupt: () => interruptFinished,
      onTranscript,
    });
    harness.effects[0]?.();

    expect(harness.listenerInput?.onSpeechStart?.()).toBe(true);
    const command = Promise.resolve(harness.listenerInput?.onCommand("do not send"));
    controller.micOff();
    finishInterrupt();
    await command;

    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("keeps the recognized command visible until submission finishes", async () => {
    let finishSubmission!: () => void;
    const submissionFinished = new Promise<void>((resolve) => {
      finishSubmission = resolve;
    });
    createController({
      onTranscript: () => submissionFinished,
    });
    harness.effects[0]?.();

    const command = Promise.resolve(harness.listenerInput?.onCommand("show this caption"));
    await Promise.resolve();

    expect(harness.stateSetters[2]).toHaveBeenCalledWith("show this caption");
    finishSubmission();
    await command;
    expect(harness.stateSetters[2]).toHaveBeenLastCalledWith("");
  });

  it("releases microphone resources on lifecycle cleanup", () => {
    createController();
    const cleanup = harness.effects[0]?.();

    cleanup?.();

    expect(harness.listener.stop).toHaveBeenCalledOnce();
  });

  it("blocks phantom mic activation and exposes an explicit browser fallback", () => {
    harness.browserSupported = true;
    const controller = createController({ httpBaseUrl: null });

    expect(controller.listenerState).toBe("blocked");
    expect(controller.canTurnMicOn).toBe(false);
    expect(controller.canEnableBrowserFallback).toBe(true);

    controller.micOn();
    expect(harness.stateSetters[0]).not.toHaveBeenCalledWith(true);

    controller.enableBrowserFallback();
    expect(harness.stateSetters[1]).toHaveBeenCalledWith(true);
    expect(harness.stateSetters[0]).toHaveBeenCalledWith(true);
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

  it("pauses capture while waiting so ambient audio cannot submit another turn", () => {
    createController({ phase: "waiting" });
    harness.effects[0]?.();
    harness.effects[1]?.();

    expect(harness.listener.pause).toHaveBeenCalledOnce();
    expect(harness.listener.resume).not.toHaveBeenCalled();
  });
  it("keeps capture live during Mai playback so sustained speech can barge in", () => {
    createController({ phase: "speaking" });
    harness.effects[0]?.();
    harness.effects[1]?.();

    expect(harness.listener.resume).toHaveBeenCalledOnce();
    expect(harness.listener.pause).not.toHaveBeenCalled();
  });
  it("does not start capture while the route is disabled", () => {
    createController({ disabled: true });

    harness.effects[0]?.();

    expect(harness.listener.start).not.toHaveBeenCalled();
    expect(harness.listenerInput).toBeNull();
  });

  it("offers browser fallback only after local capture becomes unavailable", () => {
    harness.browserSupported = true;
    const controller = createController();

    controller.micOff();

    expect(controller.canEnableBrowserFallback).toBe(false);
  });

  it("recovers pending local capture when its gateway connects", () => {
    expect(
      shouldRecoverLocalVoiceGateway({
        pending: true,
        httpBaseUrl: "http://localhost",
        captureMode: "local-audio",
      }),
    ).toBe(true);
    expect(
      shouldRecoverLocalVoiceGateway({
        pending: false,
        httpBaseUrl: "http://localhost",
        captureMode: "local-audio",
      }),
    ).toBe(false);
  });
});
