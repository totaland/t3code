import { describe, expect, it } from "vitest";
import {
  encodePcm16Wav,
  fetchModelGateway,
  isSupportedVoiceBackend,
  resolveModelGatewayConfig,
} from "./http.ts";

describe("backend-voice model gateway proxy", () => {
  it("accepts only authenticated loopback HTTP gateways", () => {
    const valid = resolveModelGatewayConfig({
      modelGatewayUrl: "http://127.0.0.1:8091",
      modelGatewayApiKey: "local-test-key-123456",
    });
    expect(valid?.baseUrl.toString()).toBe("http://127.0.0.1:8091/");
    expect(
      resolveModelGatewayConfig({
        modelGatewayUrl: "https://voice.example.com",
        modelGatewayApiKey: "local-test-key-123456",
      }),
    ).toBeNull();
    expect(
      resolveModelGatewayConfig({
        modelGatewayUrl: "http://127.0.0.1:8091",
        modelGatewayApiKey: undefined,
      }),
    ).toBeNull();
    expect(
      resolveModelGatewayConfig({
        modelGatewayUrl: "http://user:pass@127.0.0.1:8091",
        modelGatewayApiKey: "local-test-key-123456",
      }),
    ).toBeNull();
  });

  it("keeps the gateway token server-side and sends exact WAV bytes", async () => {
    const gateway = resolveModelGatewayConfig({
      modelGatewayUrl: "http://localhost:8091",
      modelGatewayApiKey: "local-test-key-123456",
    });
    expect(gateway).not.toBeNull();
    const wav = new Uint8Array([82, 73, 70, 70]);
    const requests: Array<{ input: URL; init: RequestInit | undefined }> = [];
    const fetchImplementation = async (input: URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response("ok");
    };

    await fetchModelGateway(
      gateway!,
      "/v1/stt",
      { method: "POST", body: wav },
      fetchImplementation,
    );

    const request = requests[0]!;
    expect(String(request.input)).toBe("http://localhost:8091/v1/stt");
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer local-test-key-123456");
    expect(headers.get("x-api-key")).toBeNull();
    expect(request.init?.body).toBe(wav);
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("wraps little-endian mono PCM16 in a browser-decodable WAV", () => {
    const pcm = new Uint8Array([0, 0, 1, 0, 255, 127, 0, 128]);
    const wav = encodePcm16Wav(pcm, 24_000, 1);
    expect(wav).not.toBeNull();
    const view = new DataView(wav!.buffer, wav!.byteOffset, wav!.byteLength);
    expect(new TextDecoder().decode(wav!.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav!.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(wav!.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(wav!.slice(44)).toEqual(pcm);
    expect(encodePcm16Wav(new Uint8Array([0]), 24_000, 1)).toBeNull();
    expect(encodePcm16Wav(pcm, 0, 1)).toBeNull();
    expect(encodePcm16Wav(pcm, 24_000, 2)).toBeNull();
  });
});

describe("backend-voice backend IDs", () => {
  it("accepts Step-Audio-EditX without reviving retired engine IDs", () => {
    expect(isSupportedVoiceBackend("step_audio_editx")).toBe(true);
    expect(isSupportedVoiceBackend("qwen_voice_clone")).toBe(false);
    expect(isSupportedVoiceBackend("step_audio")).toBe(false);
  });
});
