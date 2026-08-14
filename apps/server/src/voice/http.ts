import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as ServerConfig from "../config.ts";

const TRANSCRIBE_PATH = "/api/voice/transcribe";
const SYNTHESIZE_PATH = "/api/voice/synthesize";
const MAX_WAV_BYTES = 20 * 1024 * 1024;
const MAX_TRANSCRIPT_TEXT_LENGTH = 4_000;
const MAX_TTS_TEXT_LENGTH = 1_500;
const MODEL_GATEWAY_TIMEOUT_MS = 45_000;
const VOICE_BACKENDS = new Set(["auto", "qwen3", "kokoro", "step_audio_editx"]);

export function isSupportedVoiceBackend(value: string): boolean {
  return VOICE_BACKENDS.has(value);
}
type VoiceSynthesisInput = {
  readonly text: string;
  readonly backend: string;
};
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

type ModelGatewayConfig = {
  readonly baseUrl: URL;
  readonly apiKey: string;
};

export type VoiceFetch = (input: URL, init?: RequestInit) => Promise<Response>;

class VoiceProxyError extends Data.TaggedError("VoiceProxyError")<{
  readonly cause: unknown;
}> {}

export function resolveModelGatewayConfig(input: {
  readonly modelGatewayUrl?: string | undefined;
  readonly modelGatewayApiKey?: string | undefined;
}): ModelGatewayConfig | null {
  const rawUrl = input.modelGatewayUrl?.trim();
  const apiKey = input.modelGatewayApiKey?.trim();
  if (!rawUrl || !apiKey || apiKey.length < 16) return null;
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    baseUrl.protocol !== "http:" ||
    !LOOPBACK_HOSTNAMES.has(baseUrl.hostname.toLowerCase()) ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== "" ||
    (baseUrl.pathname !== "" && baseUrl.pathname !== "/")
  ) {
    return null;
  }
  return { baseUrl, apiKey };
}

