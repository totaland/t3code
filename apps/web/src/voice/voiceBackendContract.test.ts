import { describe, expect, it } from "vitest";

import {
  normalizeAssistantTextForSpeech,
  synthesizeVoiceReply,
  type VoiceFetch,
} from "./voiceClient";
import { getVoiceSynthesisSettings, voiceBackendOptions } from "./voiceSettings";

describe("backend-voice browser contract", () => {
  it("exposes only backend-voice synthesis backends and defaults to auto", () => {
    expect(voiceBackendOptions.map((option) => option.value)).toEqual([
      "auto",
      "qwen3",
      "kokoro",
      "step_audio_editx",
    ]);
    expect(voiceBackendOptions.at(-1)?.label).toBe("Step-Audio-EditX");
    expect(getVoiceSynthesisSettings()).toEqual({ backend: "auto" });
  });

  it("sends the exact model gateway synthesis shape", async () => {
    let request: RequestInit | undefined;
    const fetchImplementation: VoiceFetch = async (_input, init) => {
      request = init;
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "content-type": "audio/wav" },
      });
    };

    await synthesizeVoiceReply({
      httpBaseUrl: "http://localhost:3773",
      text: "reply",
      fetchImplementation,
    });

    expect(JSON.parse(String(request?.body))).toEqual({ text: "reply", backend: "auto" });
  });

  it("bounds text to backend-voice 1500-character limit", () => {
    expect(normalizeAssistantTextForSpeech("a".repeat(2_000))).toHaveLength(1_500);
  });
});
