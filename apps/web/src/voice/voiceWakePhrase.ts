export const VOICE_WAKE_PHRASE = "Hey Mai";
export const VOICE_SLEEP_PHRASE = "go to sleep";

export type VoiceWakePhraseState =
  | "off"
  | "starting"
  | "needs-interaction"
  | "listening"
  | "awake"
  | "paused"
  | "blocked"
  | "unsupported";

type RecognitionResultList = {
  readonly length: number;
  readonly [index: number]: {
    readonly isFinal: boolean;
    readonly length: number;
    readonly [index: number]: { readonly transcript: string };
  };
};

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onresult:
    | ((event: { readonly resultIndex: number; readonly results: RecognitionResultList }) => void)
    | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
};

export type SpeechRecognitionConstructor = new () => Recognition;

export type VoiceWakePhraseListener = {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  sleep(): void;
  unlock?(): void;
};

type ListenerInput = {
  readonly onCommand: (transcript: string) => void | Promise<void>;
  readonly onSleep?: () => void;
  readonly onSpeechStart?: () => void;
  readonly onTranscript?: (transcript: string) => void;
  readonly onWake?: () => void;
  readonly onStateChange?: (state: VoiceWakePhraseState) => void;
  readonly recognitionConstructor?: SpeechRecognitionConstructor | null;
  readonly getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null;
  readonly language?: string;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelScheduled?: (handle: unknown) => void;
};

const BLOCKING_ERRORS = new Set(["audio-capture", "network", "not-allowed", "service-not-allowed"]);
const RESTART_DELAY_MS = 250;
const WAKE_PHRASE_PATTERN = /\bhey(?:[\s,.-]+m[a-z]{0,4})?\b[\s,.:;!?-]*/iu;

