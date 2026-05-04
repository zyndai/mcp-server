/**
 * Public-URL tunneling for the persona-runner.
 *
 * The persona-runner binds to a local port (5050+). For other agents
 * to reach it, that port has to be exposed to the public internet. We
 * support two ways:
 *
 *   1. The user sets ZYNDAI_PERSONA_PUBLIC_URL themselves (their own
 *      ngrok / cloudflared / cloud LB). Bootstrap respects this and
 *      doesn't start anything.
 *
 *   2. Auto-tunnel: bootstrap detects an installed tunneler binary and
 *      spawns it pointing at the runner's local port. Preferred order:
 *
 *        a. cloudflared (`cloudflared tunnel --url http://localhost:PORT`)
 *           — free, no auth, anonymous. Public URL is parsed out of
 *           cloudflared's stdout (looks like `https://*.trycloudflare.com`).
 *           The URL is stable for the lifetime of the cloudflared
 *           process; it changes if the process restarts.
 *
 *        b. ngrok (`ngrok http PORT`) — requires NGROK_AUTHTOKEN env or
 *           ngrok config in ~/.ngrok2. Public URL fetched from ngrok's
 *           local API at http://127.0.0.1:4040/api/tunnels.
 *
 * Override priority via ZYNDAI_TUNNEL:
 *   "auto" (default) — try cloudflared, then ngrok
 *   "cloudflared"    — only cloudflared
 *   "ngrok"          — only ngrok
 *   "none"           — no auto-tunnel; require ZYNDAI_PERSONA_PUBLIC_URL
 *
 * Lifetime: the spawned tunnel is detached + child.unref()'d so it
 * survives MCP restarts the same way the runner does. persona-daemon
 * tracks the tunnel PID alongside the runner PID, and killDaemon
 * tears down both.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

export type TunnelType = "cloudflared" | "ngrok" | "none";

export interface TunnelHandle {
  type: TunnelType;
  publicUrl: string;
  pid: number;
}

export interface StartTunnelOpts {
  /** Local port the runner is bound to. */
  port: number;
  /** Override which tunneler to use. Default: env ZYNDAI_TUNNEL or "auto". */
  prefer?: "auto" | TunnelType;
  /** Total timeout for tunnel + URL discovery. Default 30s. */
  timeoutMs?: number;
}

export async function startTunnel(opts: StartTunnelOpts): Promise<TunnelHandle | null> {
  const prefer = opts.prefer ?? (process.env["ZYNDAI_TUNNEL"] as StartTunnelOpts["prefer"]) ?? "auto";
  if (prefer === "none") return null;

  const order: ("cloudflared" | "ngrok")[] =
    prefer === "cloudflared" ? ["cloudflared"]
    : prefer === "ngrok"     ? ["ngrok"]
    : ["cloudflared", "ngrok"];

  const timeoutMs = opts.timeoutMs ?? 30_000;

  for (const candidate of order) {
    if (!isInstalled(candidate)) {
      log(`${candidate} not installed — skipping`);
      continue;
    }
    try {
      const handle =
        candidate === "cloudflared"
          ? await startCloudflared(opts.port, timeoutMs)
          : await startNgrok(opts.port, timeoutMs);
      if (handle) return handle;
    } catch (e) {
      log(`${candidate} failed: ${(e as Error).message}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// cloudflared
// ---------------------------------------------------------------------------

function startCloudflared(port: number, timeoutMs: number): Promise<TunnelHandle | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!child.pid) {
      reject(new Error("cloudflared failed to spawn"));
      return;
    }
    child.unref();

    let resolved = false;
    const TIMER = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      tearDown(child);
      reject(new Error(`cloudflared did not surface a public URL within ${timeoutMs}ms`));
    }, timeoutMs);

    // cloudflared writes URL to stderr in modern versions, stdout in older
    // versions. Watch both. Match the trycloudflare.com URL pattern.
    const onChunk = (buf: Buffer): void => {
      if (resolved) return;
      const text = buf.toString("utf-8");
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        resolved = true;
        clearTimeout(TIMER);
        log(`cloudflared up: ${m[0]} → :${port} (pid ${child.pid})`);
        resolve({ type: "cloudflared", publicUrl: m[0], pid: child.pid as number });
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(TIMER);
      reject(err);
    });

    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(TIMER);
      reject(new Error(`cloudflared exited (code ${code}) before reporting a URL`));
    });
  });
}

// ---------------------------------------------------------------------------
// ngrok
// ---------------------------------------------------------------------------

async function startNgrok(port: number, timeoutMs: number): Promise<TunnelHandle | null> {
  const child = spawn("ngrok", ["http", String(port), "--log=stdout"], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (!child.pid) throw new Error("ngrok failed to spawn");
  child.unref();

  // ngrok exposes a local API at 127.0.0.1:4040 with the public URL once
  // the tunnel is up. Poll until we get one or timeout.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = await readNgrokPublicUrl().catch(() => null);
    if (url) {
      log(`ngrok up: ${url} → :${port} (pid ${child.pid})`);
      return { type: "ngrok", publicUrl: url, pid: child.pid as number };
    }
    await sleep(500);
  }
  tearDown(child);
  throw new Error(`ngrok did not surface a public URL within ${timeoutMs}ms`);
}

async function readNgrokPublicUrl(): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1000);
  try {
    const r = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: ctl.signal });
    if (!r.ok) return null;
    const body = (await r.json()) as { tunnels?: Array<{ public_url?: string; proto?: string }> };
    const httpsTunnel = body.tunnels?.find((t) => t.proto === "https" && typeof t.public_url === "string");
    return httpsTunnel?.public_url ?? null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function killTunnel(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

function isInstalled(bin: string): boolean {
  try {
    // `command -v` is portable to macOS + Linux; PATH lookups only.
    execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return existsSync(`/usr/local/bin/${bin}`) || existsSync(`/opt/homebrew/bin/${bin}`);
  }
}

function tearDown(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(child.pid, "SIGTERM");
  } catch {
    // ignore
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string): void {
  // MCP stdio rule: NEVER write to stdout.
  console.error(`[tunnel] ${msg}`);
}
