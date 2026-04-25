import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_REGISTRY_URL } from "../constants.js";
import { loadActivePersonaKeypair } from "../services/identity-store.js";
import { postReply } from "../services/persona-inbox.js";
import { handleToolError } from "./error-handler.js";

// Cross-field validation (response required when approve=true) lives in the
// handler, not the schema — the MCP SDK's registerTool() wants a raw
// ZodRawShape on inputSchema, and chaining .refine() wraps the schema in
// ZodEffects which loses the `.shape` accessor.
const RespondToRequestSchema = z
  .object({
    message_id: z
      .string()
      .min(1)
      .describe(
        "ID of the request to reply to. Get this from zyndai_pending_requests.",
      ),
    approve: z
      .boolean()
      .describe(
        "true = the user approved the request and Claude has a reply to send. false = the user explicitly rejected — the sender will be notified the persona declined to respond.",
      ),
    response: z
      .string()
      .max(10_000)
      .optional()
      .describe(
        "The reply text. Required when approve=true. Ignored when approve=false.",
      ),
    conversation_id: z
      .string()
      .optional()
      .describe(
        "Pass through the conversation_id from the incoming request to keep context across turns.",
      ),
  })
  .strict();

type RespondToRequestInput = z.infer<typeof RespondToRequestSchema>;

export function registerRespondToRequestTool(server: McpServer): void {
  server.registerTool(
    "zyndai_respond_to_request",
    {
      title: "Reply to (or reject) an incoming persona request",
      description: `Send a reply to a queued incoming message — or reject it.

Always confirm with the user before calling this:
  "Agent X is asking '<request>'. Do you want to reply, and if so, what?"

When you have the user's decision:
  - Approval + a reply: zyndai_respond_to_request({ message_id, approve: true, response: "..." })
  - Rejection: zyndai_respond_to_request({ message_id, approve: false })

The reply is signed with the active persona's Ed25519 keypair so the sender can verify it really came from this persona.

Args:
  - message_id (string, required) — from zyndai_pending_requests.
  - approve (bool, required) — true = send response, false = reject.
  - response (string) — required when approve=true.
  - conversation_id (string, optional) — for multi-turn continuity.

Errors:
  - "no active persona" — run zyndai_login + zyndai_register_persona first.
  - "inbox routing not deployed" — registry hasn't shipped /v1/inbox yet.`,
      inputSchema: RespondToRequestSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: RespondToRequestInput) => {
      try {
        if (params.approve && (!params.response || !params.response.trim())) {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text:
                  "Error: `response` is required when `approve` is true. Either set `approve: false` to reject, or pass a reply body in `response`.",
              },
            ],
          };
        }

        const loaded = loadActivePersonaKeypair();
        if (!loaded) {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text:
                  "Error: No active persona. Run `zyndai_login` and `zyndai_register_persona` first — there's no signing identity to reply with.",
              },
            ],
          };
        }

        const registryUrl =
          process.env["ZYNDAI_REGISTRY_URL"] ?? DEFAULT_REGISTRY_URL;
        const result = await postReply({
          registryUrl,
          entityId: loaded.persona.entity_id,
          messageId: params.message_id,
          personaKeypair: loaded.keypair,
          approve: params.approve,
          response: params.response,
          conversationId: params.conversation_id,
        });

        if (result.status === "unsupported") {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "Inbox routing isn't deployed on this AgentDNS registry yet (`POST /v1/inbox/.../reply` returned 404). The reply was not delivered.",
              },
            ],
          };
        }

        const verb = result.status === "delivered" ? "Reply delivered" : "Request rejected";
        const lines = [
          `**${verb}.**`,
          "",
          `- Message ID: \`${params.message_id}\``,
          `- From persona: \`${loaded.persona.agent_name}\` \`${loaded.persona.entity_id}\``,
        ];
        if (result.signature) {
          lines.push(
            `- Signature: \`${result.signature.slice(0, 32)}…\` (Ed25519, sender can verify against the persona's registered public key)`,
          );
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
