import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
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

function resolve(
  modelSelection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
) {
  return resolveVoiceSendContext({
    modelSelection,
    preferredInstanceIds: [modelSelection?.instanceId],
    providers,
    selectedProvider: "codex",
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
}

describe("voice send context", () => {
  it("derives text-only dispatch state without a mounted composer", () => {
    const context = resolve(selection, [provider()]);

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

  it("falls back from an unavailable saved instance to an enabled provider default", () => {
    const fallback = provider({
      instanceId: "codex-work",
      models: [{ slug: "gpt-5.1", name: "GPT-5.1", capabilities: {}, isDefault: true }],
    });
    const context = resolve(selection, [
      provider({ availability: "unavailable" }),
      fallback,
    ]);

    expect(context).toMatchObject({
      selectedModel: "gpt-5.1",
      selectedModelSelection: expect.objectContaining({
        instanceId: "codex-work",
        model: "gpt-5.1",
      }),
    });
  });

  it("revalidates handed-off composer state against current providers", () => {
    const context = resolve(selection, [provider()]);

    expect(
      refreshVoiceSendContext(
        context,
        [provider({ availability: "unavailable" })],
        DEFAULT_UNIFIED_SETTINGS,
      ),
    ).toBeNull();
  });

  it("returns unavailable when no provider can accept the turn", () => {
    expect(resolve(selection, [provider({ availability: "unavailable" })])).toBeNull();
  });
});
