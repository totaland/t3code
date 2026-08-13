import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { refreshVoiceSendContext, resolveVoiceSendContext } from "./voiceSendContext";

const selection = {
  instanceId: "codex",
  model: "gpt-5",
} as ModelSelection;

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    availability: "available",
    models: [{ slug: "gpt-5", name: "GPT-5", capabilities: {} }],
    ...overrides,
  } as ServerProvider;
}

describe("voice send context", () => {
  it("derives text-only dispatch state without a mounted composer", () => {
    const context = resolveVoiceSendContext({ modelSelection: selection, providers: [provider()] });

    expect(context).toMatchObject({
      prompt: "",
      providerAvailable: true,
      selectedProvider: "codex",
      selectedModel: "gpt-5",
      selectedModelSelection: expect.objectContaining({ instanceId: "codex", model: "gpt-5" }),
      images: [],
      terminalContexts: [],
    });
  });

  it("revalidates handed-off composer state against current providers", () => {
    const context = resolveVoiceSendContext({ modelSelection: selection, providers: [provider()] });

    expect(
      refreshVoiceSendContext(context, [provider({ availability: "unavailable" })]),
    ).toBeNull();
  });
  it("rejects an unavailable selected provider", () => {
    expect(
      resolveVoiceSendContext({
        modelSelection: selection,
        providers: [provider({ availability: "unavailable" })],
      }),
    ).toBeNull();
  });
});
