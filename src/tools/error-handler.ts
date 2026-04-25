import { RegistryError } from "../services/registry-client.js";

/**
 * Convert any thrown error into the MCP tool error envelope.
 *
 * Tries to surface actionable guidance to the model — e.g. "configure
 * ZYNDAI_PAYMENT_PRIVATE_KEY" on a 402, or "the agent may be offline" on a
 * connect refusal — so the model can pass it on to the user verbatim.
 */
export function handleToolError(error: unknown): {
  [key: string]: unknown;
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: formatError(error) }],
  };
}

function formatError(error: unknown): string {
  if (error instanceof RegistryError) {
    switch (error.statusCode) {
      case 404:
        return "Error: Entity not registered on AgentDNS. Verify the entity_id (or FQAN) — use zyndai_search_agents to find valid IDs.";
      case 408:
        return "Error: Registry request timed out. Try again in a moment, or check ZYNDAI_REGISTRY_URL is reachable.";
      case 429:
        return "Error: Rate limit hit on the registry. Wait a few seconds before retrying.";
      case 500:
      case 502:
      case 503:
        return "Error: AgentDNS registry is temporarily unavailable. Try again shortly.";
      default:
        return `Error: Registry returned HTTP ${error.statusCode}. ${error.message}`;
    }
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Error: Request timed out. The agent or registry may be slow — try again or pick a different agent.";
    }
    if (
      error.message.includes("fetch failed") ||
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("ENOTFOUND")
    ) {
      return "Error: Could not connect to the agent. It may be offline. Use zyndai_search_agents to find a similar working agent.";
    }
    if (error.message.includes("HTTP 402")) {
      return "Error: This agent requires payment. Set ZYNDAI_PAYMENT_PRIVATE_KEY in the env to a 64-char hex private key for a Base Sepolia wallet funded with USDC.";
    }
    if (error.message.includes("HTTP 400")) {
      return `Error: ${error.message}\n\nThis usually means the message didn't match the agent's input_schema. Call zyndai_get_agent first and format the message to match the schema.`;
    }
    return `Error: ${error.message}`;
  }

  return `Error: An unexpected error occurred: ${String(error)}`;
}
