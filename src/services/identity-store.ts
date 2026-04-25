/**
 * Filesystem-backed identity store for the MCP server.
 *
 * Layout mirrors the `zynd` CLI's home dir (zyndai-ts-sdk/src/cli/config.ts)
 * so a developer who logs in via this MCP can immediately use `zynd
 * register` or any other CLI command, and vice versa — they share state.
 *
 *   $ZYND_HOME or ~/.zynd/
 *   ├── developer.json                  (Ed25519 developer keypair)
 *   ├── agents/
 *   │   ├── agent-0.json                (derived agent keypairs, indexed)
 *   │   ├── agent-1.json
 *   │   └── ...
 *   └── mcp-active-persona.json         (which agent the MCP signs with — MCP-only)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  keypairFromPrivateBytes,
  type Ed25519Keypair,
} from "zyndai";

export function zyndDir(): string {
  return process.env["ZYND_HOME"] ?? path.join(os.homedir(), ".zynd");
}

export function ensureZyndDir(): string {
  const dir = zyndDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function developerKeyPath(): string {
  return path.join(zyndDir(), "developer.json");
}

export function agentsDir(): string {
  return path.join(zyndDir(), "agents");
}

export function ensureAgentsDir(): string {
  const dir = agentsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function activePersonaPath(): string {
  return path.join(zyndDir(), "mcp-active-persona.json");
}

/** True when a developer keypair exists on disk. */
export function hasDeveloper(): boolean {
  return fs.existsSync(developerKeyPath());
}

interface KeypairFile {
  /** base64-encoded Ed25519 private key (32 raw bytes, or 64-byte expanded — we accept both). */
  private_key: string;
  public_key?: string;
  derived_from?: {
    developer_public_key?: string;
    entity_index?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Read the developer keypair. Throws if missing. */
export function readDeveloperKeypair(): Ed25519Keypair {
  const p = developerKeyPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `No developer identity found at ${p}. Run zyndai_login to authenticate.`,
    );
  }
  return loadKeypairFile(p);
}

/** Persist a developer keypair to disk. Creates ~/.zynd/ if missing. */
export function writeDeveloperKeypair(kp: Ed25519Keypair): void {
  ensureZyndDir();
  saveKeypairFile(kp, developerKeyPath());
}

export function writeAgentKeypair(
  kp: Ed25519Keypair,
  index: number,
  developerPublicKey?: string,
): string {
  ensureAgentsDir();
  const p = path.join(agentsDir(), `agent-${index}.json`);
  saveKeypairFile(kp, p, {
    derived_from: developerPublicKey
      ? { developer_public_key: developerPublicKey, entity_index: index }
      : undefined,
  });
  return p;
}

/** Pick the next index that doesn't have an agent-N.json on disk. */
export function nextFreeAgentIndex(): number {
  const dir = agentsDir();
  if (!fs.existsSync(dir)) return 0;
  let i = 0;
  while (fs.existsSync(path.join(dir, `agent-${i}.json`))) i++;
  return i;
}

export interface ActivePersona {
  entity_id: string;
  agent_name: string;
  /** absolute path of the agent keypair file (useful for tooling that wants to load it directly) */
  keypair_path: string;
  /** which derivation index produced this keypair — useful for re-creating developer_proofs */
  entity_index: number;
  registered_at: string;
}

export function readActivePersona(): ActivePersona | null {
  const p = activePersonaPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ActivePersona;
  } catch {
    return null;
  }
}

export function writeActivePersona(persona: ActivePersona): void {
  ensureZyndDir();
  fs.writeFileSync(activePersonaPath(), JSON.stringify(persona, null, 2));
}

/** Load the active persona's keypair, or null if no active persona is set. */
export function loadActivePersonaKeypair(): {
  keypair: Ed25519Keypair;
  persona: ActivePersona;
} | null {
  const persona = readActivePersona();
  if (!persona) return null;
  if (!fs.existsSync(persona.keypair_path)) {
    // Stale pointer — file was moved or deleted. Best-effort: ignore.
    return null;
  }
  const keypair = loadKeypairFile(persona.keypair_path);
  return { keypair, persona };
}

// ---- internals ----

function loadKeypairFile(filePath: string): Ed25519Keypair {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read keypair at ${filePath}: ${String(err)}`);
  }

  let parsed: KeypairFile;
  try {
    parsed = JSON.parse(raw) as KeypairFile;
  } catch (err) {
    throw new Error(`Invalid JSON in keypair file ${filePath}: ${String(err)}`);
  }

  if (!parsed.private_key) {
    throw new Error(`Keypair file ${filePath} is missing 'private_key' field`);
  }

  let bytes = Buffer.from(parsed.private_key, "base64");
  // The TS SDK historically stores either 32-byte raw seeds or 64-byte
  // expanded keys (seed || pub) — accept both.
  if (bytes.length === 64) bytes = bytes.subarray(0, 32);
  if (bytes.length !== 32) {
    throw new Error(
      `Keypair file ${filePath} private_key has unexpected length ${bytes.length} (need 32 or 64)`,
    );
  }
  return keypairFromPrivateBytes(new Uint8Array(bytes));
}

function saveKeypairFile(
  kp: Ed25519Keypair,
  filePath: string,
  metadata: { derived_from?: Record<string, unknown> } = {},
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body: KeypairFile = {
    private_key: Buffer.from(kp.privateKeyBytes).toString("base64"),
    public_key: kp.publicKeyString,
  };
  if (metadata.derived_from) body.derived_from = metadata.derived_from;
  // 0600 perms — keypair files are sensitive
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2), { mode: 0o600 });
}
