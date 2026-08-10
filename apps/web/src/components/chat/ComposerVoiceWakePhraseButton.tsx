import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AudioLinesIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  getCaptureState,
  subscribeCaptureState,
  type VoiceTurnPhase,
} from "./ComposerVoiceInputButton";
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
  readonly onInterrupt: () => void | Promise<void>;
  readonly phase: VoiceTurnPhase;
  readonly onTranscript: (transcript: string) => Promise<void>;
}) {
  const mode = getVoiceWakePhraseMode();
  const supported = mode !== "unsupported";
  const captureState = useSyncExternalStore(
    subscribeCaptureState,
    getCaptureState,
    getCaptureState,
  );
  const [enabled, setEnabled] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [sleeping, setSleeping] = useState(false);
  const [listenerState, setListenerState] = useState<VoiceWakePhraseState>(
    supported ? "off" : "unsupported",
  );
  const listenerRef = useRef<VoiceWakePhraseListener | null>(null);
  const bargeInPromiseRef = useRef<Promise<void> | null>(null);
  const onInterruptRef = useRef(props.onInterrupt);
  const onTranscriptRef = useRef(props.onTranscript);
  const phaseRef = useRef(props.phase);
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
    const onStateChange = (state: VoiceWakePhraseState) => {
      setListenerState(state);
      if (state !== "blocked") return;
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
        if (bargeIn) await bargeIn;
        else if (phaseRef.current !== "idle") await onInterruptRef.current();
        bargeInPromiseRef.current = null;
        await onTranscriptRef.current(transcript);
      },
      onSleep: () => {
        bargeInPromiseRef.current = null;
        setLiveTranscript("");
        setSleeping(true);
      },
      onSpeechStart: () => {
        if (phaseRef.current === "idle" || bargeInPromiseRef.current) return;
        bargeInPromiseRef.current = Promise.resolve(onInterruptRef.current()).catch(
          () => undefined,
        );
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
              if (!props.httpBaseUrl) return "";
              try {
                return await transcribeVoiceWav({
                  httpBaseUrl: props.httpBaseUrl,
                  wav,
                });
              } catch {
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
      listener.stop();
      if (listenerRef.current === listener) listenerRef.current = null;
    };
  }, [enabled, mode, props.httpBaseUrl, supported]);

  useEffect(() => {
    const listener = listenerRef.current;
    if (!listener) return;
    if (captureState === "idle" && !props.disabled && props.phase === "idle") {
      listener.resume();
    } else {
      listener.pause();
    }
  }, [captureState, enabled, props.disabled, props.phase]);

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
                ? "Voice conversation paused while Mai responds"
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
                return;
              }
              const nextEnabled = !enabled;
              setEnabled(nextEnabled);
              setLiveTranscript("");
              setSleeping(false);
              setListenerState(nextEnabled ? "starting" : "off");
              writePreference(nextEnabled);
              if (nextEnabled) {
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
