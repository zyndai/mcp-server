import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import { DNSRegistryClient } from "zyndai";
import { DEFAULT_REGISTRY_URL } from "../constants.js";
import {
  loadActivePersonaKeypair,
  activePersonaPath,
} from "../services/identity-store.js";
import { existingDaemon, killDaemon } from "../services/persona-daemon.js";
import { uninstall as uninstallLaunchd } from "../services/launchd.js";
import { handleToolError } from "./error-handler.js";

const DeregisterPersonaSchema = z
  .object({
    keep_keypair: z
      .boolean()
      .optional()
      .describe(
        "If true, leave the keypair file in ~/.zynd/agents/ for archival. Default false: rename it to <file>.archived so a fresh register-persona starts clean.",
      ),
  })
  .strict();

type DeregisterPersonaInput = z.infer<typeof DeregisterPersonaSchema>;

export function registerDeregisterPersonaTool(server: McpServer): void {
  server.registerTool(
    "zyndai_deregister_persona",
    {
      title: "Deregister the user's Claude persona and stop the runner",
      description: `Tear down the user's persona end-to-end.

Steps performed:
  1. Kills the detached persona-runner process (SIGTERM).
  2. Unloads + removes the launchd plist on macOS.
  3. Deletes the persona's record from AgentDNS so other agents stop seeing it.
  4. Archives the persona keypair (renames to <file>.archived) unless keep_keypair=true.
  5. Removes ~/.zynd/mcp-active-persona.json so zyndai_register_persona is unblocked.

Use this when the user wants to switch personas or stop being reachable on the network. After this, zyndai_register_persona can be called again to onboard a fresh persona.

Args:
  - keep_keypair (bool, optional) — preserve the keypair file as-is for later re-import.`,
      inputSchema: DeregisterPersonaSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: DeregisterPersonaInput) => {
      try {
        const loaded = loadActivePersonaKeypair();
        const handle = existingDaemon();
        if (!loaded && !handle) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No active persona to deregister. Nothing to do.",
              },
            ],
          };
        }

        const lines: string[] = ["**Deregister persona — results:**", ""];

        // 1. Kill the runner
        if (handle) {
          killDaemon(handle);
          lines.push(`- Runner PID ${handle.pid}: SIGTERM sent, handle file cleared.`);
        } else {
          lines.push(`- Runner: not running.`);
        }

        // 2. Uninstall launchd
        try {
          const result = uninstallLaunchd();
          lines.push(
            result.removed
              ? `- launchd plist: removed.`
              : `- launchd plist: not installed (skipped).`,
          );
        } catch (e) {
          lines.push(`- launchd uninstall failed: ${String(e)}`);
        }

        // 3. Deregister from registry. Best-effort — if the registry is
        // down we still want the local cleanup to complete.
        if (loaded) {
          const registryUrl =
            process.env["ZYNDAI_REGISTRY_URL"] ?? DEFAULT_REGISTRY_URL;
          try {
            await DNSRegistryClient.deleteEntity({
              registryUrl,
              entityId: loaded.persona.entity_id,
              keypair: loaded.keypair,
            });
            lines.push(`- AgentDNS: \`${loaded.persona.entity_id}\` deleted.`);
          } catch (e) {
            lines.push(
              `- AgentDNS delete failed (will keep local cleanup going): ${String(e)}`,
            );
          }
        }

        // 4. Archive keypair
        if (loaded) {
          const kp = loaded.persona.keypair_path;
          if (fs.existsSync(kp)) {
            if (params.keep_keypair) {
              lines.push(`- Keypair kept at \`${kp}\`.`);
            } else {
              const archived = `${kp}.archived`;
              fs.renameSync(kp, archived);
              lines.push(`- Keypair archived: \`${archived}\`.`);
            }
          }
        }

        // 5. Clear active-persona pointer
        const ap = activePersonaPath();
        if (fs.existsSync(ap)) {
          fs.unlinkSync(ap);
          lines.push(`- Active persona pointer removed.`);
        }

        lines.push("");
        lines.push("`zyndai_register_persona` is now unblocked and can be called again with a fresh name.");

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return handleToolError(error);
      }
    },
  );
}
