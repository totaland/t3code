import { useEffect, useSyncExternalStore } from "react";
import { MicIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { encodePcm16Wav } from "./composerVoiceInput";

export type VoiceTurnPhase = "idle" | "transcribing" | "waiting" | "speaking";

type CaptureSession = {
  readonly audioContext: AudioContext;
  readonly stream: MediaStream;
  readonly source: MediaStreamAudioSourceNode;
  readonly processor: ScriptProcessorNode;
  readonly silentOutput: GainNode;
  readonly sampleRate: number;
  readonly chunks: Float32Array[];
  readonly resumeOnInteraction: () => void;
  readonly handleTrackEnded: () => void;
};

type CaptureState = "idle" | "starting" | "recording";

const CAPTURE_REMOUNT_GRACE_MS = 5_000;
let captureState: CaptureState = "idle";
let activeCaptureSession: CaptureSession | null = null;
let activeCaptureHandler: ((wav: Blob) => Promise<void>) | null = null;
let captureConsumerCount = 0;
let captureOrphanTimer: number | null = null;
const captureListeners = new Set<() => void>();

function emitCaptureState() {
  for (const listener of captureListeners) listener();
}

function setCaptureState(next: CaptureState) {
  if (captureState === next) return;
  captureState = next;
  emitCaptureState();
}

function subscribeCaptureState(listener: () => void) {
  captureListeners.add(listener);
  return () => captureListeners.delete(listener);
}

function getCaptureState() {
  return captureState;
}

function disposeCaptureSession(session: CaptureSession) {
  window.removeEventListener("pointerdown", session.resumeOnInteraction, true);
  window.removeEventListener("touchstart", session.resumeOnInteraction, true);
  document.removeEventListener("visibilitychange", session.resumeOnInteraction);
  for (const track of session.stream.getTracks()) {
    track.removeEventListener("ended", session.handleTrackEnded);
  }
  session.processor.onaudioprocess = null;
  session.source.disconnect();
  session.processor.disconnect();
  session.silentOutput.disconnect();
  for (const track of session.stream.getTracks()) track.stop();
  void session.audioContext.close();
}

function cancelActiveCapture() {
  const session = activeCaptureSession;
  activeCaptureSession = null;
  activeCaptureHandler = null;
  setCaptureState("idle");
  if (session) disposeCaptureSession(session);
}

function stopActiveCapture() {
  const session = activeCaptureSession;
  if (!session) return;

  if (session.audioContext.state !== "running" || session.chunks.length === 0) {
    void session.audioContext.resume();
    toastManager.add({
      type: "warning",
      title: "Microphone recording resumed",
      description:
        "iPhone paused audio while showing permissions. Speak now, then tap the red microphone again to send.",
    });
    return;
  }

  const onCapture = activeCaptureHandler;
  activeCaptureSession = null;
  activeCaptureHandler = null;
  setCaptureState("idle");
  disposeCaptureSession(session);

  const wav = encodePcm16Wav(session.chunks, session.sampleRate);
  if (!onCapture) return;
  void onCapture(new Blob([wav], { type: "audio/wav" })).catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Voice message failed",
      description: error instanceof Error ? error.message : "The recording could not be sent.",
    });
  });
}

function registerCaptureConsumer(onCapture: (wav: Blob) => Promise<void>) {
  captureConsumerCount += 1;
  activeCaptureHandler = onCapture;
  if (captureOrphanTimer !== null) {
    window.clearTimeout(captureOrphanTimer);
    captureOrphanTimer = null;
  }

  return () => {
    captureConsumerCount = Math.max(0, captureConsumerCount - 1);
    if (captureConsumerCount > 0 || captureState === "idle") return;
    captureOrphanTimer = window.setTimeout(() => {
      captureOrphanTimer = null;
      if (captureConsumerCount === 0) cancelActiveCapture();
    }, CAPTURE_REMOUNT_GRACE_MS);
  };
}

