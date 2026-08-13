import { describe, expect, it } from "vite-plus/test";
import {
  completedAssistantTextForVoiceTurn,
  normalizeAssistantTextForSpeech,
  resolveVoiceTurnResponse,
  synthesizeVoiceReplyStream,
  transcribeVoiceWav,
  type VoiceFetch,
} from "./voiceClient";

describe("local voice client", () => {
  it("posts WAV to the selected environment through its fetch boundary", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImplementation: VoiceFetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ text: "hello agent" });
    };
    const wav = new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" });

    await expect(
      transcribeVoiceWav({
        httpBaseUrl: "http://127.0.0.1:3773",
        wav,
        fetchImplementation,
      }),
    ).resolves.toBe("hello agent");
    expect(requests[0]?.url).toBe("http://127.0.0.1:3773/api/voice/transcribe");
    expect(requests[0]?.init?.credentials).toBeUndefined();
    expect(requests[0]?.init?.body).toBe(wav);
    expect(new Headers(requests[0]?.init?.headers).get("x-tts-backend")).toBe("auto");
  });

  it("rejects invalid streaming audio metadata", async () => {
    const invalidFetch: VoiceFetch = async () => new Response("bad");

    await expect(
      synthesizeVoiceReplyStream({
        httpBaseUrl: "http://localhost:3773",
        text: "reply",
        fetchImplementation: invalidFetch,
      }),
    ).rejects.toThrow("invalid PCM stream");
  });

  it("turns assistant markdown into bounded speakable text", () => {
    expect(
      normalizeAssistantTextForSpeech(
        "# Result\nUse **the button**. [Docs](https://example.com)\n```ts\ncode();\n```",
      ),
    ).toBe("Result Use the button . Docs Code block omitted.");
  });
});

describe("voice turn correlation", () => {
  it("returns only a completed assistant reply from the captured user turn", () => {
    const messages = [
      { id: "old-user", role: "user", text: "old", turnId: "turn-old", streaming: false },
      {
        id: "old-assistant",
        role: "assistant",
        text: "Do not speak this",
        turnId: "turn-old",
        streaming: false,
      },
      { id: "voice-user", role: "user", text: "hello", turnId: null, streaming: false },
      {
        id: "voice-stream",
        role: "assistant",
        text: "partial",
        turnId: "turn-voice",
        streaming: true,
      },
    ];

    expect(completedAssistantTextForVoiceTurn(messages, "voice-user")).toBeNull();
    expect(resolveVoiceTurnResponse(messages, "voice-user", false)).toEqual({ status: "pending" });
    expect(resolveVoiceTurnResponse(messages, "voice-user", true)).toEqual({ status: "empty" });

    const readyMessages = [
      ...messages,
      {
        id: "voice-assistant-ready",
        role: "assistant",
        text: "Speak this reply",
        turnId: "turn-voice",
        streaming: false,
      },
    ];
    expect(completedAssistantTextForVoiceTurn(readyMessages, "voice-user")).toBe(
      "Speak this reply",
    );
    expect(resolveVoiceTurnResponse(readyMessages, "voice-user", false)).toEqual({
      status: "ready",
      messageId: "voice-assistant-ready",
      text: "Speak this reply",
    });
  });

  it("stops response correlation at the next user turn", () => {
    const messages = [
      { id: "voice-user", role: "user", text: "hello", turnId: null, streaming: false },
      {
        id: "voice-assistant",
        role: "assistant",
        text: "Speak only this reply",
        turnId: "turn-voice",
        streaming: false,
      },
      { id: "next-user", role: "user", text: "follow-up", turnId: null, streaming: false },
      {
        id: "next-assistant",
        role: "assistant",
        text: "Do not speak this yet",
        turnId: "turn-next",
        streaming: false,
      },
    ];

    expect(completedAssistantTextForVoiceTurn(messages, "voice-user")).toBe(
      "Speak only this reply",
    );
    expect(resolveVoiceTurnResponse(messages, "voice-user", false)).toEqual({
      status: "ready",
      messageId: "voice-assistant",
      text: "Speak only this reply",
    });
    expect(
      resolveVoiceTurnResponse(messages, "voice-user", false, new Set(["voice-assistant"])),
    ).toEqual({ status: "pending" });
  });
  it("queues every completed assistant message once in source order", () => {
    const messages = [
      { id: "voice-user", role: "user", text: "hello", turnId: null, streaming: false },
      {
        id: "progress",
        role: "assistant",
        text: "I am checking that now.",
        turnId: "turn-voice",
        streaming: false,
      },
      {
        id: "final",
        role: "assistant",
        text: "The fix is complete.",
        turnId: "turn-voice",
        streaming: false,
      },
    ];
    const spoken = new Set<string>();

    const first = resolveVoiceTurnResponse(messages, "voice-user", false, spoken);
    expect(first).toEqual({
      status: "ready",
      messageId: "progress",
      text: "I am checking that now.",
    });
    if (first.status === "ready") spoken.add(first.messageId);

    const second = resolveVoiceTurnResponse(messages, "voice-user", false, spoken);
    expect(second).toEqual({
      status: "ready",
      messageId: "final",
      text: "The fix is complete.",
    });
    if (second.status === "ready") spoken.add(second.messageId);

    expect(resolveVoiceTurnResponse(messages, "voice-user", false, spoken)).toEqual({
      status: "pending",
    });
    expect(resolveVoiceTurnResponse(messages, "voice-user", true, spoken)).toEqual({
      status: "empty",
    });
  });

  it("splits a long completed reply into synthesizable chunks", () => {
    const text = `${"A long story sentence. ".repeat(80)}the ending.`;
    const messages = [
      { id: "voice-user", role: "user", text: "tell me a story", turnId: null, streaming: false },
      { id: "story", role: "assistant", text, turnId: "turn-voice", streaming: false },
    ];
    const spoken = new Map<string, number>();

    const first = resolveVoiceTurnResponse(messages, "voice-user", false, spoken);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.text.length).toBeLessThanOrEqual(500);
    spoken.set(first.messageId, first.text.length);

    const second = resolveVoiceTurnResponse(messages, "voice-user", false, spoken);
    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(second.text.length).toBeLessThanOrEqual(500);
    expect(first.text + second.text).toBe(text.slice(0, first.text.length + second.text.length));
  });
});
