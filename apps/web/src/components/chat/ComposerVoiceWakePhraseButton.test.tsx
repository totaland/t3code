import { Children, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
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
  const stateValues = [true, "Thank you.", false, "awake"] as const;
  return {
    ...actual,
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      harness.effects.push(effect);
    }),
    useRef: <T,>(value: T) => ({ current: value }),
    useState: vi.fn(() => [stateValues[harness.stateIndex++], vi.fn()]),
    useSyncExternalStore: vi.fn(() => "idle"),
  };
});

vi.mock("../../voice/voiceWakePhrase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../voice/voiceWakePhrase")>();
  return { ...actual, getVoiceWakePhraseMode: () => "local-audio" };
});

vi.mock("../../voice/voiceWakePhraseAudio", () => ({
  createLocalAudioWakePhraseListener: vi.fn(() => harness.listener),
}));

import { ComposerVoiceWakePhraseButton } from "./ComposerVoiceWakePhraseButton";

type TriggerElement = ReactElement<{
  readonly children: ReactNode;
  readonly render: ReactElement<{ readonly size: string }>;
}>;

function renderButton(phase: "idle" | "waiting" = "idle") {
  return ComposerVoiceWakePhraseButton({
    httpBaseUrl: "http://localhost",
    onInterrupt: vi.fn(),
    onTranscript: vi.fn(async () => undefined),
    phase,
  }) as ReactElement<{ readonly children: ReactNode }>;
}

describe("ComposerVoiceWakePhraseButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.effects.length = 0;
    harness.stateIndex = 0;
  });

  it("keeps recognized chat text out of the wake button", () => {
    const tree = renderButton();
    const trigger = Children.toArray(tree.props.children)[0] as TriggerElement;

    expect(trigger.props.render.props.size).toBe("icon-sm");
    expect(Children.toArray(trigger.props.children)).toHaveLength(1);
  });

  it("pauses wake capture while a voice reply is pending", () => {
    renderButton("waiting");

    harness.effects[1]?.();
    harness.effects[2]?.();

    expect(harness.listener.start).toHaveBeenCalledOnce();
    expect(harness.listener.pause).toHaveBeenCalledOnce();
    expect(harness.listener.resume).not.toHaveBeenCalled();
  });
});
