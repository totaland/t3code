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
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    voiceEndpoint(input.httpBaseUrl, "/api/voice/synthesize"),
    {
      method: "POST",
      body: JSON.stringify({ text: input.text }),
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
    .slice(0, 4_000);
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

export function nextCompletedAssistantMessageForVoiceTurn(
  messages: ReadonlyArray<VoiceTurnMessage>,
  userMessageId: string,
  spokenAssistantMessageIds: ReadonlySet<string>,
): CompletedAssistantVoiceMessage | null {
  const userMessageIndex = messages.findIndex(
    (message) => message.id === userMessageId && message.role === "user",
  );
  if (userMessageIndex < 0) return null;

  for (const message of messages.slice(userMessageIndex + 1)) {
    if (
      message.role === "assistant" &&
      !message.streaming &&
      message.text.trim().length > 0 &&
      !spokenAssistantMessageIds.has(message.id)
    ) {
      return { messageId: message.id, text: message.text };
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
  spokenAssistantMessageIds: ReadonlySet<string> = new Set(),
): VoiceTurnResolution {
  const userMessageExists = messages.some(
    (message) => message.id === userMessageId && message.role === "user",
  );
  if (!userMessageExists) return { status: "pending" };

  const message = nextCompletedAssistantMessageForVoiceTurn(
    messages,
    userMessageId,
    spokenAssistantMessageIds,
  );
  if (message) return { status: "ready", ...message };
  return turnSettled ? { status: "empty" } : { status: "pending" };
}
