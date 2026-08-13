import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeVoiceWav } from "./voiceClient";
import {
  createVoiceWakePhraseListener,
  getVoiceWakePhraseMode,
  VOICE_SLEEP_PHRASE,
  VOICE_WAKE_PHRASE,
  type VoiceWakePhraseListener,
  type VoiceWakePhraseState,
} from "./voiceWakePhrase";
import { createLocalAudioWakePhraseListener } from "./voiceWakePhraseAudio";

export type VoiceCaptureMode = "local-audio" | "browser-fallback" | "unsupported";
export type VoiceTurnPhase = "idle" | "transcribing" | "waiting" | "speaking";

export function resolveVoiceCaptureMode(
  detectedMode: "local-audio" | "speech-recognition" | "unsupported",
): VoiceCaptureMode {
  return detectedMode === "local-audio"
    ? "local-audio"
    : detectedMode === "speech-recognition"
      ? "browser-fallback"
      : "unsupported";
}

export function shouldAutoStartVoiceCapture(mode: VoiceCaptureMode): boolean {
  return mode === "local-audio";
}

export function isVoiceCapabilityUnavailable(
  mode: VoiceCaptureMode,
  state: VoiceWakePhraseState,
): boolean {
  return mode === "unsupported" || state === "blocked";
}

export function shouldIgnoreVoiceListenerState(
  blocked: boolean,
  next: VoiceWakePhraseState,
): boolean {
  return blocked && next === "off";
}

