import { AudioLinesIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getVoiceSynthesisSettings,
  setVoiceSynthesisSettings,
  subscribeVoiceSynthesisSettings,
  type VoiceEngine,
  voiceEngineOptions,
} from "../../voice/voiceSettings";
import { ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";

export function ComposerVoiceEnginePicker() {
  const [settings, setSettings] = useState(getVoiceSynthesisSettings);
  useEffect(
    () => subscribeVoiceSynthesisSettings(() => setSettings(getVoiceSynthesisSettings())),
    [],
  );
  const selected = voiceEngineOptions.find((option) => option.value === settings.engine)!;

  const selectEngine = (engine: VoiceEngine) => {
    if (engine === "qwen_voice_design") {
      const instruction = window.prompt(
        "Describe the voice to generate",
        settings.voiceInstruction ?? "A warm, natural Australian English voice",
      );
      if (!instruction?.trim()) return;
      setVoiceSynthesisSettings({ engine, voiceInstruction: instruction.trim() });
      return;
    }
    setVoiceSynthesisSettings({
      engine,
      ...(["qwen_voice_clone", "cosyvoice3", "step_audio_editx"].includes(engine)
        ? { voiceProfileId: settings.voiceProfileId ?? "latest" }
        : {}),
    });
  };

  return (
    <Select value={settings.engine} onValueChange={(value) => selectEngine(value as VoiceEngine)}>
      <ComposerSelectControl aria-label="Voice engine" className="max-w-44">
        <ComposerControlIcon icon={AudioLinesIcon} />
        <SelectValue>{selected.label}</SelectValue>
      </ComposerSelectControl>
      <SelectPopup alignItemWithTrigger={false}>
        {voiceEngineOptions.map((option) => (
          <SelectItem key={option.value} value={option.value} className="min-w-56">
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
