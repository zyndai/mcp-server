/**
 * Markdown formatters that turn AgentDNS records into MCP tool responses.
 *
 * The model sees these strings — keep them dense, deterministic, and
 * link-friendly so the model can quote entity_ids, FQANs, and pricing
 * back to the user without paraphrasing.
 */

import type { AgentCard, AgentSearchResponse, PaymentInfo } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

export function formatSearchResults(
  hits: AgentSearchResponse[],
  total: number,
  offset: number,
): string {
  if (hits.length === 0) {
    return "No agents found matching your query.";
  }

  const lines: string[] = [
    `Found ${total} agent${total === 1 ? "" : "s"} (showing ${hits.length}):`,
    "",
  ];

  for (const hit of hits) {
    lines.push(`**${hit.name}** \`${hit.entity_id}\``);
    if (hit.summary) lines.push(`  ${hit.summary}`);
    if (hit.category) lines.push(`  Category: ${hit.category}`);
    if (hit.tags?.length) lines.push(`  Tags: ${hit.tags.join(", ")}`);
    if (hit.score !== undefined) {
      lines.push(`  Match score: ${hit.score.toFixed(3)}`);
    }
    if (hit.status) lines.push(`  Status: ${hit.status}`);
    lines.push("");
  }

  const remaining = total - offset - hits.length;
  if (remaining > 0) {
    lines.push(
      `_${remaining} more agent${remaining === 1 ? "" : "s"} available — call again with offset=${offset + hits.length}._`,
    );
  }

  return truncate(lines.join("\n"));
}

/**
 * Format a post-A2A AgentCard. The card shape is much flatter than the
 * pre-A2A EntityCard — most fields are at the top level (no `endpoints`
 * sub-object) and signatures are JWS-detached entries under
 * `signatures[]` rather than a single inline `signature` string. We
 * tolerate both shapes via property-existence checks so callers reading
 * legacy cards through the same formatter still get sensible output.
 */
