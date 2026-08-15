export type VoiceBackend = "auto" | "qwen3" | "kokoro" | "step_audio_editx";

export type VoiceSynthesisSettings = {
  readonly backend: VoiceBackend;
};

export const voiceBackendOptions: ReadonlyArray<{ value: VoiceBackend; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "qwen3", label: "Qwen3-TTS" },
  { value: "kokoro", label: "Kokoro" },
  { value: "step_audio_editx", label: "Step-Audio-EditX" },
];

const STORAGE_KEY = "t3.voice.backend";
const DEFAULT_SETTINGS: VoiceSynthesisSettings = { backend: "auto" };
const voiceBackends = new Set(voiceBackendOptions.map((option) => option.value));

export function getVoiceSynthesisSettings(): VoiceSynthesisSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof value !== "object" || value === null || !("backend" in value)) {
      return DEFAULT_SETTINGS;
    }
    const backend = value.backend;
    if (typeof backend !== "string" || !voiceBackends.has(backend as VoiceBackend)) {
      return DEFAULT_SETTINGS;
    }
    return { backend: backend as VoiceBackend };
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
