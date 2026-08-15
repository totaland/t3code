import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { primeVoicePlaybackContext } from "./voicePlayback";

type VoiceSendContext = ReturnType<ChatComposerHandle["getSendContext"]>;

interface VoiceRouteSessionDependencies {
  readonly createAudioContext: () => AudioContext;
  readonly primeAudioContext: (context: AudioContext) => Promise<void>;
  readonly scheduleRelease: (callback: () => void) => unknown;
  readonly cancelRelease: (handle: unknown) => void;
}

const defaultDependencies: VoiceRouteSessionDependencies = {
  createAudioContext: () => new AudioContext(),
  primeAudioContext: primeVoicePlaybackContext,
  scheduleRelease: (callback) => globalThis.setTimeout(callback, 0),
  cancelRelease: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createVoiceRouteSession(
  dependencies: VoiceRouteSessionDependencies = defaultDependencies,
) {
  let playbackContext: AudioContext | null = null;
  let playbackRetainers = 0;
  let pendingRelease: unknown = null;
  const sendContexts = new Map<string, VoiceSendContext>();
  const sendContextRetainers = new Map<string, number>();
  const pendingSendContextReleases = new Map<string, unknown>();

  const cancelPendingRelease = () => {
    if (pendingRelease === null) return;
    dependencies.cancelRelease(pendingRelease);
    pendingRelease = null;
  };

  const cancelPendingSendContextRelease = (threadKey: string) => {
    const pending = pendingSendContextReleases.get(threadKey);
    if (pending === undefined) return;
    dependencies.cancelRelease(pending);
    pendingSendContextReleases.delete(threadKey);
  };

  const closePlayback = () => {
    cancelPendingRelease();
    const context = playbackContext;
    playbackContext = null;
    if (context && context.state !== "closed") {
      void context.close();
    }
  };

  return {
    async ensurePlayback(): Promise<AudioContext> {
      cancelPendingRelease();
      if (playbackContext?.state === "closed") {
        playbackContext = null;
      }
      const context = playbackContext ?? dependencies.createAudioContext();
      playbackContext = context;
      await dependencies.primeAudioContext(context);
      return context;
    },
    getPlayback(): AudioContext | null {
      return playbackContext?.state === "closed" ? null : playbackContext;
    },
    retainPlayback(): () => void {
      cancelPendingRelease();
      playbackRetainers += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        playbackRetainers = Math.max(0, playbackRetainers - 1);
        if (playbackRetainers > 0 || pendingRelease !== null) return;
        pendingRelease = dependencies.scheduleRelease(() => {
          pendingRelease = null;
          if (playbackRetainers === 0) closePlayback();
        });
      };
    },
    closePlayback,
    rememberSendContext(threadKey: string, context: VoiceSendContext): void {
      cancelPendingSendContextRelease(threadKey);
      sendContexts.set(threadKey, context);
    },
    readSendContext(threadKey: string): VoiceSendContext | null {
      return sendContexts.get(threadKey) ?? null;
    },
    retainSendContext(threadKey: string): () => void {
      cancelPendingSendContextRelease(threadKey);
      sendContextRetainers.set(threadKey, (sendContextRetainers.get(threadKey) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const retainers = Math.max(0, (sendContextRetainers.get(threadKey) ?? 0) - 1);
        if (retainers > 0) {
          sendContextRetainers.set(threadKey, retainers);
          return;
        }
        sendContextRetainers.delete(threadKey);
        if (pendingSendContextReleases.has(threadKey)) return;
        const pending = dependencies.scheduleRelease(() => {
          pendingSendContextReleases.delete(threadKey);
          if (!sendContextRetainers.has(threadKey)) sendContexts.delete(threadKey);
        });
        pendingSendContextReleases.set(threadKey, pending);
      };
    },
    clearSendContext(threadKey: string): void {
      cancelPendingSendContextRelease(threadKey);
      sendContextRetainers.delete(threadKey);
      sendContexts.delete(threadKey);
    },
  } as const;
}

export const voiceRouteSession = createVoiceRouteSession();
