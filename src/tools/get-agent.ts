import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GetAgentSchema, type GetAgentInput } from "../schemas/tools.js";
import { getAgentById } from "../services/registry-client.js";
import { formatAgentDetail } from "../services/format.js";
import { handleToolError } from "./error-handler.js";

export function registerGetAgent(server: McpServer): void {
  server.registerTool(
    "zyndai_get_agent",
    {
      title: "Get ZyndAI Agent Details",
      description: `Get full details of a specific ZyndAI agent by its ID.

Returns complete agent information including capabilities, webhook URL, DID, and health check status. Use this to inspect an agent before calling it.

Args:
  - agent_id (string): ID of the agent (from search or list results)

Returns:
  Full agent details: name, description, capabilities, DID identifier, webhook URL, health check status, and timestamps.

Examples:
  - Inspect before calling: agent_id: "HuwSphtvcR5k37BPIxdbJ"

Error Handling:
  - "Resource not found" if agent_id doesn't exist — verify the ID from search results
  - Returns error if registry is unreachable`,
      inputSchema: GetAgentSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetAgentInput) => {
      try {
        const agent = await getAgentById(params.agent_id);

        return {
          content: [
            {
              type: "text" as const,
              text: formatAgentDetail(agent),
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
