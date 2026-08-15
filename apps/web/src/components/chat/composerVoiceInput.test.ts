import { describe, expect, it } from "vite-plus/test";
import { encodePcm16Wav } from "./composerVoiceInput";

describe("composer local voice capture", () => {
  it("encodes mono float samples as a valid PCM16 WAV", () => {
    const wav = encodePcm16Wav(
      [new Float32Array([-1, -0.5]), new Float32Array([0, 0.5, 1])],
      48_000,
    );
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(48, true)).toBe(0);
    expect(view.getInt16(52, true)).toBe(32_767);
  });

  it("encodes an empty capture as a header-only WAV", () => {
    const wav = encodePcm16Wav([], 44_100);
    expect(wav.byteLength).toBe(44);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
  });
});
