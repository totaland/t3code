import { describe, expect, it, vi } from "vite-plus/test";
import { enterVoiceThread, returnToTextThread } from "./voiceThreadRoutes";

describe("voice thread navigation", () => {
  it("navigates into voice with the exact environment and thread", () => {
    const navigate = vi.fn();

    enterVoiceThread(navigate, "env-one", "thread-two");

    expect(navigate).toHaveBeenCalledWith({
      to: "/voice/$environmentId/$threadId",
      params: { environmentId: "env-one", threadId: "thread-two" },
    });
  });

  it("returns to the exact text route without replacing conversation history", () => {
    const messages = [{ id: "message-1", role: "user", text: "Keep this history" }];
    const state = {
      environmentId: "env-one",
      threadId: "thread-two",
      messages,
      route: null as unknown,
    };
    const navigate = vi.fn((route) => {
      state.route = route;
    });

    returnToTextThread(navigate, state.environmentId, state.threadId);

    expect(state.route).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-one", threadId: "thread-two" },
    });
    expect(state.messages).toBe(messages);
  });
});
