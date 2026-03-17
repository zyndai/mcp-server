import { randomUUID } from "node:crypto";
import { MCP_SENDER_ID, CALL_AGENT_TIMEOUT_MS } from "../constants.js";
import { getPaymentFetchAsync } from "./payment.js";
import type {
  AgentMessage,
  WebhookSyncResponse,
  PaymentInfo,
} from "../types.js";

export interface CallAgentResult {
  response: string;
  agentId: string;
  agentName: string;
  messageId: string;
  conversationId: string;
  payment: PaymentInfo;
}

export async function callAgent(params: {
  webhookUrl: string;
  agentId: string;
  agentName: string;
  message: string;
  conversationId?: string;
}): Promise<CallAgentResult> {
  const { webhookUrl, agentId, agentName, message, conversationId } = params;

  // zyndai-agent SDK exposes /webhook (async) and /webhook/sync (sync).
  // n8n and other platforms use their own URL patterns (already synchronous).
  // Only append /sync for URLs ending in /webhook.
  let syncUrl = webhookUrl;
  if (/\/webhook\/?$/.test(webhookUrl)) {
    syncUrl = webhookUrl.replace(/\/webhook\/?$/, "/webhook/sync");
  }

  const messageId = randomUUID();
  const convId = conversationId || randomUUID();

  const agentMessage: AgentMessage = {
    content: message,
    prompt: message,
    sender_id: MCP_SENDER_ID,
    receiver_id: agentId,
    message_type: "query",
    message_id: messageId,
    conversation_id: convId,
    in_reply_to: null,
    metadata: { source: "mcp-server" },
    timestamp: Date.now() / 1000,
  };

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CALL_AGENT_TIMEOUT_MS,
  );

  const payment: PaymentInfo = {
    paid: false,
    transaction: null,
    network: null,
    payer: null,
  };

  try {
    const fetchFn = await getPaymentFetchAsync();

    const response = await fetchFn(syncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agentMessage),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Agent returned HTTP ${response.status}: ${body || response.statusText}`,
      );
    }

    const paymentResponse = response.headers.get("payment-response");
    if (paymentResponse) {
      try {
        const parsed = JSON.parse(paymentResponse) as Record<string, unknown>;
        payment.paid = true;
        payment.transaction = (parsed.transaction as string) ?? null;
        payment.network = (parsed.network as string) ?? null;
        payment.payer = (parsed.payer as string) ?? null;
      } catch {
        payment.paid = true;
      }
    }

    const rawBody = await response.text();
    if (!rawBody.trim()) {
      throw new Error(
        "Agent returned an empty response. The agent's workflow may be inactive or misconfigured.",
      );
    }

    let data: WebhookSyncResponse;
    try {
      data = JSON.parse(rawBody) as WebhookSyncResponse;
    } catch {
      // Non-JSON response — return the raw text
      return {
        response: rawBody,
        agentId,
        agentName,
        messageId,
        conversationId: convId,
        payment,
      };
    }

    const agentResponse =
      data.output ?? data.response ?? data.status ?? JSON.stringify(data);

    return {
      response: agentResponse,
      agentId,
      agentName,
      messageId,
      conversationId: convId,
      payment,
    };
  } finally {
    clearTimeout(timeout);
  }
}
