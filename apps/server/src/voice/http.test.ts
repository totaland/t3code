import { describe, expect, it } from "vitest";
import { fetchVoiceService, resolveVoiceServiceConfig } from "./http.ts";

describe("local voice service proxy", () => {
  it("accepts only authenticated loopback HTTP services", () => {
    const valid = resolveVoiceServiceConfig({
      voiceServiceUrl: "http://127.0.0.1:8090",
      voiceServiceApiKey: "local-test-key-123456",
    });
    expect(valid?.baseUrl.toString()).toBe("http://127.0.0.1:8090/");
    expect(
      resolveVoiceServiceConfig({
        voiceServiceUrl: "https://voice.example.com",
        voiceServiceApiKey: "local-test-key-123456",
      }),
    ).toBeNull();
    expect(
      resolveVoiceServiceConfig({
        voiceServiceUrl: "http://127.0.0.1:8090",
        voiceServiceApiKey: undefined,
      }),
    ).toBeNull();
    expect(
      resolveVoiceServiceConfig({
        voiceServiceUrl: "http://user:pass@127.0.0.1:8090",
        voiceServiceApiKey: "local-test-key-123456",
      }),
    ).toBeNull();
  });

  it("keeps the service key server-side and sends exact WAV bytes", async () => {
    const service = resolveVoiceServiceConfig({
      voiceServiceUrl: "http://localhost:8090",
      voiceServiceApiKey: "local-test-key-123456",
    });
    expect(service).not.toBeNull();
    const wav = new Uint8Array([82, 73, 70, 70]);
    const requests: Array<{ input: URL; init: RequestInit | undefined }> = [];
    const fetchImplementation = async (input: URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response("ok");
    };

    await fetchVoiceService(
      service!,
      "/v1/speech/transcribe",
      { method: "POST", body: wav },
      fetchImplementation,
    );

    const request = requests[0]!;
    expect(String(request.input)).toBe("http://localhost:8090/v1/speech/transcribe");
    expect(new Headers(request.init?.headers).get("x-api-key")).toBe("local-test-key-123456");
    expect(request.init?.body).toBe(wav);
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
