import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
  return fetchImplementation(new URL(path, config.baseUrl), {
    ...init,
    headers,
    signal: AbortSignal.timeout(MODEL_GATEWAY_TIMEOUT_MS),
  });
}

async function requestTranscription(config: ModelGatewayConfig, wav: Uint8Array) {
  const response = await fetchModelGateway(config, "/v1/stt", {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: wav,
  });
  const payload: unknown = response.ok ? await response.json() : null;
  return { response, payload };
}

async function requestSynthesis(config: ModelGatewayConfig, input: VoiceSynthesisInput) {
  const response = await fetchModelGateway(config, "/v1/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeUnknownJson(input),
  });
  const pcm = response.ok ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array();
  return { response, pcm };
}

export function encodePcm16Wav(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
): Uint8Array | null {
  if (
    pcm.byteLength === 0 ||
    pcm.byteLength % 2 !== 0 ||
    pcm.byteLength > 0xffff_ffff - 36 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 96_000 ||
    channels !== 1
  ) {
    return null;
  }

  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  wav.set([82, 73, 70, 70], 0);
  view.setUint32(4, 36 + pcm.byteLength, true);
  wav.set([87, 65, 86, 69], 8);
  wav.set([102, 109, 116, 32], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  wav.set([100, 97, 116, 97], 36);
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
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
    const upstream = yield* Effect.tryPromise({
      try: () => requestTranscription(gateway, wav),
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
    const text =
      typeof payload === "object" &&
      payload !== null &&
      "text" in payload &&
      typeof payload.text === "string"
        ? payload.text.trim()
        : "";
    if (!text || text.length > MAX_TRANSCRIPT_TEXT_LENGTH) {
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
      try: () => requestSynthesis(gateway, { text, backend }),
      catch: (cause) => new VoiceProxyError({ cause }),
    }).pipe(Effect.option);
    if (upstream._tag === "None") {
      return HttpServerResponse.text("Voice model gateway is unavailable.", { status: 502 });
    }
    const { response, pcm } = upstream.value;
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const sampleRate = Number(response.headers.get("x-audio-sample-rate"));
    const channels = Number(response.headers.get("x-audio-channels"));
    const wav =
      response.ok && contentType === "audio/l16" ? encodePcm16Wav(pcm, sampleRate, channels) : null;
    if (!response.ok || !wav) {
      return HttpServerResponse.text(
        response.status === 409 ? "Voice model gateway is busy." : "Speech synthesis failed.",
        { status: response.status === 409 ? 409 : 502 },
      );
    }
    return HttpServerResponse.uint8Array(wav, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "audio/wav",
      },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const voiceHttpRouteLayer = Layer.mergeAll(transcribeRouteLayer, synthesizeRouteLayer);
