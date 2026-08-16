import { Children, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { enterVoiceThread } from "../../voice/voiceThreadRoutes";
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

it("keeps the primed context retained until playback unlock settles", async () => {
  let finishPlaybackUnlock!: () => void;
  const onEnterVoice = vi.fn();
  const trigger = triggerFor({
    onEnterVoice,
    onPlaybackUnlock: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPlaybackUnlock = resolve;
        }),
    ),
  });

  trigger.props.render.props.onClick();

  expect(onEnterVoice).not.toHaveBeenCalled();
  finishPlaybackUnlock();
  await Promise.resolve();

  expect(onEnterVoice).toHaveBeenCalledOnce();
});

describe("ComposerVoiceWakePhraseButton", () => {
  it("uses the waveform gesture to prime audio before navigating to the exact voice thread", async () => {
    const order: string[] = [];
    const navigate = vi.fn();
    const trigger = triggerFor({
      onPlaybackUnlock: vi.fn(async () => {
        order.push("prime");
      }),
      onEnterVoice: vi.fn(() => {
        order.push("navigate");
        enterVoiceThread(navigate, "env-one", "thread-two");
      }),
    });

    trigger.props.render.props.onClick();
    await Promise.resolve();

    expect(order).toEqual(["prime", "navigate"]);
    expect(navigate).toHaveBeenCalledWith({
      to: "/voice/$environmentId/$threadId",
      params: { environmentId: "env-one", threadId: "thread-two" },
    });
    expect(trigger.props.render.props["aria-label"]).toBe("Open voice conversation");
  });

  it("does not start capture on the text-chat page", async () => {
    const onEnterVoice = vi.fn();
    const trigger = triggerFor({ onEnterVoice });

    trigger.props.render.props.onClick();
    await Promise.resolve();

    expect(onEnterVoice).toHaveBeenCalledOnce();
  });

  it("disables voice entry when the current conversation cannot start voice", () => {
    const trigger = triggerFor({ disabled: true });

    expect(trigger.props.render.props.disabled).toBe(true);
    expect(trigger.props.render.props["aria-label"]).toBe("Voice conversation unavailable");
  });
});
