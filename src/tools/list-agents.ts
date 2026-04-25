import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListAgentsSchema,
  type ListAgentsInput,
} from "../schemas/tools.js";
import { searchEntities } from "../services/registry-client.js";
import { formatSearchResults } from "../services/format.js";
import { handleToolError } from "./error-handler.js";

export function registerListAgents(server: McpServer): void {
  server.registerTool(
    "zyndai_list_agents",
    {
      title: "List AgentDNS Entities",
      description: `Browse all agents and services on AgentDNS with pagination.

Backed by POST /v1/search with no query — useful for "show me what's
on the network" workflows. For targeted discovery, prefer
zyndai_search_agents.

Args:
  - category (string, optional)
  - tags (string[], optional)
  - federated (bool, optional) — query the federation, not just dns01
  - max_results (1-100, default 20)
  - offset (default 0)

Examples:
  - "Browse the network"                  -> {}
  - "Show finance agents"                 -> { category: "finance" }
  - "Next page"                           -> { offset: 20 }
  - "Browse the whole federation"         -> { federated: true }`,
      inputSchema: ListAgentsSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListAgentsInput) => {
      try {
        const result = await searchEntities({
          category: params.category,
          tags: params.tags,
          federated: params.federated,
          max_results: params.max_results,
          offset: params.offset,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: formatSearchResults(
                result.results,
                result.total_found,
                params.offset ?? 0,
              ),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
