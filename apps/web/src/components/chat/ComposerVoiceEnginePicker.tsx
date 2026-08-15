import { AudioLinesIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  getVoiceSynthesisSettings,
  setVoiceSynthesisSettings,
  subscribeVoiceSynthesisSettings,
  type VoiceBackend,
  voiceBackendOptions,
} from "../../voice/voiceSettings";
import { ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";

export function ComposerVoiceEnginePicker() {
  const [settings, setSettings] = useState(getVoiceSynthesisSettings);
  useEffect(
    () => subscribeVoiceSynthesisSettings(() => setSettings(getVoiceSynthesisSettings())),
    [],
  );
  const selected = voiceBackendOptions.find((option) => option.value === settings.backend)!;

  const selectBackend = (backend: VoiceBackend) => {
    setVoiceSynthesisSettings({ backend });
  };

  return (
    <Select
      value={settings.backend}
      onValueChange={(value) => selectBackend(value as VoiceBackend)}
    >
      <ComposerSelectControl aria-label="Voice backend" className="max-w-44">
        <ComposerControlIcon icon={AudioLinesIcon} />
        <SelectValue>{selected.label}</SelectValue>
      </ComposerSelectControl>
      <SelectPopup alignItemWithTrigger={false}>
        {voiceBackendOptions.map((option) => (
          <SelectItem key={option.value} value={option.value} className="min-w-56">
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
