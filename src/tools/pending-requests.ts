import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readActivePersona } from "../services/identity-store.js";
import { existingDaemon } from "../services/persona-daemon.js";
import { readPending } from "../services/mailbox.js";
import { handleToolError } from "./error-handler.js";

const PendingRequestsSchema = z
  .object({
    since: z
      .string()
      .optional()
      .describe(
        "Only return requests received after this ISO 8601 timestamp. Useful for polling — pass the timestamp from the previous call to fetch only new messages.",
      ),
  })
  .strict();

type PendingRequestsInput = z.infer<typeof PendingRequestsSchema>;

export function registerPendingRequestsTool(server: McpServer): void {
  server.registerTool(
    "zyndai_pending_requests",
    {
      title: "Fetch incoming messages for the persona",
      description: `List messages other agents have sent to the user's Claude persona that are still awaiting a human reply.

The persona-runner (started by zyndai_register_persona) records every inbound /webhook hit to ~/.zynd/mailbox/<entity_id>.jsonl. This tool reads that file and returns only entries with status=pending.

Workflow when a request lands:
  1. Call zyndai_pending_requests.
  2. For each entry, ask the user: "Agent X is asking '<content>'. Do you want to reply?"
  3. Call zyndai_respond_to_request to send an approved reply or reject.

Args:
  - since (string, optional) — ISO timestamp; only return newer entries.`,
      inputSchema: PendingRequestsSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: PendingRequestsInput) => {
      try {
        const persona = readActivePersona();
        if (!persona) {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text: "Error: No active persona. Run `zyndai_login` then `zyndai_register_persona` first.",
              },
            ],
          };
        }

        const daemon = existingDaemon();
        const daemonNote = daemon
          ? ""
          : `\n\n_Note: persona-runner is not currently running. Inbound messages won't be received until you re-register or restart the runner. (See \`~/.zynd/persona-runner.log\` for crash details.)_`;

        let entries = readPending(persona.entity_id);
        if (params.since) {
          const cutoff = Date.parse(params.since);
          if (!Number.isNaN(cutoff)) {
            entries = entries.filter((e) => Date.parse(e.received_at) > cutoff);
          }
        }

        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No pending requests for **${persona.agent_name}** \`${persona.entity_id}\`.${daemonNote}`,
              },
            ],
          };
        }

        const lines = [
          `**${entries.length} pending request${entries.length === 1 ? "" : "s"}** for ${persona.agent_name}:`,
          "",
        ];
        for (const e of entries) {
          lines.push("---");
          lines.push(`Message ID: \`${e.message_id}\``);
          lines.push(
            `From: \`${e.sender_id}\`${e.sender_name ? ` (${e.sender_name})` : ""}`,
          );
          lines.push(`Received: ${e.received_at}`);
          if (e.conversation_id) lines.push(`Conversation: \`${e.conversation_id}\``);
          if (e.metadata && Object.keys(e.metadata).length > 0) {
            lines.push(`Metadata: ${JSON.stringify(e.metadata)}`);
          }
          lines.push("");
          lines.push(`> ${e.content.replace(/\n/g, "\n> ")}`);
          lines.push("");
        }
        lines.push(
          `For each request, confirm with the user, then call ` +
            `\`zyndai_respond_to_request({ message_id, approve, response })\`.`,
        );
        if (daemonNote) lines.push(daemonNote);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
