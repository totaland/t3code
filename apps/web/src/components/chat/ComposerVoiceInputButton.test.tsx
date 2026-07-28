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

import { ComposerVoiceInputButton } from "./ComposerVoiceInputButton";

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
