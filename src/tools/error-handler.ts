import { RegistryError } from "../services/registry-client.js";

export function handleToolError(error: unknown): {
  [key: string]: unknown;
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const message = formatError(error);

  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function formatError(error: unknown): string {
  if (error instanceof RegistryError) {
    switch (error.statusCode) {
      case 404:
        return "Error: Agent not found. Verify the agent ID is correct — use zyndai_search_agents to find valid agent IDs.";
      case 401:
      case 403:
        return "Error: Authentication failed. Check that ZYNDAI_API_KEY is set correctly.";
      case 429:
        return "Error: Rate limit exceeded. Wait a moment before retrying.";
      case 500:
      case 502:
      case 503:
        return "Error: ZyndAI registry is temporarily unavailable. Try again in a few seconds.";
      default:
        return `Error: Registry request failed (HTTP ${error.statusCode}). ${error.message}`;
    }
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Error: Request timed out. The agent may be slow or unavailable. Try again or try a different agent.";
    }

    if (error.message.includes("fetch failed") || error.message.includes("ECONNREFUSED")) {
      return "Error: Could not connect to the agent. It may be offline. Try searching for another agent with similar capabilities.";
    }

    if (error.message.includes("HTTP 402")) {
      return "Error: This agent requires payment. Set ZYNDAI_PRIVATE_KEY in the .env file with a hex private key for a Base Sepolia wallet funded with USDC.";
    }

    return `Error: ${error.message}`;
  }

  return `Error: An unexpected error occurred: ${String(error)}`;
}
