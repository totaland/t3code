import { useCallback, useEffect, useRef, useState } from "react";
import {
  isRetryableVoiceTranscriptionError,
  transcribeVoiceWav,
  type VoiceFetch,
} from "./voiceClient";
import {
  createVoiceWakePhraseListener,
  getVoiceWakePhraseMode,
  isBrowserSpeechRecognitionSupported,
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

export function shouldRecoverLocalVoiceGateway(input: {
  readonly pending: boolean;
  readonly httpBaseUrl: string | null;
  readonly disabled?: boolean | undefined;
  readonly captureMode: VoiceCaptureMode;
}): boolean {
  return (
    input.pending &&
    Boolean(input.httpBaseUrl) &&
    !input.disabled &&
    input.captureMode === "local-audio"
  );
}

export function isVoiceCapabilityUnavailable(
  mode: VoiceCaptureMode,
  state: VoiceWakePhraseState,
): boolean {
  return mode === "unsupported" || state === "blocked";
}

export function shouldIgnoreVoiceListenerState(
  blocked: boolean,
  _next: VoiceWakePhraseState,
): boolean {
  return blocked;
}

export function useVoiceSessionController(props: {
  readonly disabled: boolean | undefined;
  readonly fetchImplementation: VoiceFetch;
  readonly httpBaseUrl: string | null;
  readonly onCaptureCancelled: () => void | Promise<void>;
  readonly onInterrupt: () => void | Promise<void>;
  readonly onPlaybackUnlock: () => Promise<unknown>;
  readonly phase: VoiceTurnPhase;
  readonly onTranscript: (transcript: string) => Promise<void>;
}) {
  const detectedMode = getVoiceWakePhraseMode();
  const detectedCaptureMode = resolveVoiceCaptureMode(detectedMode);
  const browserFallbackSupported = isBrowserSpeechRecognitionSupported();
  const initialUnavailableReason =
    detectedCaptureMode === "unsupported"
      ? "Voice capture is unavailable in this browser."
      : detectedCaptureMode === "local-audio" && !props.httpBaseUrl
        ? "The local voice gateway is unavailable."
        : null;
  const [enabled, setEnabled] = useState(
    shouldAutoStartVoiceCapture(detectedCaptureMode) && Boolean(props.httpBaseUrl),
  );
  const [browserFallbackApproved, setBrowserFallbackApproved] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [sleeping, setSleeping] = useState(false);
  const [listenerState, setListenerState] = useState<VoiceWakePhraseState>(
    initialUnavailableReason
      ? detectedCaptureMode === "unsupported"
        ? "unsupported"
        : "blocked"
      : "off",
  );
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    initialUnavailableReason,
  );
  const listenerRef = useRef<VoiceWakePhraseListener | null>(null);
  const blockedRef = useRef(initialUnavailableReason !== null);
  const gatewayRecoveryPendingRef = useRef(
    detectedCaptureMode === "local-audio" && !props.httpBaseUrl,
  );
  const bargeInPromiseRef = useRef<Promise<boolean> | null>(null);
  const sessionGenerationRef = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  const effectiveCaptureMode = browserFallbackApproved ? "browser-fallback" : detectedCaptureMode;

  const notifyCaptureCancelled = () => {
    void Promise.resolve(propsRef.current.onCaptureCancelled()).catch(() => undefined);
  };

  const invalidateSession = () => {
    const hadBargeIn = bargeInPromiseRef.current !== null;
    sessionGenerationRef.current += 1;
    bargeInPromiseRef.current = null;
    if (hadBargeIn) notifyCaptureCancelled();
    return hadBargeIn;
  };

  useEffect(() => {
    if (props.disabled || !enabled || effectiveCaptureMode === "unsupported") return;
    if (effectiveCaptureMode === "local-audio" && !propsRef.current.httpBaseUrl) return;
    if (effectiveCaptureMode === "browser-fallback" && !browserFallbackApproved) return;

    const markBlocked = (reason: string) => {
      const hadBargeIn = invalidateSession();
      blockedRef.current = true;
      const listener = listenerRef.current;
      listenerRef.current = null;
      listener?.stop();
      setEnabled(false);
      setSleeping(false);
      setLiveTranscript("");
      setListenerState("blocked");
      setUnavailableReason(reason);
      if (!hadBargeIn) notifyCaptureCancelled();
    };

    const releasePendingBargeIn = async (generation: number, signal?: AbortSignal) => {
      const bargeIn = bargeInPromiseRef.current;
      if (!bargeIn) return;
      await bargeIn;
      if (
        signal?.aborted ||
        sessionGenerationRef.current !== generation ||
        bargeInPromiseRef.current !== bargeIn
      ) {
        return;
      }
      bargeInPromiseRef.current = null;
      notifyCaptureCancelled();
    };
    const listenerInput = {
      onCommand: async (transcript: string) => {
        const commandGeneration = sessionGenerationRef.current;
        setLiveTranscript(transcript);
        try {
          const bargeIn = bargeInPromiseRef.current;
          if (bargeIn) {
            if (!(await bargeIn)) throw new Error("Voice interruption failed.");
            if (sessionGenerationRef.current !== commandGeneration) return;
            if (bargeInPromiseRef.current === bargeIn) {
              bargeInPromiseRef.current = null;
            }
          } else if (propsRef.current.phase !== "idle") {
            await propsRef.current.onInterrupt();
            if (sessionGenerationRef.current !== commandGeneration) return;
          }
          if (sessionGenerationRef.current !== commandGeneration) return;
          await propsRef.current.onTranscript(transcript);
          if (sessionGenerationRef.current === commandGeneration) {
            setLiveTranscript("");
          }
        } catch {
          if (sessionGenerationRef.current === commandGeneration) {
            notifyCaptureCancelled();
            setLiveTranscript("");
          }
        }
      },
      onNoCommand: () => {
        void releasePendingBargeIn(sessionGenerationRef.current);
      },
      onSleep: () => {
        invalidateSession();
        setLiveTranscript("");
        setSleeping(true);
      },
      onSpeechStart: () => {
        const phase = propsRef.current.phase;
        if (propsRef.current.disabled || blockedRef.current || phase === "idle") return false;
        if (bargeInPromiseRef.current) return phase === "speaking";
        const interrupt = Promise.resolve(propsRef.current.onInterrupt()).then(
          () => true,
          () => false,
        );
        bargeInPromiseRef.current = interrupt;
        return phase === "speaking";
      },
      onStateChange: (state: VoiceWakePhraseState) => {
        if (shouldIgnoreVoiceListenerState(blockedRef.current, state)) return;
        setListenerState(state);
        if (state === "blocked") {
          markBlocked(
            effectiveCaptureMode === "browser-fallback"
              ? "Browser speech recognition is unavailable or permission was denied."
              : "Local voice transcription is unavailable.",
          );
          return;
        }
        if (!blockedRef.current) setUnavailableReason(null);
      },
      onTranscript: setLiveTranscript,
      onWake: () => {
        bargeInPromiseRef.current = null;
        setSleeping(false);
      },
    };

    const listener =
      effectiveCaptureMode === "local-audio"
        ? createLocalAudioWakePhraseListener({
            ...listenerInput,
            onTranscribe: async (wav, signal) => {
              const transcriptionGeneration = sessionGenerationRef.current;
              const httpBaseUrl = propsRef.current.httpBaseUrl;
              if (!httpBaseUrl) throw new Error("The local voice gateway is unavailable.");
              const transcript = await transcribeVoiceWav({
                fetchImplementation: propsRef.current.fetchImplementation,
                httpBaseUrl,
                signal,
                wav,
              });
              if (!transcript.trim()) {
                await releasePendingBargeIn(transcriptionGeneration, signal);
              }
              return transcript;
            },
            shouldRetryError: isRetryableVoiceTranscriptionError,
            onError: (error) => {
              markBlocked(
                error instanceof Error && error.message
                  ? error.message
                  : "Local voice transcription is unavailable.",
              );
            },
          })
        : createVoiceWakePhraseListener(listenerInput);

    if (!listener) {
      blockedRef.current = true;
      setEnabled(false);
      setListenerState("unsupported");
      setUnavailableReason("Voice capture is unavailable in this browser.");
      return;
    }

    blockedRef.current = false;
    setUnavailableReason(null);
    listenerRef.current = listener;
    listener.start();
    return () => {
      const ownsListener = listenerRef.current === listener;
      if (ownsListener) {
        listenerRef.current = null;
        listener.stop();
        invalidateSession();
      }
    };
  }, [browserFallbackApproved, effectiveCaptureMode, enabled, props.disabled]);

  useEffect(() => {
    const listener = listenerRef.current;
    if (!listener) return;
    if (props.disabled) {
      invalidateSession();
      listener.pause();
    } else {
      listener.resume();
    }
  }, [props.disabled]);

  useEffect(() => {
    if (!enabled) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      invalidateSession();
      listenerRef.current?.sleep();
      setLiveTranscript("");
      setSleeping(true);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [enabled]);

  const sleep = useCallback(() => {
    invalidateSession();
    listenerRef.current?.sleep();
    setLiveTranscript("");
    setSleeping(true);
  }, []);

  useEffect(() => {
    if (
      !shouldRecoverLocalVoiceGateway({
        pending: gatewayRecoveryPendingRef.current,
        httpBaseUrl: props.httpBaseUrl,
        disabled: props.disabled,
        captureMode: detectedCaptureMode,
      })
    ) {
      return;
    }
    gatewayRecoveryPendingRef.current = false;
    blockedRef.current = false;
    setEnabled(true);
    setListenerState("starting");
    setUnavailableReason(null);
  }, [detectedCaptureMode, props.disabled, props.httpBaseUrl]);

  const micOff = useCallback(() => {
    const hadBargeIn = invalidateSession();
    gatewayRecoveryPendingRef.current = false;
    blockedRef.current = false;
    listenerRef.current?.stop();
    listenerRef.current = null;
    setEnabled(false);
    setSleeping(false);
    setLiveTranscript("");
    setListenerState("off");
    setUnavailableReason(null);
    if (!hadBargeIn) notifyCaptureCancelled();
  }, []);

  const micOn = useCallback(() => {
    if (propsRef.current.disabled) return;
    if (
      effectiveCaptureMode === "unsupported" ||
      (effectiveCaptureMode === "local-audio" && !propsRef.current.httpBaseUrl) ||
      (effectiveCaptureMode === "browser-fallback" && !browserFallbackApproved)
    ) {
      return;
    }
    invalidateSession();
    blockedRef.current = false;
    setEnabled(true);
    setSleeping(false);
    setListenerState("starting");
    setUnavailableReason(null);
    void propsRef.current.onPlaybackUnlock().catch(() => undefined);
  }, [browserFallbackApproved, effectiveCaptureMode]);

  const enableBrowserFallback = useCallback(() => {
    if (!browserFallbackSupported || propsRef.current.disabled) return;
    invalidateSession();
    blockedRef.current = false;
    setBrowserFallbackApproved(true);
    setEnabled(true);
    setSleeping(false);
    setListenerState("starting");
    setUnavailableReason(null);
    void propsRef.current.onPlaybackUnlock().catch(() => undefined);
  }, [browserFallbackSupported]);

  const unlock = useCallback(() => {
    listenerRef.current?.unlock?.();
    void propsRef.current.onPlaybackUnlock().catch(() => undefined);
  }, []);

  const awake = listenerState === "awake";
  const canEnableBrowserFallback =
    browserFallbackSupported &&
    !browserFallbackApproved &&
    !props.disabled &&
    (detectedCaptureMode === "browser-fallback" || listenerState === "blocked");
  const canTurnMicOn =
    !props.disabled &&
    effectiveCaptureMode !== "unsupported" &&
    (effectiveCaptureMode === "browser-fallback"
      ? browserFallbackApproved
      : Boolean(props.httpBaseUrl));
  const statusText =
    props.phase === "speaking"
      ? "Mai is speaking"
      : props.phase === "waiting"
        ? "Mai is working"
        : props.phase === "transcribing"
          ? "Transcribing"
          : props.disabled
            ? "Voice capture paused"
            : listenerState === "blocked"
              ? (unavailableReason ?? "Voice unavailable")
              : !enabled
                ? effectiveCaptureMode === "unsupported"
                  ? "Voice unavailable"
                  : "Microphone off"
                : listenerState === "needs-interaction"
                  ? "Tap Enable audio to continue"
                  : sleeping
                    ? "Sleeping — say “" + VOICE_WAKE_PHRASE + "” to wake"
                    : awake
                      ? liveTranscript
                        ? "Heard “" + liveTranscript + "” — pause to send"
                        : "Listening — say “" + VOICE_SLEEP_PHRASE + "” or press Escape to sleep"
                      : listenerState === "starting"
                        ? "Starting voice"
                        : "Listening for “" + VOICE_WAKE_PHRASE + "”";

  return {
    awake,
    canEnableBrowserFallback,
    canTurnMicOn,
    captureMode: effectiveCaptureMode,
    enabled,
    liveTranscript,
    listenerState,
    sleeping,
    statusText,
    unavailableReason,
    enableBrowserFallback,
    micOff,
    micOn,
    sleep,
    unlock,
  } as const;
}
