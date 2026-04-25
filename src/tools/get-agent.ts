import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GetAgentSchema, type GetAgentInput } from "../schemas/tools.js";
import { getEntityCard } from "../services/registry-client.js";
import { formatEntityCard } from "../services/format.js";
import { handleToolError } from "./error-handler.js";

export function registerGetAgent(server: McpServer): void {
  server.registerTool(
    "zyndai_get_agent",
    {
      title: "Get AgentDNS Entity Card",
      description: `Fetch the full signed entity card for an agent or service.

Hits GET /v1/entities/{id}/card on AgentDNS, falling back to the entity's
own /.well-known/agent.json if the registry doesn't return a card.

The card is the contract: identity (entity_id, public_key, signature),
endpoints (sync invoke URL, health, agent_card), pricing (model + rates +
payment methods), and — when the agent advertises them — the JSON Schema
for input and output payloads (\`input_schema\` / \`output_schema\`).

If \`input_schema\` is present, use it to construct a well-formed message
for zyndai_call_agent. If \`output_schema\` is present, parse the call
response as JSON.

Args:
  - entity_id (string): zns:… ID from search/resolve results.

Errors:
  - 404 — agent not registered or already deregistered.
  - 5xx — registry temporarily unavailable.`,
      inputSchema: GetAgentSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetAgentInput) => {
      try {
        const { card } = await getEntityCard(params.entity_id);
        return {
          content: [
            { type: "text" as const, text: formatEntityCard(card) },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
