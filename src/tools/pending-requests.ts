import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_REGISTRY_URL } from "../constants.js";
import { readActivePersona } from "../services/identity-store.js";
import { fetchPendingRequests } from "../services/persona-inbox.js";
import { handleToolError } from "./error-handler.js";

const PendingRequestsSchema = z
  .object({
    since: z
      .string()
      .optional()
      .describe(
        "Only return requests queued after this ISO 8601 timestamp. Useful for polling — pass the timestamp from the previous call to fetch only new messages.",
      ),
  })
  .strict();

type PendingRequestsInput = z.infer<typeof PendingRequestsSchema>;

export function registerPendingRequestsTool(server: McpServer): void {
  server.registerTool(
    "zyndai_pending_requests",
    {
      title: "Fetch incoming messages for the persona",
      description: `List messages other agents have sent to the user's Claude persona.

Other agents on AgentDNS can call into the persona's entity_url. Since the MCP doesn't host a webhook directly, the registry queues the messages in an inbox. This tool fetches that inbox.

Workflow when an incoming request arrives:
  1. Call zyndai_pending_requests to fetch the queue.
  2. For each request, ask the user: "Agent X is asking '<content>'. Do you want to reply?"
  3. Use zyndai_respond_to_request to either send an approved reply or reject the request.

Returned fields per request:
  - message_id (string) — pass back to zyndai_respond_to_request
  - sender_id (zns:...) — who's calling
  - sender_name (optional) — friendly name from sender's card
  - content (string) — the actual message
  - conversation_id (optional)
  - queued_at — when the registry received it
  - metadata (optional) — any extra context the sender attached

Args:
  - since (string, optional) — ISO timestamp; only return newer requests.`,
      inputSchema: PendingRequestsSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
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
                text:
                  "Error: No active persona. Run `zyndai_login` and `zyndai_register_persona` first — until you have a persona, no one can address messages to you.",
              },
            ],
          };
        }

        const registryUrl =
          process.env["ZYNDAI_REGISTRY_URL"] ?? DEFAULT_REGISTRY_URL;
        const result = await fetchPendingRequests({
          registryUrl,
          entityId: persona.entity_id,
          since: params.since,
        });

        if (result.unsupported) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Inbox routing isn't deployed on this AgentDNS registry yet (\`GET /v1/inbox/${persona.entity_id}\` returned 404). ` +
                  `Other agents can still see your persona on the registry, but their messages won't reach the MCP until inbox support ships. ` +
                  `Track the registry's release notes for "/v1/inbox" availability.`,
              },
            ],
          };
        }

        if (result.requests.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No pending requests for **${persona.agent_name}** \`${persona.entity_id}\`.\n\n` +
                  `Other agents on AgentDNS can reach this persona by sending an AgentMessage to its entity_url. ` +
                  `Call this tool again later to check.`,
              },
            ],
          };
        }

        const lines = [
          `**${result.requests.length} pending request${result.requests.length === 1 ? "" : "s"}** for ${persona.agent_name}:`,
          "",
        ];
        for (const req of result.requests) {
          lines.push(`---`);
          lines.push(`Message ID: \`${req.message_id}\``);
          lines.push(`From: \`${req.sender_id}\`${req.sender_name ? ` (${req.sender_name})` : ""}`);
          lines.push(`Queued at: ${req.queued_at}`);
          if (req.conversation_id) {
            lines.push(`Conversation: \`${req.conversation_id}\``);
          }
          if (req.metadata && Object.keys(req.metadata).length > 0) {
            lines.push(`Metadata: ${JSON.stringify(req.metadata)}`);
          }
          lines.push("");
          lines.push(`> ${req.content.replace(/\n/g, "\n> ")}`);
          lines.push("");
        }
        lines.push(
          `For each request, ask the user whether to approve, then call ` +
            `\`zyndai_respond_to_request({ message_id, approve, response })\`.`,
        );

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
