/**
 * MCP server auto-bootstrap.
 *
 * Runs once at startup. Goal: by the time the MCP server's stdio loop
 * accepts the first tool call, the user already has a registered Claude
 * persona reachable on the Zynd network. No "first run a login wizard,
 * then a register wizard, then ask Claude" friction.
 *
 * Flow:
 *
 *   1. Developer keypair (~/.zynd/developer.json):
 *        present  → reuse it
 *        missing  → run the interactive browser auth flow against the
 *                   default registry (or ZYNDAI_REGISTRY_URL). Save it.
 *
 *   2. Active persona (~/.zynd/mcp-active-persona.json):
 *        present  → reuse it
 *        missing  → derive a fresh agent keypair, register on AgentDNS,
 *                   save the persona pointer.
 *
 *   3. Persona-runner daemon:
 *        already running → reuse it (PID alive)
 *        not running     → spawn a detached child running persona-runner.js
 *                          on a free local port. The runner hosts the
 *                          A2A server other agents talk to.
 *
 * Bootstrap NEVER blocks the MCP startup on a network error — if the
 * registry is unreachable, the bootstrap logs a warning to stderr and
 * lets MCP come up anyway. Read tools (search/list/get) work without a
 * persona; only zyndai_call_agent and inbox tools require it.
 *
 * Environment knobs:
 *
 *   ZYNDAI_REGISTRY_URL           — registry to log in against
 *                                   (default: https://zns01.zynd.ai)
 *   ZYNDAI_PERSONA_NAME           — base name for the auto-derived
 *                                   persona (default: hostname or "claude")
 *   ZYNDAI_PERSONA_PUBLIC_URL     — PUBLIC URL the runner advertises.
 *                                   Required to register; without it
 *                                   bootstrap registers + runs but warns
 *                                   that the entity_url is loopback.
 *   ZYNDAI_AUTO_BOOTSTRAP=0       — disable auto-bootstrap entirely
 *                                   (back to v3 behavior: manual zyndai_login)
 *   ZYNDAI_AUTO_LOGIN_TIMEOUT_MS  — auth flow timeout (default 5 min)
 */

import * as os from "node:os";
import { DEFAULT_REGISTRY_URL } from "../constants.js";
import {
  developerKeyPath,
  hasDeveloper,
  readActivePersona,
  readDeveloperKeypair,
  writeActivePersona,
  writeDeveloperKeypair,
} from "./identity-store.js";
import { doInteractiveLogin } from "./auth-flow.js";
import { registerPersona } from "./persona-registration.js";
import {
  existingDaemon,
  pickFreePort,
  spawnDaemon,
  type DaemonHandle,
} from "./persona-daemon.js";
import { install as installLaunchd, isInstalled as launchdInstalled } from "./launchd.js";
import { startTunnel } from "./tunnel.js";

export interface BootstrapResult {
  developerId: string | null;
  persona: { entity_id: string; agent_name: string } | null;
  daemon: DaemonHandle | null;
  warnings: string[];
}

