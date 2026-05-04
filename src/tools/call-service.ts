import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallServiceSchema, type CallServiceInput } from "../schemas/tools.js";
import { getEntityCard } from "../services/registry-client.js";
import { callAgent } from "../services/agent-caller.js";
import { formatCallResult } from "../services/format.js";
import { handleToolError } from "./error-handler.js";

/**
 * Service entities are stateless agents on the Zynd network — same A2A wire
 * shape, same signed envelopes, but conventionally one-shot (no persona,
 * no sticky context). This tool is a thin wrapper around the same caller
 * `zyndai_call_agent` uses; the distinct surface keeps service vs agent
 * semantics legible to the model.
 */
export function registerCallService(server: McpServer): void {
  server.registerTool(
    "zyndai_call_service",
    {
      title: "Call AgentDNS Service",
      description: `Invoke a service entity (zns:svc:…) registered on AgentDNS.

Services = stateless agents. Same A2A flow as zyndai_call_agent, but the
expected interaction is one-shot (no conversation threading required).

Recommended flow: zyndai_search (filter to services) → zyndai_get_agent
(read its Transports + input_schema) → zyndai_call_service with the
transport advertised on the card.

Args:
  - entity_id (string): zns:svc:… (or any zns:…) entity ID.
  - message (string): payload (max 10k chars). Match input_schema if present.
  - conversation_id (string, optional): A2A contextId for follow-ups.
  - mode (auto|sync|push, optional): delivery channel. Most services = sync.
  - transport (auto|JSONRPC|HTTP+JSON, optional): wire transport.
    "auto" follows the card's preferredTransport.

Errors:
  - 400 — payload didn't match input_schema.
  - 402 — paid service; configure ZYNDAI_PAYMENT_PRIVATE_KEY.
  - 404 — service not registered.
  - 408 — service timed out.
  - 5xx — service crashed or is offline.`,
      inputSchema: CallServiceSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: CallServiceInput) => {
      try {
        const { card } = await getEntityCard(params.entity_id);

        const result = await callAgent({
          card,
          ...(params.message !== undefined ? { message: params.message } : {}),
          ...(params.payload !== undefined ? { payload: params.payload } : {}),
          contextId: params.conversation_id,
          mode: params.mode,
          transport: params.transport,
        });

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
                  `The service will POST its reply to the persona-runner when it finishes. ` +
                  `Use \`zyndai_async_replies\` to check for the result.`,
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
