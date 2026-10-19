import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  "x-tts-backend",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;
export const browserApiCorsExposedHeaders = ["X-Audio-Channels", "X-Audio-Sample-Rate"] as const;
export const browserApiCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": browserApiCorsAllowedMethods.join(", "),
  "access-control-allow-headers": browserApiCorsAllowedHeaders.join(", "),
  "access-control-expose-headers": browserApiCorsExposedHeaders.join(", "),
} as const;

export const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"] as const;