export function useVoiceSessionController(props: {
  readonly disabled?: boolean;
  readonly httpBaseUrl: string | null;
  readonly onCaptureCancelled: () => void | Promise<void>;
  readonly onInterrupt: () => void | Promise<void>;
  readonly onPlaybackUnlock: () => Promise<unknown>;
  readonly phase: VoiceTurnPhase;
  readonly onTranscript: (transcript: string) => Promise<void>;
}) {
  const detectedMode = getVoiceWakePhraseMode();
  const captureMode = resolveVoiceCaptureMode(detectedMode);
  const [enabled, setEnabled] = useState(shouldAutoStartVoiceCapture(captureMode));
  const [browserFallbackApproved, setBrowserFallbackApproved] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [sleeping, setSleeping] = useState(false);
  const [listenerState, setListenerState] = useState<VoiceWakePhraseState>(
    detectedMode === "unsupported" ? "unsupported" : "off",
  );
  const listenerRef = useRef<VoiceWakePhraseListener | null>(null);
  const blockedRef = useRef(false);
  const bargeInPromiseRef = useRef<Promise<void> | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!enabled || captureMode === "unsupported") return;
    if (captureMode === "browser-fallback" && !browserFallbackApproved) return;
    const cancelPendingBargeIn = async () => {
      const bargeIn = bargeInPromiseRef.current;
      if (!bargeIn) return;
      await bargeIn;
      if (bargeInPromiseRef.current !== bargeIn) return;
      bargeInPromiseRef.current = null;
      await propsRef.current.onCaptureCancelled();
    };
    const listenerInput = {
      onCommand: async (transcript: string) => {
        const bargeIn = bargeInPromiseRef.current;
        try {
          if (bargeIn) await bargeIn;
          else if (propsRef.current.phase !== "idle") await propsRef.current.onInterrupt();
          if (bargeInPromiseRef.current === bargeIn) bargeInPromiseRef.current = null;
          await propsRef.current.onTranscript(transcript);
        } catch {
          await propsRef.current.onCaptureCancelled();
        }
      },
      onSleep: () => {
        void cancelPendingBargeIn();
        setLiveTranscript("");
        setSleeping(true);
      },
      onSpeechStart: () => {
        const phase = propsRef.current.phase;
        if (phase === "idle" || bargeInPromiseRef.current) return false;
        bargeInPromiseRef.current = Promise.resolve(propsRef.current.onInterrupt()).catch(
          () => undefined,
        );
        return phase === "speaking";
      },
      onStateChange: (state: VoiceWakePhraseState) => {
        if (shouldIgnoreVoiceListenerState(blockedRef.current, state)) return;
        setListenerState(state);
        if (state !== "blocked") return;
        blockedRef.current = true;
        void cancelPendingBargeIn();
        setEnabled(false);
      },
      onTranscript: setLiveTranscript,
      onWake: () => {
        bargeInPromiseRef.current = null;
        setSleeping(false);
      },
    };
    const listener =
      captureMode === "local-audio"
        ? createLocalAudioWakePhraseListener({
            ...listenerInput,
            onTranscribe: async (wav) => {
              if (!propsRef.current.httpBaseUrl) return "";
              try {
                const transcript = await transcribeVoiceWav({
                  httpBaseUrl: propsRef.current.httpBaseUrl,
                  wav,
                });
                if (!transcript.trim()) await cancelPendingBargeIn();
                return transcript;
              } catch {
                await cancelPendingBargeIn();
                return "";
              }
            },
          })
        : createVoiceWakePhraseListener(listenerInput);
    if (!listener) {
      setListenerState("unsupported");
      return;
    }
    listenerRef.current = listener;
    listener.start();
    return () => {
      if (listenerRef.current === listener) {
        listener.stop();
        listenerRef.current = null;
      }
      void cancelPendingBargeIn();
    };
  }, [browserFallbackApproved, captureMode, enabled]);

  useEffect(() => {
    const listener = listenerRef.current;
    if (!listener) return;
    if (props.disabled) listener.pause();
    else listener.resume();
  }, [enabled, props.disabled]);

  useEffect(() => {
    if (!enabled) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      listenerRef.current?.sleep();
      setLiveTranscript("");
      setSleeping(true);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [enabled]);

  const sleep = useCallback(() => {
    listenerRef.current?.sleep();
    setLiveTranscript("");
    setSleeping(true);
  }, []);

  const micOff = useCallback(() => {
    blockedRef.current = false;
    listenerRef.current?.stop();
    listenerRef.current = null;
    setEnabled(false);
    setSleeping(false);
    setLiveTranscript("");
    setListenerState("off");
    void propsRef.current.onCaptureCancelled();
  }, []);

  const micOn = useCallback(() => {
    if (captureMode === "browser-fallback" && !browserFallbackApproved) return;
    blockedRef.current = false;
    setEnabled(true);
    setSleeping(false);
    setListenerState("starting");
    void propsRef.current.onPlaybackUnlock().catch(() => undefined);
  }, [browserFallbackApproved, captureMode]);

  const enableBrowserFallback = useCallback(() => {
    blockedRef.current = false;
    setBrowserFallbackApproved(true);
    setEnabled(true);
    setSleeping(false);
    setListenerState("starting");
    void propsRef.current.onPlaybackUnlock().catch(() => undefined);
  }, []);

  const unlock = useCallback(() => {
    listenerRef.current?.unlock?.();
    void propsRef.current.onPlaybackUnlock().catch(() => undefined);
  }, []);

  const awake = listenerState === "awake";
  const statusText =
    props.phase === "speaking"
      ? "Mai is speaking"
      : props.phase === "waiting"
        ? "Mai is working"
        : props.phase === "transcribing"
          ? "Transcribing"
          : listenerState === "blocked"
            ? "Microphone permission unavailable"
            : !enabled
              ? captureMode === "unsupported"
                ? "Voice unavailable"
                : "Microphone off"
              : listenerState === "needs-interaction"
                ? "Tap Enable audio to continue"
                : sleeping
                  ? `Sleeping — say “${VOICE_WAKE_PHRASE}” to wake`
                  : awake
                    ? liveTranscript
                      ? `Heard “${liveTranscript}” — pause to send`
                      : `Listening — say “${VOICE_SLEEP_PHRASE}” or press Escape to sleep`
                    : listenerState === "starting"
                      ? "Starting voice"
                      : `Listening for “${VOICE_WAKE_PHRASE}”`;

  return {
    awake,
    captureMode,
    enabled,
    liveTranscript,
    listenerState,
    sleeping,
    statusText,
    enableBrowserFallback,
    micOff,
    micOn,
    sleep,
    unlock,
  } as const;
}
