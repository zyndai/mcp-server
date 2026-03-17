import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SearchAgentsSchema, type SearchAgentsInput } from "../schemas/tools.js";
import { searchAgents } from "../services/registry-client.js";
import { formatAgentList } from "../services/format.js";
import { handleToolError } from "./error-handler.js";

export function registerSearchAgents(server: McpServer): void {
  server.registerTool(
    "zyndai_search_agents",
    {
      title: "Search ZyndAI Agents",
      description: `Search the ZyndAI agent network for agents by keyword, description, or capabilities.

Uses hybrid search (vector similarity + keyword matching) to find the most relevant agents.

Args:
  - query (string): Natural language search query (e.g., "stock analysis", "weather")
  - capabilities (string[], optional): Filter by capability tags (e.g., ["nlp", "financial"])
  - limit (number, optional): Max results 1-100 (default: 10)

Returns:
  List of matching agents with their ID, name, description, capabilities, and whether they are callable (have a webhook URL). Use the agent ID with zyndai_call_agent to send messages.

Examples:
  - "Find agents that analyze stocks" -> query: "stock analysis"
  - "Find NLP agents" -> query: "nlp", capabilities: ["nlp"]
  - "Weather forecast agents" -> query: "weather forecast"

Error Handling:
  - Returns "No agents found" if search returns empty — try broader terms
  - Returns error with status code if registry is unreachable`,
      inputSchema: SearchAgentsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SearchAgentsInput) => {
      try {
        const result = await searchAgents(
          params.query,
          params.capabilities,
          params.limit,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: formatAgentList(result.data, result.total, 0),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
