import {
  ArrowLeftIcon,
  AudioLinesIcon,
  HistoryIcon,
  MicIcon,
  MicOffIcon,
  MoonIcon,
  PhoneOffIcon,
  Volume2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../types";
import type { VoiceFetch } from "../../voice/voiceClient";
import { Button } from "../ui/button";
import {
  isVoiceCapabilityUnavailable,
  type VoiceTurnPhase,
  useVoiceSessionController,
} from "../../voice/useVoiceSessionController";

export function VoiceChatPage(props: {
  readonly httpBaseUrl: string | null;
  readonly fetchImplementation: VoiceFetch;
  readonly disabled?: boolean;
  readonly messages: readonly ChatMessage[];
  readonly phase: VoiceTurnPhase;
  readonly projectTitle: string | null;
  readonly threadTitle: string;
  readonly onCaptureCancelled: () => void;
  readonly onInterrupt: () => void | Promise<void>;
  readonly onPlaybackUnlock: () => Promise<unknown>;
  readonly onReturnToText: () => void;
  readonly onTranscript: (transcript: string) => Promise<void>;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mainRef.current?.focus();
  }, []);
  const session = useVoiceSessionController({
    disabled: props.disabled,
    fetchImplementation: props.fetchImplementation,
    httpBaseUrl: props.httpBaseUrl,
    onCaptureCancelled: props.onCaptureCancelled,
    onInterrupt: props.onInterrupt,
    onPlaybackUnlock: props.onPlaybackUnlock,
    phase: props.phase,
    onTranscript: props.onTranscript,
  });
  const recentMessages = props.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-10);
  const unavailable =
    isVoiceCapabilityUnavailable(session.captureMode, session.listenerState) &&
    !session.canEnableBrowserFallback;
  const phaseIcon =
    props.phase === "speaking" ? (
      <Volume2Icon className="size-14" aria-hidden />
    ) : (
      <AudioLinesIcon className="size-14" aria-hidden />
    );

  const endAndReturn = () => {
    session.micOff();
    props.onReturnToText();
  };

  return (
    <main
      ref={mainRef}
      tabIndex={-1}
      aria-label="Voice conversation"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="flex min-h-14 items-center gap-3 border-b border-border/60 px-[calc(env(safe-area-inset-left)+1rem)] pr-[calc(env(safe-area-inset-right)+1rem)]">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Return to text conversation"
          onClick={endAndReturn}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0">
          <p className="truncate font-medium text-sm">{props.threadTitle}</p>
          {props.projectTitle ? (
            <p className="truncate text-muted-foreground text-xs">{props.projectTitle}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label={historyOpen ? "Hide transcript history" : "Show transcript history"}
          aria-pressed={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <HistoryIcon />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-5 py-8 text-center">
          <div
            aria-hidden
            data-voice-phase={props.phase}
            className="grid size-[min(68vw,20rem)] shrink-0 place-items-center rounded-full border border-primary/20 bg-primary/5 text-primary shadow-[0_0_100px_-35px_hsl(var(--primary))] motion-safe:transition-transform motion-safe:duration-500 data-[voice-phase=speaking]:motion-safe:scale-105"
          >
            {phaseIcon}
          </div>
          <div className="max-w-xl space-y-2">
            <p className="font-medium text-xl" role="status" aria-live="polite">
              {session.statusText}
            </p>
            <p className="min-h-10 text-muted-foreground text-sm">
              {session.liveTranscript ||
                (session.sleeping
                  ? "Wake-word detection remains on. Conversation capture is paused."
                  : session.enabled
                    ? "Say “Hey Mai”, then speak naturally."
                    : "Microphone capture is fully stopped.")}
            </p>
          </div>

          {unavailable ? (
            <div
              className="max-w-md rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-left"
              role="alert"
            >
              <p className="font-medium">Voice capability unavailable</p>
              <p className="mt-1 text-muted-foreground text-sm">
                {session.unavailableReason ??
                  "Check browser microphone permission, or continue in this same text conversation."}
              </p>
              <Button className="mt-3" variant="outline" onClick={endAndReturn}>
                Continue in text
              </Button>
            </div>
          ) : null}

          {session.canEnableBrowserFallback && !session.enabled ? (
            <div className="max-w-md rounded-xl border border-border bg-muted/30 p-4 text-left">
              <p className="font-medium">Local transcription unavailable</p>
              <p className="mt-1 text-muted-foreground text-sm">
                Browser speech recognition may process audio online. It never starts without your
                explicit choice.
              </p>
              <Button className="mt-3" variant="outline" onClick={session.enableBrowserFallback}>
                Use browser speech fallback
              </Button>
            </div>
          ) : null}

          {session.listenerState === "needs-interaction" ? (
            <Button variant="outline" onClick={session.unlock}>
              Enable audio
            </Button>
          ) : null}
        </section>

        {historyOpen ? (
          <aside
            className="max-h-[42dvh] overflow-y-auto border-t border-border/60 bg-muted/20 p-4 md:max-h-none md:w-80 md:border-t-0 md:border-l"
            aria-label="Conversation transcript"
          >
            <h2 className="mb-3 font-medium text-sm">Conversation</h2>
            <ol className="space-y-3">
              {recentMessages.map((message) => (
                <li key={message.id}>
                  <p className="text-muted-foreground text-xs">
                    {message.role === "user" ? "You" : "Mai"}
                  </p>
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm">{message.text}</p>
                </li>
              ))}
            </ol>
          </aside>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-border/60 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 rounded-full"
          disabled={!session.enabled}
          aria-label="Sleep; keep wake-word detection on"
          onClick={session.sleep}
        >
          <MoonIcon />
          Sleep
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 rounded-full"
          disabled={!session.enabled && !session.canTurnMicOn}
          aria-pressed={session.enabled}
          aria-label={
            session.enabled ? "Turn microphone capture off" : "Turn microphone capture on"
          }
          onClick={session.enabled ? session.micOff : session.micOn}
        >
          {session.enabled ? <MicIcon /> : <MicOffIcon />}
          {session.enabled ? "Mic on" : "Mic off"}
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="min-h-11 rounded-full"
          aria-label="End voice and return to text conversation"
          onClick={endAndReturn}
        >
          <PhoneOffIcon />
          End
        </Button>
      </footer>
    </main>
  );
}