async function startActiveCapture(onCapture: (wav: Blob) => Promise<void>) {
  if (captureState !== "idle") return;
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
    toastManager.add({
      type: "error",
      title: "Microphone capture is not supported",
      description: "Open T3 Code using HTTPS or localhost in a current browser.",
    });
    return;
  }

  activeCaptureHandler = onCapture;
  setCaptureState("starting");
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  try {
    audioContext = new AudioContext();
    const streamPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const resumePromise = audioContext.resume();
    [stream] = await Promise.all([streamPromise, resumePromise]);
    if (getCaptureState() !== "starting") {
      for (const track of stream.getTracks()) track.stop();
      void audioContext.close();
      return;
    }

    const context = audioContext;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4_096, 1, 1);
    const silentOutput = context.createGain();
    const chunks: Float32Array[] = [];
    silentOutput.gain.value = 0;
    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(context.destination);

    const resumeOnInteraction = () => {
      if (context.state === "suspended") void context.resume();
    };
    let session: CaptureSession;
    const handleTrackEnded = () => {
      if (activeCaptureSession !== session) return;
      cancelActiveCapture();
      toastManager.add({
        type: "warning",
        title: "Microphone permission changed",
        description:
          "Chrome stopped microphone access. Allow it, then tap the T3 microphone again.",
      });
    };
    session = {
      audioContext: context,
      stream,
      source,
      processor,
      silentOutput,
      sampleRate: context.sampleRate,
      chunks,
      resumeOnInteraction,
      handleTrackEnded,
    };
    window.addEventListener("pointerdown", resumeOnInteraction, true);
    window.addEventListener("touchstart", resumeOnInteraction, true);
    document.addEventListener("visibilitychange", resumeOnInteraction);
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", handleTrackEnded);
    }
    activeCaptureSession = session;
    stream = null;
    audioContext = null;
    setCaptureState("recording");
  } catch (error) {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (audioContext) void audioContext.close();
    activeCaptureSession = null;
    activeCaptureHandler = null;
    setCaptureState("idle");

    const isIosBrowser = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const permissionDenied =
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "SecurityError");
    toastManager.add({
      type: "error",
      title: "Microphone access failed",
      description:
        isIosBrowser && permissionDenied
          ? "On iPhone: open Settings → Chrome → Microphone and turn it on. Then return to Chrome, tap the icon left of the address bar, enable Permissions, and reload T3 Code."
          : error instanceof DOMException
            ? `${error.name}: ${error.message || "The browser rejected microphone capture."}`
            : error instanceof Error
              ? error.message
              : "The browser rejected microphone capture.",
    });
  }
}

export function ComposerVoiceInputButton(props: {
  disabled?: boolean;
  phase: VoiceTurnPhase;
  onCapture: (wav: Blob) => Promise<void>;
}) {
  const currentCaptureState = useSyncExternalStore(
    subscribeCaptureState,
    getCaptureState,
    getCaptureState,
  );
  useEffect(() => registerCaptureConsumer(props.onCapture), [props.onCapture]);

  const isStarting = currentCaptureState === "starting";
  const isRecording = currentCaptureState === "recording";
  const handleClick = () => {
    if (isRecording) {
      void stopActiveCapture();
      return;
    }
    void startActiveCapture(props.onCapture);
  };

  const label = isStarting
    ? "Starting microphone"
    : isRecording
      ? "Stop recording and send"
      : props.phase === "transcribing"
        ? "Transcribing locally"
        : props.phase === "waiting"
          ? "Waiting for agent reply"
          : props.phase === "speaking"
            ? "Speaking agent reply"
            : "Start local voice conversation";
  const isBusy = props.phase !== "idle";
  const isActive = isStarting || isRecording || isBusy;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={
              isActive
                ? "relative shrink-0 rounded-full bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
                : "relative shrink-0 rounded-full text-muted-foreground/70 hover:text-foreground"
            }
            disabled={isStarting || (props.disabled && !isRecording)}
            aria-label={label}
            aria-pressed={isRecording}
            aria-busy={isBusy}
            onClick={handleClick}
          />
        }
      >
        <MicIcon className={isRecording ? "animate-pulse" : undefined} />
        <span className="sr-only" aria-live="polite">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
