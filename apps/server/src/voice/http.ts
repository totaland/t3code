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
const MAX_WAV_BYTES = 6 * 1024 * 1024;
const MAX_SPEECH_TEXT_LENGTH = 4_000;
const VOICE_SERVICE_TIMEOUT_MS = 45_000;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

type VoiceServiceConfig = {
  readonly baseUrl: URL;
  readonly apiKey: string;
};

export type VoiceFetch = (input: URL, init?: RequestInit) => Promise<Response>;

class VoiceProxyError extends Data.TaggedError("VoiceProxyError")<{
  readonly cause: unknown;
}> {}

export function resolveVoiceServiceConfig(input: {
  readonly voiceServiceUrl?: string | undefined;
  readonly voiceServiceApiKey?: string | undefined;
}): VoiceServiceConfig | null {
  const rawUrl = input.voiceServiceUrl?.trim();
  const apiKey = input.voiceServiceApiKey?.trim();
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

export async function fetchVoiceService(
  config: VoiceServiceConfig,
  path: "/v1/speech/transcribe" | "/v1/speech/synthesize",
  init: RequestInit,
  fetchImplementation: VoiceFetch = fetch,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-api-key", config.apiKey);
  return fetchImplementation(new URL(path, config.baseUrl), {
    ...init,
    headers,
    signal: AbortSignal.timeout(VOICE_SERVICE_TIMEOUT_MS),
  });
}

async function requestTranscription(config: VoiceServiceConfig, wav: Uint8Array) {
  const response = await fetchVoiceService(config, "/v1/speech/transcribe", {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: wav,
  });
  const payload: unknown = response.ok ? await response.json() : null;
  return { response, payload };
}

async function requestSynthesis(config: VoiceServiceConfig, text: string) {
  const response = await fetchVoiceService(config, "/v1/speech/synthesize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeUnknownJson({ text }),
  });
  const wav = response.ok ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array();
  return { response, wav };
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
    const service = resolveVoiceServiceConfig(config);
    if (!service) {
      return HttpServerResponse.text("Local voice service is not configured.", { status: 503 });
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
      try: () => requestTranscription(service, wav),
      catch: (cause) => new VoiceProxyError({ cause }),
    }).pipe(Effect.option);
    if (upstream._tag === "None") {
      return HttpServerResponse.text("Local voice service is unavailable.", { status: 502 });
    }
    const { response, payload } = upstream.value;
    if (!response.ok) {
      return HttpServerResponse.text(
        response.status === 409 ? "Local voice service is busy." : "Transcription failed.",
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
    if (!text || text.length > MAX_SPEECH_TEXT_LENGTH) {
      return HttpServerResponse.text("Local voice service returned an invalid transcript.", {
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
    const service = resolveVoiceServiceConfig(config);
    if (!service) {
      return HttpServerResponse.text("Local voice service is not configured.", { status: 503 });
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
    if (!text || text.length > MAX_SPEECH_TEXT_LENGTH) {
      return HttpServerResponse.text("Speech text is empty or too long.", { status: 422 });
    }
    const upstream = yield* Effect.tryPromise({
      try: () => requestSynthesis(service, text),
      catch: (cause) => new VoiceProxyError({ cause }),
    }).pipe(Effect.option);
    if (upstream._tag === "None") {
      return HttpServerResponse.text("Local voice service is unavailable.", { status: 502 });
    }
    const { response, wav } = upstream.value;
    if (!response.ok || !response.headers.get("content-type")?.startsWith("audio/wav")) {
      return HttpServerResponse.text(
        response.status === 409 ? "Local voice service is busy." : "Speech synthesis failed.",
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
