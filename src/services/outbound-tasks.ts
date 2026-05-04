/**
 * Outbound-task ledger.
 *
 * When the MCP `call_agent` tool fires a request to another agent in
 * push-notification mode, we register the resulting taskId here so the
 * persona-runner (which receives the eventual callback) can recognize
 * "this is a callback for a task Claude initiated" vs "this is a fresh
 * inbound from a stranger that needs human review".
 *
 * The ledger lives at `~/.zynd/mcp-outbound-tasks.jsonl` so the runner
 * — a different process from the MCP server — can read it. Append-only;
 * we read line-by-line and look up by taskId. Capped at LEDGER_CAP_LINES
 * via lazy compaction (drop the oldest half once we exceed the cap).
 *
 * Each entry:
 *   {
 *     "task_id":         "task_abc123",
 *     "context_id":      "ctx_xyz",
 *     "target_url":      "http://other-agent.example/a2a/v1",
 *     "target_entity_id":"zns:other-agent-id",
 *     "outbound_message":"<the message Claude sent>",
 *     "callback_url":    "https://my-runner.example/cb",  // null if non-push
 *     "callback_token":  "shared-secret",                 // null if no token
 *     "registered_at":   "2026-05-04T12:34:56Z"
 *   }
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { zyndDir } from "./identity-store.js";

const LEDGER_FILE = "mcp-outbound-tasks.jsonl";
const LEDGER_CAP_LINES = 5_000;

export interface OutboundTaskEntry {
  task_id: string;
  context_id: string;
  target_url: string;
  target_entity_id: string;
  outbound_message: string;
  callback_url: string | null;
  callback_token: string | null;
  registered_at: string;
}

export interface AsyncReplyEntry {
  task_id: string;
  context_id: string;
  state: string;
  /** Final reply text, when the callback carried artifact data. */
  reply: string | null;
  /** When the push callback arrived. */
  received_at: string;
  /** ISO timestamp of the source task's status. */
  status_timestamp: string | null;
}

function ledgerPath(): string {
  return join(zyndDir(), LEDGER_FILE);
}

function repliesPath(): string {
  return join(zyndDir(), "mcp-async-replies.jsonl");
}

function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}

export function registerOutboundTask(entry: OutboundTaskEntry): void {
  const p = ledgerPath();
  ensureDir(p);
  appendFileSync(p, JSON.stringify(entry) + "\n", { mode: 0o600 });
  maybeCompact(p, LEDGER_CAP_LINES);
}

export function findOutboundTask(taskId: string): OutboundTaskEntry | null {
  const p = ledgerPath();
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
  // Walk backwards — most recent registration wins on the rare collision.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as OutboundTaskEntry;
      if (entry.task_id === taskId) return entry;
    } catch {
      continue;
    }
  }
  return null;
}

export function recordAsyncReply(reply: AsyncReplyEntry): void {
  const p = repliesPath();
  ensureDir(p);
  appendFileSync(p, JSON.stringify(reply) + "\n", { mode: 0o600 });
  maybeCompact(p, LEDGER_CAP_LINES);
}

export function listAsyncReplies(limit = 50): AsyncReplyEntry[] {
  const p = repliesPath();
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
  const out: AsyncReplyEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]) as AsyncReplyEntry);
    } catch {
      // skip
    }
  }
  return out;
}

function maybeCompact(path: string, cap: number): void {
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    if (lines.length <= cap) return;
    // Drop oldest half — append-only ledgers don't need precise FIFO.
    const keep = lines.slice(Math.floor(cap / 2));
    writeFileSync(path, keep.join("\n") + "\n", { mode: 0o600 });
  } catch {
    // ignore — best effort
  }
}
