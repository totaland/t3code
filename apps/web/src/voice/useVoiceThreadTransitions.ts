import { useNavigate } from "@tanstack/react-router";

import { enterVoiceThread, returnToTextThread } from "./voiceThreadRoutes";

export function useVoiceThreadTransitions(options: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly beforeEnterVoice: () => void;
  readonly beforeReturnToText: () => void;
}) {
  const navigate = useNavigate();

  return {
    enterVoice: () => {
      options.beforeEnterVoice();
      void enterVoiceThread(navigate, options.environmentId, options.threadId);
    },
    returnToText: () => {
      options.beforeReturnToText();
      void returnToTextThread(navigate, options.environmentId, options.threadId);
    },
  };
}
