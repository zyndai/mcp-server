/**
 * MCP-local types. Anything that describes the A2A wire format is imported
 * from the `zyndai` SDK — keeping it in one place avoids drift.
 */

import type { AgentSearchResponse, ATask } from "zyndai";

export type { AgentSearchResponse } from "zyndai";

/**
 * A signed A2A AgentCard. The post-A2A SDK doesn't ship a single named
 * `AgentCard` type (it uses the `BuildCardOptions` / `SignedAgentCard`
 * shapes) — we describe just the fields the MCP server relies on.
 *
 * Anything not listed here can still be present on the wire; we treat the
 * card as a permissive bag.
 */
export interface AgentCard {
  /** Display name (required). */
  name: string;
  /** A2A endpoint URL (canonical JSON-RPC entry — usually <base>/a2a/v1). */
  url: string;
  /** Public base URL (well-known card lives at <baseUrl>/.well-known/agent-card.json). */
  baseUrl?: string;
  /** Stable Zynd entity_id. */
  entity_id?: string;
  /** Free-form summary surfaced in registry search. */
  summary?: string;
  description?: string;
  version?: string;
  /** Tag list for discovery. */
  tags?: string[];
  /** Optional fully-qualified agent name (e.g. registry/handle/name). */
  fqan?: string;
  /** Optional pricing the agent advertises. */
  pricing?: {
    model?: string;
    rates?: Record<string, number>;
    currency?: string;
    paymentMethods?: string[];
  };
  /** Permits access to additional A2A interfaces (transport variants). */
  additionalInterfaces?: Array<{ url: string; transport: string }>;
  /** Catch-all so unknown fields pass through. */
  [key: string]: unknown;
}

/**
 * Back-compat alias. The MCP server historically called the registry payload
 * an "EntityCard"; under A2A it's more conventionally an AgentCard.
 */
export type EntityCard = AgentCard;

/**
 * The two shapes of "agent" we hand back to the model:
 *   - SearchResultRow  — what a search hit looks like (terse, ranked)
 *   - AgentCard        — what `get_agent` returns (full, signed)
 *
 * MCP tool results stringify these via format.ts.
 */
export type SearchResultRow = AgentSearchResponse;

/** What `call_agent` returns to the MCP client. */
export interface CallAgentResult {
  response: string;
  entityId: string;
  agentName: string;
  /** Outbound A2A messageId we stamped on the call. */
  messageId: string;
  /** A2A contextId — used to thread follow-ups in the same conversation. */
  contextId: string;
  /** Final task ID — used to follow up via tasks/get or push notifications. */
  taskId: string;
  /** Final A2A task state (`completed`, `failed`, `input-required`, …). */
  taskState: string;
  /** Full final Task object — left here for tools that want richer context. */
  task: ATask;
  payment: PaymentInfo;
  /**
   * The A2A receiver verifies our outbound x-zynd-auth signature. We can't
   * easily verify the receiver's *response* signature without their public
   * key in hand, so for now this stays at the same `null` baseline the
   * legacy webhook flow used. Full reverse-verification is tracked
   * separately.
   */
  signatureVerified: boolean | null;
}

/** Payment metadata extracted from x402 settlement headers on a successful call. */
export interface PaymentInfo {
  paid: boolean;
  transaction: string | null;
  network: string | null;
  payer: string | null;
}

/**
 * Internal: a hydrated card for use by tools. We attach the entity_url that
 * resolved the card so call_agent doesn't need to re-derive it.
 */
export interface HydratedCard {
  card: AgentCard;
  entityUrl: string;
}
