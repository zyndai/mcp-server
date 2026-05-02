/**
 * AgentDNS registry client.
 *
 * Thin wrappers over the `zyndai` SDK — every call hits a `/v1/...` endpoint
 * on the registry. No custom HTTP, no API-key auth (search/list/get are
 * public on AgentDNS), no `/agents/:id` legacy paths.
 */

import {
  DNSRegistryClient,
  type AgentSearchResponse,
  type SearchRequest,
  type SearchResult,
} from "zyndai";

import { DEFAULT_REGISTRY_URL, REQUEST_TIMEOUT_MS } from "../constants.js";
import type { AgentCard, HydratedCard } from "../types.js";

function getRegistryUrl(): string {
  return process.env["ZYNDAI_REGISTRY_URL"] ?? DEFAULT_REGISTRY_URL;
}

/** Custom error thrown so the MCP error handler can format registry failures with status codes. */
export class RegistryError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * Run a `POST /v1/search` query.
 *
 * Calls the SDK's low-level `DNSRegistryClient.searchEntities` directly so we
 * preserve the full `SearchResult` shape (results + total_found + offset +
 * has_more) — the higher-level `SearchAndDiscoveryManager` returns only the
 * results array, which would lose pagination metadata.
 */
export async function searchEntities(
  req: SearchRequest,
): Promise<SearchResult> {
  try {
    return await DNSRegistryClient.searchEntities({
      registryUrl: getRegistryUrl(),
      query: req,
    });
  } catch (err) {
    throw mapError(err);
  }
}

/**
 * Fetch a signed entity card by entity_id.
 *
 * Goes through `GET /v1/entities/:id/card` first (returns the full signed
 * card directly) and falls back to `GET /v1/entities/:id` if the registry
 * returns 404 — older nodes only expose the bare record.
 */
export async function getEntityCard(entityId: string): Promise<HydratedCard> {
  const registry = getRegistryUrl();
  // Use AbortController so a slow registry doesn't block the MCP server forever.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const cardResp = await fetch(
      `${registry.replace(/\/+$/, "")}/v1/entities/${encodeURIComponent(entityId)}/card`,
      { signal: ctl.signal, headers: { Accept: "application/json" } },
    );
    if (cardResp.ok) {
      const card = (await cardResp.json()) as AgentCard;
      return { card, entityUrl: deriveEntityUrl(card) };
    }
    if (cardResp.status !== 404) {
      const body = await cardResp.text().catch(() => "");
      throw new RegistryError(
        `GET /v1/entities/${entityId}/card -> HTTP ${cardResp.status}: ${body || cardResp.statusText}`,
        cardResp.status,
      );
    }
    // 404 on /card — fall through to bare entity lookup.
    const entityResp = await fetch(
      `${registry.replace(/\/+$/, "")}/v1/entities/${encodeURIComponent(entityId)}`,
      { signal: ctl.signal, headers: { Accept: "application/json" } },
    );
    if (!entityResp.ok) {
      const body = await entityResp.text().catch(() => "");
      throw new RegistryError(
        `GET /v1/entities/${entityId} -> HTTP ${entityResp.status}: ${body || entityResp.statusText}`,
        entityResp.status,
      );
    }
    const record = (await entityResp.json()) as Partial<AgentCard> & {
      entity_url?: string;
    };
    const entityUrlGuess = record.entity_url ?? (record["url"] as string | undefined);
    if (!entityUrlGuess) {
      throw new RegistryError(
        `Registry returned an entity record without an entity_url for ${entityId}`,
        500,
      );
    }
    // Hydrate by hitting the entity's well-known A2A card. Try the new path
    // first (post-A2A) and fall back to the legacy path for older agents.
    const card = await fetchWellKnownCard(entityUrlGuess, ctl.signal);
    return { card, entityUrl: deriveEntityUrl(card) ?? entityUrlGuess };
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    throw mapError(err);
  } finally {
    clearTimeout(timer);
  }
}

/** Try the A2A well-known path first, fall back to legacy. */
async function fetchWellKnownCard(
  baseUrl: string,
  signal: AbortSignal,
): Promise<AgentCard> {
  const root = baseUrl.replace(/\/+$/, "");
  const candidates = [
    `${root}/.well-known/agent-card.json`,
    `${root}/.well-known/agent.json`,
  ];
  let lastStatus = 0;
  for (const url of candidates) {
    const resp = await fetch(url, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (resp.ok) {
      return (await resp.json()) as AgentCard;
    }
    lastStatus = resp.status;
  }
  throw new RegistryError(
    `Could not fetch ${candidates[0]} or ${candidates[1]} (last HTTP ${lastStatus}). The agent may be offline.`,
    lastStatus,
  );
}

/**
 * Read the public base URL from an A2A AgentCard. Post-A2A cards expose `url`
 * (the JSON-RPC endpoint, e.g. `https://x/a2a/v1`); pre-A2A cards exposed
 * `entity_url` (the public base, e.g. `https://x`). Strip the `/a2a/...`
 * suffix when we recognize it so callers get a stable base URL.
 */
function deriveEntityUrl(card: AgentCard): string {
  const legacy = (card as { entity_url?: string }).entity_url;
  if (legacy) return legacy.replace(/\/+$/, "");
  const url = card.url ?? "";
  return url.replace(/\/a2a\/v\d+\/?$/i, "").replace(/\/+$/, "");
}

/**
 * Resolve a fully-qualified agent name (FQAN) → entity_id by hitting the
 * registry search with the `fqan` filter. Same path the `zynd resolve` CLI uses.
 */
export async function resolveFqan(fqan: string): Promise<AgentSearchResponse> {
  const result = await searchEntities({ fqan, max_results: 1 });
  const hit = result.results[0];
  if (!hit) {
    throw new RegistryError(`No agent registered with FQAN '${fqan}'`, 404);
  }
  return hit;
}

function mapError(err: unknown): Error {
  if (err instanceof RegistryError) return err;
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return new RegistryError("Registry request timed out", 408);
    }
    return new RegistryError(err.message, 0);
  }
  return new RegistryError(String(err), 0);
}
