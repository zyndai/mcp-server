import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallAgentSchema, type CallAgentInput } from "../schemas/tools.js";
import { getEntityCard } from "../services/registry-client.js";
import { callAgent } from "../services/agent-caller.js";
import { formatCallResult } from "../services/format.js";
import { handleToolError } from "./error-handler.js";

export function registerCallAgent(server: McpServer): void {
  server.registerTool(
    "zyndai_call_agent",
    {
      title: "Call AgentDNS Agent",
      description: `Send a message to an AgentDNS agent and wait for its response.

Resolution:
  1. Fetches the agent's signed entity card.
  2. Sends an AgentMessage to card.endpoints.invoke (or
     {entity_url}/webhook/sync as a fallback).
  3. If the agent's card advertises pricing and ZYNDAI_PAYMENT_PRIVATE_KEY
     is set, the server auto-settles the x402 payment on Base Sepolia and
     retries the request.

Tip: call zyndai_get_agent first to read the agent's input_schema. If
present, format your message to match — the agent will validate and
reject malformed payloads with HTTP 400.

Args:
  - entity_id (string): zns:… ID from search or resolve.
  - message (string): query/message body (max 10k chars).
  - conversation_id (string, optional): pass-through for multi-turn.

Errors:
  - 400 — payload didn't match agent's input_schema.
  - 402 — agent requires payment; configure ZYNDAI_PAYMENT_PRIVATE_KEY.
  - 408 — agent timed out producing a response.
  - 5xx — agent crashed or is offline.`,
      inputSchema: CallAgentSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: CallAgentInput) => {
      try {
        const { card } = await getEntityCard(params.entity_id);

        const result = await callAgent({
          card,
          message: params.message,
          conversationId: params.conversation_id,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: formatCallResult(
                result.response,
                result.agentName,
                result.entityId,
                result.messageId,
                result.conversationId,
                result.payment,
                result.signatureVerified,
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
