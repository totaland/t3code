import { describe, expect, it } from "vitest";
import { createPcmStreamResponse, readPcmStreamMetadata } from "./http.ts";

describe("voice PCM stream proxy", () => {
  it("accepts only valid mono PCM16 stream metadata", () => {
    const response = new Response(new Uint8Array([0, 0]), {
      headers: {
        "content-type": "audio/L16",
        "x-audio-channels": "1",
        "x-audio-sample-rate": "24000",
      },
    });

    expect(readPcmStreamMetadata(response)).toEqual({ channels: 1, sampleRate: 24_000 });
    expect(readPcmStreamMetadata(new Response("bad"))).toBeNull();
  });

  it("uses an Effect stream body that the Node server can pipe", () => {
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const response = createPcmStreamResponse(upstreamBody, { channels: 1, sampleRate: 24_000 });

    expect(response.headers["content-type"]).toBe("audio/L16");
    expect(response.body._tag).toBe("Stream");
  });
});
