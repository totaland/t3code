import { encodePcm16Wav } from "../components/chat/composerVoiceInput";
import {
  containsVoiceWakePhrase,
  isVoiceSleepCommand,
  stripVoiceWakePhrase,
  type VoiceWakePhraseListener,
  type VoiceWakePhraseState,
} from "./voiceWakePhrase";

type AudioContextConstructor = new () => AudioContext;

type LocalAudioWakePhraseListenerInput = {
  readonly onCommand: (transcript: string) => void | Promise<void>;
  readonly onNoCommand?: () => void;
  readonly onTranscribe: (wav: Blob, signal: AbortSignal) => Promise<string>;
  readonly onSleep?: () => void;
  readonly onSpeechStart?: () => boolean | void;
  readonly onTranscript?: (transcript: string) => void;
  readonly onWake?: () => void;
  readonly onStateChange?: (state: VoiceWakePhraseState) => void;
  readonly onError?: (error: unknown) => void;
  readonly shouldRetryError?: (error: unknown) => boolean;
  readonly audioContextConstructor?: AudioContextConstructor | null;
  readonly getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelScheduled?: (handle: unknown) => void;
};

type LocalAudioSession = {
  readonly context: AudioContext;
  readonly stream: MediaStream;
  readonly source: MediaStreamAudioSourceNode;
  readonly processor: ScriptProcessorNode;
  readonly silentOutput: GainNode;
  readonly sampleRate: number;
  readonly chunks: Float32Array[];
  readonly resumeOnInteraction: () => void;
  audibleGeneration: number;
  captureGeneration: number;
  completedCaptureGeneration: number;
  frameCount: number;
  maxRms: number;
  probeTimer: unknown | null;
  silenceFrames: number;
  speechStarted: boolean;
  transcribing: boolean;
  transcriptionAbortController: AbortController | null;
  voicedFrames: number;
};

const PROBE_INTERVAL_MS = 2_500;
const WAKE_AUDIO_WINDOW_MS = 5_000;
const COMMAND_AUDIO_WINDOW_MS = 30_000;
const COMMAND_SILENCE_MS = 650;
const MIN_VOICE_RMS = 0.006;
const MIN_VOICED_AUDIO_MS = 120;

function defaultAudioContextConstructor(): AudioContextConstructor | null {
  return typeof AudioContext === "undefined" ? null : AudioContext;
}

function defaultGetUserMedia():
  | ((constraints: MediaStreamConstraints) => Promise<MediaStream>)
  | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
}

