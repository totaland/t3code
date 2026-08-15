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

export function enterVoiceThread<TResult>(
  navigate: (route: ReturnType<typeof buildVoiceThreadRoute>) => TResult,
  environmentId: string,
  threadId: string,
): TResult {
  return navigate(buildVoiceThreadRoute(environmentId, threadId));
}

export function returnToTextThread<TResult>(
  navigate: (route: ReturnType<typeof buildTextThreadRoute>) => TResult,
  environmentId: string,
  threadId: string,
): TResult {
  return navigate(buildTextThreadRoute(environmentId, threadId));
}