function normalizeVoicePhrase(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export type VoiceWakePhraseMode = "speech-recognition" | "local-audio" | "unsupported";

export function selectVoiceWakePhraseMode(input: {
  readonly hasAudioCapture: boolean;
  readonly hasSpeechRecognition: boolean;
  readonly isMobileBrowser: boolean;
}): VoiceWakePhraseMode {
  if (input.hasAudioCapture) return "local-audio";
  if (input.hasSpeechRecognition) return "speech-recognition";
  return "unsupported";
}

function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /Android|iPad|iPhone|iPod|Mobile/iu.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function resolveVoiceWakePhraseEnabledPreference(stored: string | null): boolean {
  return stored === "true";
}

export function getVoiceWakePhraseMode(): VoiceWakePhraseMode {
  const hasAudioCapture =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioContext !== "undefined";
  return selectVoiceWakePhraseMode({
    hasAudioCapture,
    hasSpeechRecognition: getRecognitionConstructor() !== null,
    isMobileBrowser: isMobileBrowser(),
  });
}

export function isVoiceWakePhraseSupported(): boolean {
  return getVoiceWakePhraseMode() !== "unsupported";
}

export function containsVoiceWakePhrase(transcript: string): boolean {
  const normalized = normalizeVoicePhrase(transcript);
  if (normalized === "hey") return true;
  return /\bhey\s+m[a-z]{0,4}\b/.test(normalized);
}

export function stripVoiceWakePhrase(transcript: string): string {
  if (!containsVoiceWakePhrase(transcript)) return transcript.trim();
  const match = WAKE_PHRASE_PATTERN.exec(transcript);
  return match ? transcript.slice(match.index + match[0].length).trim() : transcript.trim();
}

export function isVoiceSleepCommand(transcript: string): boolean {
  const normalized = normalizeVoicePhrase(transcript).replace(/^mai\s+/, "");
  return (
    normalized === VOICE_SLEEP_PHRASE ||
    normalized === `${VOICE_SLEEP_PHRASE} now` ||
    normalized === `${VOICE_SLEEP_PHRASE} please`
  );
}

export function createVoiceWakePhraseListener(
  input: ListenerInput,
): VoiceWakePhraseListener | null {
  const RecognitionConstructor =
    input.recognitionConstructor === undefined
      ? getRecognitionConstructor()
      : input.recognitionConstructor;
  if (!RecognitionConstructor) return null;

  const getUserMedia =
    input.getUserMedia === undefined
      ? typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getUserMedia === "function"
        ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        : null
      : input.getUserMedia;
  const schedule =
    input.schedule ??
    ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
  const cancelScheduled =
    input.cancelScheduled ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  let enabled = false;
  let paused = false;
  let awake = false;
  let recognition: Recognition | null = null;
  let restartHandle: unknown = null;
  let microphoneAuthorized = getUserMedia === null;
  let authorizationGeneration = 0;
  let currentState: VoiceWakePhraseState = "off";

  const emitState = (next: VoiceWakePhraseState) => {
    if (currentState === next) return;
    currentState = next;
    input.onStateChange?.(next);
  };
  const clearRestart = () => {
    if (restartHandle === null) return;
    cancelScheduled(restartHandle);
    restartHandle = null;
  };
  const goToSleep = () => {
    if (!awake) return;
    awake = false;
    input.onTranscript?.("");
    input.onSleep?.();
    if (enabled && !paused) emitState("listening");
  };
  const startRecognition = () => {
    if (!enabled || paused || recognition) return;
    clearRestart();
    const next = new RecognitionConstructor();
    next.continuous = true;
    next.interimResults = true;
    next.lang = input.language ?? (typeof navigator === "undefined" ? "en-US" : navigator.language);
    next.onstart = () => emitState(awake ? "awake" : "listening");
    next.onspeechstart = () => {
      if (awake) input.onSpeechStart?.();
    };
    next.onresult = (event) => {
      if (paused || recognition !== next) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript;
        if (!result || !transcript) continue;

        if (!awake) {
          if (!containsVoiceWakePhrase(transcript)) continue;
          awake = true;
          emitState("awake");
          input.onWake?.();
        }

        const command = containsVoiceWakePhrase(transcript)
          ? stripVoiceWakePhrase(transcript)
          : transcript.trim();
        input.onTranscript?.(command);
        if (!result.isFinal || command.length === 0) continue;
        if (isVoiceSleepCommand(command)) {
          goToSleep();
          continue;
        }

        paused = true;
        input.onTranscript?.("");
        emitState("paused");
        next.abort();
        const commandGeneration = authorizationGeneration;
        void Promise.resolve(input.onCommand(command))
          .catch(() => undefined)
          .finally(() => {
            if (!enabled || !paused || authorizationGeneration !== commandGeneration) {
              return;
            }
            paused = false;
            void authorizeAndStartRecognition();
          });
        return;
      }
    };
    // SpeechRecognition's cross-browser shape still uses legacy event-handler properties.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    next.onerror = (event) => {
      if (!BLOCKING_ERRORS.has(event.error)) return;
      enabled = false;
      paused = false;
      awake = false;
      emitState("blocked");
    };
    next.onend = () => {
      if (recognition === next) recognition = null;
      if (!enabled || paused) return;
      restartHandle = schedule(() => {
        restartHandle = null;
        startRecognition();
      }, RESTART_DELAY_MS);
    };
    recognition = next;
    emitState("starting");
    try {
      next.start();
    } catch {
      recognition = null;
      restartHandle = schedule(() => {
        restartHandle = null;
        startRecognition();
      }, RESTART_DELAY_MS);
    }
  };
  const authorizeAndStartRecognition = async () => {
    if (!enabled || paused || recognition) return;
    if (microphoneAuthorized || !getUserMedia) {
      startRecognition();
      return;
    }

    const generation = ++authorizationGeneration;
    emitState("starting");
    try {
      const stream = await getUserMedia({
        audio: {
          autoGainControl: true,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      for (const track of stream.getTracks()) track.stop();
      if (!enabled || paused || generation !== authorizationGeneration) return;
      microphoneAuthorized = true;
      startRecognition();
    } catch {
      if (!enabled || paused || generation !== authorizationGeneration) return;
      enabled = false;
      emitState("blocked");
    }
  };

  return {
    start() {
      if (!enabled) awake = false;
      enabled = true;
      paused = false;
      void authorizeAndStartRecognition();
    },
    stop() {
      enabled = false;
      paused = false;
      awake = false;
      authorizationGeneration += 1;
      clearRestart();
      recognition?.abort();
      recognition = null;
      input.onTranscript?.("");
      emitState("off");
    },
    pause() {
      if (!enabled) return;
      paused = true;
      authorizationGeneration += 1;
      clearRestart();
      recognition?.abort();
      recognition = null;
      input.onTranscript?.("");
      emitState("paused");
    },
    resume() {
      if (!enabled || !paused) return;
      paused = false;
      void authorizeAndStartRecognition();
    },
    sleep() {
      goToSleep();
    },
  };
}
