import { describe, expect, it, vi } from "vite-plus/test";
import {
  containsVoiceWakePhrase,
  createVoiceWakePhraseListener,
  isVoiceSleepCommand,
  resolveVoiceWakePhraseEnabledPreference,
  selectVoiceWakePhraseMode,
  stripVoiceWakePhrase,
  type SpeechRecognitionConstructor,
  type VoiceWakePhraseState,
} from "./voiceWakePhrase";

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onresult:
    | ((event: {
        readonly resultIndex: number;
        readonly results: {
          readonly length: number;
          readonly [index: number]: {
            readonly isFinal: boolean;
            readonly length: number;
            readonly [index: number]: { readonly transcript: string };
          };
        };
      }) => void)
    | null = null;
  onerror: ((event: { readonly error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }
  start() {
    this.onstart?.();
  }
  abort() {
    this.onend?.();
  }
  emitTranscript(transcript: string, isFinal = true) {
    this.onresult?.({
      resultIndex: 0,
      results: { 0: { 0: { transcript }, isFinal, length: 1 }, length: 1 },
    });
  }
  emitSpeechStart() {
    this.onspeechstart?.();
  }
  emitError(error: string) {
    this.onerror?.({ error });
  }
}

describe("voice wake phrase", () => {
  it("recognizes Mai only when addressed as a wake phrase", () => {
    expect(containsVoiceWakePhrase("Hey Mai, start a new task")).toBe(true);
    expect(containsVoiceWakePhrase("hey may open the thread")).toBe(true);
    expect(containsVoiceWakePhrase("Hey, mate.")).toBe(true);
    expect(containsVoiceWakePhrase("Hey.")).toBe(true);
    expect(containsVoiceWakePhrase("hey there")).toBe(false);
    expect(containsVoiceWakePhrase("my release plan changed")).toBe(false);
  });

  it("extracts a command and only treats a standalone go-to-sleep phrase as sleep", () => {
    expect(stripVoiceWakePhrase("Hey Mai, open the current thread")).toBe(
      "open the current thread",
    );
    expect(isVoiceSleepCommand("Go to sleep.")).toBe(true);
    expect(isVoiceSleepCommand("Mai, go to sleep please")).toBe(true);
    expect(isVoiceSleepCommand("Add go to sleep support")).toBe(false);
  });

  it("uses local audio samples on mobile Chrome even when speech recognition is exposed", () => {
    expect(
      selectVoiceWakePhraseMode({
        hasAudioCapture: true,
        hasSpeechRecognition: true,
        isMobileBrowser: true,
      }),
    ).toBe("local-audio");
  });

  it("uses the same local Whisper audio path on supported desktop browsers", () => {
    expect(
      selectVoiceWakePhraseMode({
        hasAudioCapture: true,
        hasSpeechRecognition: true,
        isMobileBrowser: false,
      }),
    ).toBe("local-audio");
    expect(
      selectVoiceWakePhraseMode({
        hasAudioCapture: false,
        hasSpeechRecognition: true,
        isMobileBrowser: false,
      }),
    ).toBe("speech-recognition");
  });

  it("keeps wake listening off until the user explicitly enables it", () => {
    expect(resolveVoiceWakePhraseEnabledPreference(null)).toBe(false);
    expect(resolveVoiceWakePhraseEnabledPreference("true")).toBe(true);
    expect(resolveVoiceWakePhraseEnabledPreference("false")).toBe(false);
  });

  it("requests microphone access before starting desktop speech recognition", async () => {
    FakeSpeechRecognition.instances = [];
    const stop = vi.fn();
    const getUserMedia = vi.fn(
      async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream,
    );
    const states: VoiceWakePhraseState[] = [];
    const listener = createVoiceWakePhraseListener({
      recognitionConstructor: FakeSpeechRecognition as SpeechRecognitionConstructor,
      getUserMedia,
      onCommand: vi.fn(),
      onStateChange: (state) => states.push(state),
    });

    listener?.start();

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
    await vi.waitFor(() => expect(FakeSpeechRecognition.instances).toHaveLength(1));
    expect(stop).toHaveBeenCalledOnce();
    expect(states).toEqual(["starting", "listening"]);
  });

  it("keeps listening after Hey Mai, auto-submits final speech, and stays awake", async () => {
    FakeSpeechRecognition.instances = [];
    const onWake = vi.fn();
    const onCommand = vi.fn();
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const states: VoiceWakePhraseState[] = [];
    const listener = createVoiceWakePhraseListener({
      recognitionConstructor: FakeSpeechRecognition as SpeechRecognitionConstructor,
      onCommand,
      onSpeechStart,
      onTranscript,
      onWake,
      onStateChange: (state) => states.push(state),
    });

    listener?.start();
    const firstRecognition = FakeSpeechRecognition.instances[0]!;
    firstRecognition.emitTranscript("Hey Mai", true);

    expect(onWake).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe("awake");
    expect(FakeSpeechRecognition.instances).toHaveLength(1);

    firstRecognition.emitSpeechStart();
    expect(onSpeechStart).toHaveBeenCalledOnce();
    firstRecognition.emitTranscript("open the current thread", false);
    expect(onTranscript).toHaveBeenLastCalledWith("open the current thread");
    expect(onCommand).not.toHaveBeenCalled();

    firstRecognition.emitTranscript("open the current thread", true);
    expect(onCommand).toHaveBeenLastCalledWith("open the current thread");
    expect(states.at(-1)).toBe("paused");

    await vi.waitFor(() => expect(FakeSpeechRecognition.instances).toHaveLength(2));
    const secondRecognition = FakeSpeechRecognition.instances[1]!;
    expect(states.at(-1)).toBe("awake");
    secondRecognition.emitSpeechStart();
    secondRecognition.emitTranscript("show the logs", true);
    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    expect(onCommand).toHaveBeenLastCalledWith("show the logs");
    expect(onCommand).toHaveBeenCalledTimes(2);
  });

  it("reports final speech that contains no command", () => {
    FakeSpeechRecognition.instances = [];
    const onNoCommand = vi.fn();
    const listener = createVoiceWakePhraseListener({
      recognitionConstructor: FakeSpeechRecognition as SpeechRecognitionConstructor,
      onCommand: vi.fn(),
      onNoCommand,
    });

    listener?.start();
    const recognition = FakeSpeechRecognition.instances[0]!;
    recognition.emitTranscript("Hey Mai", true);
    recognition.emitSpeechStart();
    recognition.emitTranscript("   ", true);

    expect(onNoCommand).toHaveBeenCalledTimes(2);
  });
  it("ignores duplicate final results while a voice command is pending", () => {
    FakeSpeechRecognition.instances = [];
    const onCommand = vi.fn(() => new Promise<void>(() => {}));
    const listener = createVoiceWakePhraseListener({
      recognitionConstructor: FakeSpeechRecognition as SpeechRecognitionConstructor,
      onCommand,
    });

    listener?.start();
    const recognition = FakeSpeechRecognition.instances[0]!;
    recognition.emitTranscript("Hey Mai", true);
    recognition.emitTranscript("Thank you.", true);
    recognition.emitTranscript("Thank you.", true);

    expect(onCommand).toHaveBeenCalledOnce();
  });

  it("stays paused when externally paused during a pending voice command", async () => {
    FakeSpeechRecognition.instances = [];
    let finishCommand!: () => void;
    const commandFinished = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    const listener = createVoiceWakePhraseListener({
      recognitionConstructor: FakeSpeechRecognition as SpeechRecognitionConstructor,
      onCommand: vi.fn(() => commandFinished),
    });

    listener?.start();
    const recognition = FakeSpeechRecognition.instances[0]!;
    recognition.emitTranscript("Hey Mai", true);
    recognition.emitTranscript("open the current thread", true);
    listener?.pause();

    finishCommand();
    await commandFinished;
    await Promise.resolve();
    expect(FakeSpeechRecognition.instances).toHaveLength(1);

    listener?.resume();
    expect(FakeSpeechRecognition.instances).toHaveLength(2);
  });
  it("returns to wake-only listening for go to sleep or Escape", () => {
    FakeSpeechRecognition.instances = [];
    const onCommand = vi.fn();
    const onSleep = vi.fn();
    const states: VoiceWakePhraseState[] = [];
    const listener = createVoiceWakePhraseListener({
      recognitionConstructor: FakeSpeechRecognition as SpeechRecognitionConstructor,
      onCommand,
      onSleep,
      onStateChange: (state) => states.push(state),
    });

    listener?.start();
    const recognition = FakeSpeechRecognition.instances[0]!;
    recognition.emitTranscript("Hey Mai", true);
    recognition.emitTranscript("go to sleep", true);

    expect(onSleep).toHaveBeenCalledOnce();
    expect(onCommand).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe("listening");

    recognition.emitTranscript("Hey Mai", true);
    listener?.sleep();
    expect(onSleep).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("listening");
  });

  it("stops retrying after recognition access is blocked", () => {
    FakeSpeechRecognition.instances = [];
    const states: VoiceWakePhraseState[] = [];
    const schedule = vi.fn();
    const listener = createVoiceWakePhraseListener({
      recognitionConstructor: FakeSpeechRecognition as SpeechRecognitionConstructor,
      onCommand: vi.fn(),
      onStateChange: (state) => states.push(state),
      schedule,
    });

    listener?.start();
    const recognition = FakeSpeechRecognition.instances[0]!;
    recognition.emitError("not-allowed");
    recognition.onend?.();

    expect(states.at(-1)).toBe("blocked");
    expect(schedule).not.toHaveBeenCalled();
  });
});
