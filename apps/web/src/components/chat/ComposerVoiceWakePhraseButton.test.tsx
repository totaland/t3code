import { Children, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerVoiceWakePhraseButton } from "./ComposerVoiceWakePhraseButton";

type TriggerElement = ReactElement<{
  readonly render: ReactElement<{
    readonly disabled?: boolean;
    readonly onClick: () => void;
    readonly "aria-label": string;
  }>;
}>;

function triggerFor(props?: {
  readonly disabled?: boolean;
  readonly onEnterVoice?: () => void;
  readonly onPlaybackUnlock?: () => Promise<unknown>;
}) {
  const tree = ComposerVoiceWakePhraseButton({
    ...(props?.disabled === undefined ? {} : { disabled: props.disabled }),
    onEnterVoice: props?.onEnterVoice ?? vi.fn(),
    onPlaybackUnlock: props?.onPlaybackUnlock ?? vi.fn(async () => undefined),
  }) as ReactElement<{ readonly children: ReactNode }>;
  return Children.toArray(tree.props.children)[0] as TriggerElement;
}

describe("ComposerVoiceWakePhraseButton", () => {
  it("uses the waveform gesture to prime audio before entering voice", () => {
    const order: string[] = [];
    const trigger = triggerFor({
      onPlaybackUnlock: vi.fn(async () => {
        order.push("prime");
      }),
      onEnterVoice: vi.fn(() => {
        order.push("navigate");
      }),
    });

    trigger.props.render.props.onClick();

    expect(order).toEqual(["prime", "navigate"]);
    expect(trigger.props.render.props["aria-label"]).toBe("Open voice conversation");
  });

  it("does not start capture on the text-chat page", () => {
    const onEnterVoice = vi.fn();
    const trigger = triggerFor({ onEnterVoice });

    trigger.props.render.props.onClick();

    expect(onEnterVoice).toHaveBeenCalledOnce();
  });

  it("disables voice entry when the current conversation cannot start voice", () => {
    const trigger = triggerFor({ disabled: true });

    expect(trigger.props.render.props.disabled).toBe(true);
    expect(trigger.props.render.props["aria-label"]).toBe("Voice conversation unavailable");
  });
});
