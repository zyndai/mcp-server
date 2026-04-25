/**
 * MCP-local types. Anything that describes the AgentDNS wire format is
 * imported from the `zyndai` SDK — keeping it in one place avoids drift.
 */

import type { EntityCard, AgentSearchResponse } from "zyndai";

export type { EntityCard, AgentSearchResponse } from "zyndai";

/**
 * The two shapes of "agent" we hand back to the model:
 *   - SearchResultRow  — what a search hit looks like (terse, ranked)
 *   - EntityCard       — what `get_agent` returns (full, signed)
 *
 * MCP tool results stringify these via format.ts.
 */
export type SearchResultRow = AgentSearchResponse;

/** What `call_agent` returns to the MCP client. */
export interface CallAgentResult {
  response: string;
  entityId: string;
  agentName: string;
  messageId: string;
  conversationId: string;
  payment: PaymentInfo;
  /** True if the response was signed and the signature verified, false if unsigned, null if not checked. */
  signatureVerified: boolean | null;
}

/** Payment metadata extracted from x402 settlement headers on a successful call. */
export interface PaymentInfo {
  paid: boolean;
  transaction: string | null;
  network: string | null;
  payer: string | null;
}

/** What an AgentDNS-compliant agent's /webhook/sync response body looks like on the wire. */
export interface WebhookSyncResponse {
  status?: string;
  message_id?: string;
  response?: string;
  /** Some legacy agents emitted `output` instead of `response` — accept both for compat. */
  output?: string;
  /** Optional Ed25519 signature over the response body (when the agent signs replies). */
  signature?: string;
  /** Public key the response was signed with — present only when `signature` is present. */
  signed_by?: string;
  [key: string]: unknown;
}

/**
 * Internal: a hydrated card for use by tools. We attach the entity_url that
 * resolved the card so call_agent doesn't need to re-derive it.
 */
export interface HydratedCard {
  card: EntityCard;
  entityUrl: string;
}
