import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { MAX_PHONE_REPLY_LENGTH, phoneReplyText, phoneSessionStore } from "./phone.ts";

import { authorizeVoiceRoute } from "./http.ts";
const PHONE_HEALTH_PATH = "/api/voice/phone/health";
const PHONE_SESSIONS_PATH = "/api/voice/phone/sessions";
const PHONE_TURN_PATH = "/api/voice/phone/sessions/:sessionId/turn";
const PHONE_ABORT_PATH = "/api/voice/phone/sessions/:sessionId/abort";
const PHONE_SESSION_PATH = "/api/voice/phone/sessions/:sessionId";
const CODEX_DRIVER = ProviderDriverKind.make("codex");

type PhoneGenerator = NonNullable<TextGeneration.TextGeneration["Service"]["generatePhoneReply"]>;

const noStoreHeaders = { "Cache-Control": "no-store" };

const phoneGenerator = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settingsOption = yield* settingsService.getSettings.pipe(Effect.option);
  if (Option.isNone(settingsOption)) return null;
  const settings = settingsOption.value;
  const instance = yield* registry.getInstance(settings.textGenerationModelSelection.instanceId);
  if (!instance || !instance.enabled || instance.driverKind !== CODEX_DRIVER) return null;

  const generatePhoneReply = instance.textGeneration.generatePhoneReply;
  if (!generatePhoneReply) return null;
  return {
    generatePhoneReply: generatePhoneReply as PhoneGenerator,
    modelSelection: settings.textGenerationModelSelection,
  };
});

const readTurnText = (payload: unknown): string | null => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("text" in payload) ||
    typeof payload.text !== "string"
  ) {
    return null;
  }
  return payload.text;
};

const sessionIdFromRoute = Effect.map(HttpRouter.params, (params) => params.sessionId ?? "");

const authCatch = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const phoneHealthRoute = HttpRouter.add(
  "GET",
  PHONE_HEALTH_PATH,
  Effect.gen(function* () {
    yield* authorizeVoiceRoute;
    const brain = yield* phoneGenerator;
    if (!brain) {
      return HttpServerResponse.text("Codex phone brain is not ready.", { status: 503 });
    }
    return HttpServerResponse.jsonUnsafe(
      { ok: true, ready: true, brain: "codex" },
      { headers: noStoreHeaders },
    );
  }).pipe(Effect.catchTags(authCatch)),
);

const createPhoneSessionRoute = HttpRouter.add(
  "POST",
  PHONE_SESSIONS_PATH,
  Effect.gen(function* () {
    yield* authorizeVoiceRoute;
    const brain = yield* phoneGenerator;
    if (!brain) {
      return HttpServerResponse.text("Codex phone brain is not available.", { status: 503 });
    }
    const sessionId = phoneSessionStore.create();
    if (sessionId === null) {
      return HttpServerResponse.text("Phone session capacity is exhausted.", { status: 429 });
    }
    return HttpServerResponse.jsonUnsafe({ sessionId }, { status: 201, headers: noStoreHeaders });
  }).pipe(Effect.catchTags(authCatch)),
);

const phoneTurnRoute = HttpRouter.add(
  "POST",
  PHONE_TURN_PATH,
  Effect.gen(function* () {
    yield* authorizeVoiceRoute;
    const sessionId = yield* sessionIdFromRoute;
    const payload = yield* HttpServerRequest.HttpServerRequest.pipe(
      Effect.flatMap((request) => request.json),
      Effect.option,
    );
    if (Option.isNone(payload)) {
      return HttpServerResponse.text("Request body must be JSON.", { status: 400 });
    }
    const text = readTurnText(payload.value);
    if (text === null) {
      return HttpServerResponse.text("Phone turn text is required.", { status: 422 });
    }

    const started = phoneSessionStore.beginTurn(sessionId, text);
    if (!started.ok) {
      const status =
        started.reason === "not_found"
          ? 404
          : started.reason === "busy"
            ? 409
            : started.reason === "capacity"
              ? 429
              : 422;
      return HttpServerResponse.text(`Phone turn ${started.reason.replace("_", " ")}.`, { status });
    }

    return yield* Effect.gen(function* () {
      const brain = yield* phoneGenerator;
      if (!brain) {
        return HttpServerResponse.text("Codex phone brain is not available.", { status: 503 });
      }

      const generated = yield* brain
        .generatePhoneReply({
          history: started.turn.history,
          text: started.turn.text,
          modelSelection: brain.modelSelection,
          signal: started.turn.signal,
        })
        .pipe(Effect.option);

      if (Option.isNone(generated)) {
        return HttpServerResponse.text(
          started.turn.signal.aborted
            ? "Phone turn was aborted."
            : "Phone reply generation failed.",
          { status: started.turn.signal.aborted ? 409 : 502 },
        );
      }

      const reply = phoneReplyText(generated.value);
      if (reply.length === 0 || reply.length > MAX_PHONE_REPLY_LENGTH) {
        return HttpServerResponse.text("Phone reply was invalid.", { status: 502 });
      }
      if (!phoneSessionStore.finishTurn(sessionId, started.turn.text, reply, started.turn.signal)) {
        return HttpServerResponse.text("Phone turn was aborted.", { status: 409 });
      }
      return HttpServerResponse.jsonUnsafe({ text: reply }, { headers: noStoreHeaders });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => phoneSessionStore.releaseTurn(sessionId, started.turn.signal)),
      ),
    );
  }).pipe(Effect.catchTags(authCatch)),
);
const phoneAbortRoute = HttpRouter.add(
  "POST",
  PHONE_ABORT_PATH,
  Effect.gen(function* () {
    yield* authorizeVoiceRoute;
    const sessionId = yield* sessionIdFromRoute;
    if (!phoneSessionStore.abort(sessionId)) {
      return HttpServerResponse.text("Phone session was not found.", { status: 404 });
    }
    return HttpServerResponse.jsonUnsafe({ aborted: true }, { headers: noStoreHeaders });
  }).pipe(Effect.catchTags(authCatch)),
);

const phoneDeleteRoute = HttpRouter.add(
  "DELETE",
  PHONE_SESSION_PATH,
  Effect.gen(function* () {
    yield* authorizeVoiceRoute;
    const sessionId = yield* sessionIdFromRoute;
    if (!phoneSessionStore.delete(sessionId)) {
      return HttpServerResponse.text("Phone session was not found.", { status: 404 });
    }
    return HttpServerResponse.empty({ status: 204 });
  }).pipe(Effect.catchTags(authCatch)),
);

export const phoneHttpRouteLayer = Layer.mergeAll(
  phoneHealthRoute,
  createPhoneSessionRoute,
  phoneTurnRoute,
  phoneAbortRoute,
  phoneDeleteRoute,
);
