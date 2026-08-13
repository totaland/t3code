import { AudioLinesIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

export function ComposerVoiceWakePhraseButton(props: {
  readonly disabled?: boolean;
  readonly onEnterVoice: () => void;
  readonly onPlaybackUnlock: () => Promise<unknown>;
}) {
  const label = props.disabled ? "Voice conversation unavailable" : "Open voice conversation";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="relative shrink-0 rounded-full text-muted-foreground/70 hover:text-foreground"
            disabled={props.disabled}
            aria-label={label}
            onClick={() => {
              void props.onPlaybackUnlock().catch((error: unknown) => {
                toastManager.add({
                  type: "error",
                  title: "Audio playback unavailable",
                  description:
                    error instanceof Error ? error.message : "The browser blocked audio playback.",
                });
              });
              props.onEnterVoice();
            }}
          />
        }
      >
        <AudioLinesIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
