import { describe, expect, it } from "vitest";
import {
  fetchModelGateway,
  isSupportedVoiceBackend,
  requestTranscription,
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

  it("forwards the selected reply backend with transcription", async () => {
    const gateway = resolveModelGatewayConfig({
      modelGatewayUrl: "http://localhost:8091",
      modelGatewayApiKey: "local-test-key-123456",
    });
    expect(gateway).not.toBeNull();
    const requests: Array<{ input: URL; init: RequestInit | undefined }> = [];
    const fetchImplementation = async (input: URL, init?: RequestInit) => {
      requests.push({ input, init });
      return Response.json({ text: "hello" });
    };

    await requestTranscription(
      gateway!,
      new Uint8Array([82, 73, 70, 70]),
      "step_audio_editx",
      fetchImplementation,
    );

    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("x-tts-backend")).toBe("step_audio_editx");
    expect(headers.get("authorization")).toBe("Bearer local-test-key-123456");
  });
});

describe("backend-voice backend IDs", () => {
  it("accepts Step-Audio-EditX without reviving retired engine IDs", () => {
    expect(isSupportedVoiceBackend("step_audio_editx")).toBe(true);
    expect(isSupportedVoiceBackend("qwen_voice_clone")).toBe(false);
    expect(isSupportedVoiceBackend("step_audio")).toBe(false);
  });
});
