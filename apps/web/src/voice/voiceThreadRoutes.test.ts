import { describe, expect, it } from "vite-plus/test";
import { buildTextThreadRoute, buildVoiceThreadRoute } from "./voiceThreadRoutes";

describe("voice thread routes", () => {
  it("preserves environment and thread when entering voice", () => {
    expect(buildVoiceThreadRoute("env-one", "thread-two")).toEqual({
      to: "/voice/$environmentId/$threadId",
      params: { environmentId: "env-one", threadId: "thread-two" },
    });
  });

  it("returns to the exact text conversation", () => {
    expect(buildTextThreadRoute("env-one", "thread-two")).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-one", threadId: "thread-two" },
    });
  });
});
