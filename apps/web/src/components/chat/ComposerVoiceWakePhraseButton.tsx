import { useEffect, useRef, useState } from "react";
import { AudioLinesIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  createVoiceWakePhraseListener,
  getVoiceWakePhraseMode,
  resolveVoiceWakePhraseEnabledPreference,
  VOICE_SLEEP_PHRASE,
  VOICE_WAKE_PHRASE,
  type VoiceWakePhraseListener,
  type VoiceWakePhraseState,
} from "../../voice/voiceWakePhrase";
import { createLocalAudioWakePhraseListener } from "../../voice/voiceWakePhraseAudio";
import { transcribeVoiceWav } from "../../voice/voiceClient";

export type VoiceTurnPhase = "idle" | "transcribing" | "waiting" | "speaking";

const STORAGE_KEY = "t3.voice.wake-phrase-enabled.v4";

function writePreference(enabled: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Session-only state still works when storage is unavailable.
  }
}

export function ComposerVoiceWakePhraseButton(props: {
  readonly disabled?: boolean;
  readonly httpBaseUrl: string | null;
  readonly onCaptureCancelled: () => void | Promise<void>;
  readonly onInterrupt: () => void | Promise<void>;
  readonly onPlaybackUnlock: () => Promise<unknown>;
  readonly phase: VoiceTurnPhase;
  readonly onTranscript: (transcript: string) => Promise<void>;
}) {
  const mode = getVoiceWakePhraseMode();
  const supported = mode !== "unsupported";
  const [enabled, setEnabled] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [sleeping, setSleeping] = useState(false);
  const [listenerState, setListenerState] = useState<VoiceWakePhraseState>(
    supported ? "off" : "unsupported",
  );
  const listenerRef = useRef<VoiceWakePhraseListener | null>(null);
  const bargeInPromiseRef = useRef<Promise<void> | null>(null);
  const onCaptureCancelledRef = useRef(props.onCaptureCancelled);
  const onInterruptRef = useRef(props.onInterrupt);
  const onTranscriptRef = useRef(props.onTranscript);
  const phaseRef = useRef(props.phase);
  onCaptureCancelledRef.current = props.onCaptureCancelled;
  onInterruptRef.current = props.onInterrupt;
  onTranscriptRef.current = props.onTranscript;
  phaseRef.current = props.phase;

  useEffect(() => {
    if (!supported) return;
    try {
      setEnabled(resolveVoiceWakePhraseEnabledPreference(window.localStorage.getItem(STORAGE_KEY)));
    } catch {
      setEnabled(false);
    }
  }, [supported]);

  useEffect(() => {
    if (!enabled || !supported) return;
    const cancelPendingBargeIn = async () => {
      const bargeIn = bargeInPromiseRef.current;
      if (!bargeIn) return;
      await bargeIn;
      if (bargeInPromiseRef.current !== bargeIn) return;
      bargeInPromiseRef.current = null;
      await onCaptureCancelledRef.current();
    };
    const onStateChange = (state: VoiceWakePhraseState) => {
      setListenerState(state);
      if (state !== "blocked") return;
      void cancelPendingBargeIn();
      setEnabled(false);
      toastManager.add({
        type: "warning",
        title: `${VOICE_WAKE_PHRASE} unavailable`,
        description:
          "T3 could not keep the wake microphone active. Check Chrome microphone permission and the T3 connection.",
      });
    };
    const listenerInput = {
      onCommand: async (transcript: string) => {
        const bargeIn = bargeInPromiseRef.current;
        try {
          if (bargeIn) await bargeIn;
          else if (phaseRef.current !== "idle") await onInterruptRef.current();
          if (bargeInPromiseRef.current === bargeIn) {
            bargeInPromiseRef.current = null;
          }
          await onTranscriptRef.current(transcript);
        } catch {
          await onCaptureCancelledRef.current();
        }
      },
      onSleep: () => {
        void cancelPendingBargeIn();
        setLiveTranscript("");
        setSleeping(true);
      },
      onSpeechStart: () => {
        const phase = phaseRef.current;
        if (phase === "idle" || bargeInPromiseRef.current) return false;
        bargeInPromiseRef.current = Promise.resolve(onInterruptRef.current()).catch(
          () => undefined,
        );
        return phase === "speaking";
      },
      onStateChange,
      onTranscript: setLiveTranscript,
      onWake: () => {
        bargeInPromiseRef.current = null;
        setSleeping(false);
      },
    };
    const listener =
      mode === "local-audio"
        ? createLocalAudioWakePhraseListener({
            ...listenerInput,
            onTranscribe: async (wav) => {
              let transcript = "";
              if (props.httpBaseUrl) {
                try {
                  transcript = await transcribeVoiceWav({
                    httpBaseUrl: props.httpBaseUrl,
                    wav,
                  });
                } catch {
                  transcript = "";
                }
              }
              if (transcript.trim().length === 0) {
                await cancelPendingBargeIn();
              }
              return transcript;
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
      listener.stop();
      void cancelPendingBargeIn();
      if (listenerRef.current === listener) listenerRef.current = null;
    };
  }, [enabled, mode, props.httpBaseUrl, supported]);

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
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [enabled]);

  const unlockPlayback = () => {
    void props.onPlaybackUnlock().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Audio playback unavailable",
        description: error instanceof Error ? error.message : "The browser blocked audio playback.",
      });
    });
  };

  const awake = listenerState === "awake";
  const label = !supported
    ? `${VOICE_WAKE_PHRASE} is unavailable in this browser`
    : sleeping
      ? `Sleeping — say “${VOICE_WAKE_PHRASE}” to wake`
      : awake
        ? liveTranscript
          ? `Heard “${liveTranscript}” — pause to send`
          : `Listening — say “${VOICE_SLEEP_PHRASE}” or press Esc to finish`
        : listenerState === "listening"
          ? `Listening for “${VOICE_WAKE_PHRASE}”`
          : listenerState === "needs-interaction"
            ? `Tap once to enable “${VOICE_WAKE_PHRASE}”`
            : listenerState === "starting"
              ? `Starting “${VOICE_WAKE_PHRASE}”`
              : listenerState === "paused"
                ? "Submitting voice command"
                : `Enable “${VOICE_WAKE_PHRASE}”`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={
              enabled
                ? "relative shrink-0 rounded-full bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                : "relative shrink-0 rounded-full text-muted-foreground/70 hover:text-foreground"
            }
            disabled={!supported || (props.disabled && !enabled)}
            aria-label={label}
            aria-pressed={enabled}
            aria-busy={listenerState === "starting"}
            onClick={() => {
              if (enabled && listenerState === "needs-interaction") {
                listenerRef.current?.unlock?.();
                unlockPlayback();
                return;
              }
              const nextEnabled = !enabled;
              setEnabled(nextEnabled);
              setLiveTranscript("");
              setSleeping(false);
              setListenerState(nextEnabled ? "starting" : "off");
              writePreference(nextEnabled);
              if (nextEnabled) {
                unlockPlayback();
                toastManager.add({
                  type: "warning",
                  title: `${VOICE_WAKE_PHRASE} enabled`,
                  description:
                    mode === "local-audio"
                      ? "Wake and command audio use your existing T3 Whisper service."
                      : "Wake audio is handled by your browser's speech recognition service and may be processed online.",
                });
              }
            }}
          />
        }
      >
        <AudioLinesIcon
          className={listenerState === "listening" || awake ? "animate-pulse" : undefined}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
