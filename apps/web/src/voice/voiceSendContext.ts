import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { getComposerProviderState } from "../components/chat/composerProviderState";
import { resolveAppModelSelectionForInstance } from "../modelSelection";

export type VoiceSendContext = ReturnType<ChatComposerHandle["getSendContext"]>;

export function resolveVoiceSendContext(input: {
  readonly modelSelection: ModelSelection | null | undefined;
  readonly preferredInstanceIds: ReadonlyArray<string | null | undefined>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selectedProvider: ServerProvider["driver"];
  readonly settings: UnifiedSettings;
}): VoiceSendContext | null {
  const preferredProvider = input.preferredInstanceIds.flatMap((instanceId) => {
    if (!instanceId) return [];
    const provider = input.providers.find(
      (candidate) =>
        candidate.instanceId === instanceId &&
        candidate.enabled &&
        candidate.availability !== "unavailable" &&
        candidate.driver === input.selectedProvider,
    );
    return provider ? [provider] : [];
  })[0];
  const provider =
    preferredProvider ??
    input.providers.find(
      (candidate) =>
        candidate.enabled &&
        candidate.availability !== "unavailable" &&
        candidate.driver === input.selectedProvider,
    ) ??
    input.providers.find(
      (candidate) => candidate.enabled && candidate.availability !== "unavailable",
    );
  if (!provider) return null;

  const keptSelection =
    input.modelSelection?.instanceId === provider.instanceId ? input.modelSelection : null;
  const model = resolveAppModelSelectionForInstance(
    provider.instanceId,
    input.settings,
    input.providers,
    keptSelection?.model,
  );
  if (!model) return null;

  const providerState = getComposerProviderState({
    provider: provider.driver,
    model,
    models: provider.models,
    modelOptions: keptSelection?.options,
  });

  return {
    prompt: "",
    images: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    selectedPromptEffort: providerState.promptEffort,
    selectedModelOptionsForDispatch: providerState.modelOptionsForDispatch,
    selectedModelSelection: createModelSelection(
      provider.instanceId,
      model,
      providerState.modelOptionsForDispatch,
    ),
    providerAvailable: true,
    selectedProvider: provider.driver,
    selectedModel: model,
    selectedProviderModels: provider.models,
  };
}

export function refreshVoiceSendContext(
  context: VoiceSendContext | null,
  providers: ReadonlyArray<ServerProvider>,
  settings: UnifiedSettings,
): VoiceSendContext | null {
  if (!context) return null;
  return resolveVoiceSendContext({
    modelSelection: context.selectedModelSelection,
    preferredInstanceIds: [context.selectedModelSelection.instanceId],
    providers,
    selectedProvider: context.selectedProvider,
    settings,
  });
}
