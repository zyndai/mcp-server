import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as os from "node:os";
import { DEFAULT_REGISTRY_URL } from "../constants.js";
import {
  hasDeveloper,
  readDeveloperKeypair,
  readActivePersona,
  writeActivePersona,
} from "../services/identity-store.js";
import { registerPersona } from "../services/persona-registration.js";
import {
  spawnDaemon,
  existingDaemon,
  pickFreePort,
} from "../services/persona-daemon.js";
import { install as installLaunchd, isInstalled as launchdInstalled } from "../services/launchd.js";
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
  })
  .strict();

type RegisterPersonaInput = z.infer<typeof RegisterPersonaSchema>;

export function registerRegisterPersonaTool(server: McpServer): void {
  server.registerTool(
    "zyndai_register_persona",
    {
      title: "Register Claude persona on AgentDNS (one-time)",
      description: `Register the user's Claude persona on AgentDNS AND start a detached background webhook so other agents can actually reach them.

This is a ONE-TIME action per user. If a persona is already registered (i.e. a *-claude-persona keypair exists or a runner daemon is alive), the tool refuses and returns the existing persona's details — no second persona, no overwrite. To replace, the user must call zyndai_deregister_persona first.

What happens on success:
  1. Derives an Ed25519 persona keypair from the developer key (~/.zynd/agents/agent-N.json).
  2. Registers it on AgentDNS as <name>-claude-persona, tagged 'claude-persona', 'mcp-client', 'human-in-the-loop'.
  3. Spawns a detached persona-runner process that hosts a real webhook on $ZYNDAI_PERSONA_PUBLIC_URL — survives Claude Desktop being closed.
  4. On macOS, installs ~/Library/LaunchAgents/ai.zynd.persona.plist so the runner auto-starts on login and respawns on crash.

After registration, callers reach the persona at <ZYNDAI_PERSONA_PUBLIC_URL>/webhook. Inbound messages land in ~/.zynd/mailbox/<entity_id>.jsonl. Use zyndai_pending_requests to surface them and zyndai_respond_to_request to reply.

Required env (set in the MCP host config):
  ZYNDAI_PERSONA_PUBLIC_URL — the public URL the runner is reachable at. Set this BEFORE registering. Use a tunnel (ngrok/cloudflared) or a stable cloud URL pointing back to the runner's webhook port.

Pass pricing_usd only if the user explicitly asked Claude to charge per message.

Errors:
  - "no developer keypair" — run zyndai_login first.
  - "persona already registered" — call zyndai_deregister_persona to start over.
  - "ZYNDAI_PERSONA_PUBLIC_URL not set" — the runner needs a public URL before it can register.`,
      inputSchema: RegisterPersonaSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
                text: "Error: No developer identity yet. Call `zyndai_login` first.",
              },
            ],
          };
        }

        // Strict idempotency — either an active persona on disk OR a live
        // daemon means the user has already onboarded once. Refuse outright.
        const existingPersona = readActivePersona();
        const liveDaemon = existingDaemon();
        if (existingPersona || liveDaemon) {
          const id =
            existingPersona?.entity_id ??
            liveDaemon?.entity_id ??
            "(unknown)";
          const name = existingPersona?.agent_name ?? "(unknown)";
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Persona already registered for this user.\n\n` +
                  `- Name: \`${name}\`\n` +
                  `- Entity ID: \`${id}\`\n` +
                  (liveDaemon
                    ? `- Runner PID: ${liveDaemon.pid} (alive, listening on ${liveDaemon.entity_url})\n`
                    : `- Runner: not currently running — call \`zyndai_deregister_persona\` to clean up, then re-register.\n`) +
                  `\nOnly one Claude persona is supported per user. To replace it, call \`zyndai_deregister_persona\` first.`,
              },
            ],
          };
        }

        const publicUrl = process.env["ZYNDAI_PERSONA_PUBLIC_URL"];
        if (!publicUrl || !/^https?:\/\//i.test(publicUrl)) {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text:
                  "Error: ZYNDAI_PERSONA_PUBLIC_URL is not set. The persona-runner needs a public URL (e.g. an ngrok or cloudflared tunnel pointing at the local webhook port) before it can register on AgentDNS. Set it in the MCP host config and try again.",
              },
            ],
          };
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

        // If the user has fixed the upstream port for their tunnel
        // (ngrok/cloudflared/etc.), honor it. Otherwise pick any free port
        // starting from 5050.
        const pinnedPort = process.env["ZYNDAI_PERSONA_WEBHOOK_PORT"];
        const webhookPort = pinnedPort
          ? Number.parseInt(pinnedPort, 10)
          : await pickFreePort(5050);
        if (Number.isNaN(webhookPort) || webhookPort <= 0 || webhookPort > 65535) {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text: `Error: ZYNDAI_PERSONA_WEBHOOK_PORT must be a valid port number (1..65535), got '${pinnedPort}'.`,
              },
            ],
          };
        }
        const internalPort = await pickFreePort(webhookPort + 1);

        const result = await registerPersona({
          developerKeypair,
          name: params.name,
          registryUrl,
          summary: params.summary,
          pricing,
          entityUrl: publicUrl,
        });

        // Now spin up the detached runner so callers can actually reach the
        // webhook URL we just registered.
        const handle = spawnDaemon({
          entityId: result.entityId,
          agentName: result.agentName,
          keypairPath: result.keypairPath,
          registryUrl,
          entityUrl: publicUrl,
          webhookPort,
          internalPort,
          pricing: pricing
            ? { amount_usd: pricing.amount_usd, currency: pricing.currency ?? "USDC" }
            : undefined,
        });

        // Optional but recommended on macOS — keeps the runner alive after
        // reboot / Claude Desktop close.
        let launchdNote = "";
        if (os.platform() === "darwin" && !launchdInstalled()) {
          try {
            const installed = installLaunchd({ configPath: handle.config_path });
            launchdNote = `- launchd plist: \`${installed.plistPath}\` (auto-start on login enabled)\n`;
          } catch (e) {
            launchdNote = `- launchd install failed (runner still detached and running): ${String(e)}\n`;
          }
        } else if (os.platform() !== "darwin") {
          launchdNote =
            "- Auto-restart: not configured (non-macOS). Runner is detached but won't survive a reboot — wrap with systemd / pm2 if you need 24/7 presence.\n";
        }

        // Refresh the active persona pointer (registerPersona already wrote
        // it once, but we update it now that we have daemon details too).
        writeActivePersona({
          entity_id: result.entityId,
          agent_name: result.agentName,
          keypair_path: result.keypairPath,
          entity_index: result.entityIndex,
          registered_at: new Date().toISOString(),
        });

        const pricingLine = pricing
          ? `- Pricing: $${pricing.amount_usd} ${pricing.currency ?? "USDC"} per call (x402)`
          : `- Pricing: FREE`;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Persona registered and runner started.**\n\n` +
                `- Name: \`${result.agentName}\`\n` +
                `- Entity ID: \`${result.entityId}\`\n` +
                `- Public key: \`${result.publicKey}\`\n` +
                `- Public URL: ${publicUrl}\n` +
                `- Local webhook port: ${webhookPort}\n` +
                `- Internal reply port: ${internalPort} (loopback only)\n` +
                `- Runner PID: ${handle.pid}\n` +
                `- Keypair: \`${result.keypairPath}\`\n` +
                `${launchdNote}` +
                `${pricingLine}\n\n` +
                `Other agents can now reach you at ${publicUrl}/webhook. Use \`zyndai_pending_requests\` to fetch incoming messages and \`zyndai_respond_to_request\` to reply (after asking the user). Logs at \`~/.zynd/persona-runner.log\`.`,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
