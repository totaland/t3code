// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- plain Node store resolution; no Effect services.
// One chat per project, with a single-writer lock (SPEC.md §1, mistake #12):
// one process owns a chat. Project resolution follows the Pi implementation.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** A chat owner marks its store, so subagents read the chat their parent writes. */
export const STORE_ENV = "OPTCHAT_MUSE_STORE";

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  }).trim();

/** The project of a directory: its main git repository (a linked worktree belongs to it), or the directory itself. */
export function projectOf(cwd: string): string {
  try {
    const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return real(
      basename(common) === ".git" ? dirname(common) : git(cwd, ["rev-parse", "--show-toplevel"]),
    );
  } catch {
    return real(cwd);
  }
}

/** A project's store under the optchat-muse root (separate from Pi's store). */
export function storeOf(root: string, project: string): string {
  const name = basename(project).replace(/[^A-Za-z0-9._-]/g, "_") || "root";
  return join(
    root,
    "projects",
    `${name}-${createHash("sha256").update(project).digest("hex").slice(0, 8)}`,
  );
}

export function defaultRoot(): string {
  return process.env["OPTCHAT_MUSE_HOME"] ?? join(homedir(), ".local", "share", "optchat-muse");
}

/** Resolve a cwd to its store: env override wins, else one store per project. */
export function storeFor(cwd: string): string {
  const marked = process.env[STORE_ENV];
  if (marked) return marked;
  return storeOf(defaultRoot(), projectOf(cwd));
}

export interface ChatLock {
  readonly path: string;
  release(): void;
}

/**
 * Acquire the single-writer lock for a store. Throws when a live owner holds
 * it; a stale lock from a dead process is taken over.
 */
export function acquireLock(store: string): ChatLock {
  mkdirSync(store, { recursive: true });
  const path = join(store, "lock.json");
  const take = (): number => {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return fd;
  };
  let fd: number;
  try {
    fd = take();
  } catch {
    let owner: number | undefined;
    try {
      owner = (JSON.parse(readFileSync(path, "utf8")) as { pid?: number }).pid;
    } catch {
      /* unreadable lock: treat as stale */
    }
    const alive = owner !== undefined && isAlive(owner);
    if (alive)
      throw new Error(`optchat store ${store} is owned by live pid ${owner}; one writer per chat`);
    if (existsSync(path)) unlinkSync(path);
    fd = take();
  }
  return {
    path,
    release() {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
