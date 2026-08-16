import { MessageId } from "@t3tools/contracts";
import { Children, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  focus: vi.fn(),
  micOff: vi.fn(),
  useVoiceSessionController: vi.fn(() => ({
    canEnableBrowserFallback: false,
    canTurnMicOn: true,
    captureMode: "local-audio" as const,
    enableBrowserFallback: vi.fn(),
    enabled: false,
    listenerState: "off" as const,
    liveTranscript: "",
    micOff: harness.micOff,
    micOn: vi.fn(),
    sleeping: false,
    sleep: vi.fn(),
    statusText: "Microphone capture is fully stopped.",
    unlock: vi.fn(),
    unavailableReason: null,
  })),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void) => effect(),
    useRef: () => ({ current: { focus: harness.focus } }),
    useState: () => [false, vi.fn()],
  };
});

vi.mock("../../voice/useVoiceSessionController", () => ({
  isVoiceCapabilityUnavailable: () => false,
  useVoiceSessionController: harness.useVoiceSessionController,
}));

import { VoiceChatPage } from "./VoiceChatPage";

function findByLabel(
  node: ReactNode,
  label: string,
): ReactElement<{ onClick: (event: { stopPropagation: () => void }) => void }> | null {
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.props["aria-label"] === label) {
    return element as ReactElement<{
      onClick: (event: { stopPropagation: () => void }) => void;
    }>;
  }
  for (const child of Children.toArray(element.props.children as ReactNode)) {
    const match = findByLabel(child, label);
    if (match) return match;
  }
  return null;
}

function renderVoicePage(overrides: Partial<Parameters<typeof VoiceChatPage>[0]> = {}) {
  return VoiceChatPage({
    fetchImplementation: vi.fn(async () => Response.json({})),
    httpBaseUrl: "http://localhost",
    messages: [],
    onCaptureCancelled: vi.fn(),
    onInterrupt: vi.fn(),
    onPlaybackUnlock: vi.fn(),
    onReturnToText: vi.fn(),
    onTranscript: vi.fn(),
    phase: "idle",
    playbackNeedsInteraction: false,
    projectTitle: null,
    threadTitle: "Thread",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("offers a playback unlock when a direct voice route has no running audio context", () => {
  const tree = renderVoicePage({ playbackNeedsInteraction: true });
  const control = findByLabel(tree, "Enable Mai audio playback");

  expect(control).not.toBeNull();
  control?.props.onClick({ stopPropagation: vi.fn() });

  const session = harness.useVoiceSessionController.mock.results.at(-1)?.value;
  expect(session?.unlock).toHaveBeenCalledOnce();
});

describe("VoiceChatPage", () => {
  it("focuses the page and forwards capture suspension state", () => {
    const fetchImplementation = vi.fn(async () => Response.json({}));
    renderVoicePage({ disabled: true, fetchImplementation });

    expect(harness.focus).toHaveBeenCalledOnce();
    expect(harness.useVoiceSessionController).toHaveBeenCalledWith(
      expect.objectContaining({ disabled: true, fetchImplementation }),
    );
  });

  it.each(["Return to text conversation", "End voice and return to text conversation"])(
    "%s stops capture and requests text return",
    (label) => {
      harness.micOff.mockClear();
      const messages: Parameters<typeof VoiceChatPage>[0]["messages"] = [
        {
          id: MessageId.make("message-1"),
          role: "user",
          text: "Keep this history",
          turnId: null,
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
          streaming: false,
        },
      ];
      const onReturnToText = vi.fn();
      const tree = renderVoicePage({ messages, onReturnToText });
      const control = findByLabel(tree, label);

      expect(control).not.toBeNull();
      const stopPropagation = vi.fn();
      control?.props.onClick({ stopPropagation });

      expect(harness.micOff).toHaveBeenCalledOnce();
      expect(onReturnToText).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
    },
  );
});
