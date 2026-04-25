/**
 * Browser-based developer login flow.
 *
 * Vendored (with adaptations) from zyndai-ts-sdk/src/cli/auth.ts so the MCP
 * server is self-contained — no programmatic auth API exists in the SDK
 * yet, and stdio MCP servers can't pipe through CLI console output.
 *
 * Protocol:
 *   1. GET {registry}/v1/info -> read developer_onboarding.{mode, auth_url}.
 *      For "open" registries, the user can register without a browser flow,
 *      but this MCP always uses interactive auth so the user gets a stable
 *      developer_id bound to a verified identity.
 *   2. Generate 32-byte URL-safe state. The state acts as both CSRF token
 *      AND the seed for AES-256-GCM key (key = SHA-256(state)).
 *   3. Bind a callback HTTP server on 127.0.0.1:0 (any free port).
 *   4. Spawn the user's browser at:
 *        {auth_url}?callback_port=PORT&state=STATE&registry_url=REGISTRY
 *      Optional `name` query param when the caller knows what to display.
 *   5. Wait for the browser to redirect to:
 *        http://127.0.0.1:PORT/callback?
 *          state=STATE&developer_id=zns:dev:...&private_key_enc=BASE64
 *   6. Verify state, decrypt the private_key_enc payload (AES-256-GCM,
 *      key=SHA-256(state), nonce=first 12 bytes, tag=last 16 bytes).
 *   7. Resolve the keypair and return it.
 *
 * The function returns rather than writing to disk — the caller decides
 * where the developer keypair lands (typically ~/.zynd/developer.json).
 */

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as http from "node:http";
import { keypairFromPrivateBytes, type Ed25519Keypair } from "zyndai";

export interface InteractiveLoginOpts {
  registryUrl: string;
  /** Display name forwarded to the auth website's signup screen. */
  developerName?: string;
  /** Called once the auth URL is ready — caller decides whether to log it / surface it to the user. */
  onAuthUrl?: (url: string) => void;
  /** Auto-spawn the user's default browser pointed at the auth URL. Default: true. */
  openBrowser?: boolean;
  /** Total time to wait for the callback before giving up. Default: 5 minutes. */
  timeoutMs?: number;
}

export interface InteractiveLoginResult {
  developerId: string;
  keypair: Ed25519Keypair;
  registryUrl: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function doInteractiveLogin(
  opts: InteractiveLoginOpts,
): Promise<InteractiveLoginResult> {
  const registryUrl = opts.registryUrl.replace(/\/+$/, "");

  // Step 1 — discover auth_url + onboarding mode.
  const info = await fetchRegistryInfo(registryUrl);
  const onboarding =
    (info["developer_onboarding"] ?? {}) as Record<string, string>;
  const mode = onboarding["mode"] ?? "open";
  const authUrl = onboarding["auth_url"] ?? "";
  if (mode !== "restricted" || !authUrl) {
    throw new Error(
      `Registry at ${registryUrl} uses '${mode}' onboarding without a browser auth_url. ` +
        `MCP-driven login requires a registry that supports browser flow.`,
    );
  }

  // Step 2 — random state. 32 bytes -> ~256 bits of CSRF entropy + AES key seed.
  const state = crypto.randomBytes(32).toString("base64url");

  // Steps 3-5 — bind a callback server, open the browser, wait for redirect.
  const callback = await waitForCallback({
    state,
    authUrl,
    registryUrl,
    developerName: opts.developerName,
    onAuthUrl: opts.onAuthUrl,
    openBrowser: opts.openBrowser ?? true,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  // Step 6 — decrypt + sanity-check.
  const privateKeyB64 = decryptPrivateKey(callback.private_key_enc, state);
  let bytes = Buffer.from(privateKeyB64, "base64");
  if (bytes.length === 64) bytes = bytes.subarray(0, 32);
  if (bytes.length !== 32) {
    throw new Error(
      `Decrypted private key has unexpected length ${bytes.length} (need 32 or 64)`,
    );
  }
  const keypair = keypairFromPrivateBytes(new Uint8Array(bytes));

  return {
    developerId: callback.developer_id,
    keypair,
    registryUrl,
  };
}

async function fetchRegistryInfo(
  registryUrl: string,
): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const resp = await fetch(`${registryUrl}/v1/info`, {
      signal: ctl.signal,
    });
    if (!resp.ok) {
      throw new Error(`registry /v1/info returned HTTP ${resp.status}`);
    }
    return (await resp.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

interface CallbackPayload {
  developer_id: string;
  private_key_enc: string;
}

async function waitForCallback(opts: {
  state: string;
  authUrl: string;
  registryUrl: string;
  developerName?: string;
  onAuthUrl?: (url: string) => void;
  openBrowser: boolean;
  timeoutMs: number;
}): Promise<CallbackPayload> {
  const result: Partial<CallbackPayload> = {};

  return new Promise<CallbackPayload>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== opts.state) {
        res.writeHead(400).end("State mismatch — close this tab and retry.");
        return;
      }
      result.developer_id = url.searchParams.get("developer_id") ?? "";
      result.private_key_enc = url.searchParams.get("private_key_enc") ?? "";

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><head><title>Authenticated</title></head>" +
          "<body style=\"font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:24px\">" +
          "<h2>You're signed in to Zynd</h2>" +
          "<p>Identity captured. You can close this tab and return to Claude.</p>" +
          "</body></html>",
      );

      server.close();
      if (result.developer_id && result.private_key_enc) {
        resolve(result as CallbackPayload);
      } else {
        reject(new Error("callback missing developer_id or private_key_enc"));
      }
    });

    server.on("error", (err) => reject(err));

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const callbackPort =
        addr && typeof addr === "object" ? addr.port : 0;

      const params = new URLSearchParams({
        callback_port: String(callbackPort),
        state: opts.state,
        registry_url: opts.registryUrl,
      });
      if (opts.developerName) params.set("name", opts.developerName);

      const browserUrl = `${opts.authUrl}?${params.toString()}`;
      opts.onAuthUrl?.(browserUrl);

      if (opts.openBrowser) {
        spawnBrowser(browserUrl);
      }
    });

    setTimeout(() => {
      server.close();
      reject(
        new Error(
          `auth callback did not arrive within ${Math.floor(opts.timeoutMs / 1000)}s — try zyndai_login again`,
        ),
      );
    }, opts.timeoutMs);
  });
}

function spawnBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  // execFile fire-and-forget — we don't care about the browser process exit code.
  execFile(cmd, [url], () => {});
}

function decryptPrivateKey(ciphertextB64: string, state: string): string {
  const key = crypto.createHash("sha256").update(state).digest();
  const raw = Buffer.from(ciphertextB64, "base64");
  if (raw.length < 12 + 16) {
    throw new Error("ciphertext too short to contain nonce + tag");
  }

  const nonce = raw.subarray(0, 12);
  const ciphertext = raw.subarray(12);
  const tagStart = ciphertext.length - 16;

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(ciphertext.subarray(tagStart));
  const plaintext = Buffer.concat([
    decipher.update(ciphertext.subarray(0, tagStart)),
    decipher.final(),
  ]);
  return plaintext.toString("utf-8");
}
