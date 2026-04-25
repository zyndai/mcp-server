/**
 * Markdown formatters that turn AgentDNS records into MCP tool responses.
 *
 * The model sees these strings — keep them dense, deterministic, and
 * link-friendly so the model can quote entity_ids, FQANs, and pricing
 * back to the user without paraphrasing.
 */

import type { EntityCard, AgentSearchResponse, PaymentInfo } from "../types.js";
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

export function formatEntityCard(card: EntityCard): string {
  const lines: string[] = [
    `**${card.name}** \`${card.entity_id}\``,
    "",
  ];

  if (card.description) lines.push(card.description, "");
  if (card.summary && card.summary !== card.description) {
    lines.push(`_${card.summary}_`, "");
  }

  lines.push("**Identity**");
  lines.push(`- Entity ID: \`${card.entity_id}\``);
  lines.push(`- Public key: \`${card.public_key}\``);
  if (card.signature) {
    lines.push(`- Signed: yes (\`${truncateMiddle(card.signature, 40)}\`)`);
  } else {
    lines.push(`- Signed: no`);
  }
  lines.push("");

  if (card.category || card.tags?.length) {
    lines.push("**Discovery**");
    if (card.category) lines.push(`- Category: ${card.category}`);
    if (card.tags?.length) lines.push(`- Tags: ${card.tags.join(", ")}`);
    lines.push("");
  }

  if (card.capabilities?.length) {
    lines.push("**Capabilities**");
    for (const cap of card.capabilities) {
      lines.push(`- ${cap.name} (${cap.category})`);
    }
    lines.push("");
  }

  if (card.endpoints) {
    lines.push("**Endpoints**");
    if (card.endpoints.invoke) lines.push(`- Sync invoke: ${card.endpoints.invoke}`);
    if (card.endpoints.invoke_async) lines.push(`- Async invoke: ${card.endpoints.invoke_async}`);
    if (card.endpoints.health) lines.push(`- Health: ${card.endpoints.health}`);
    if (card.endpoints.agent_card) lines.push(`- Card: ${card.endpoints.agent_card}`);
    lines.push("");
  }

  if (card.pricing) {
    lines.push("**Pricing**");
    lines.push(`- Model: ${card.pricing.model}`);
    lines.push(`- Currency: ${card.pricing.currency}`);
    const rates = Object.entries(card.pricing.rates ?? {});
    if (rates.length) {
      for (const [k, v] of rates) lines.push(`- ${k}: ${v}`);
    }
    if (card.pricing.payment_methods?.length) {
      lines.push(`- Payment methods: ${card.pricing.payment_methods.join(", ")}`);
    }
    lines.push("");
  }

  if (card.input_schema || card.output_schema || card.accepts_files) {
    lines.push("**Contract**");
    if (card.input_schema) {
      lines.push(`- Input schema: ${stringifyCompact(card.input_schema)}`);
    }
    if (card.output_schema) {
      lines.push(`- Output schema: ${stringifyCompact(card.output_schema)}`);
    }
    if (card.accepts_files) {
      lines.push(`- Accepts file uploads: yes`);
    }
    lines.push("");
  }

  lines.push("**Status**");
  lines.push(`- Status: ${card.status}`);
  lines.push(`- Last heartbeat: ${card.last_heartbeat}`);
  lines.push(`- Signed at: ${card.signed_at}`);

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
