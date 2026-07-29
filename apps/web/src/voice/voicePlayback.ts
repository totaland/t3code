export async function primeVoicePlaybackContext(context: AudioContext): Promise<void> {
  const resume = context.resume();
  const frameCount = Math.max(1, Math.floor(context.sampleRate * 0.05));
  const buffer = context.createBuffer(1, frameCount, context.sampleRate);
  buffer.getChannelData(0)[0] = 0.0001;

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.addEventListener(
    "ended",
    () => {
      source.disconnect();
    },
    { once: true },
  );
  source.start();
  await resume;
}

const MIN_PLAYBACK_LEAD_SECONDS = 0.025;
const STEP_AUDIO_PLAYBACK_LOOKAHEAD_SECONDS = 1.1;

export function nextVoicePlaybackStartTime(input: {
  backend: string;
  currentTime: number;
  hasPendingPlayback: boolean;
  scheduledUntil: number;
}): number {
  const leadSeconds =
    !input.hasPendingPlayback && input.backend === "step_audio_editx"
      ? STEP_AUDIO_PLAYBACK_LOOKAHEAD_SECONDS
      : MIN_PLAYBACK_LEAD_SECONDS;
  return Math.max(input.scheduledUntil, input.currentTime + leadSeconds);
}
