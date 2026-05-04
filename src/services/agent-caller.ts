/**
 * Agent invocation — sends a signed A2A message to a registered agent and
 * returns its reply.
 *
 * The post-A2A flow:
 *   1. Resolve the JSON-RPC endpoint advertised on the AgentCard (`card.url`)
 *      with a fallback to `<entity_url>/a2a/v1` for older agents.
 *   2. Build an A2A `Message` with a TextPart, sign it with the active
 *      persona's keypair (or generate a one-shot anonymous keypair when
 *      there's no persona), and call `message/send` via `A2AClient.sync()`.
 *   3. Pull the reply text out of the returned Task's artifacts (NOT
 *      `task.history` — that includes the caller's outbound message echoed
 *      back, which would feed an LLM tool a copy of its own input). The
 *      SDK's `taskReplyText()` helper already handles the priority chain
 *      (artifacts → status.message → history fallback).
 *
 * x402 payments still flow through the @x402/fetch wrapper, so the
 * `payment-response` settlement header is captured the same way as before
 * by patching `globalThis.fetch` for the call's lifetime — A2AClient uses
 * the global `fetch`, so that's our injection point.
 */

import { randomUUID } from "node:crypto";
import {
  A2AClient,
  generateKeypair,
  taskReplyText,
  type ATask,
  type Ed25519Keypair,
} from "zyndai";
import { CALL_AGENT_TIMEOUT_MS, MCP_SENDER_ID } from "../constants.js";
import { getPaymentFetchAsync } from "./payment.js";
import { loadActivePersonaKeypair } from "./identity-store.js";
import { existingDaemon } from "./persona-daemon.js";
import { registerOutboundTask } from "./outbound-tasks.js";
import type { AgentCard, CallAgentResult, PaymentInfo } from "../types.js";

export type CallMode = "auto" | "sync" | "stream" | "push";

export interface CallAgentParams {
  card: AgentCard;
  message: string;
  /** Continue an existing A2A conversation. */
  contextId?: string;
  /** Continue (rather than open) an existing task — used for input-required loopbacks. */
  taskId?: string;
  /**
   * Delivery channel for this call:
   *   "auto"   — pick based on the agent's card capabilities + message size
   *   "sync"   — message/send blocking (default for most calls)
   *   "stream" — message/send with streaming (returns first artifact only here)
   *   "push"   — message/send non-blocking + register a push callback URL.
   *              Reply lands in ~/.zynd/mcp-async-replies.jsonl when the
   *              agent settles. Use zyndai_async_replies to fetch.
   */
  mode?: CallMode;
}

