import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListAgentsSchema, type ListAgentsInput } from "../schemas/tools.js";
import { listAgents } from "../services/registry-client.js";
import { formatAgentList } from "../services/format.js";
import { handleToolError } from "./error-handler.js";

export function registerListAgents(server: McpServer): void {
  server.registerTool(
    "zyndai_list_agents",
    {
      title: "List ZyndAI Agents",
      description: `Browse all agents registered on the ZyndAI network with pagination.

Unlike search, this returns all agents without keyword matching — useful for browsing the network or getting an overview of available agents.

Args:
  - status (string, optional): Filter by status — "ACTIVE" (default), "INACTIVE", or "DEPRECATED"
  - limit (number, optional): Max results 1-100 (default: 20)
  - offset (number, optional): Skip N results for pagination (default: 0)

Returns:
  Paginated list of agents with their ID, name, description, capabilities, and callable status. Includes total count and pagination guidance.

Examples:
  - Browse all active agents: (no params needed)
  - See next page: offset: 20
  - Find deprecated agents: status: "DEPRECATED"

Error Handling:
  - Returns empty list if no agents match the status filter
  - Returns error if registry is unreachable`,
      inputSchema: ListAgentsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListAgentsInput) => {
      try {
        const result = await listAgents(
          params.status,
          params.limit,
          params.offset,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: formatAgentList(
                result.data,
                result.total,
                params.offset,
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
