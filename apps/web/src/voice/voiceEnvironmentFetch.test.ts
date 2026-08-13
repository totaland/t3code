import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createVoiceEnvironmentFetch } from "./voiceEnvironmentFetch";
import type { VoiceFetch } from "./voiceClient";

const environmentId = EnvironmentId.make("remote");

function prepared(httpAuthorization: PreparedConnection["httpAuthorization"]): PreparedConnection {
  return {
    environmentId,
    label: "Remote",
    httpBaseUrl: "https://remote.test",
    socketUrl: "wss://remote.test/ws",
    httpAuthorization,
    target: {} as PreparedConnection["target"],
  };
}

describe("voice environment fetch", () => {
  it.each([
    {
      name: "cookie",
      connection: prepared(null),
      authHeaders: {},
      expectedCredentials: "include",
      expectedAuthorization: null,
      expectedDpop: null,
    },
    {
      name: "bearer",
      connection: prepared({ _tag: "Bearer", token: "bearer-token" }),
      authHeaders: { authorization: "Bearer bearer-token" },
      expectedCredentials: undefined,
      expectedAuthorization: "Bearer bearer-token",
      expectedDpop: null,
    },
    {
      name: "DPoP",
      connection: prepared({ _tag: "Dpop", accessToken: "access-token" }),
      authHeaders: { authorization: "DPoP access-token", dpop: "signed-proof" },
      expectedCredentials: undefined,
      expectedAuthorization: "DPoP access-token",
      expectedDpop: "signed-proof",
    },
  ])(
    "uses prepared $name environment authentication",
    async ({
      connection,
      authHeaders,
      expectedCredentials,
      expectedAuthorization,
      expectedDpop,
    }) => {
      const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
      const fetchImplementation: VoiceFetch = vi.fn(async (input, init) => {
        requests.push({ input, ...(init ? { init } : {}) });
        return Response.json({ text: "ok" });
      });
      const buildAuthHeaders = vi.fn(async () => authHeaders);
      const environmentFetch = createVoiceEnvironmentFetch(environmentId, {
        fetchImplementation,
        readPreparedConnection: () => connection,
        buildAuthHeaders,
      });

      await environmentFetch("https://remote.test/api/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/wav" },
      });

      const request = requests[0];
      expect(buildAuthHeaders).toHaveBeenCalledWith(
        connection,
        "https://remote.test/api/voice/transcribe",
      );
      expect(request?.init?.credentials).toBe(expectedCredentials);
      const headers = new Headers(request?.init?.headers);
      expect(headers.get("authorization")).toBe(expectedAuthorization);
      expect(headers.get("dpop")).toBe(expectedDpop);
      expect(headers.get("content-type")).toBe("audio/wav");
    },
  );
});