export async function autoBootstrap(): Promise<BootstrapResult> {
  const warnings: string[] = [];

  if (process.env["ZYNDAI_AUTO_BOOTSTRAP"] === "0") {
    log("auto-bootstrap disabled by env (ZYNDAI_AUTO_BOOTSTRAP=0)");
    return { developerId: null, persona: null, daemon: null, warnings };
  }

  const registryUrl =
    process.env["ZYNDAI_REGISTRY_URL"] ?? DEFAULT_REGISTRY_URL;

  // ---- 1. Developer keypair --------------------------------------------
  let developerId: string | null = null;

  if (!hasDeveloper()) {
    log(`no developer keypair at ${developerKeyPath()}, running interactive login...`);
    try {
      const result = await doInteractiveLogin({
        registryUrl,
        developerName: defaultPersonaBaseName(),
        onAuthUrl: (url) => {
          // The MCP client (Claude Desktop / Claude Code) sees stderr in its
          // logs. Surface the URL so the user can click it manually if the
          // browser auto-spawn fails.
          log(`open in your browser to authenticate: ${url}`);
        },
        timeoutMs: parseIntSafe(process.env["ZYNDAI_AUTO_LOGIN_TIMEOUT_MS"], 5 * 60 * 1000),
      });
      writeDeveloperKeypair(result.keypair);
      developerId = result.developerId;
      log(`developer logged in: ${developerId}`);
    } catch (e) {
      const msg = (e as Error).message;
      warnings.push(`auto-login failed: ${msg}. Run zyndai_login manually.`);
      log(`auto-login failed: ${msg}`);
      return { developerId: null, persona: null, daemon: null, warnings };
    }
  } else {
    try {
      const kp = readDeveloperKeypair();
      const { generateDeveloperId } = await import("zyndai");
      developerId = generateDeveloperId(kp.publicKeyBytes);
      log(`reusing developer ${developerId}`);
    } catch (e) {
      warnings.push(`developer keypair on disk is unreadable: ${(e as Error).message}`);
      return { developerId: null, persona: null, daemon: null, warnings };
    }
  }

  // ---- 2. Resolve public URL (env override OR auto-tunnel) --------------
  //
  // We need the public URL BEFORE registering / spawning the runner so
  // the persona's registry record + the runner's served agent-card.json
  // both reference the right entity_url from the start.
  //
  // Order:
  //   a. ZYNDAI_PERSONA_PUBLIC_URL set → trust the user (their tunnel /
  //      reverse-proxy / cloud LB)
  //   b. an auto-tunnel binary is installed → spawn it, use the URL it
  //      gives us
  //   c. neither → register with localhost placeholder + warn

  // Allocate the bind port first since the tunnel needs to know it.
  const existingD = existingDaemon();
  const serverPort = existingD?.server_port ?? parseIntSafe(
    process.env["ZYNDAI_PERSONA_SERVER_PORT"] ?? process.env["ZYNDAI_PERSONA_WEBHOOK_PORT"],
    await pickFreePort(5050),
  );

  let publicUrl: string | null = process.env["ZYNDAI_PERSONA_PUBLIC_URL"] ?? null;
  let tunnelHandle: { type: "cloudflared" | "ngrok"; publicUrl: string; pid: number } | null = null;

  if (!publicUrl && !existingD) {
    log("no ZYNDAI_PERSONA_PUBLIC_URL — trying auto-tunnel...");
    try {
      const t = await startTunnel({ port: serverPort });
      if (t && (t.type === "cloudflared" || t.type === "ngrok")) {
        tunnelHandle = { type: t.type, publicUrl: t.publicUrl, pid: t.pid };
        publicUrl = tunnelHandle.publicUrl;
        log(`auto-tunnel up via ${tunnelHandle.type}: ${publicUrl}`);
      } else {
        warnings.push(
          "Could not auto-tunnel. Install cloudflared (`brew install cloudflared`, or " +
            "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) " +
            "for a free anonymous public URL, or install ngrok with NGROK_AUTHTOKEN set. " +
            "Until then, set ZYNDAI_PERSONA_PUBLIC_URL yourself.",
        );
      }
    } catch (e) {
      warnings.push(`auto-tunnel failed: ${(e as Error).message}`);
    }
  } else if (existingD) {
    publicUrl = existingD.entity_url;
  }

  if (!publicUrl) publicUrl = `http://localhost:${serverPort}`;

  // ---- 3. Active persona ------------------------------------------------
  let persona = readActivePersona();

  if (!persona) {
    persona = await registerFreshPersona(registryUrl, publicUrl, warnings);
  } else {
    log(`reusing persona ${persona.entity_id} (${persona.agent_name})`);
  }

  if (!persona) {
    return { developerId, persona: null, daemon: null, warnings };
  }

  // ---- 4. Persona-runner daemon -----------------------------------------
  let daemon: DaemonHandle | null = existingD;
  if (daemon) {
    log(`reusing daemon pid=${daemon.pid} on port ${daemon.server_port}`);
  } else {
    try {
      const internalPort = await pickFreePort(serverPort + 1);
      daemon = spawnDaemon({
        entityId: persona.entity_id,
        agentName: persona.agent_name,
        keypairPath: persona.keypair_path,
        registryUrl,
        entityUrl: publicUrl,
        serverPort,
        internalPort,
        ...(tunnelHandle
          ? {
              tunnelPid: tunnelHandle.pid,
              tunnelType: tunnelHandle.type,
            }
          : {}),
      });
      log(`spawned persona-runner pid=${daemon.pid} on port ${serverPort}`);

      // launchd plist on macOS — auto-respawn on crash + restart on login.
      if (os.platform() === "darwin" && !launchdInstalled()) {
        try {
          installLaunchd({ configPath: daemon.config_path });
          log("installed launchd plist for runner persistence");
        } catch (e) {
          warnings.push(`could not install launchd plist: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      warnings.push(`could not spawn persona-runner: ${(e as Error).message}`);
    }
  }

  return { developerId, persona, daemon, warnings };
}

async function registerFreshPersona(
  registryUrl: string,
  entityUrl: string,
  warnings: string[],
): Promise<{ entity_id: string; agent_name: string; keypair_path: string; entity_index: number; registered_at: string } | null> {
  try {
    const dev = readDeveloperKeypair();
    const baseName = process.env["ZYNDAI_PERSONA_NAME"] ?? defaultPersonaBaseName();
    const result = await registerPersona({
      developerKeypair: dev,
      name: baseName,
      registryUrl,
      entityUrl,
    });
    log(`registered new persona ${result.agentName} → ${result.entityId}`);
    const persona = {
      entity_id: result.entityId,
      agent_name: result.agentName,
      keypair_path: result.keypairPath,
      entity_index: result.entityIndex,
      registered_at: new Date().toISOString(),
    };
    writeActivePersona(persona);
    return persona;
  } catch (e) {
    warnings.push(`persona registration failed: ${(e as Error).message}`);
    return null;
  }
}

function defaultPersonaBaseName(): string {
  const env = process.env["ZYNDAI_PERSONA_NAME"];
  if (env) return env;
  // Fall back to the OS user, then hostname's first segment.
  return process.env["USER"] ?? process.env["USERNAME"] ?? os.hostname().split(".")[0] ?? "claude";
}

function parseIntSafe(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function log(msg: string): void {
  // MCP servers must NOT write to stdout (it's the JSON-RPC transport).
  // stderr is safe.
  console.error(`[bootstrap] ${msg}`);
}
