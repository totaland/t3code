import { Children, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: vi.fn(),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

import { ComposerVoiceInputButton, getCaptureState } from "./ComposerVoiceInputButton";

type ClickableElement = ReactElement<{ readonly onClick?: () => void }>;
type TriggerElement = ReactElement<{ readonly render: ClickableElement }>;

function renderVoiceButton(
  props: Parameters<typeof ComposerVoiceInputButton>[0],
): ClickableElement {
  const tree = ComposerVoiceInputButton(props) as ReactElement<{ readonly children: ReactNode }>;
  const trigger = Children.toArray(tree.props.children)[0] as TriggerElement;
  return trigger.props.render;
}

describe("ComposerVoiceInputButton", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps microphone capture armed when audio resume requires interaction", async () => {
    let handleTrackEnded: (() => void) | undefined;
    const stop = vi.fn();
    const track = {
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        handleTrackEnded = listener;
      }),
      removeEventListener: vi.fn(),
      stop,
    };
    const stream = {
      getTracks: () => [track],
    } as unknown as MediaStream;
    class FakeAudioContext {
      readonly state = "suspended";
      readonly sampleRate = 48_000;
      readonly destination = {};
      resume() {
        return Promise.reject(new DOMException("Interaction required", "NotAllowedError"));
      }
      close() {
        return Promise.resolve();
      }
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
      }
      createGain() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          gain: { value: 1 },
        };
      }
    }
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      userAgent: "Chrome",
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const button = renderVoiceButton({
      phase: "idle",
      onCapture: vi.fn(async () => {}),
      onPlaybackUnlock: vi.fn(async () => {}),
    });
    button.props.onClick?.();

    await vi.waitFor(() => expect(getCaptureState()).toBe("recording"));
    expect(stop).not.toHaveBeenCalled();

    handleTrackEnded?.();
    expect(getCaptureState()).toBe("idle");
  });

  it("starts microphone capture without unlocking reply playback first", () => {
    const order: string[] = [];
    const getUserMedia = vi.fn(() => {
      order.push("capture");
      return new Promise<MediaStream>(() => {});
    });
    class FakeAudioContext {
      readonly state = "running";
      constructor() {
        order.push("capture-context");
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const onPlaybackUnlock = vi.fn(() => Promise.resolve());

    const button = renderVoiceButton({
      phase: "idle",
      onCapture: vi.fn(async () => {}),
      onPlaybackUnlock,
    });

    button.props.onClick?.();

    expect(order).toEqual(["capture-context", "capture"]);
    expect(onPlaybackUnlock).not.toHaveBeenCalled();
  });
});
