import { nextVoicePlaybackStartTime } from "./voicePlayback";

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

export async function* readPcm16Chunks(
  body: ReadableStream<Uint8Array<ArrayBufferLike>>,
  minimumChunkBytes: number,
): AsyncGenerator<Uint8Array<ArrayBufferLike>> {
  const reader = body.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      pending = appendBytes(pending, result.value);
      const completeBytes = pending.byteLength - (pending.byteLength % 2);
      if (completeBytes < minimumChunkBytes) continue;
      yield pending.slice(0, completeBytes);
      pending = pending.slice(completeBytes);
    }
    if (pending.byteLength % 2 !== 0) {
      throw new Error("Streaming PCM ended with an incomplete sample.");
    }
    if (pending.byteLength > 0) yield pending;
  } finally {
    reader.releaseLock();
  }
}

export function decodePcm16Le(pcm: Uint8Array<ArrayBufferLike>): Float32Array<ArrayBuffer> {
  if (pcm.byteLength % 2 !== 0) throw new Error("PCM16 audio must contain complete samples.");
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(pcm.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return samples;
}

type ActiveSource = {
  readonly source: AudioBufferSourceNode;
  readonly finish: () => void;
};

export class VoicePcmStreamPlayer {
  private readonly activeSources = new Set<ActiveSource>();
  private scheduledUntil = 0;

  constructor(private readonly context: AudioContext) {}

  stop(): void {
    for (const active of this.activeSources) {
      try {
        active.source.stop();
      } catch {
        // The source may already have ended.
      }
      active.source.disconnect();
      active.finish();
    }
    this.activeSources.clear();
    this.scheduledUntil = 0;
  }

  async enqueue(input: {
    readonly backend: string;
    readonly body: ReadableStream<Uint8Array>;
    readonly sampleRate: number;
    readonly signal: AbortSignal;
    readonly shouldContinue: () => boolean;
  }): Promise<{ readonly playback: Promise<void> }> {
    await this.context.resume();
    const endings: Promise<void>[] = [];
    const minimumChunkBytes = Math.max(2, Math.floor(input.sampleRate * 0.08) * 2);
    try {
      for await (const pcm of readPcm16Chunks(input.body, minimumChunkBytes)) {
        if (input.signal.aborted || !input.shouldContinue()) {
          throw new DOMException("Voice stream was cancelled.", "AbortError");
        }
        const samples = decodePcm16Le(pcm);
        const buffer = this.context.createBuffer(1, samples.length, input.sampleRate);
        buffer.copyToChannel(samples, 0);
        const startAt = nextVoicePlaybackStartTime({
          backend: input.backend,
          currentTime: this.context.currentTime,
          hasPendingPlayback: this.activeSources.size > 0,
          scheduledUntil: this.scheduledUntil,
        });
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        this.scheduledUntil = startAt + buffer.duration;
        let finishPlayback!: () => void;
        const ended = new Promise<void>((resolve) => {
          finishPlayback = resolve;
        });
        const active: ActiveSource = { source, finish: finishPlayback };
        this.activeSources.add(active);
        source.addEventListener(
          "ended",
          () => {
            if (this.activeSources.delete(active)) source.disconnect();
            finishPlayback();
          },
          { once: true },
        );
        source.start(startAt);
        endings.push(ended);
      }
      if (endings.length === 0) throw new Error("Local speech synthesis returned no audio.");
      return { playback: Promise.all(endings).then(() => undefined) };
    } catch (error) {
      this.stop();
      throw error;
    }
  }
}
