import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateDeveloperId } from "zyndai";
import { DEFAULT_REGISTRY_URL } from "../constants.js";
import {
  hasDeveloper,
  readDeveloperKeypair,
  writeDeveloperKeypair,
} from "../services/identity-store.js";
import { doInteractiveLogin } from "../services/auth-flow.js";
import { handleToolError } from "./error-handler.js";

const LoginSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Optional developer display name shown on the auth website. The user can also set or change it during the auth flow.",
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        "Re-run auth even if a developer keypair already exists at ~/.zynd/developer.json. Existing key is overwritten.",
      ),
  })
  .strict();

type LoginInput = z.infer<typeof LoginSchema>;

export function registerLoginTool(server: McpServer): void {
  server.registerTool(
    "zyndai_login",
    {
      title: "Authenticate with Zynd (browser)",
      description: `Onboard the user with Zynd via the registry's restricted-mode browser flow.

What happens when called:
  1. The MCP server hits GET {registry}/v1/info to discover the auth URL.
  2. It binds a localhost HTTP listener and spawns the user's browser at
     the auth URL with a callback_port + state CSRF token.
  3. The user signs up or logs in on the website and the browser redirects
     to the local callback with an encrypted developer private key.
  4. The MCP decrypts (AES-256-GCM keyed on SHA-256(state)) and saves the
     keypair at ~/.zynd/developer.json — same path the zynd CLI uses, so
     CLI tools share state.

This tool is the prerequisite for zyndai_register_persona. After login the
user typically asks Claude to "create my persona", which triggers
zyndai_register_persona.

Args:
  - name (string, optional): suggested developer display name
  - force (bool, optional): overwrite an existing developer key

Errors:
  - "developer key already exists" — pass force:true to overwrite, or run
    zyndai_whoami to see who you're already logged in as.
  - "registry uses open onboarding" — the configured ZYNDAI_REGISTRY_URL
    doesn't support browser auth. Use a registry whose /v1/info reports
    developer_onboarding.mode = "restricted".`,
      inputSchema: LoginSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: LoginInput) => {
      try {
        if (hasDeveloper() && !params.force) {
          const existing = readDeveloperKeypair();
          const developerId = generateDeveloperId(existing.publicKeyBytes);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Already logged in as **${developerId}**.\n\n` +
                  `Public key: \`${existing.publicKeyString}\`\n\n` +
                  `Pass \`force: true\` to re-run auth and overwrite the existing keypair, ` +
                  `or call \`zyndai_register_persona\` to register a new persona.`,
              },
            ],
          };
        }

        const registryUrl =
          process.env["ZYNDAI_REGISTRY_URL"] ?? DEFAULT_REGISTRY_URL;
        const result = await doInteractiveLogin({
          registryUrl,
          developerName: params.name,
          openBrowser: true,
          onAuthUrl: (url) => {
            // Logged to stderr (stdio MCP — stdout is reserved for JSON-RPC).
            // Surfaced to the user inside the tool's text response too.
            console.error(`Auth URL: ${url}`);
          },
        });

        writeDeveloperKeypair(result.keypair);

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Logged in to Zynd.**\n\n` +
                `- Developer ID: \`${result.developerId}\`\n` +
                `- Public key: \`${result.keypair.publicKeyString}\`\n` +
                `- Registry: \`${result.registryUrl}\`\n` +
                `- Saved to: \`~/.zynd/developer.json\`\n\n` +
                `Next: ask the user for a persona name and call ` +
                `\`zyndai_register_persona({ name })\` — your persona will be ` +
                `published as \`<name>-claude-persona\` and free-to-call by default.`,
            },
          ],
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
