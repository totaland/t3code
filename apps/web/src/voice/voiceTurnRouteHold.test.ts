import { expect, it, vi } from "vite-plus/test";
import {
  beginVoiceTurnRouteHold,
  endVoiceTurnRouteHold,
  isVoiceTurnRouteHeld,
  subscribeVoiceTurnRouteHolds,
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
