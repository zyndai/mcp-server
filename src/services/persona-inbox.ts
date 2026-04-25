/**
 * Persona inbox — incoming-message handling for the user's Claude persona.
 *
 * Since the MCP server is a stdio child process with no public webhook URL,
 * other agents that want to call the persona's `entity_url` go through the
 * registry's inbox routing. The MCP polls the registry for queued messages,
 * surfaces them via the `zyndai_pending_requests` tool so Claude can ask the
 * user for approval, and posts replies via `zyndai_respond_to_request`.
 *
 * Endpoints used (per the AgentDNS spec):
 *   GET  {registry}/v1/inbox/{entity_id}?since={iso8601}
 *   POST {registry}/v1/inbox/{entity_id}/{message_id}/reply
 *
 * If the registry hasn't deployed the inbox endpoints yet, both calls 404
 * cleanly and the tools surface a friendly "feature pending" error to the
 * model — the rest of the MCP keeps working.
 */

import type { Ed25519Keypair } from "zyndai";
import { sign } from "zyndai";

const REQUEST_TIMEOUT_MS = 15_000;

export interface PendingRequest {
  message_id: string;
  /** sender's entity_id, e.g. "zns:b91d..." */
  sender_id: string;
  /** sender's name from their card, when the registry includes it (best-effort) */
  sender_name?: string;
  /** sender's claimed public key — Claude can verify against the registry if it cares */
  sender_public_key?: string;
  /** message body */
  content: string;
  conversation_id?: string;
  /** ISO 8601 timestamp the registry queued the message */
  queued_at: string;
  /** any additional metadata the sender attached */
  metadata?: Record<string, unknown>;
}

export interface InboxResult {
  requests: PendingRequest[];
  /** True when the registry doesn't expose /v1/inbox/* yet — surfaced via error from tools. */
  unsupported: boolean;
}

export async function fetchPendingRequests(opts: {
  registryUrl: string;
  entityId: string;
  /** Only return requests queued after this ISO timestamp. Pass undefined for "all". */
  since?: string;
}): Promise<InboxResult> {
  const url = new URL(
    `${opts.registryUrl.replace(/\/+$/, "")}/v1/inbox/${encodeURIComponent(opts.entityId)}`,
  );
  if (opts.since) url.searchParams.set("since", opts.since);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: ctl.signal,
    });

    // 404 here means the registry doesn't have inbox routing yet. Treat as
    // "unsupported" so the tool can render a helpful message instead of an
    // opaque error.
    if (resp.status === 404) {
      return { requests: [], unsupported: true };
    }

    if (!resp.ok) {
      throw new Error(
        `inbox fetch failed: HTTP ${resp.status} ${resp.statusText}`,
      );
    }

    const body = (await resp.json()) as { requests?: PendingRequest[] };
    return {
      requests: Array.isArray(body.requests) ? body.requests : [],
      unsupported: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface PostReplyOpts {
  registryUrl: string;
  entityId: string;
  /** id of the message we're replying to */
  messageId: string;
  /** persona's keypair — used to sign the reply so the recipient can verify it really came from us */
  personaKeypair: Ed25519Keypair;
  /** True if Claude (with user approval) is sending a real reply, false to reject */
  approve: boolean;
  /** the reply body — required if approve === true */
  response?: string;
  conversationId?: string;
}

export interface PostReplyResult {
  status: "delivered" | "rejected" | "unsupported";
  /** signature over the canonical reply body, for receiver-side verification */
  signature?: string;
}

export async function postReply(opts: PostReplyOpts): Promise<PostReplyResult> {
  if (opts.approve && !opts.response) {
    throw new Error("response text is required when approve=true");
  }

  // Body the persona signs. The recipient verifies this signature against
  // the persona's registered public key to confirm the reply is authentic.
  const body: Record<string, unknown> = {
    message_id: opts.messageId,
    approve: opts.approve,
    timestamp: new Date().toISOString(),
  };
  if (opts.approve) body["response"] = opts.response;
  if (opts.conversationId) body["conversation_id"] = opts.conversationId;

  const canonical = JSON.stringify(body);
  const signature = sign(
    opts.personaKeypair.privateKeyBytes,
    new TextEncoder().encode(canonical),
  );
  body["signature"] = signature;
  body["sender_public_key"] = opts.personaKeypair.publicKeyString;

  const url = `${opts.registryUrl.replace(/\/+$/, "")}/v1/inbox/${encodeURIComponent(
    opts.entityId,
  )}/${encodeURIComponent(opts.messageId)}/reply`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });

    if (resp.status === 404) {
      return { status: "unsupported" };
    }
    if (!resp.ok) {
      throw new Error(
        `inbox reply failed: HTTP ${resp.status} ${resp.statusText}`,
      );
    }
    return {
      status: opts.approve ? "delivered" : "rejected",
      signature,
    };
  } finally {
    clearTimeout(timer);
  }
}
