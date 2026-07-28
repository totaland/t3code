export type VoiceEngine =
  | "kokoro"
  | "qwen_voice_design"
  | "qwen_voice_clone"
  | "cosyvoice3"
  | "step_audio_editx";

export type VoiceSynthesisSettings = {
  readonly engine: VoiceEngine;
  readonly voiceInstruction?: string;
  readonly voiceProfileId?: string;
};

export const voiceEngineOptions: ReadonlyArray<{ value: VoiceEngine; label: string }> = [
  { value: "kokoro", label: "Kokoro" },
  { value: "qwen_voice_design", label: "Qwen Voice Design" },
  { value: "qwen_voice_clone", label: "Qwen Voice Clone" },
  { value: "cosyvoice3", label: "CosyVoice 3" },
  { value: "step_audio_editx", label: "Step Audio EditX" },
];

const STORAGE_KEY = "t3.voice.synthesis";
const DEFAULT_SETTINGS: VoiceSynthesisSettings = { engine: "kokoro" };
const voiceEngines = new Set(voiceEngineOptions.map((option) => option.value));

export function getVoiceSynthesisSettings(): VoiceSynthesisSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof value !== "object" || value === null || !("engine" in value))
      return DEFAULT_SETTINGS;
    const engine = value.engine;
    if (typeof engine !== "string" || !voiceEngines.has(engine as VoiceEngine))
      return DEFAULT_SETTINGS;
    const voiceInstruction =
      "voiceInstruction" in value && typeof value.voiceInstruction === "string"
        ? value.voiceInstruction.trim().slice(0, 500)
        : undefined;
    const voiceProfileId =
      "voiceProfileId" in value && typeof value.voiceProfileId === "string"
        ? value.voiceProfileId.trim()
        : undefined;
    return {
      engine: engine as VoiceEngine,
      ...(voiceInstruction ? { voiceInstruction } : {}),
      ...(voiceProfileId ? { voiceProfileId } : {}),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function setVoiceSynthesisSettings(settings: VoiceSynthesisSettings): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event("t3-voice-settings"));
}

export function subscribeVoiceSynthesisSettings(listener: () => void): () => void {
  window.addEventListener("storage", listener);
  window.addEventListener("t3-voice-settings", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("t3-voice-settings", listener);
  };
}
