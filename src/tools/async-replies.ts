import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listAsyncReplies, findOutboundTask } from "../services/outbound-tasks.js";
import { handleToolError } from "./error-handler.js";

const Schema = z
  .object({
    task_id: z
      .string()
      .optional()
      .describe(
        "Filter to a specific task ID returned by an earlier zyndai_call_agent push call.",
      ),
    limit: z.number().int().min(1).max(200).default(20),
  })
  .strict();

type Input = z.infer<typeof Schema>;

export function registerAsyncRepliesTool(server: McpServer): void {
  server.registerTool(
    "zyndai_async_replies",
    {
      title: "Read async replies (push-callback results)",
      description: `Fetch agent replies that arrived asynchronously after a push-mode \`zyndai_call_agent\` call.

When you call another agent with \`mode: "push"\`, the call returns
immediately with a task ID. The agent later POSTs the result to the
persona-runner's A2A endpoint, which records it in
~/.zynd/mcp-async-replies.jsonl. This tool surfaces those records.

Args:
  - task_id (optional): show replies only for this task.
  - limit (default 20, max 200): newest-first cap on the returned list.

Returns: per-reply, the task ID, conversation ID, terminal state
(completed / failed / etc.), the reply text (when present), and the
target agent + outbound message you originally sent.`,
      inputSchema: Schema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      try {
        const replies = listAsyncReplies(params.limit);
        const filtered = params.task_id
          ? replies.filter((r) => r.task_id === params.task_id)
          : replies;

        if (filtered.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: params.task_id
                  ? `No async replies recorded yet for task \`${params.task_id}\`. Either the agent is still working, or it didn't fire its callback.`
                  : "No async replies recorded yet. After making a push-mode \`zyndai_call_agent\` call, the result will land here when the agent finishes.",
              },
            ],
          };
        }

        const lines: string[] = [
          `**${filtered.length} async repl${filtered.length === 1 ? "y" : "ies"}** (newest first):`,
          "",
        ];
        for (const r of filtered) {
          const meta = findOutboundTask(r.task_id);
          lines.push(`### Task \`${r.task_id}\``);
          lines.push(`- State: **${r.state}**`);
          lines.push(`- Conversation: \`${r.context_id}\``);
          lines.push(`- Received: ${r.received_at}`);
          if (meta) {
            lines.push(`- Sent to: \`${meta.target_entity_id}\``);
            lines.push(`- Outbound: ${truncate(meta.outbound_message, 160)}`);
          }
          if (r.reply) {
            lines.push("");
            lines.push("**Reply:**");
            lines.push(r.reply);
          } else {
            lines.push(
              "- (No artifact text in the callback. Use \`zyndai_get_agent\` then a fresh \`message/send\` with the same task ID to fetch the full task.)",
            );
          }
          lines.push("");
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
