import { describe, expect, it } from "vitest";
import { decodePcm16Le, readPcm16Chunks } from "./voicePcmStream";

describe("PCM16 streaming", () => {
  it("preserves samples split across odd network chunk boundaries", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5, 6, 7]));
        controller.close();
      },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of readPcm16Chunks(body, 2)) chunks.push(chunk);

    expect(chunks).toEqual([new Uint8Array([0, 1]), new Uint8Array([2, 3, 4, 5, 6, 7])]);
  });

  it("decodes little-endian PCM16 into normalized float samples", () => {
    expect(Array.from(decodePcm16Le(new Uint8Array([0, 128, 0, 0, 255, 127])))).toEqual([
      -1,
      0,
      32_767 / 32_768,
    ]);
  });
});
