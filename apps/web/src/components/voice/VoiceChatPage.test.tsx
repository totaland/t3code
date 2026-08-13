import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  focus: vi.fn(),
  useVoiceSessionController: vi.fn(() => ({
    canEnableBrowserFallback: false,
    canTurnMicOn: true,
    captureMode: "local-audio" as const,
    enableBrowserFallback: vi.fn(),
    enabled: false,
    listenerState: "off" as const,
    liveTranscript: "",
    micOff: vi.fn(),
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

describe("VoiceChatPage", () => {
  it("focuses the page and forwards capture suspension state", () => {
    const fetchImplementation = vi.fn(async () => Response.json({}));
    VoiceChatPage({
      disabled: true,
      fetchImplementation,
      httpBaseUrl: "http://localhost",
      messages: [],
      onCaptureCancelled: vi.fn(),
      onInterrupt: vi.fn(),
      onPlaybackUnlock: vi.fn(),
      onReturnToText: vi.fn(),
      onTranscript: vi.fn(),
      phase: "idle",
      projectTitle: null,
      threadTitle: "Thread",
    });

    expect(harness.focus).toHaveBeenCalledOnce();
    expect(harness.useVoiceSessionController).toHaveBeenCalledWith(
      expect.objectContaining({ disabled: true, fetchImplementation }),
    );
  });
});
