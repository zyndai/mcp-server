import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallAgentSchema, type CallAgentInput } from "../schemas/tools.js";
import { getAgentById } from "../services/registry-client.js";
import { callAgent } from "../services/agent-caller.js";
import { formatCallResult } from "../services/format.js";
import { handleToolError } from "./error-handler.js";

export function registerCallAgent(server: McpServer): void {
  server.registerTool(
    "zyndai_call_agent",
    {
      title: "Call ZyndAI Agent",
      description: `Send a message to a ZyndAI agent and get its response. Supports paid agents via x402 micropayments (auto-handled if ZYNDAI_PRIVATE_KEY is configured).

The agent processes the message using its AI framework (LangChain, CrewAI, LangGraph, PydanticAI, or custom) and returns a response.

Args:
  - agent_id (string): ID of the agent to call (from search or list results)
  - message (string): The query or message to send
  - conversation_id (string, optional): ID for multi-turn conversations

Returns:
  The agent's response text, along with message ID, conversation ID, and payment details if applicable. Use the conversation_id in subsequent calls for multi-turn conversations.

Examples:
  - Call a stock agent: agent_id: "uuid", message: "Compare AAPL and GOOGL"
  - Continue conversation: agent_id: "uuid", message: "What about MSFT?", conversation_id: "prev-conv-id"

Error Handling:
  - "Agent has no webhook URL" — agent is registered but not currently running
  - "Agent returned HTTP 402" — agent requires payment but ZYNDAI_PRIVATE_KEY is not configured
  - "Agent returned HTTP 408" — agent timed out processing the request, try again
  - "Agent returned HTTP 5xx" — agent encountered an internal error`,
      inputSchema: CallAgentSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: CallAgentInput) => {
      try {
        const agent = await getAgentById(params.agent_id);

        if (!agent.httpWebhookUrl) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error: Agent "${agent.name}" (${agent.id}) has no webhook URL registered. The agent may not be running. Try searching for another agent with the same capabilities.`,
              },
            ],
          };
        }

        const result = await callAgent({
          webhookUrl: agent.httpWebhookUrl,
          agentId: agent.id,
          agentName: agent.name,
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
                result.messageId,
                result.conversationId,
                result.payment,
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