export function formatEntityCard(card: AgentCard): string {
  const get = (k: string): unknown => (card as Record<string, unknown>)[k];

  const lines: string[] = [
    `**${card.name}** \`${card.entity_id ?? "(no entity_id)"}\``,
    "",
  ];

  if (card.description) lines.push(card.description, "");
  if (card.summary && card.summary !== card.description) {
    lines.push(`_${card.summary}_`, "");
  }

  lines.push("**Identity**");
  if (card.entity_id) lines.push(`- Entity ID: \`${card.entity_id}\``);
  const publicKey = get("publicKey") ?? get("public_key");
  if (typeof publicKey === "string") {
    lines.push(`- Public key: \`${publicKey}\``);
  }
  if (typeof card.fqan === "string" && card.fqan) {
    lines.push(`- FQAN: \`${card.fqan}\``);
  }
  // A2A cards: signatures[] is JWS-detached. Pre-A2A cards: a single
  // inline `signature` string.
  const sigsArr = get("signatures");
  const inlineSig = get("signature");
  if (Array.isArray(sigsArr) && sigsArr.length > 0) {
    lines.push(`- Signed: yes (${sigsArr.length} JWS signature${sigsArr.length === 1 ? "" : "s"})`);
  } else if (typeof inlineSig === "string" && inlineSig) {
    lines.push(`- Signed: yes (\`${truncateMiddle(inlineSig, 40)}\`)`);
  } else {
    lines.push(`- Signed: no`);
  }
  if (typeof card.version === "string") lines.push(`- Version: ${card.version}`);
  lines.push("");

  if (typeof get("category") === "string" || card.tags?.length) {
    lines.push("**Discovery**");
    const category = get("category");
    if (typeof category === "string") lines.push(`- Category: ${category}`);
    if (card.tags?.length) lines.push(`- Tags: ${card.tags.join(", ")}`);
    lines.push("");
  }

  // Skills list (A2A native).
  const skills = get("skills");
  if (Array.isArray(skills) && skills.length > 0) {
    lines.push("**Skills**");
    for (const s of skills) {
      if (s && typeof s === "object") {
        const sk = s as Record<string, unknown>;
        const id = typeof sk.id === "string" ? sk.id : "(no id)";
        const name = typeof sk.name === "string" ? sk.name : id;
        lines.push(`- ${name} \`${id}\``);
        if (typeof sk.description === "string") {
          lines.push(`    ${sk.description}`);
        }
      }
    }
    lines.push("");
  }

  // A2A endpoint: `url` is the JSON-RPC endpoint, `additionalInterfaces`
  // lists alternate transports. Pre-A2A `endpoints.invoke` etc. are
  // surfaced for back-compat when present.
  const a2aUrl = card.url;
  const additionalIfaces = card.additionalInterfaces;
  const legacyEndpoints = get("endpoints") as Record<string, unknown> | undefined;
  if (a2aUrl || additionalIfaces?.length || legacyEndpoints) {
    lines.push("**Endpoints**");
    if (typeof a2aUrl === "string" && a2aUrl) {
      lines.push(`- A2A (JSON-RPC): ${a2aUrl}`);
    }
    if (Array.isArray(additionalIfaces)) {
      for (const iface of additionalIfaces) {
        if (typeof iface?.url === "string" && typeof iface?.transport === "string") {
          lines.push(`- ${iface.transport}: ${iface.url}`);
        }
      }
    }
    if (legacyEndpoints) {
      // Pre-A2A shape — preserve the old field names for clarity.
      if (typeof legacyEndpoints["invoke"] === "string") {
        lines.push(`- Sync invoke (legacy): ${legacyEndpoints["invoke"]}`);
      }
      if (typeof legacyEndpoints["invoke_async"] === "string") {
        lines.push(`- Async invoke (legacy): ${legacyEndpoints["invoke_async"]}`);
      }
      if (typeof legacyEndpoints["health"] === "string") {
        lines.push(`- Health (legacy): ${legacyEndpoints["health"]}`);
      }
      if (typeof legacyEndpoints["agent_card"] === "string") {
        lines.push(`- Card (legacy): ${legacyEndpoints["agent_card"]}`);
      }
    }
    lines.push("");
  }

  if (card.pricing) {
    lines.push("**Pricing**");
    if (card.pricing.model) lines.push(`- Model: ${card.pricing.model}`);
    if (card.pricing.currency) lines.push(`- Currency: ${card.pricing.currency}`);
    const rates = Object.entries(card.pricing.rates ?? {});
    if (rates.length) {
      for (const [k, v] of rates) lines.push(`- ${k}: ${v}`);
    }
    // Tolerate both A2A camelCase and legacy snake_case payment field names.
    const paymentMethods =
      card.pricing.paymentMethods ??
      ((card.pricing as Record<string, unknown>)["payment_methods"] as
        | string[]
        | undefined);
    if (paymentMethods?.length) {
      lines.push(`- Payment methods: ${paymentMethods.join(", ")}`);
    }
    lines.push("");
  }

  // I/O contract — A2A cards expose `inputSchema`/`outputSchema` (camelCase),
  // pre-A2A used snake_case.
  const inputSchema = get("inputSchema") ?? get("input_schema");
  const outputSchema = get("outputSchema") ?? get("output_schema");
  const acceptsFiles = get("acceptsFiles") ?? get("accepts_files");
  if (inputSchema || outputSchema || acceptsFiles) {
    lines.push("**Contract**");
    if (inputSchema) {
      lines.push(`- Input schema: ${stringifyCompact(inputSchema)}`);
    }
    if (outputSchema) {
      lines.push(`- Output schema: ${stringifyCompact(outputSchema)}`);
    }
    if (acceptsFiles === true) {
      lines.push(`- Accepts file uploads: yes`);
    }
    lines.push("");
  }

  // Status / heartbeat are still surfaced when the registry attached them.
  const status = get("status");
  const lastHeartbeat = get("last_heartbeat") ?? get("lastHeartbeat");
  const signedAt = get("signed_at") ?? get("signedAt");
  if (status || lastHeartbeat || signedAt) {
    lines.push("**Status**");
    if (status) lines.push(`- Status: ${String(status)}`);
    if (lastHeartbeat) lines.push(`- Last heartbeat: ${String(lastHeartbeat)}`);
    if (signedAt) lines.push(`- Signed at: ${String(signedAt)}`);
  }

  return truncate(lines.join("\n"));
}

export function formatCallResult(
  response: string,
  agentName: string,
  entityId: string,
  messageId: string,
  conversationId: string,
  payment: PaymentInfo,
  signatureVerified: boolean | null,
): string {
  const lines: string[] = [
    `**Response from ${agentName}** \`${entityId}\``,
    "",
    response,
    "",
    "---",
    `Message ID: \`${messageId}\``,
    `Conversation ID: \`${conversationId}\``,
  ];

  if (signatureVerified === true) {
    lines.push("Response signature: verified");
  } else if (signatureVerified === false) {
    lines.push("Response signature: PRESENT BUT FAILED VERIFICATION — treat as untrusted");
  } else {
    lines.push("Response signature: not present");
  }

  if (payment.paid) {
    lines.push("", "**Payment (x402):**");
    if (payment.transaction) lines.push(`- Transaction: ${payment.transaction}`);
    if (payment.network) lines.push(`- Network: ${payment.network}`);
    if (payment.payer) lines.push(`- Payer: ${payment.payer}`);
  }

  return truncate(lines.join("\n"));
}

/** JSON Schema renderer that keeps the output readable in MCP responses. */
function stringifyCompact(obj: unknown): string {
  const json = JSON.stringify(obj);
  if (json.length <= 240) return `\`${json}\``;
  return `${json.slice(0, 240)}…\` _(${json.length} chars total — fetch full schema with zyndai_get_agent)_`;
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const truncated = text.slice(0, CHARACTER_LIMIT);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint =
    lastNewline > CHARACTER_LIMIT * 0.8 ? lastNewline : CHARACTER_LIMIT;
  return (
    truncated.slice(0, cutPoint) +
    "\n\n_Response truncated. Narrow your query or paginate to see more._"
  );
}
