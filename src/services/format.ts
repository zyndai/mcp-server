import { CHARACTER_LIMIT } from "../constants.js";
import type { Agent, PaymentInfo } from "../types.js";

export function formatAgentList(
  agents: Agent[],
  total: number,
  offset: number,
): string {
  if (agents.length === 0) {
    return "No agents found matching your query.";
  }

  const lines: string[] = [
    `Found ${total} agent${total === 1 ? "" : "s"} (showing ${agents.length}):`,
    "",
  ];

  for (const agent of agents) {
    lines.push(`**${agent.name}** (${agent.id})`);
    if (agent.description) {
      lines.push(`  ${agent.description}`);
    }
    if (agent.capabilities) {
      const caps = flattenCapabilities(agent.capabilities);
      if (caps.length > 0) {
        lines.push(`  Capabilities: ${caps.join(", ")}`);
      }
    }
    lines.push(`  Status: ${agent.status}`);
    if (agent.httpWebhookUrl) {
      lines.push("  Callable: Yes (has webhook)");
    }
    lines.push("");
  }

  const hasMore = total > offset + agents.length;
  if (hasMore) {
    lines.push(
      `_${total - offset - agents.length} more agent${total - offset - agents.length === 1 ? "" : "s"} available. Use offset=${offset + agents.length} to see next page._`,
    );
  }

  return truncateResponse(lines.join("\n"));
}

export function formatAgentDetail(agent: Agent): string {
  const lines: string[] = [
    `**${agent.name}**`,
    "",
    `- **ID**: ${agent.id}`,
    `- **Status**: ${agent.status}`,
  ];

  if (agent.description) {
    lines.push(`- **Description**: ${agent.description}`);
  }

  if (agent.capabilities) {
    const caps = flattenCapabilities(agent.capabilities);
    if (caps.length > 0) {
      lines.push(`- **Capabilities**: ${caps.join(", ")}`);
    }
  }

  lines.push(`- **DID**: ${agent.didIdentifier}`);

  if (agent.httpWebhookUrl) {
    lines.push(`- **Webhook**: ${agent.httpWebhookUrl}`);
    lines.push("- **Callable**: Yes");
  } else {
    lines.push("- **Callable**: No (no webhook URL registered)");
  }

  if (agent.lastHealthCheckAt) {
    lines.push(`- **Last Health Check**: ${agent.lastHealthCheckAt}`);
  }

  lines.push(`- **Created**: ${agent.createdAt}`);
  lines.push(`- **Updated**: ${agent.updatedAt}`);

  return lines.join("\n");
}

export function formatCallResult(
  response: string,
  agentName: string,
  messageId: string,
  conversationId: string,
  payment: PaymentInfo,
): string {
  const lines: string[] = [
    `**Response from ${agentName}:**`,
    "",
    response,
    "",
    "---",
    `Message ID: ${messageId}`,
    `Conversation ID: ${conversationId}`,
  ];

  if (payment.paid) {
    lines.push("");
    lines.push("**Payment:**");
    if (payment.transaction) {
      lines.push(`- Transaction: ${payment.transaction}`);
    }
    if (payment.network) {
      lines.push(`- Network: ${payment.network}`);
    }
    if (payment.payer) {
      lines.push(`- Payer: ${payment.payer}`);
    }
  }

  return truncateResponse(lines.join("\n"));
}

function flattenCapabilities(
  caps: Record<string, unknown>,
): string[] {
  const result: string[] = [];
  for (const [, value] of Object.entries(caps)) {
    if (Array.isArray(value)) {
      result.push(...value.map(String));
    } else if (typeof value === "string") {
      result.push(value);
    }
  }
  return result;
}

function truncateResponse(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;

  const truncated = text.slice(0, CHARACTER_LIMIT);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > CHARACTER_LIMIT * 0.8 ? lastNewline : CHARACTER_LIMIT;

  return (
    truncated.slice(0, cutPoint) +
    "\n\n_Response truncated. Use more specific queries or pagination to see more._"
  );
}
