import { getVoiceSynthesisSettings } from "./voiceSettings";
export type VoiceFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function voiceEndpoint(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

export class VoiceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VoiceHttpError";
  }
}
async function responseError(response: Response, fallback: string): Promise<Error> {
  const detail = (await response.text()).trim();
  return new VoiceHttpError(detail || fallback, response.status);
}

export function isRetryableVoiceTranscriptionError(error: unknown): boolean {
  return (
    error instanceof VoiceHttpError &&
    (error.status === 409 || error.status === 429 || error.status >= 500)
  );
}

export async function transcribeVoiceWav(input: {
  readonly httpBaseUrl: string;
  readonly wav: Blob;
  readonly signal?: AbortSignal;
  readonly fetchImplementation?: VoiceFetch;
}): Promise<string> {
  const settings = getVoiceSynthesisSettings();
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    voiceEndpoint(input.httpBaseUrl, "/api/voice/transcribe"),
    {
      method: "POST",
      body: input.wav,
      headers: {
        "content-type": "audio/wav",
        "x-tts-backend": settings.backend,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (!response.ok) throw await responseError(response, "Local transcription failed.");
  const payload: unknown = await response.json();
  const text =
    typeof payload === "object" &&
    payload !== null &&
    "text" in payload &&
    typeof payload.text === "string"
      ? payload.text.trim()
      : "";
  return text;
}

export type VoiceReplyPcmStream = {
  readonly backend: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly channels: 1;
  readonly sampleRate: number;
};
export async function synthesizeVoiceReplyStream(input: {
  readonly httpBaseUrl: string;
  readonly text: string;
  readonly signal?: AbortSignal;
  readonly fetchImplementation?: VoiceFetch;
}): Promise<VoiceReplyPcmStream> {
  const settings = getVoiceSynthesisSettings();
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    voiceEndpoint(input.httpBaseUrl, "/api/voice/synthesize"),
    {
      method: "POST",
      body: JSON.stringify({ text: input.text, backend: settings.backend }),
      headers: { "content-type": "application/json" },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (!response.ok) throw await responseError(response, "Local speech synthesis failed.");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
  const sampleRate = Number(response.headers.get("x-audio-sample-rate"));
  const channels = Number(response.headers.get("x-audio-channels"));
  if (
    contentType !== "audio/l16" ||
    !response.body ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 96_000 ||
    channels !== 1
  ) {
    throw new Error("Local speech synthesis returned an invalid PCM stream.");
  }
  return { backend: settings.backend, body: response.body, channels: 1, sampleRate };
}

export function normalizeAssistantTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " Code block omitted. ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/[*_~>#]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_500);
}

// Step-Audio-EditX can OOM on this GPU with otherwise valid 900+ character
// requests. Keep the client chunks small; long replies are still queued in order.
const MAX_VOICE_SPEECH_CHUNK_LENGTH = 500;

function boundVoiceSpeechChunk(text: string): string {
  if (text.length <= MAX_VOICE_SPEECH_CHUNK_LENGTH) return text;

  const limitedText = text.slice(0, MAX_VOICE_SPEECH_CHUNK_LENGTH);
  const sentenceBoundaries = [...limitedText.matchAll(/[.!?](?:\s+|$)|\n+/gu)];
  const lastSentenceBoundary = sentenceBoundaries.at(-1);
  const sentenceEnd = lastSentenceBoundary
    ? lastSentenceBoundary.index! + lastSentenceBoundary[0].length
    : 0;
  if (sentenceEnd >= MAX_VOICE_SPEECH_CHUNK_LENGTH * 0.6) {
    return limitedText.slice(0, sentenceEnd);
  }

  const lastWhitespace = limitedText.lastIndexOf(" ");
  return limitedText.slice(0, lastWhitespace > 0 ? lastWhitespace + 1 : limitedText.length);
}

export type VoiceTurnMessage = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
};

export function completedAssistantTextForVoiceTurn(
  messages: ReadonlyArray<VoiceTurnMessage>,
  userMessageId: string,
): string | null {
  const userMessageIndex = messages.findIndex(
    (message) => message.id === userMessageId && message.role === "user",
  );
  if (userMessageIndex < 0) return null;

  let completedText: string | null = null;
  for (const message of messages.slice(userMessageIndex + 1)) {
    if (message.role === "user") break;
    if (message.role === "assistant" && !message.streaming && message.text.trim().length > 0) {
      completedText = message.text;
    }
  }
  return completedText;
}

export type CompletedAssistantVoiceMessage = {
  readonly messageId: string;
  readonly text: string;
};

export function nextAssistantSpeechChunkForVoiceTurn(
  messages: ReadonlyArray<VoiceTurnMessage>,
  userMessageId: string,
  spokenAssistantProgress: ReadonlyMap<string, number> | ReadonlySet<string>,
): CompletedAssistantVoiceMessage | null {
  const userMessageIndex = messages.findIndex(
    (message) => message.id === userMessageId && message.role === "user",
  );
  if (userMessageIndex < 0) return null;

  for (const message of messages.slice(userMessageIndex + 1)) {
    if (message.role === "user") break;
    if (message.role !== "assistant" || message.text.trim().length === 0) continue;

    const spokenOffset =
      "get" in spokenAssistantProgress
        ? Math.min(spokenAssistantProgress.get(message.id) ?? 0, message.text.length)
        : spokenAssistantProgress.has(message.id)
          ? message.text.length
          : 0;
    if (spokenOffset >= message.text.length) continue;

    const remainingText = message.text.slice(spokenOffset);
    if (!message.streaming) {
      return { messageId: message.id, text: boundVoiceSpeechChunk(remainingText) };
    }

    const sentenceBoundary = /[.!?](?:\s+|$)|\n+/u.exec(remainingText);
    if (sentenceBoundary) {
      const chunkEnd = sentenceBoundary.index + sentenceBoundary[0].length;
      return {
        messageId: message.id,
        text: boundVoiceSpeechChunk(remainingText.slice(0, chunkEnd)),
      };
    }
  }
  return null;
}

export type VoiceTurnResolution =
  | { readonly status: "pending" }
  | { readonly status: "empty" }
  | { readonly status: "ready"; readonly messageId: string; readonly text: string };

export function resolveVoiceTurnResponse(
  messages: ReadonlyArray<VoiceTurnMessage>,
  userMessageId: string,
  turnSettled: boolean,
  spokenAssistantProgress: ReadonlyMap<string, number> | ReadonlySet<string> = new Map(),
): VoiceTurnResolution {
  const userMessageExists = messages.some(
    (message) => message.id === userMessageId && message.role === "user",
  );
  if (!userMessageExists) return { status: "pending" };

  const message = nextAssistantSpeechChunkForVoiceTurn(
    messages,
    userMessageId,
    spokenAssistantProgress,
  );
  if (message) return { status: "ready", ...message };
  return turnSettled ? { status: "empty" } : { status: "pending" };
}
