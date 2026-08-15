import { expect, it, vi } from "vite-plus/test";
import {
  beginVoiceTurnRouteHold,
  endVoiceTurnRouteHold,
  isVoiceTurnRouteHeld,
  subscribeVoiceTurnRouteHolds,
  transitionVoiceTurnRouteHold,
} from "./voiceTurnRouteHold";

it("holds a promoted draft route until its voice turn ends", () => {
  const threadKey = "environment:voice-thread";
  const listener = vi.fn();
  const unsubscribe = subscribeVoiceTurnRouteHolds(listener);

  expect(isVoiceTurnRouteHeld(threadKey)).toBe(false);

  beginVoiceTurnRouteHold(threadKey);
  expect(isVoiceTurnRouteHeld(threadKey)).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);

  beginVoiceTurnRouteHold(threadKey);
  expect(listener).toHaveBeenCalledTimes(1);

  endVoiceTurnRouteHold(threadKey);
  expect(isVoiceTurnRouteHeld(threadKey)).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);

  unsubscribe();
});

it("releases the previous route hold before adopting a new thread", () => {
  const previousThreadKey = "environment:previous-thread";
  const nextThreadKey = "environment:next-thread";
  beginVoiceTurnRouteHold(previousThreadKey);
  beginVoiceTurnRouteHold(nextThreadKey);

  expect(transitionVoiceTurnRouteHold(previousThreadKey, nextThreadKey)).toBe(nextThreadKey);
  expect(isVoiceTurnRouteHeld(previousThreadKey)).toBe(false);
  expect(isVoiceTurnRouteHeld(nextThreadKey)).toBe(true);

  expect(transitionVoiceTurnRouteHold(nextThreadKey, nextThreadKey)).toBe(nextThreadKey);
  expect(isVoiceTurnRouteHeld(nextThreadKey)).toBe(true);

  endVoiceTurnRouteHold(nextThreadKey);
});
