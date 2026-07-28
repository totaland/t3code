import { describe, expect, it } from "vitest";
import { resolveVoiceTurnResponse, type VoiceTurnMessage } from "./voiceClient";

describe("streaming voice replies", () => {
  it("speaks completed sentences before the assistant message finishes", () => {
    const progress = new Map<string, number>();
    const messages: VoiceTurnMessage[] = [
      { id: "user", role: "user", text: "hello", turnId: null, streaming: false },
      {
        id: "assistant",
        role: "assistant",
        text: "First sentence. Second still streaming",
        turnId: "turn",
        streaming: true,
      },
    ];

    const first = resolveVoiceTurnResponse(messages, "user", false, progress);
    expect(first).toEqual({
      status: "ready",
      messageId: "assistant",
      text: "First sentence. ",
    });
    if (first.status === "ready") progress.set(first.messageId, first.text.length);

    expect(resolveVoiceTurnResponse(messages, "user", false, progress)).toEqual({
      status: "pending",
    });

    messages[1] = { ...messages[1]!, streaming: false };
    const final = resolveVoiceTurnResponse(messages, "user", true, progress);
    expect(final).toEqual({
      status: "ready",
      messageId: "assistant",
      text: "Second still streaming",
    });
  });

  it("waits while a streaming fragment has no complete sentence", () => {
    const messages: VoiceTurnMessage[] = [
      { id: "user", role: "user", text: "hello", turnId: null, streaming: false },
      {
        id: "assistant",
        role: "assistant",
        text: "Still composing this sentence",
        turnId: "turn",
        streaming: true,
      },
    ];

    expect(resolveVoiceTurnResponse(messages, "user", false, new Map())).toEqual({
      status: "pending",
    });
  });
});
