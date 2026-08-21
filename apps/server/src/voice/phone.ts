import * as NodeCrypto from "node:crypto";

import type {
  PhoneReplyGenerationMessage,
  PhoneReplyGenerationResult,
} from "../textGeneration/TextGeneration.ts";

export const PHONE_SESSION_TTL_MS = 5 * 60_000;
export const MAX_PHONE_TURN_TEXT_LENGTH = 4_000;
export const MAX_PHONE_HISTORY_MESSAGES = 12;
export const MAX_PHONE_REPLY_LENGTH = 2_000;
export const MAX_PHONE_SESSIONS = 8;
export const MAX_CONCURRENT_PHONE_TURNS = 1;

export type PhoneSessionRole = PhoneReplyGenerationMessage["role"];

export type PhoneSessionMessage = PhoneReplyGenerationMessage;

export type PhoneSessionTurn = {
  readonly sessionId: string;
  readonly text: string;
  readonly history: ReadonlyArray<PhoneSessionMessage>;
  readonly signal: AbortSignal;
};

type MutablePhoneSession = {
  readonly id: string;
  readonly history: PhoneSessionMessage[];
  createdAt: number;
  lastUsedAt: number;
  active: boolean;
  abortController: AbortController | undefined;
};

export type PhoneSessionBeginResult =
  | { readonly ok: true; readonly turn: PhoneSessionTurn }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "busy" | "capacity" | "invalid_text";
    };

export type PhoneSessionStoreClock = () => number;
export type PhoneSessionIdFactory = () => string;

export class PhoneSessionStore {
  private readonly sessions = new Map<string, MutablePhoneSession>();
  private readonly now: PhoneSessionStoreClock;
  private readonly createId: PhoneSessionIdFactory;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxConcurrentTurns: number;

  constructor(
    now: PhoneSessionStoreClock = Date.now,
    createId: PhoneSessionIdFactory = NodeCrypto.randomUUID,
    ttlMs: number = PHONE_SESSION_TTL_MS,
    maxSessions: number = MAX_PHONE_SESSIONS,
    maxConcurrentTurns: number = MAX_CONCURRENT_PHONE_TURNS,
  ) {
    if (ttlMs <= 0 || maxSessions <= 0 || maxConcurrentTurns <= 0) {
      throw new RangeError("Phone session limits must be positive.");
    }
    this.now = now;
    this.createId = createId;
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.maxConcurrentTurns = maxConcurrentTurns;
  }

  create(): string | null {
    this.purgeExpired();
    if (this.sessions.size >= this.maxSessions) return null;
    const id = this.createId();
    const now = this.now();
    this.sessions.set(id, {
      id,
      history: [],
      createdAt: now,
      lastUsedAt: now,
      active: false,
      abortController: undefined,
    });
    return id;
  }

  beginTurn(sessionId: string, rawText: string): PhoneSessionBeginResult {
    this.purgeExpired();
    const text = rawText.trim();
    if (text.length === 0 || text.length > MAX_PHONE_TURN_TEXT_LENGTH) {
      return { ok: false, reason: "invalid_text" };
    }
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: "not_found" };
    if (session.active) return { ok: false, reason: "busy" };
    if (this.activeTurnCount() >= this.maxConcurrentTurns) {
      return { ok: false, reason: "capacity" };
    }

    const now = this.now();
    const abortController = new AbortController();
    session.active = true;
    session.abortController = abortController;
    session.lastUsedAt = now;
    return {
      ok: true,
      turn: {
        sessionId,
        text,
        history: session.history.slice(),
        signal: abortController.signal,
      },
    };
  }

  finishTurn(
    sessionId: string,
    userText: string,
    replyText: string,
    signal?: AbortSignal,
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      !session.active ||
      !session.abortController ||
      (signal !== undefined && session.abortController.signal !== signal) ||
      session.abortController.signal.aborted
    ) {
      return false;
    }
    const reply = replyText.trim();
    if (reply.length === 0 || reply.length > MAX_PHONE_REPLY_LENGTH) {
      this.releaseTurn(sessionId, signal);
      return false;
    }
    session.history.push({ role: "user", text: userText.trim() });
    session.history.push({ role: "assistant", text: reply });
    if (session.history.length > MAX_PHONE_HISTORY_MESSAGES) {
      session.history.splice(0, session.history.length - MAX_PHONE_HISTORY_MESSAGES);
    }
    session.active = false;
    session.abortController = undefined;
    session.lastUsedAt = this.now();
    return true;
  }

  releaseTurn(sessionId: string, signal?: AbortSignal): void {
    const session = this.sessions.get(sessionId);
    if (!session || (signal !== undefined && session.abortController?.signal !== signal)) return;
    session.active = false;
    session.abortController = undefined;
    session.lastUsedAt = this.now();
  }

  abort(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.abortController?.abort();
    session.active = false;
    session.abortController = undefined;
    session.lastUsedAt = this.now();
    return true;
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.abortController?.abort();
    this.sessions.delete(sessionId);
    return true;
  }

  has(sessionId: string): boolean {
    this.purgeExpired();
    return this.sessions.has(sessionId);
  }

  size(): number {
    this.purgeExpired();
    return this.sessions.size;
  }

  purgeExpired(): number {
    const threshold = this.now() - this.ttlMs;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.lastUsedAt <= threshold) {
        session.abortController?.abort();
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  private activeTurnCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.active) count++;
    }
    return count;
  }
}

export const phoneSessionStore = new PhoneSessionStore();

export function phoneReplyText(result: PhoneReplyGenerationResult): string {
  return result.text.trim();
}
