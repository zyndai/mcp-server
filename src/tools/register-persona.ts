import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_REGISTRY_URL } from "../constants.js";
import {
  hasDeveloper,
  readDeveloperKeypair,
  readActivePersona,
} from "../services/identity-store.js";
import { registerPersona } from "../services/persona-registration.js";
import { handleToolError } from "./error-handler.js";

const RegisterPersonaSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(40)
      .describe(
        "The bare persona name supplied by the user (e.g. 'alice'). The MCP automatically suffixes '-claude-persona' so the registered agent is 'alice-claude-persona'.",
      ),
    pricing_usd: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Optional x402 price in USD. OMIT to register the persona as FREE — that's the default and matches user expectation of no payments unless they explicitly ask. Pass a number (e.g. 0.05) only when the user has explicitly said they want to charge for incoming messages.",
      ),
    pricing_currency: z
      .string()
      .optional()
      .describe(
        "Currency for x402 pricing — defaults to USDC. Only meaningful when pricing_usd is set.",
      ),
    summary: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Optional summary surfaced on the agent's registry record. Defaults to a sensible 'Claude-hosted persona' description.",
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        "Register a new persona even if an active persona already exists in ~/.zynd/mcp-active-persona.json.",
      ),
  })
  .strict();

type RegisterPersonaInput = z.infer<typeof RegisterPersonaSchema>;

export function registerRegisterPersonaTool(server: McpServer): void {
  server.registerTool(
    "zyndai_register_persona",
    {
      title: "Register Claude persona on AgentDNS",
      description: `Register the user's Claude persona on AgentDNS so other agents can reach them through the network.

The persona is registered as \`<name>-claude-persona\` (e.g. 'alice-claude-persona') and tagged 'claude-persona', 'mcp-client', 'human-in-the-loop' so callers know:
  - The webhook is human-mediated (Claude will ask the user before replying).
  - The agent is FREE TO CALL by default — no x402 demand on incoming messages.

Pass \`pricing_usd\` only if the user has explicitly asked Claude to charge per message. Most personas should stay free.

After registration:
  - The persona keypair is saved at ~/.zynd/agents/agent-N.json (same layout as zynd CLI).
  - ~/.zynd/mcp-active-persona.json points at it so subsequent zyndai_call_agent invocations sign with this identity.
  - Call zyndai_pending_requests to fetch incoming messages other agents queued for the persona.

Prerequisite: zyndai_login must have been run first.

Args:
  - name (string, required): bare name; '-claude-persona' suffix is added automatically.
  - pricing_usd (number, optional): omit for free. Setting > 0 enables x402.
  - pricing_currency (string, optional): defaults USDC.
  - summary (string, optional): override the default registry summary.
  - force (bool, optional): register a new persona even if one is already active.

Errors:
  - "no developer keypair" — run zyndai_login first.
  - "persona already active" — pass force:true to register a new one.`,
      inputSchema: RegisterPersonaSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: RegisterPersonaInput) => {
      try {
        if (!hasDeveloper()) {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text:
                  "Error: No developer identity yet. Call `zyndai_login` first — that opens the registry's auth website in the user's browser, captures their developer keypair, and saves it to ~/.zynd/developer.json.",
              },
            ],
          };
        }

        if (!params.force) {
          const existing = readActivePersona();
          if (existing) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Active persona already registered: **${existing.agent_name}** \`${existing.entity_id}\`.\n\n` +
                    `- Keypair at: \`${existing.keypair_path}\`\n` +
                    `- Registered: ${existing.registered_at}\n\n` +
                    `Pass \`force: true\` to register a new persona alongside this one (the new one becomes active for outgoing calls).`,
                },
              ],
            };
          }
        }

        const developerKeypair = readDeveloperKeypair();
        const registryUrl =
          process.env["ZYNDAI_REGISTRY_URL"] ?? DEFAULT_REGISTRY_URL;

        const pricing =
          params.pricing_usd !== undefined && params.pricing_usd > 0
            ? {
                amount_usd: params.pricing_usd,
                currency: params.pricing_currency ?? "USDC",
              }
            : undefined;

        const result = await registerPersona({
          developerKeypair,
          name: params.name,
          registryUrl,
          summary: params.summary,
          pricing,
        });

        const pricingLine = pricing
          ? `- Pricing: $${pricing.amount_usd} ${pricing.currency} per call (x402)`
          : `- Pricing: FREE (no x402 demand on incoming calls)`;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Persona registered on AgentDNS.**\n\n` +
                `- Name: \`${result.agentName}\`\n` +
                `- Entity ID: \`${result.entityId}\`\n` +
                `- Public key: \`${result.publicKey}\`\n` +
                `- Developer: \`${result.developerId}\`\n` +
                `- Derivation index: ${result.entityIndex}\n` +
                `- Keypair: \`${result.keypairPath}\`\n` +
                `${pricingLine}\n\n` +
                `Other agents can now reach you. Use \`zyndai_pending_requests\` to fetch incoming messages and \`zyndai_respond_to_request\` to reply (after asking the user for approval). Outgoing calls via \`zyndai_call_agent\` will sign with this persona's identity.`,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
