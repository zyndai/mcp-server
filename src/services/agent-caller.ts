/**
 * Agent invocation — sends an AgentMessage to a registered AgentDNS agent
 * and returns its response.
 *
 * Resolution order for the invoke URL (matches the TS SDK's `connectAgent()`
 * logic — duplicated here to keep this file dependency-light and easy to
 * audit):
 *
 *   1. card.endpoints.invoke    — what the agent advertises on its card
 *   2. ${entity_url}/webhook/sync — fallback for older agents
 *
 * x402 payments are auto-handled by the wrapped fetch when the agent's card
 * advertises pricing and `ZYNDAI_PAYMENT_PRIVATE_KEY` is set.
 */

import { randomUUID } from "node:crypto";
import { AgentMessage, type EntityCard } from "zyndai";
import { CALL_AGENT_TIMEOUT_MS, MCP_SENDER_ID } from "../constants.js";
import { getPaymentFetchAsync } from "./payment.js";
import { loadActivePersonaKeypair } from "./identity-store.js";
import type {
  CallAgentResult,
  PaymentInfo,
  WebhookSyncResponse,
} from "../types.js";

export interface CallAgentParams {
  card: EntityCard;
  message: string;
  conversationId?: string;
}

export async function callAgent({
  card,
  message,
  conversationId,
}: CallAgentParams): Promise<CallAgentResult> {
  const invokeUrl = resolveInvokeUrl(card);

  // If the user has registered a Claude persona, sign outgoing calls with
  // that identity so the recipient sees a real, registry-verifiable
  // sender_id. Falls back to the generic MCP_SENDER_ID for unauthenticated
  // callers (read tools work without a persona).
  const persona = loadActivePersonaKeypair();
  const senderId = persona?.persona.entity_id ?? MCP_SENDER_ID;
  const senderPublicKey = persona?.keypair.publicKeyString;

  const agentMessage = new AgentMessage({
    content: message,
    senderId,
    senderPublicKey,
    receiverId: card.entity_id,
    messageType: "query",
    conversationId,
    metadata: {
      source: "mcp-server",
      tool: "zyndai_call_agent",
      ...(persona ? { persona_name: persona.persona.agent_name } : {}),
    },
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_AGENT_TIMEOUT_MS);

  const payment: PaymentInfo = {
    paid: false,
    transaction: null,
    network: null,
    payer: null,
  };

  try {
    const fetchFn = await getPaymentFetchAsync();

    const response = await fetchFn(invokeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agentMessage.toDict()),
      signal: ctl.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Agent ${card.entity_id} returned HTTP ${response.status}: ${body || response.statusText}`,
      );
    }

    // x402 settlement metadata is returned in the `payment-response` header
    // by the @x402/fetch wrapper after a successful paid call.
    const settlement = response.headers.get("payment-response");
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

    const rawBody = await response.text();
    if (!rawBody.trim()) {
      throw new Error(
        `Agent ${card.entity_id} returned an empty response — workflow may be inactive.`,
      );
    }

    let data: WebhookSyncResponse;
    try {
      data = JSON.parse(rawBody) as WebhookSyncResponse;
    } catch {
      // Non-JSON body — pass through as-is.
      return {
        response: rawBody,
        entityId: card.entity_id,
        agentName: card.name,
        messageId: agentMessage.messageId,
        conversationId: agentMessage.conversationId,
        payment,
        signatureVerified: null,
      };
    }

    const responseText =
      data.response ??
      data.output ??
      data.status ??
      JSON.stringify(data);

    // Signature verification is intentionally a stub for v2.0.0 — we surface
    // whether a signature was present so the caller can choose to verify
    // out-of-band, but full verification (Ed25519 over canonical JSON) lands
    // in v2.1 once we standardize the response signing envelope.
    const signatureVerified =
      typeof data.signature === "string" && data.signature.length > 0
        ? null
        : null;

    return {
      response: responseText,
      entityId: card.entity_id,
      agentName: card.name,
      messageId: agentMessage.messageId,
      conversationId: agentMessage.conversationId,
      payment,
      signatureVerified,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the invoke URL the agent advertises on its card. We trust the card
 * because it's signed at the registry — if `endpoints.invoke` isn't present
 * (very old agent), reconstruct from `entity_url + /webhook/sync`.
 */
function resolveInvokeUrl(card: EntityCard): string {
  const advertised = card.endpoints?.invoke;
  if (advertised) return advertised;
  return `${card.entity_url.replace(/\/+$/, "")}/webhook/sync`;
}

/**
 * Generate a fresh conversation id when the caller doesn't supply one.
 * Exposed for tests; the AgentMessage constructor would otherwise generate
 * one anyway.
 */
export function newConversationId(): string {
  return randomUUID();
}
