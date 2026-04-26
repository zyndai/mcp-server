import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readActivePersona } from "../services/identity-store.js";
import { existingDaemon, postInternalReply } from "../services/persona-daemon.js";
import { findEntry, updateStatus } from "../services/mailbox.js";
import { handleToolError } from "./error-handler.js";

const RespondToRequestSchema = z
  .object({
    message_id: z
      .string()
      .min(1)
      .describe("ID of the request to reply to. Get this from zyndai_pending_requests."),
    approve: z
      .boolean()
      .describe(
        "true = the user approved and Claude has a reply to send. false = user explicitly rejected.",
      ),
    response: z
      .string()
      .max(10_000)
      .optional()
      .describe("The reply text. Required when approve=true. Ignored when approve=false."),
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
  - Approval: zyndai_respond_to_request({ message_id, approve: true, response: "..." })
  - Rejection: zyndai_respond_to_request({ message_id, approve: false })

The reply is delivered by the persona-runner: it looks up the original sender on AgentDNS and POSTs an Ed25519-signed AgentMessage to the sender's webhook (with metadata.in_reply_to set so they can correlate it back to the original request).

Args:
  - message_id (string, required) — from zyndai_pending_requests.
  - approve (bool, required) — true = send response, false = reject.
  - response (string) — required when approve=true.

Errors:
  - "no active persona" — run zyndai_login + zyndai_register_persona first.
  - "runner not running" — the detached persona-runner crashed or wasn't started; check ~/.zynd/persona-runner.log.
  - "no such message" — message_id not in mailbox (already replied or wrong id).`,
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
                text: "Error: `response` is required when `approve` is true.",
              },
            ],
          };
        }

        const persona = readActivePersona();
        if (!persona) {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text: "Error: No active persona. Run `zyndai_login` and `zyndai_register_persona` first.",
              },
            ],
          };
        }

        const entry = findEntry(persona.entity_id, params.message_id);
        if (!entry) {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text: `Error: no message \`${params.message_id}\` in mailbox. Use \`zyndai_pending_requests\` to see current ids.`,
              },
            ],
          };
        }
        if (entry.status !== "pending") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Message \`${params.message_id}\` is already \`${entry.status}\` — no further action needed.`,
              },
            ],
          };
        }

        const handle = existingDaemon();
        if (!handle) {
          // Daemon not running — at least mark the mailbox so the user
          // can see they declined. Outbound delivery requires the runner.
          if (!params.approve) {
            updateStatus(persona.entity_id, params.message_id, { status: "rejected" });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Marked \`${params.message_id}\` as rejected locally. (Runner not running, so the sender was NOT notified — they'll retry until they give up or until you re-register the persona.)`,
                },
              ],
            };
          }
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text:
                  "Error: persona-runner is not running, so we can't deliver the reply outbound. Check `~/.zynd/persona-runner.log`, or call `zyndai_deregister_persona` and re-register to restart it.",
              },
            ],
          };
        }

        const result = await postInternalReply(handle, {
          message_id: params.message_id,
          response: params.response ?? "",
          approve: params.approve,
        });

        const verb = result.status === "delivered" ? "Reply delivered" : "Request rejected";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `**${verb}.**\n\n` +
                `- Message ID: \`${params.message_id}\`\n` +
                `- From persona: \`${persona.agent_name}\` \`${persona.entity_id}\`\n` +
                `- Sent to sender: \`${entry.sender_id}\``,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
