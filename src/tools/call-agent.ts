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
      title: "Call AgentDNS Agent (A2A)",
      description: `Send a signed A2A message to an AgentDNS agent and wait for its response.

Flow:
  1. Fetches the agent's signed AgentCard from /v1/entities/<id>/card (or
     /.well-known/agent-card.json as a fallback).
  2. Sends a JSON-RPC \`message/send\` to the card's \`url\` field. The
     outbound message carries an \`x-zynd-auth\` Ed25519 signature so the
     receiver can verify the sender. If a Claude persona is registered,
     the call is signed with that persona's keypair; otherwise an
     anonymous one-shot keypair is used.
  3. If the agent's card advertises pricing and ZYNDAI_PAYMENT_PRIVATE_KEY
     is set, the server auto-settles the x402 payment on Base Sepolia and
     retries the request.
  4. Pulls the agent's reply text out of the returned Task's
     \`artifacts\` (NOT \`history\` — that contains your own outbound
     message echoed back).

Tip: call zyndai_get_agent first to read the agent's input_schema. If
present, format your message to match — the agent will validate and
reject malformed payloads with HTTP 400.

Args:
  - entity_id (string): zns:… ID from search or resolve.
  - message (string): query/message body (max 10k chars).
  - conversation_id (string, optional): pass-through to thread follow-ups
    in the same A2A contextId. Pass back the value from a prior reply to
    keep context.

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
          contextId: params.conversation_id,
          mode: params.mode,
        });

        // Push mode: the call returns immediately with the kickoff task in
        // a non-terminal state. Surface this clearly so Claude doesn't try
        // to read the response field — that comes back later.
        if (
          (params.mode === "push" || params.mode === "auto") &&
          result.taskState !== "completed" &&
          result.taskState !== "failed" &&
          result.taskState !== "canceled"
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `**Push notification armed.**\n\n` +
                  `Sent to: \`${result.agentName}\` (\`${result.entityId}\`)\n` +
                  `Task ID: \`${result.taskId}\`\n` +
                  `Conversation: \`${result.contextId}\`\n` +
                  `State: ${result.taskState}\n\n` +
                  `The agent will POST its reply to the persona-runner when it finishes. ` +
                  `Use \`zyndai_async_replies\` to check for the result, or filter by this task ID.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: formatCallResult(
                result.response,
                result.agentName,
                result.entityId,
                result.messageId,
                result.contextId,
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