export async function callAgent({
  card,
  message,
  contextId,
  taskId,
  mode = "auto",
}: CallAgentParams): Promise<CallAgentResult> {
  const endpoint = resolveA2AEndpoint(card);

  // Sender identity:
  //   - active persona  → registry-verifiable sender_id (preferred)
  //   - no persona     → generate a one-shot anonymous keypair so we can
  //                       still emit a valid x-zynd-auth signature. The
  //                       receiver decides what to do with an unknown
  //                       sender (their authMode setting governs that).
  const persona = loadActivePersonaKeypair();
  const senderKeypair: Ed25519Keypair = persona?.keypair ?? generateKeypair();
  const senderId = persona?.persona.entity_id ?? senderKeypair.entityId;
  const senderName =
    persona?.persona.agent_name ?? MCP_SENDER_ID;

  const client = new A2AClient({
    keypair: senderKeypair,
    entityId: senderId,
  });

  const messageId = randomUUID();
  const conversationId = contextId ?? randomUUID();

  // Capture x402 settlement metadata. A2AClient calls `fetch()` directly,
  // so we wrap globalThis.fetch with the @x402/fetch payment wrapper for
  // the duration of this call only and snoop the `payment-response`
  // header off the response that comes back to the wrapper.
  const payment: PaymentInfo = {
    paid: false,
    transaction: null,
    network: null,
    payer: null,
  };
  const originalFetch = globalThis.fetch;
  const paymentFetch = await getPaymentFetchAsync();
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const resp = await paymentFetch(input as never, init as never);
    const settlement = resp.headers.get("payment-response");
    if (settlement) {
      try {
        const parsed = JSON.parse(settlement) as Record<string, unknown>;
        payment.paid = true;
        payment.transaction = (parsed["transaction"] as string) ?? null;
        payment.network = (parsed["network"] as string) ?? null;
        payment.payer = (parsed["payer"] as string) ?? null;
      } catch {
        payment.paid = true;
      }
    }
    return resp;
  }) as typeof fetch;

  // Resolve effective mode + push config once.
  const effectiveMode = resolveMode(mode, card, message);
  const pushCfg =
    effectiveMode === "push" ? buildPushConfig(persona?.persona.entity_id) : null;

  let task: ATask;
  try {
    if (effectiveMode === "push" && pushCfg) {
      // Non-blocking — agent ack's the kickoff and shuts the connection.
      // The eventual result lands at our callback URL via the persona-runner.
      task = await client.sync({
        url: endpoint,
        text: message,
        contextId: conversationId,
        ...(taskId ? { taskId } : {}),
        blocking: false,
        timeoutMs: 30_000,
        // @ts-expect-error - configuration.pushNotificationConfig is the
        // A2A spec-mandated inline registration shape; the SDK forwards
        // it as an opaque pass-through under params.configuration.
        configuration: {
          blocking: false,
          pushNotificationConfig: {
            url: pushCfg.url,
            token: pushCfg.token,
          },
        },
      });
    } else {
      // Default: sync. (Streaming would return the same final artifact
      // here — the MCP tool surface doesn't expose intermediate progress
      // events.)
      task = await client.sync({
        url: endpoint,
        text: message,
        contextId: conversationId,
        ...(taskId ? { taskId } : {}),
        blocking: true,
        timeoutMs: CALL_AGENT_TIMEOUT_MS,
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  // For push mode, also register the outbound taskId so the runner can
  // recognize the eventual callback as ours.
  if (effectiveMode === "push" && pushCfg) {
    registerOutboundTask({
      task_id: task.id,
      context_id: task.contextId ?? conversationId,
      target_url: endpoint,
      target_entity_id: (card.entity_id as string) ?? endpoint,
      outbound_message: message,
      callback_url: pushCfg.url,
      callback_token: pushCfg.token,
      registered_at: new Date().toISOString(),
    });
  }

  const responseText = taskReplyText(task) ?? "";
  // Reply-side signature verification stays a `null` baseline for now —
  // see the comment on CallAgentResult.signatureVerified in types.ts.
  const signatureVerified: boolean | null = null;

  return {
    response: responseText,
    entityId: (card.entity_id as string) ?? card.name,
    agentName: typeof card.name === "string" ? card.name : senderName,
    messageId,
    contextId: task.contextId ?? conversationId,
    taskId: task.id,
    taskState: (task.status?.state as string) ?? "unknown",
    task,
    payment,
    signatureVerified,
  };
}

/**
 * Pick a delivery mode when the caller passed "auto":
 *
 *   - Push, when the target advertises `capabilities.pushNotifications`
 *     AND the message is "long-job-shaped" (>2KB, mentions long-running
 *     verbs). Push avoids holding open a long sync HTTP call.
 *   - Sync, in every other case.
 *
 * This is intentionally simple — wrong choice rarely hurts (sync just
 * holds the connection longer; push just delays the reply by one
 * round-trip). The caller can always force a mode explicitly.
 */
function resolveMode(mode: CallMode, card: AgentCard, message: string): CallMode {
  if (mode !== "auto") return mode;

  const caps = (card as { capabilities?: { pushNotifications?: boolean } }).capabilities;
  const pushSupported = caps?.pushNotifications === true;
  if (!pushSupported) return "sync";

  // Long-job heuristics: message is large OR mentions phrases that
  // suggest the work won't return in a few seconds.
  if (message.length > 2_000) return "push";
  if (/\b(transcribe|render|generate.*video|train|crawl|scrape entire)\b/i.test(message)) {
    return "push";
  }

  return "sync";
}

/**
 * Build a push-callback config pointing at our local persona-runner.
 * Returns null when no runner is alive — push mode doesn't make sense
 * without somewhere for the callback to land.
 */
function buildPushConfig(_personaId: string | undefined): {
  url: string;
  token: string;
} | null {
  const daemon = existingDaemon();
  if (!daemon) return null;

  // The runner's A2A endpoint IS the callback URL — push payloads are
  // signed A2A messages, and the runner already knows how to verify +
  // route them (via outbound-tasks ledger lookup).
  const url = `${daemon.entity_url.replace(/\/+$/, "")}/a2a/v1`;
  // Ed25519-derived nonce so each call gets a fresh shared secret.
  const token = randomUUID();
  return { url, token };
}

/**
 * Pick the A2A endpoint URL from an AgentCard.
 *
 *   1. `card.url`   — the canonical post-A2A field (JSON-RPC endpoint, e.g.
 *                    `https://x/a2a/v1`). What `buildAgentCard` writes.
 *   2. `card.additionalInterfaces[].url` where `transport === "JSONRPC"` —
 *                    fallback for cards that ship multiple transports.
 *   3. `<entity_url>/a2a/v1` — last-resort reconstruction for legacy cards.
 */
function resolveA2AEndpoint(card: AgentCard): string {
  if (typeof card.url === "string" && card.url) return card.url;

  const ifaces = card.additionalInterfaces ?? [];
  for (const iface of ifaces) {
    if (
      typeof iface?.url === "string" &&
      typeof iface?.transport === "string" &&
      iface.transport.toUpperCase() === "JSONRPC"
    ) {
      return iface.url;
    }
  }

  const baseUrl =
    (card as { baseUrl?: string }).baseUrl ??
    (card as { entity_url?: string }).entity_url;
  if (typeof baseUrl === "string" && baseUrl) {
    return `${baseUrl.replace(/\/+$/, "")}/a2a/v1`;
  }

  throw new Error(
    `Agent card for ${card.name ?? card.entity_id ?? "(unknown)"} has no A2A endpoint`,
  );
}

/**
 * Generate a fresh conversation id when the caller doesn't supply one.
 * Exposed for tests; A2AClient.sync() would otherwise generate one on its
 * own, but tools that want to surface the contextId in their reply need
 * to mint it before the call.
 */
export function newConversationId(): string {
  return randomUUID();
}
