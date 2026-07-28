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
