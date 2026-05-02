/**
 * Persona daemon — spawn / status / kill helper for the detached
 * persona-runner process (post-A2A).
 *
 * The MCP server doesn't host the persona itself (its lifetime is bound to
 * the Claude host), so register-persona spawns persona-runner.js as a
 * detached child and tracks its PID + ports in ~/.zynd/mcp-persona.json.
 *
 *   {
 *     "entity_id": "zns:abc...",
 *     "pid": 12345,
 *     "started_at": "2026-04-26T...",
 *     "config_path": "~/.zynd/mcp-persona-config.json",
 *     "server_port": 5050,
 *     "internal_port": 5051,
 *     "entity_url": "https://...",
 *     "registry_url": "https://zns01.zynd.ai"
 *   }
 *
 * Concurrency: only one runner per machine. ensureRunning() refuses to
 * spawn a second copy if the recorded PID is alive — instead it returns
 * the existing handle.
 *
 * Backward compat: pre-A2A handles wrote `webhook_port` instead of
 * `server_port`. readHandle() normalizes both into `server_port` so older
 * persona installs are picked up without losing the daemon.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureZyndDir, zyndDir } from "./identity-store.js";

export interface DaemonHandle {
  entity_id: string;
  pid: number;
  started_at: string;
  config_path: string;
  /** A2A bind port. The runner listens here for `message/send` traffic. */
  server_port: number;
  internal_port: number;
  entity_url: string;
  registry_url: string;
}

export interface SpawnOpts {
  entityId: string;
  agentName: string;
  keypairPath: string;
  registryUrl: string;
  entityUrl: string;
  /** A2A bind port. */
  serverPort: number;
  internalPort: number;
  pricing?: { amount_usd: number; currency: string };
}

const HANDLE_FILE = "mcp-persona.json";
const RUNNER_CONFIG_FILE = "mcp-persona-config.json";

export function handlePath(): string {
  return path.join(zyndDir(), HANDLE_FILE);
}

export function readHandle(): DaemonHandle | null {
  const p = handlePath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<DaemonHandle> & {
      webhook_port?: number;
    };
    // Pre-A2A handles wrote `webhook_port`. Coerce so the rest of the code
    // sees only `server_port` and old installs don't break post-upgrade.
    if (raw.server_port == null && raw.webhook_port != null) {
      raw.server_port = raw.webhook_port;
    }
    return raw as DaemonHandle;
  } catch {
    return null;
  }
}

export function writeHandle(h: DaemonHandle): void {
  ensureZyndDir();
  fs.writeFileSync(handlePath(), JSON.stringify(h, null, 2));
}

export function clearHandle(): void {
  const p = handlePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function pickFreePort(start = 5050): Promise<number> {
  // Naive scanner — try ports sequentially until one binds. Avoids race
  // conditions by actually listening rather than asking the OS for a hint.
  for (let port = start; port < start + 200; port++) {
    if (await tryBind(port)) return port;
  }
  throw new Error(`no free port in ${start}..${start + 199}`);
}

function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Resolve the absolute path to dist/services/persona-runner.js. We can't
 * rely on cwd or PATH because the MCP host spawns us from anywhere — use
 * the URL of *this* compiled module to anchor the lookup.
 */
function runnerEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // We compile to dist/services/persona-daemon.js; runner sits beside us.
  return path.join(here, "persona-runner.js");
}

export function spawnDaemon(opts: SpawnOpts): DaemonHandle {
  ensureZyndDir();

  const configPath = path.join(zyndDir(), RUNNER_CONFIG_FILE);
  const config = {
    entity_id: opts.entityId,
    agent_name: opts.agentName,
    keypair_path: opts.keypairPath,
    registry_url: opts.registryUrl,
    server_port: opts.serverPort,
    entity_url: opts.entityUrl,
    internal_port: opts.internalPort,
    pricing: opts.pricing,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  const logPath = path.join(zyndDir(), "persona-runner.log");
  const out = fs.openSync(logPath, "a");
  const err = fs.openSync(logPath, "a");

  const child = spawn(process.execPath, [runnerEntry()], {
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      ZYND_PERSONA_CONFIG: configPath,
    },
  });
  child.unref();

  if (!child.pid) {
    throw new Error("failed to spawn persona-runner");
  }

  const handle: DaemonHandle = {
    entity_id: opts.entityId,
    pid: child.pid,
    started_at: new Date().toISOString(),
    config_path: configPath,
    server_port: opts.serverPort,
    internal_port: opts.internalPort,
    entity_url: opts.entityUrl,
    registry_url: opts.registryUrl,
  };
  writeHandle(handle);
  return handle;
}

export function killDaemon(handle: DaemonHandle): void {
  if (!isAlive(handle.pid)) {
    clearHandle();
    return;
  }
  try {
    process.kill(handle.pid, "SIGTERM");
  } catch {
    // already gone
  }
  clearHandle();
}

/**
 * If a recorded daemon is still alive, return its handle. Otherwise return
 * null so the caller knows it's safe to spawn a fresh one.
 */
export function existingDaemon(): DaemonHandle | null {
  const h = readHandle();
  if (!h) return null;
  if (!isAlive(h.pid)) {
    clearHandle();
    return null;
  }
  return h;
}

export async function postInternalReply(
  handle: DaemonHandle,
  body: { message_id: string; response: string; approve: boolean },
): Promise<{ status: string }> {
  const url = `http://127.0.0.1:${handle.internal_port}/internal/reply`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`runner /internal/reply HTTP ${r.status}: ${text}`);
    }
    return (await r.json()) as { status: string };
  } finally {
    clearTimeout(timer);
  }
}

/** noop on non-darwin — kept here so callers can stay platform-agnostic */
export function isMac(): boolean {
  return os.platform() === "darwin";
}

/**
 * Stop a running daemon and spawn a fresh one with new opts. Reuses the
 * same webhook + internal ports unless overridden so the entity_url
 * recorded on the registry stays valid.
 */
export function restartDaemon(opts: SpawnOpts): DaemonHandle {
  const existing = readHandle();
  if (existing) killDaemon(existing);
  return spawnDaemon(opts);
}
