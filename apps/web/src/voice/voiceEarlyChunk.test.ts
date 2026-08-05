import { describe, expect, it } from "vitest";
import { nextAssistantSpeechChunkForVoiceTurn } from "./voiceClient";

const userMessage = {
  id: "voice-user",
  role: "user" as const,
  text: "hello",
  turnId: null,
  streaming: false,
};

describe("early streaming voice chunks", () => {
  it("releases a coherent whole-word phrase without waiting for punctuation", () => {
    const messages = [
      userMessage,
      {
        id: "assistant",
        role: "assistant" as const,
        text: "This response now has enough words still streaming",
        turnId: "turn-voice",
        streaming: true,
      },
    ];

    expect(nextAssistantSpeechChunkForVoiceTurn(messages, "voice-user", new Map())).toEqual({
      messageId: "assistant",
      text: "This response now has enough ",
    });
  });

  it("waits when the phrase is too short or the last word is incomplete", () => {
    const shortMessages = [
      userMessage,
      {
        id: "assistant",
        role: "assistant" as const,
        text: "I am in a big hurry",
        turnId: "turn-voice",
        streaming: true,
      },
    ];
    const incompleteMessages = [
      userMessage,
      {
        id: "assistant",
        role: "assistant" as const,
        text: "This response now has enough",
        turnId: "turn-voice",
        streaming: true,
      },
    ];

    expect(nextAssistantSpeechChunkForVoiceTurn(shortMessages, "voice-user", new Map())).toBeNull();
    expect(
      nextAssistantSpeechChunkForVoiceTurn(incompleteMessages, "voice-user", new Map()),
    ).toBeNull();
  });
});
