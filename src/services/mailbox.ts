/**
 * Filesystem mailbox for the running persona.
 *
 * The detached persona-runner appends every inbound AgentMessage as a JSON line
 * to ~/.zynd/mailbox/<entity_id>.jsonl. The MCP tools (zyndai_pending_requests,
 * zyndai_respond_to_request) read this file to surface messages to the user
 * and to mark them processed once a reply has been queued.
 *
 * Each line is a MailboxEntry. The status field is rewritten in place by
 * recompacting the file when a reply lands — we don't try to be clever with
 * partial line updates because mailbox files are small (one user's persona,
 * a handful of msgs/day).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type MailboxStatus = "pending" | "answered" | "rejected";

export interface MailboxEntry {
  message_id: string;
  sender_id: string;
  sender_public_key?: string;
  sender_name?: string;
  content: string;
  conversation_id?: string;
  metadata?: Record<string, unknown>;
  /** ISO timestamp the runner received the message */
  received_at: string;
  /** Where to deliver the reply. The runner stores the syncReplyId or callback URL here. */
  reply_target?: {
    /** sync HTTP request id held open by the runner — pass to /internal/reply */
    sync_id?: string;
    /** if sender provided a callback URL */
    callback_url?: string;
  };
  status: MailboxStatus;
  /** the reply text once the user has approved one */
  response?: string;
  responded_at?: string;
}

function mailboxDir(): string {
  const home = process.env["ZYND_HOME"] ?? path.join(os.homedir(), ".zynd");
  return path.join(home, "mailbox");
}

export function mailboxPath(entityId: string): string {
  return path.join(mailboxDir(), `${entityId.replace(/[^a-zA-Z0-9:_-]/g, "_")}.jsonl`);
}

function ensureDir(): void {
  fs.mkdirSync(mailboxDir(), { recursive: true });
}

export function appendEntry(entityId: string, entry: MailboxEntry): void {
  ensureDir();
  fs.appendFileSync(mailboxPath(entityId), JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function readEntries(entityId: string): MailboxEntry[] {
  const p = mailboxPath(entityId);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf-8");
  const out: MailboxEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as MailboxEntry);
    } catch {
      // skip malformed lines so a single corrupt write doesn't poison the inbox
    }
  }
  return out;
}

export function readPending(entityId: string): MailboxEntry[] {
  return readEntries(entityId).filter((e) => e.status === "pending");
}

export function updateStatus(
  entityId: string,
  messageId: string,
  patch: { status: MailboxStatus; response?: string; responded_at?: string },
): MailboxEntry | null {
  const entries = readEntries(entityId);
  let updated: MailboxEntry | null = null;
  for (const e of entries) {
    if (e.message_id === messageId) {
      e.status = patch.status;
      if (patch.response !== undefined) e.response = patch.response;
      e.responded_at = patch.responded_at ?? new Date().toISOString();
      updated = e;
    }
  }
  if (updated) {
    const p = mailboxPath(entityId);
    fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", {
      mode: 0o600,
    });
  }
  return updated;
}

export function findEntry(entityId: string, messageId: string): MailboxEntry | null {
  return readEntries(entityId).find((e) => e.message_id === messageId) ?? null;
}
