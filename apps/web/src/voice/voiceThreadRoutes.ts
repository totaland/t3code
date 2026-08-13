export function buildVoiceThreadRoute<TEnvironmentId extends string, TThreadId extends string>(
  environmentId: TEnvironmentId,
  threadId: TThreadId,
) {
  return {
    to: "/voice/$environmentId/$threadId" as const,
    params: { environmentId, threadId },
  };
}

export function buildTextThreadRoute<TEnvironmentId extends string, TThreadId extends string>(
  environmentId: TEnvironmentId,
  threadId: TThreadId,
) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId, threadId },
  };
}
