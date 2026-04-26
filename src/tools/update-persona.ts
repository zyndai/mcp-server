import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DNSRegistryClient } from "zyndai";
import { DEFAULT_REGISTRY_URL } from "../constants.js";
import { loadActivePersonaKeypair } from "../services/identity-store.js";
import {
  existingDaemon,
  restartDaemon,
} from "../services/persona-daemon.js";
import { handleToolError } from "./error-handler.js";

const UpdatePersonaSchema = z
  .object({
    entity_url: z
      .string()
      .url()
      .optional()
      .describe(
        "New public URL for the persona — pass when the tunnel rotated (e.g. ngrok-free issued a new hostname). The runner is restarted with this URL so callers immediately reach the right upstream.",
      ),
    summary: z
      .string()
      .max(200)
      .optional()
      .describe("Replace the persona's registry summary."),
    tags: z
      .array(z.string().min(1).max(40))
      .max(20)
      .optional()
      .describe(
        "Replace the persona's tags. The defaults ['claude-persona','mcp-client','human-in-the-loop'] are merged in automatically so callers can still discover the persona by those.",
      ),
    pricing_usd: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Update x402 pricing in USD. Pass 0 to switch the persona back to FREE.",
      ),
    pricing_currency: z
      .string()
      .optional()
      .describe("Currency for x402 pricing — defaults to USDC. Only meaningful with pricing_usd > 0."),
  })
  .strict();

type UpdatePersonaInput = z.infer<typeof UpdatePersonaSchema>;

const PERSONA_TAGS = ["claude-persona", "mcp-client", "human-in-the-loop"];

export function registerUpdatePersonaTool(server: McpServer): void {
  server.registerTool(
    "zyndai_update_persona",
    {
      title: "Update the persona's registry record (and restart runner if needed)",
      description: `Patch the active persona's AgentDNS record without changing its entity_id. Use when:
  - The ngrok / cloudflared / tunnel URL rotated → pass entity_url=<new-https-url>.
  - The user wants to start charging (or stop) → pass pricing_usd.
  - The persona's summary or tags need refreshing.

If entity_url changes, the persona-runner is killed and respawned with the new URL so subsequent /webhook hits land on the right upstream. The old PID is replaced in ~/.zynd/mcp-persona.json.

At least one field must be provided. Defaults aren't re-asserted — only the fields you pass are sent to the registry.

Args:
  - entity_url (URL, optional)
  - summary (string ≤200 chars, optional)
  - tags (string[], optional) — claude-persona / mcp-client / human-in-the-loop are always merged in.
  - pricing_usd (number, optional) — 0 = free, >0 enables x402.
  - pricing_currency (string, optional) — defaults USDC.

Errors:
  - "no active persona" — run zyndai_login + zyndai_register_persona first.
  - "nothing to update" — no fields supplied.
  - registry HTTP errors are surfaced as-is.`,
      inputSchema: UpdatePersonaSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: UpdatePersonaInput) => {
      try {
        const loaded = loadActivePersonaKeypair();
        if (!loaded) {
          return {
            isError: true as const,
            content: [
              { type: "text" as const, text: "Error: No active persona. Run `zyndai_login` and `zyndai_register_persona` first." },
            ],
          };
        }

        const fields: Record<string, unknown> = {};
        if (params.entity_url !== undefined) fields["entity_url"] = params.entity_url;
        if (params.summary !== undefined) fields["summary"] = params.summary;
        if (params.tags !== undefined) {
          // Merge with defaults so the persona is still discoverable by
          // those tags. Dedupe.
          fields["tags"] = Array.from(new Set([...PERSONA_TAGS, ...params.tags]));
        }
        if (params.pricing_usd !== undefined) {
          if (params.pricing_usd > 0) {
            fields["entity_pricing"] = {
              model: "per-request",
              base_price_usd: params.pricing_usd,
              currency: params.pricing_currency ?? "USDC",
              payment_methods: ["x402"],
            };
          } else {
            // Explicit zero = clear pricing. The registry treats null /
            // missing as "no x402 demand"; we send null to be unambiguous.
            fields["entity_pricing"] = null;
          }
        }

        if (Object.keys(fields).length === 0) {
          return {
            isError: true as const,
            content: [
              { type: "text" as const, text: "Error: nothing to update — pass at least one of entity_url, summary, tags, pricing_usd." },
            ],
          };
        }

        const registryUrl = process.env["ZYNDAI_REGISTRY_URL"] ?? DEFAULT_REGISTRY_URL;
        await DNSRegistryClient.updateEntity({
          registryUrl,
          entityId: loaded.persona.entity_id,
          keypair: loaded.keypair,
          fields,
        });

        const lines: string[] = [
          `**Persona updated on AgentDNS.**`,
          ``,
          `- Entity ID (unchanged): \`${loaded.persona.entity_id}\``,
        ];
        for (const k of Object.keys(fields)) lines.push(`- Updated field: \`${k}\``);

        // If the public URL changed, the runner needs to know — its webhook
        // is bound to a local port, but the entity_url it advertises in
        // .well-known/agent.json comes from the daemon config we hand it.
        // Restart with the new URL so the served card matches reality.
        if (params.entity_url) {
          const current = existingDaemon();
          if (current) {
            const fresh = restartDaemon({
              entityId: loaded.persona.entity_id,
              agentName: loaded.persona.agent_name,
              keypairPath: loaded.persona.keypair_path,
              registryUrl,
              entityUrl: params.entity_url,
              webhookPort: current.webhook_port,
              internalPort: current.internal_port,
            });
            lines.push(``);
            lines.push(`Runner restarted: PID ${current.pid} → ${fresh.pid}, now serving \`${params.entity_url}\` upstream.`);
          } else {
            lines.push(``);
            lines.push(`_Note: runner is not currently running — call \`zyndai_deregister_persona\` then \`zyndai_register_persona\` to start it again._`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
