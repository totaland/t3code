import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { buildEnvironmentAuthHeaders } from "@t3tools/client-runtime/state/environment-http-auth";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";
import { readPreparedConnection } from "../state/session";
import type { VoiceFetch } from "./voiceClient";

type VoiceAuthHeaders = {
  readonly authorization?: string;
  readonly dpop?: string;
};

type VoiceEnvironmentFetchDependencies = {
  readonly fetchImplementation: VoiceFetch;
  readonly readPreparedConnection: (environmentId: EnvironmentId) => PreparedConnection | null;
  readonly buildAuthHeaders: (
    prepared: PreparedConnection,
    requestUrl: string,
  ) => Promise<VoiceAuthHeaders>;
};

const defaultBuildAuthHeaders = (prepared: PreparedConnection, requestUrl: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      return yield* buildEnvironmentAuthHeaders(
        prepared.httpAuthorization,
        "POST",
        requestUrl,
        signer,
      );
    }),
  );

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

export function createVoiceEnvironmentFetch(
  environmentId: EnvironmentId,
  overrides: Partial<VoiceEnvironmentFetchDependencies> = {},
): VoiceFetch {
  const fetchImplementation = overrides.fetchImplementation ?? globalThis.fetch;
  const readConnection = overrides.readPreparedConnection ?? readPreparedConnection;
  const buildAuthHeaders = overrides.buildAuthHeaders ?? defaultBuildAuthHeaders;

  return async (input, init) => {
    const prepared = readConnection(environmentId);
    if (!prepared) {
      throw new Error("The selected T3 environment is not connected.");
    }
    const authHeaders = await buildAuthHeaders(prepared, requestUrl(input));
    const headers = new Headers(init?.headers);
    if (authHeaders.authorization) headers.set("authorization", authHeaders.authorization);
    if (authHeaders.dpop) headers.set("dpop", authHeaders.dpop);

    return fetchImplementation(input, {
      ...init,
      headers,
      ...(prepared.httpAuthorization === null ? { credentials: "include" } : {}),
    });
  };
}
