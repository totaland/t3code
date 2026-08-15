import { describe, expect, it } from "vite-plus/test";
import { synthesizeVoiceReplyStream, type VoiceFetch } from "./voiceClient";

describe("streaming voice client", () => {
  it("returns the PCM body without buffering it into a WAV blob", async () => {
    const pcm = new Uint8Array([0, 0, 255, 127]);
    const fetchImplementation: VoiceFetch = async () =>
      new Response(pcm, {
        headers: {
          "content-type": "audio/L16",
          "x-audio-channels": "1",
          "x-audio-sample-rate": "24000",
        },
      });

    const audio = await synthesizeVoiceReplyStream({
      httpBaseUrl: "http://localhost:3773",
      text: "reply",
      fetchImplementation,
    });

    expect(audio).toMatchObject({ channels: 1, sampleRate: 24_000 });
    const chunk = await audio.body.getReader().read();
    expect(chunk.value).toEqual(pcm);
  });
});
