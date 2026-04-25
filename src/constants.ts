/**
 * Defaults for the AgentDNS MCP server.
 *
 * The registry URL points at the AgentDNS root node — every operation goes
 * through `POST /v1/search`, `GET /v1/entities/:id`, or `GET /v1/entities/:id/card`.
 * Override with the `ZYNDAI_REGISTRY_URL` env var for federated registries
 * or a self-hosted dev node.
 */

export const DEFAULT_REGISTRY_URL = "https://dns01.zynd.ai";

/** Hard cap on a single MCP tool response payload — protects the model context window. */
export const CHARACTER_LIMIT = 25_000;

/** Timeout for registry HTTP requests (search / get / card). */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Timeout for `POST /webhook/sync` agent invocations. Longer because the agent might be running an LLM. */
export const CALL_AGENT_TIMEOUT_MS = 60_000;

/** Default search results returned when the user doesn't specify `limit`. */
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 20;

/**
 * sender_id stamped on outbound AgentMessage envelopes. Not signed —
 * AgentDNS doesn't require MCP clients to register a developer identity for
 * read-only operations or paid invocations. If a downstream agent rejects
 * unsigned messages, configure ZYNDAI_DEVELOPER_KEY (future feature).
 */
export const MCP_SENDER_ID = "zyndai-mcp-server";