export async function fetchModelGateway(
  config: ModelGatewayConfig,
  path: "/v1/stt" | "/v1/tts",
  init: RequestInit,
  fetchImplementation: VoiceFetch = fetch,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${config.apiKey}`);
  const timeoutSignal = AbortSignal.timeout(MODEL_GATEWAY_TIMEOUT_MS);
  return fetchImplementation(new URL(path, config.baseUrl), {
    ...init,
    headers,
    signal: init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
  });
}

export async function requestTranscription(
  config: ModelGatewayConfig,
  wav: Uint8Array,
  replyBackend: string,
  fetchImplementation: VoiceFetch = fetch,
  signal?: AbortSignal,
) {
  const response = await fetchModelGateway(
    config,
    "/v1/stt",
    {
      method: "POST",
      headers: {
        "content-type": "audio/wav",
        "x-tts-backend": replyBackend,
      },
      body: wav,
      signal,
    },
    fetchImplementation,
  );
  const payload: unknown = response.ok ? await response.json() : null;
  return { response, payload };
}

export function readTranscriptionText(payload: unknown): string | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("text" in payload) ||
    typeof payload.text !== "string"
  ) {
    return null;
  }
  const text = payload.text.trim();
  return text.length <= MAX_TRANSCRIPT_TEXT_LENGTH ? text : null;
}

async function requestSynthesis(
  config: ModelGatewayConfig,
  input: VoiceSynthesisInput,
  signal?: AbortSignal,
) {
  return fetchModelGateway(config, "/v1/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeUnknownJson(input),
    signal,
  });
}

export function readPcmStreamMetadata(
  response: Response,
): { readonly sampleRate: number; readonly channels: 1 } | null {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const sampleRate = Number(response.headers.get("x-audio-sample-rate"));
  const channels = Number(response.headers.get("x-audio-channels"));
  if (
    contentType !== "audio/l16" ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 96_000 ||
    channels !== 1
  ) {
    return null;
  }
  return { sampleRate, channels: 1 };
}

export function createPcmStreamResponse(
  body: ReadableStream<Uint8Array>,
  metadata: { readonly sampleRate: number; readonly channels: 1 },
) {
  const stream = Stream.fromReadableStream({
    evaluate: () => body,
    onError: (cause) => new VoiceProxyError({ cause }),
  });
  return HttpServerResponse.stream(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "audio/L16",
      "X-Audio-Channels": String(metadata.channels),
      "X-Audio-Sample-Rate": String(metadata.sampleRate),
    },
  });
}

const authorizeVoiceRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
});

const transcribeRouteLayer = HttpRouter.add(
  "POST",
  TRANSCRIBE_PATH,
  Effect.gen(function* () {
    yield* authorizeVoiceRoute;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const gateway = resolveModelGatewayConfig(config);
    if (!gateway) {
      return HttpServerResponse.text("Voice model gateway is not configured.", { status: 503 });
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "audio/wav") {
      return HttpServerResponse.text("Content-Type must be audio/wav.", { status: 415 });
    }
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WAV_BYTES) {
      return HttpServerResponse.text("WAV audio is too large.", { status: 413 });
    }
    const wav = new Uint8Array(yield* request.arrayBuffer);
    if (wav.byteLength === 0 || wav.byteLength > MAX_WAV_BYTES) {
      return HttpServerResponse.text("WAV audio is empty or too large.", {
        status: wav.byteLength === 0 ? 422 : 413,
      });
    }
    const replyBackend = request.headers["x-tts-backend"]?.trim().toLowerCase() ?? "auto";
    if (!isSupportedVoiceBackend(replyBackend)) {
      return HttpServerResponse.text("Unknown voice backend.", { status: 422 });
    }
    const upstream = yield* Effect.tryPromise({
      try: (signal) => requestTranscription(gateway, wav, replyBackend, fetch, signal),
      catch: (cause) => new VoiceProxyError({ cause }),
    }).pipe(Effect.option);
    if (upstream._tag === "None") {
      return HttpServerResponse.text("Voice model gateway is unavailable.", { status: 502 });
    }
    const { response, payload } = upstream.value;
    if (!response.ok) {
      return HttpServerResponse.text(
        response.status === 409 ? "Voice model gateway is busy." : "Transcription failed.",
        { status: response.status === 409 ? 409 : 502 },
      );
    }
    const text = readTranscriptionText(payload);
    if (text === null) {
      return HttpServerResponse.text("Voice model gateway returned an invalid transcript.", {
        status: 502,
      });
    }
    return HttpServerResponse.jsonUnsafe({ text }, { headers: { "Cache-Control": "no-store" } });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

const synthesizeRouteLayer = HttpRouter.add(
  "POST",
  SYNTHESIZE_PATH,
  Effect.gen(function* () {
    yield* authorizeVoiceRoute;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const gateway = resolveModelGatewayConfig(config);
    if (!gateway) {
      return HttpServerResponse.text("Voice model gateway is not configured.", { status: 503 });
    }
    const payload = yield* request.json.pipe(Effect.option);
    const text =
      payload._tag === "Some" &&
      typeof payload.value === "object" &&
      payload.value !== null &&
      "text" in payload.value &&
      typeof payload.value.text === "string"
        ? payload.value.text.trim()
        : "";
    const value =
      payload._tag === "Some" && typeof payload.value === "object" && payload.value !== null
        ? payload.value
        : null;
    const backend =
      value && "backend" in value && typeof value.backend === "string" ? value.backend : "auto";
    if (!text || text.length > MAX_TTS_TEXT_LENGTH) {
      return HttpServerResponse.text("Speech text is empty or too long.", { status: 422 });
    }
    if (!isSupportedVoiceBackend(backend)) {
      return HttpServerResponse.text("Unknown voice backend.", { status: 422 });
    }
    const upstream = yield* Effect.tryPromise({
      try: (signal) => requestSynthesis(gateway, { text, backend }, signal),
      catch: (cause) => new VoiceProxyError({ cause }),
    }).pipe(Effect.option);
    if (upstream._tag === "None") {
      return HttpServerResponse.text("Voice model gateway is unavailable.", { status: 502 });
    }
    const response = upstream.value;
    const metadata = readPcmStreamMetadata(response);
    if (!response.ok || !metadata || !response.body) {
      return HttpServerResponse.text(
        response.status === 409 ? "Voice model gateway is busy." : "Speech synthesis failed.",
        { status: response.status === 409 ? 409 : 502 },
      );
    }
    return createPcmStreamResponse(response.body, metadata);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const voiceHttpRouteLayer = Layer.mergeAll(transcribeRouteLayer, synthesizeRouteLayer);