export function createLocalAudioWakePhraseListener(
  input: LocalAudioWakePhraseListenerInput,
): VoiceWakePhraseListener | null {
  const AudioContextImplementation =
    input.audioContextConstructor === undefined
      ? defaultAudioContextConstructor()
      : input.audioContextConstructor;
  const getUserMedia =
    input.getUserMedia === undefined ? defaultGetUserMedia() : input.getUserMedia;
  if (!AudioContextImplementation || !getUserMedia) return null;

  const schedule =
    input.schedule ??
    ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
  const cancelScheduled =
    input.cancelScheduled ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  let enabled = false;
  let paused = false;
  let awake = false;
  let startGeneration = 0;
  let session: LocalAudioSession | null = null;
  let currentState: VoiceWakePhraseState = "off";

  const emitState = (next: VoiceWakePhraseState) => {
    if (currentState === next) return;
    currentState = next;
    input.onStateChange?.(next);
  };

  const resetCaptureEvidence = (target: LocalAudioSession) => {
    target.chunks.length = 0;
    target.frameCount = 0;
    target.captureGeneration += 1;
    target.maxRms = 0;
    target.silenceFrames = 0;
    target.speechStarted = false;
    target.voicedFrames = 0;
  };

  const resetAudio = (target: LocalAudioSession) => {
    target.transcriptionAbortController?.abort();
    target.transcriptionAbortController = null;
    resetCaptureEvidence(target);
    target.transcribing = false;
  };

  const hasVoiceEvidence = (target: LocalAudioSession) =>
    target.chunks.length > 0 &&
    target.maxRms >= MIN_VOICE_RMS &&
    target.voicedFrames >= Math.round((target.sampleRate * MIN_VOICED_AUDIO_MS) / 1_000);
  const resumeAudio = async (target: LocalAudioSession) => {
    try {
      await target.context.resume();
    } catch {
      // iOS rejects resume outside a user gesture. The explicit unlock button retries it.
    }
    if (session !== target || !enabled || paused) return;
    if (target.context.state !== "running") {
      emitState("needs-interaction");
      return;
    }
    if (!awake) scheduleProbe(target);
    emitState(awake ? "awake" : "listening");
  };

  const disposeSession = (target: LocalAudioSession) => {
    if (target.probeTimer !== null) cancelScheduled(target.probeTimer);
    target.probeTimer = null;
    target.transcriptionAbortController?.abort();
    target.transcriptionAbortController = null;
    target.transcribing = false;
    target.processor.onaudioprocess = null;
    target.source.disconnect();
    target.processor.disconnect();
    target.silentOutput.disconnect();
    for (const track of target.stream.getTracks()) track.stop();
    if (typeof window !== "undefined") {
      window.removeEventListener("pointerdown", target.resumeOnInteraction, true);
      window.removeEventListener("touchstart", target.resumeOnInteraction, true);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", target.resumeOnInteraction);
    }
    void target.context.close();
    if (session === target) session = null;
  };

  const retryCapture = (target: LocalAudioSession) => {
    if (session !== target || !enabled || paused) return;
    resetAudio(target);
    input.onTranscript?.("");
    input.onNoCommand?.();
    if (awake) emitState("awake");
    else scheduleProbe(target);
  };

  const blockCapture = (target: LocalAudioSession, error: unknown) => {
    if (session !== target || !enabled || paused) return;
    enabled = false;
    awake = false;
    startGeneration += 1;
    disposeSession(target);
    input.onTranscript?.("");
    input.onError?.(error);
    emitState("blocked");
  };

  const scheduleProbe = (target: LocalAudioSession) => {
    if (target.probeTimer !== null) return;
    target.probeTimer = schedule(() => {
      target.probeTimer = null;
      void probe(target);
    }, PROBE_INTERVAL_MS);
  };

  const goToSleep = (target: LocalAudioSession | null) => {
    if (!awake) return;
    awake = false;
    input.onTranscript?.("");
    input.onSleep?.();
    if (target && session === target) {
      resetAudio(target);
      if (!paused) scheduleProbe(target);
    }
    if (enabled && !paused) emitState("listening");
  };

  const acceptTranscript = (
    target: LocalAudioSession,
    transcript: string,
    captureGeneration: number,
  ) => {
    if (
      target.captureGeneration !== captureGeneration ||
      target.completedCaptureGeneration === captureGeneration
    ) {
      return;
    }
    target.transcribing = false;
    const command = containsVoiceWakePhrase(transcript)
      ? stripVoiceWakePhrase(transcript)
      : transcript.trim();
    input.onTranscript?.(command);

    if (isVoiceSleepCommand(command)) {
      goToSleep(target);
      return;
    }
    if (command.length === 0) {
      input.onNoCommand?.();
      resetAudio(target);
      emitState("awake");
      return;
    }

    target.completedCaptureGeneration = captureGeneration;
    paused = true;
    input.onTranscript?.("");
    if (target.probeTimer !== null) cancelScheduled(target.probeTimer);
    target.probeTimer = null;
    resetAudio(target);
    emitState("paused");
    const commandGeneration = startGeneration;
    void Promise.resolve(input.onCommand(command))
      .catch(() => undefined)
      .finally(() => {
        if (session !== target || !enabled || !paused || startGeneration !== commandGeneration) {
          return;
        }
        paused = false;
        void resumeAudio(target);
      });
  };

  const finalizeCommand = async (target: LocalAudioSession) => {
    if (session !== target || !enabled || paused || !awake || target.transcribing) return;
    if (!hasVoiceEvidence(target)) {
      resetAudio(target);
      input.onTranscript?.("");
      input.onNoCommand?.();
      emitState("awake");
      return;
    }
    target.transcribing = true;
    const captureGeneration = target.captureGeneration;
    const controller = new AbortController();
    target.transcriptionAbortController = controller;

    try {
      const wav = encodePcm16Wav(target.chunks, target.sampleRate);
      const transcript = await input.onTranscribe(
        new Blob([wav], { type: "audio/wav" }),
        controller.signal,
      );
      if (session !== target || !enabled || paused || !awake || controller.signal.aborted) return;
      target.transcriptionAbortController = null;
      acceptTranscript(target, transcript, captureGeneration);
    } catch (error) {
      if (session !== target || !enabled || paused || !awake || controller.signal.aborted) return;
      target.transcriptionAbortController = null;
      if (input.shouldRetryError?.(error)) retryCapture(target);
      else blockCapture(target, error);
    }
  };

  const probe = async (target: LocalAudioSession) => {
    if (session !== target || !enabled || paused || awake || target.transcribing) return;
    const shouldProbe = hasVoiceEvidence(target);
    target.maxRms = 0;
    if (!shouldProbe) {
      resetAudio(target);
      scheduleProbe(target);
      return;
    }

    const wav = encodePcm16Wav(target.chunks, target.sampleRate);
    resetCaptureEvidence(target);
    target.transcribing = true;
    const captureGeneration = target.captureGeneration;
    const controller = new AbortController();
    target.transcriptionAbortController = controller;
    const probedAudibleGeneration = target.audibleGeneration;
    let transcript = "";
    try {
      transcript = await input.onTranscribe(
        new Blob([wav], { type: "audio/wav" }),
        controller.signal,
      );
    } catch (error) {
      if (session !== target || !enabled || paused || controller.signal.aborted) return;
      target.transcriptionAbortController = null;
      if (input.shouldRetryError?.(error)) retryCapture(target);
      else blockCapture(target, error);
      return;
    }
    if (session !== target || !enabled || paused || controller.signal.aborted) return;
    target.transcriptionAbortController = null;
    target.transcribing = false;
    if (!containsVoiceWakePhrase(transcript)) {
      scheduleProbe(target);
      return;
    }

    awake = true;
    emitState("awake");
    input.onWake?.();
    const command = stripVoiceWakePhrase(transcript);
    input.onTranscript?.(command);
    const heardMoreAudio = target.audibleGeneration !== probedAudibleGeneration;
    const silenceReached =
      target.silenceFrames >= Math.round((target.sampleRate * COMMAND_SILENCE_MS) / 1_000);

    if (command.length > 0 && silenceReached && !heardMoreAudio) {
      acceptTranscript(target, transcript, captureGeneration);
      return;
    }
    if (command.length === 0 && !heardMoreAudio) {
      resetAudio(target);
      return;
    }
    if (silenceReached) void finalizeCommand(target);
  };

  const startMonitoring = async () => {
    if (!enabled || paused || session) return;
    const generation = ++startGeneration;
    emitState("starting");

    let context: AudioContext | null = null;
    let stream: MediaStream | null = null;
    try {
      context = new AudioContextImplementation();
      stream = await getUserMedia({
        audio: {
          autoGainControl: true,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      try {
        await context.resume();
      } catch {
        // iOS requires the follow-up resume to happen during a user gesture.
      }
      if (!enabled || paused || generation !== startGeneration) {
        for (const track of stream.getTracks()) track.stop();
        void context.close();
        return;
      }

      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4_096, 1, 1);
      const silentOutput = context.createGain();
      let target: LocalAudioSession;
      target = {
        context,
        stream,
        source,
        processor,
        silentOutput,
        sampleRate: context.sampleRate,
        chunks: [],
        frameCount: 0,
        maxRms: 0,
        probeTimer: null,
        silenceFrames: 0,
        speechStarted: false,
        transcribing: false,
        transcriptionAbortController: null,
        voicedFrames: 0,
        audibleGeneration: 0,
        captureGeneration: 0,
        completedCaptureGeneration: -1,
        resumeOnInteraction: () => void resumeAudio(target),
      };
      silentOutput.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (paused) return;
        const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
        let squaredAmplitude = 0;
        for (const sample of chunk) squaredAmplitude += sample * sample;
        const chunkRms = Math.sqrt(squaredAmplitude / chunk.length);

        target.chunks.push(chunk);
        target.frameCount += chunk.length;
        target.maxRms = Math.max(target.maxRms, chunkRms);
        if (chunkRms >= MIN_VOICE_RMS) {
          target.voicedFrames += chunk.length;
          const discardTriggerChunk =
            awake && !target.speechStarted && input.onSpeechStart?.() === true;
          if (discardTriggerChunk) {
            resetAudio(target);
            // Keep the capture window open so post-interruption silence can
            // settle an echo-only trigger and release the preserved route hold.
            target.speechStarted = true;
            return;
          }
          target.audibleGeneration += 1;
          target.speechStarted = true;
          target.silenceFrames = 0;
        } else if (target.speechStarted) {
          target.silenceFrames += chunk.length;
        }

        const windowMs = awake ? COMMAND_AUDIO_WINDOW_MS : WAKE_AUDIO_WINDOW_MS;
        const maxFrames = Math.round((target.sampleRate * windowMs) / 1_000);
        while (target.frameCount > maxFrames && target.chunks.length > 1) {
          target.frameCount -= target.chunks.shift()!.length;
        }

        const silenceFrames = Math.round((target.sampleRate * COMMAND_SILENCE_MS) / 1_000);
        if (
          awake &&
          !target.transcribing &&
          target.speechStarted &&
          target.silenceFrames >= silenceFrames
        ) {
          void finalizeCommand(target);
        }
      };
      source.connect(processor);
      processor.connect(silentOutput);
      silentOutput.connect(context.destination);
      if (typeof window !== "undefined") {
        window.addEventListener("pointerdown", target.resumeOnInteraction, true);
        window.addEventListener("touchstart", target.resumeOnInteraction, true);
      }
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", target.resumeOnInteraction);
      }
      session = target;
      if (context.state === "running") {
        if (!awake) scheduleProbe(target);
        emitState(awake ? "awake" : "listening");
      } else {
        emitState("needs-interaction");
      }
    } catch {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
      if (context) void context.close();
      if (enabled && !paused && generation === startGeneration) {
        enabled = false;
        awake = false;
        emitState("blocked");
      }
    }
  };

  return {
    start() {
      if (!enabled) awake = false;
      enabled = true;
      paused = false;
      void startMonitoring();
    },
    stop() {
      enabled = false;
      paused = false;
      awake = false;
      startGeneration += 1;
      if (session) disposeSession(session);
      input.onTranscript?.("");
      emitState("off");
    },
    pause() {
      if (!enabled) return;
      paused = true;
      startGeneration += 1;
      if (session) {
        if (session.probeTimer !== null) cancelScheduled(session.probeTimer);
        session.probeTimer = null;
        resetAudio(session);
      }
      input.onTranscript?.("");
      emitState("paused");
    },
    resume() {
      if (!enabled || !paused) return;
      paused = false;
      if (session) void resumeAudio(session);
      else void startMonitoring();
    },
    sleep() {
      goToSleep(session);
    },
    unlock() {
      if (session) void resumeAudio(session);
    },
  };
}
