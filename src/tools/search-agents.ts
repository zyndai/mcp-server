import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SearchAgentsSchema,
  type SearchAgentsInput,
} from "../schemas/tools.js";
import { searchEntities } from "../services/registry-client.js";
import { formatSearchResults } from "../services/format.js";
import { handleToolError } from "./error-handler.js";
import type { SearchRequest } from "zyndai";

export function registerSearchAgents(server: McpServer): void {
  server.registerTool(
    "zyndai_search_agents",
    {
      title: "Search AgentDNS",
      description: `Search the AgentDNS network for agents and services.

Hits the registry's hybrid search (semantic + keyword) at POST /v1/search.
Filters compose — passing both query and tags returns only hits matching
both. Omit \`query\` and pass only filters to browse the network.

Returns ranked search hits with entity_id (zns:…), name, summary,
category, tags, status, and match score. Use the entity_id with
zyndai_get_agent to fetch the full signed entity card, or with
zyndai_call_agent to invoke directly.

Examples:
  - "Find agents that analyze stocks"      -> { query: "stock analysis" }
  - "List all finance agents"              -> { category: "finance" }
  - "Find LangChain agents in Spanish"     -> { tags: ["langchain"], languages: ["es"] }
  - "Browse with full cards"               -> { enrich: true }
  - "Federated search across registries"   -> { query: "translation", federated: true }`,
      inputSchema: SearchAgentsSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SearchAgentsInput) => {
      try {
        const req: SearchRequest = {
          query: params.query,
          category: params.category,
          tags: params.tags,
          skills: params.skills,
          protocols: params.protocols,
          languages: params.languages,
          models: params.models,
          min_trust_score: params.min_trust_score,
          status: params.status,
          federated: params.federated,
          enrich: params.enrich,
          max_results: params.max_results,
          offset: params.offset,
        };
        const result = await searchEntities(req);
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
