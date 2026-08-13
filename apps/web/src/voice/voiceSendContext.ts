import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { getComposerProviderState } from "../components/chat/composerProviderState";

export type VoiceSendContext = ReturnType<ChatComposerHandle["getSendContext"]>;

export function resolveVoiceSendContext(input: {
  readonly modelSelection: ModelSelection | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}): VoiceSendContext | null {
  const selection = input.modelSelection;
  if (!selection) return null;
  const provider = input.providers.find(
    (candidate) =>
      candidate.instanceId === selection.instanceId &&
      candidate.enabled &&
      candidate.availability !== "unavailable",
  );
  if (!provider) return null;

  const providerState = getComposerProviderState({
    provider: provider.driver,
    model: selection.model,
    models: provider.models,
    modelOptions: selection.options,
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
      selection.instanceId,
      selection.model,
      providerState.modelOptionsForDispatch,
    ),
    providerAvailable: true,
    selectedProvider: provider.driver,
    selectedModel: selection.model,
    selectedProviderModels: provider.models,
  };
}

export function refreshVoiceSendContext(
  context: VoiceSendContext | null,
  providers: ReadonlyArray<ServerProvider>,
): VoiceSendContext | null {
  if (!context) return null;
  const provider = providers.find(
    (candidate) =>
      candidate.instanceId === context.selectedModelSelection.instanceId &&
      candidate.enabled &&
      candidate.availability !== "unavailable",
  );
  if (!provider) return null;
  return {
    ...context,
    providerAvailable: true,
    selectedProvider: provider.driver,
    selectedProviderModels: provider.models,
  };
}
