/**
 * Persona registration — the second half of the MCP auth flow.
 *
 * After zyndai_login lands a developer keypair at ~/.zynd/developer.json,
 * this module derives a per-persona agent keypair, builds the
 * developer_proof attestation, registers the persona on AgentDNS, and
 * persists the agent keypair so subsequent zyndai_call_agent invocations
 * can sign outgoing messages.
 *
 * The registered persona is intentionally NOT a webhook host — Claude's
 * MCP server is a child process with no stable URL. We register with a
 * placeholder entity_url and tag it `claude-persona` + `mcp-client` so
 * other agents understand it's a calling identity, not a callable one.
 */

import {
  DNSRegistryClient,
  createDerivationProof,
  deriveAgentKeypair,
  generateDeveloperId,
  type Ed25519Keypair,
} from "zyndai";
import {
  ensureZyndDir,
  nextFreeAgentIndex,
  writeAgentKeypair,
  writeActivePersona,
  agentsDir,
} from "./identity-store.js";
import * as path from "node:path";

export interface RegisterPersonaOpts {
  developerKeypair: Ed25519Keypair;
  /** The bare name supplied by the user (e.g. "alice"). We always suffix `-claude-persona`. */
  name: string;
  registryUrl: string;
  /** Optional summary surfaced on the agent's registry record. */
  summary?: string;
  /**
   * Optional pricing. Personas default to FREE (no x402 demand on incoming
   * messages) — the user has to explicitly ask Claude to enable charging.
   *
   *   { amount_usd: 0.05, currency: "USDC" }  →  agent demands $0.05 USDC per call.
   */
  pricing?: {
    amount_usd: number;
    currency?: string;
  };
}

export interface RegisterPersonaResult {
  entityId: string;
  agentName: string;
  developerId: string;
  publicKey: string;
  /** absolute path on disk where the persona keypair was saved */
  keypairPath: string;
  entityIndex: number;
  registryUrl: string;
}

const PERSONA_SUFFIX = "-claude-persona";

export async function registerPersona(
  opts: RegisterPersonaOpts,
): Promise<RegisterPersonaResult> {
  ensureZyndDir();

  const baseName = sanitizeBaseName(opts.name);
  const agentName = `${baseName}${PERSONA_SUFFIX}`;

  const index = nextFreeAgentIndex();
  const personaKp = deriveAgentKeypair(opts.developerKeypair.privateKeyBytes, index);
  const developerProof = createDerivationProof(
    opts.developerKeypair,
    personaKp.publicKeyBytes,
    index,
  );
  const developerId = generateDeveloperId(opts.developerKeypair.publicKeyBytes);

  // Placeholder entity_url. Personas don't host webhooks — they're
  // signing identities. Other agents that try to call this URL will
  // 404, which is the expected behavior.
  const entityUrl = `https://zynd.ai/personas/${personaKp.entityId}`;

  const summary =
    opts.summary ??
    `Claude-hosted persona for ${baseName}. Incoming messages are reviewed by the human before any reply is sent.`;

  // Build entity_pricing only when the user explicitly opted in. Personas
  // default to FREE so other agents can call without paying.
  const entityPricing =
    opts.pricing && opts.pricing.amount_usd > 0
      ? {
          model: "per-request",
          base_price_usd: opts.pricing.amount_usd,
          currency: opts.pricing.currency ?? "USDC",
          payment_methods: ["x402"],
        }
      : undefined;

  const entityId = await DNSRegistryClient.registerEntity({
    registryUrl: opts.registryUrl,
    keypair: personaKp,
    name: agentName,
    entityUrl,
    category: "persona",
    tags: ["claude-persona", "mcp-client", "human-in-the-loop"],
    summary,
    developerId,
    developerProof,
    entityType: "agent",
    ...(entityPricing ? { entityPricing } : {}),
  });

  // Persist the keypair AFTER successful registration so a network failure
  // doesn't leave a stale agent-N.json on disk that the next nextFreeAgentIndex()
  // call would skip.
  const keypairPath = writeAgentKeypair(
    personaKp,
    index,
    opts.developerKeypair.publicKeyString,
  );

  writeActivePersona({
    entity_id: entityId,
    agent_name: agentName,
    keypair_path: path.resolve(keypairPath),
    entity_index: index,
    registered_at: new Date().toISOString(),
  });

  return {
    entityId,
    agentName,
    developerId,
    publicKey: personaKp.publicKeyString,
    keypairPath,
    entityIndex: index,
    registryUrl: opts.registryUrl,
  };
}

/**
 * Strip whitespace, lower-case, replace runs of non-[a-z0-9-] with '-'.
 * Mirrors the slugify the Python CLI does so the same name produces the
 * same FQAN whether registered via MCP or `zynd register`.
 */
function sanitizeBaseName(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("persona name cannot be empty");
  }
  const slug = trimmed
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error(
      `persona name '${raw}' contains no usable characters — try a-z, 0-9, or -`,
    );
  }
  if (slug.endsWith(PERSONA_SUFFIX.replace(/^-/, ""))) {
    // User passed "alice-claude-persona" — strip the suffix so we don't
    // double it.
    return slug.slice(0, -PERSONA_SUFFIX.length + 1);
  }
  return slug;
}
