import { getVoiceSynthesisSettings } from "./voiceSettings";
export type VoiceFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function voiceEndpoint(baseUrl: string, path: string): URL {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const detail = (await response.text()).trim();
  return new Error(detail || fallback);
}

export async function transcribeVoiceWav(input: {
  readonly httpBaseUrl: string;
  readonly wav: Blob;
  readonly signal?: AbortSignal;
  readonly fetchImplementation?: VoiceFetch;
}): Promise<string> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    voiceEndpoint(input.httpBaseUrl, "/api/voice/transcribe"),
    {
      method: "POST",
      body: input.wav,
      credentials: "include",
      headers: { "content-type": "audio/wav" },
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
  if (!text) throw new Error("No speech was detected.");
  return text;
}

export async function synthesizeVoiceReply(input: {
  readonly httpBaseUrl: string;
  readonly text: string;
  readonly signal?: AbortSignal;
  readonly fetchImplementation?: VoiceFetch;
}): Promise<Blob> {
  const settings = getVoiceSynthesisSettings();
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    voiceEndpoint(input.httpBaseUrl, "/api/voice/synthesize"),
    {
      method: "POST",
      body: JSON.stringify({ text: input.text, backend: settings.backend }),
      credentials: "include",
      headers: { "content-type": "application/json" },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (!response.ok) throw await responseError(response, "Local speech synthesis failed.");
  const audio = await response.blob();
  if (!audio.type.startsWith("audio/wav") || audio.size === 0) {
    throw new Error("Local speech synthesis returned invalid audio.");
  }
  return audio;
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
      return { messageId: message.id, text: remainingText };
    }

    const sentenceBoundary = /[.!?](?:\s+|$)|\n+/u.exec(remainingText);
    if (sentenceBoundary) {
      const chunkEnd = sentenceBoundary.index + sentenceBoundary[0].length;
      return { messageId: message.id, text: remainingText.slice(0, chunkEnd) };
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
