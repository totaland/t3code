import { describe, expect, it } from "vite-plus/test";
import { nextVoicePlaybackStartTime } from "./voicePlayback";

describe("nextVoicePlaybackStartTime", () => {
  it("keeps decoded clips on one continuous playback timeline", () => {
    const firstStart = nextVoicePlaybackStartTime({
      backend: "step_audio_editx",
      currentTime: 10,
      hasPendingPlayback: false,
      scheduledUntil: 0,
    });
    const secondStart = nextVoicePlaybackStartTime({
      backend: "step_audio_editx",
      currentTime: 10.5,
      hasPendingPlayback: true,
      scheduledUntil: firstStart + 2,
    });

    expect(firstStart).toBeCloseTo(11.1);
    expect(secondStart).toBeCloseTo(13.1);
  });

  it("starts a late clip promptly instead of scheduling it in the past", () => {
    expect(
      nextVoicePlaybackStartTime({
        backend: "qwen3",
        currentTime: 4,
        hasPendingPlayback: true,
        scheduledUntil: 3,
      }),
    ).toBeCloseTo(4.025);
  });
});
