import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateDeveloperId } from "zyndai";
import { DEFAULT_REGISTRY_URL } from "../constants.js";
import {
  developerKeyPath,
  hasDeveloper,
  readActivePersona,
  readDeveloperKeypair,
  zyndDir,
} from "../services/identity-store.js";
import { handleToolError } from "./error-handler.js";

const WhoamiSchema = z.object({}).strict();

export function registerWhoamiTool(server: McpServer): void {
  server.registerTool(
    "zyndai_whoami",
    {
      title: "Show Zynd identity state",
      description: `Report the user's current Zynd identity state — whether they're logged in, which developer key is active, and whether a Claude persona is registered.

Use this whenever the user asks "who am I on Zynd?", "am I logged in?", or as a quick health check before calling other tools.

Returns:
  - Developer status (logged in or not)
  - Developer ID and public key (if logged in)
  - Active persona entity_id and name (if registered)
  - Registry URL in use
  - Filesystem locations for keypair files`,
      inputSchema: WhoamiSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const lines: string[] = ["**Zynd identity**", ""];

        if (!hasDeveloper()) {
          lines.push("- Status: not logged in");
          lines.push("");
          lines.push("Call `zyndai_login` to authenticate via the browser.");
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        }

        const developerKeypair = readDeveloperKeypair();
        const developerId = generateDeveloperId(developerKeypair.publicKeyBytes);
        const registryUrl =
          process.env["ZYNDAI_REGISTRY_URL"] ?? DEFAULT_REGISTRY_URL;

        lines.push(`- Status: logged in`);
        lines.push(`- Developer ID: \`${developerId}\``);
        lines.push(`- Public key: \`${developerKeypair.publicKeyString}\``);
        lines.push(`- Registry: ${registryUrl}`);
        lines.push(`- Keypair: \`${developerKeyPath()}\``);
        lines.push(`- Zynd home: \`${zyndDir()}\``);
        lines.push("");

        const persona = readActivePersona();
        if (!persona) {
          lines.push("**Persona**");
          lines.push("- No active persona.");
          lines.push("");
          lines.push(
            "Ask the user for a name and call `zyndai_register_persona({ name })` to register `<name>-claude-persona`.",
          );
        } else {
          lines.push("**Active persona**");
          lines.push(`- Name: \`${persona.agent_name}\``);
          lines.push(`- Entity ID: \`${persona.entity_id}\``);
          lines.push(`- Derivation index: ${persona.entity_index}`);
          lines.push(`- Keypair: \`${persona.keypair_path}\``);
          lines.push(`- Registered: ${persona.registered_at}`);
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
