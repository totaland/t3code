import { Children, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ListenerInput = {
  readonly onCommand: (transcript: string) => void | Promise<void>;
  readonly onSpeechStart?: () => boolean | void;
  readonly onTranscribe?: (wav: Blob) => Promise<string>;
};

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  enabledState: true,
  listenerInput: null as ListenerInput | null,
  listenerState: "awake",
  listener: {
    pause: vi.fn(),
    resume: vi.fn(),
    sleep: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    unlock: vi.fn(),
  },
  stateIndex: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      harness.effects.push(effect);
    }),
    useRef: <T,>(value: T) => ({ current: value }),
    useState: vi.fn(() => {
      const stateValues = [
        harness.enabledState,
        "Thank you.",
        false,
        harness.listenerState,
      ] as const;
      return [stateValues[harness.stateIndex++], vi.fn()];
    }),
  };
});

vi.mock("../../voice/voiceClient", () => ({
  transcribeVoiceWav: vi.fn(async () => ""),
}));
vi.mock("../../voice/voiceWakePhrase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../voice/voiceWakePhrase")>();
  return { ...actual, getVoiceWakePhraseMode: () => "local-audio" };
});

vi.mock("../../voice/voiceWakePhraseAudio", () => ({
  createLocalAudioWakePhraseListener: vi.fn((input: ListenerInput) => {
    harness.listenerInput = input;
    return harness.listener;
  }),
}));

import {
  ComposerVoiceWakePhraseButton,
  type VoiceTurnPhase,
} from "./ComposerVoiceWakePhraseButton";

type TriggerElement = ReactElement<{
  readonly children: ReactNode;
  readonly render: ReactElement<{
    readonly onClick: () => void;
    readonly size: string;
  }>;
}>;

type RenderCallbacks = {
  readonly onCaptureCancelled?: () => void;
  readonly onInterrupt?: () => void | Promise<void>;
  readonly onPlaybackUnlock?: () => Promise<unknown>;
  readonly onTranscript?: (transcript: string) => Promise<void>;
};

function renderButton(phase: VoiceTurnPhase = "idle", callbacks: RenderCallbacks = {}) {
  return ComposerVoiceWakePhraseButton({
    httpBaseUrl: "http://localhost",
    onCaptureCancelled: callbacks.onCaptureCancelled ?? vi.fn(),
    onInterrupt: callbacks.onInterrupt ?? vi.fn(),
    onPlaybackUnlock: callbacks.onPlaybackUnlock ?? vi.fn(async () => undefined),
    onTranscript: callbacks.onTranscript ?? vi.fn(async () => undefined),
    phase,
  }) as ReactElement<{ readonly children: ReactNode }>;
}

describe("ComposerVoiceWakePhraseButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.effects.length = 0;
    harness.enabledState = true;
    harness.listenerInput = null;
    harness.listenerState = "awake";
    harness.stateIndex = 0;
  });

  it("keeps recognized chat text out of the wake button", () => {
    const tree = renderButton();
    const trigger = Children.toArray(tree.props.children)[0] as TriggerElement;

    expect(trigger.props.render.props.size).toBe("icon-sm");
    expect(Children.toArray(trigger.props.children)).toHaveLength(1);
  });

  it("keeps wake capture active while a voice reply is pending", () => {
    renderButton("waiting");

    harness.effects[1]?.();
    harness.effects[2]?.();

    expect(harness.listener.start).toHaveBeenCalledOnce();
    expect(harness.listener.resume).toHaveBeenCalledOnce();
    expect(harness.listener.pause).not.toHaveBeenCalled();
  });

  it("stops the current reply on speech start before submitting the new command", async () => {
    let finishInterrupt!: () => void;
    const interruptFinished = new Promise<void>((resolve) => {
      finishInterrupt = resolve;
    });
    const onInterrupt = vi.fn(() => interruptFinished);
    const onTranscript = vi.fn(async () => undefined);
    renderButton("speaking", { onInterrupt, onTranscript });

    harness.effects[1]?.();
    harness.effects[2]?.();
    const discardTriggerChunk = harness.listenerInput?.onSpeechStart?.();

    expect(discardTriggerChunk).toBe(true);

    expect(onInterrupt).toHaveBeenCalledOnce();
    const submission = Promise.resolve(harness.listenerInput?.onCommand("change direction"));
    expect(onTranscript).not.toHaveBeenCalled();

    finishInterrupt();
    await submission;

    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("change direction");
  });

  it("releases a preserved barge-in when local transcription returns no command", async () => {
    let finishInterrupt!: () => void;
    const interruptFinished = new Promise<void>((resolve) => {
      finishInterrupt = resolve;
    });
    const onCaptureCancelled = vi.fn();
    renderButton("speaking", {
      onCaptureCancelled,
      onInterrupt: vi.fn(() => interruptFinished),
    });

    harness.effects[1]?.();
    harness.effects[2]?.();
    harness.listenerInput?.onSpeechStart?.();
    const transcription = Promise.resolve(
      harness.listenerInput?.onTranscribe?.(new Blob(["silence"])),
    );

    expect(onCaptureCancelled).not.toHaveBeenCalled();
    finishInterrupt();
    await transcription;

    expect(onCaptureCancelled).toHaveBeenCalledOnce();
  });
  it("primes reply playback when the wave control is enabled", () => {
    harness.enabledState = false;
    harness.listenerState = "off";
    const onPlaybackUnlock = vi.fn(async () => undefined);
    const tree = renderButton("idle", { onPlaybackUnlock });
    const trigger = Children.toArray(tree.props.children)[0] as TriggerElement;

    trigger.props.render.props.onClick();

    expect(onPlaybackUnlock).toHaveBeenCalledOnce();
  });
});
