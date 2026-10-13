/**
 * OptChat for Muse: one endless chat per project (SPEC.md), driven over
 * the Muse MSP SDK with a fresh native session per message.
 *
 * @module optchat-muse/server
 */
export { OptChat, type AskResult, type OptChatOptions } from "./driver.ts";
export {
  Memory,
  bytes,
  capText,
  cutBytes,
  formatDate,
  mostDue,
  name,
  pages,
  CAP,
  CVIEW,
  JOBS,
  NODE,
  PLACEHOLDER,
  TRIES,
  VIEW,
  type Ask,
  type Band,
  type Kind,
  type MemoryOptions,
  type Message,
  type Part,
} from "./memory.ts";
export {
  createOptChatTools,
  serveOptChatTools,
  type OptChatMcpServer,
  type OptChatTools,
} from "./mcp.ts";
export {
  classifyItem,
  createMuseHost,
  makeCompactorAsk,
  runFreshTurn,
  type FreshTurnOptions,
  type MuseHost,
  type MuseHostOptions,
  type TurnItem,
} from "./muse.ts";
export {
  SYSTEM,
  DATE_DESCRIPTION,
  ZOOM_DESCRIPTION,
  compressTask,
  mergeTask,
  ruler,
  tooLong,
} from "./prompts.ts";
export {
  acquireLock,
  defaultRoot,
  projectOf,
  storeFor,
  storeOf,
  STORE_ENV,
  type ChatLock,
} from "./store.ts";
