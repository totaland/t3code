const heldThreadKeys = new Set<string>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function beginVoiceTurnRouteHold(threadKey: string): void {
  if (heldThreadKeys.has(threadKey)) return;
  heldThreadKeys.add(threadKey);
  emitChange();
}

export function endVoiceTurnRouteHold(threadKey: string): void {
  if (!heldThreadKeys.delete(threadKey)) return;
  emitChange();
}

export function isVoiceTurnRouteHeld(threadKey: string | null): boolean {
  return threadKey !== null && heldThreadKeys.has(threadKey);
}

export function subscribeVoiceTurnRouteHolds(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
