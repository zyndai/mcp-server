import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ResolveFqanSchema,
  type ResolveFqanInput,
} from "../schemas/tools.js";
import { resolveFqan } from "../services/registry-client.js";
import { handleToolError } from "./error-handler.js";

/**
 * Resolve a fully-qualified agent name (FQAN) to its entity_id and a
 * one-line summary.
 *
 * FQANs look like `<entity_name>.<dev_handle>.zynd` — e.g. `stocks.alice.zynd`.
 * Backed by POST /v1/search with the `fqan` filter, the same path the
 * `zynd resolve` CLI uses.
 *
 * The model can use this to translate a human-friendly name into the
 * entity_id needed for zyndai_get_agent or zyndai_call_agent.
 */
export function registerResolveFqan(server: McpServer): void {
  server.registerTool(
    "zyndai_resolve_fqan",
    {
      title: "Resolve FQAN -> Entity",
      description: `Resolve a fully-qualified agent name to an entity_id.

FQAN format: <entity_name>.<dev_handle>.zynd
Example: 'stocks.alice.zynd' -> 'zns:a90cb541…'

Returns the entity_id, name, summary, category, tags, and entity_url so
you can pass entity_id into zyndai_get_agent or zyndai_call_agent.

Errors:
  - 404 — no agent registered with that FQAN.`,
      inputSchema: ResolveFqanSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ResolveFqanInput) => {
      try {
        const hit = await resolveFqan(params.fqan);
        const lines = [
          `**${hit.name}** \`${hit.entity_id}\``,
          "",
          hit.summary || "(no summary)",
          "",
          `- Category: ${hit.category}`,
          `- Tags: ${(hit.tags ?? []).join(", ") || "(none)"}`,
          `- Entity URL: ${hit.entity_url}`,
          `- Home registry: ${hit.home_registry}`,
        ];
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
