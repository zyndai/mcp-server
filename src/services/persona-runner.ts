#!/usr/bin/env node
/**
 * Persona runner — the detached background agent that hosts the user's
 * Claude persona on the Zynd network.
 *
 * The runner is spawned by the MCP server's `register-persona` tool with
 * `child_process.spawn(detached:true)`, so it survives the MCP host (Claude
 * Desktop / Claude Code) being closed. macOS users can additionally install
 * a launchd plist (see launchd.ts) for true 24/7 presence + auto-restart.
 *
 * Lifecycle:
 *   1. Read persona config (entity_id, keypair path, registry, public URL,
 *      webhook port, internal-reply port) from $ZYND_PERSONA_CONFIG.
 *   2. Boot a ZyndAIAgent with a no-op custom handler — the SDK's webhook
 *      server still runs, accepts /webhook + /webhook/sync, and the
 *      addMessageHandler hook below intercepts each inbound message.
 *   3. For every inbound message: append to ~/.zynd/mailbox/<entity_id>.jsonl
 *      and immediately ack the /webhook/sync caller with a "queued for human
 *      approval" sentinel so they don't wait for the SDK's 30s timeout.
 *   4. Expose a 127.0.0.1-only HTTP server on `internalPort` with a single
 *      route POST /internal/reply { message_id, response, approve } — the
 *      MCP `respond-to-request` tool calls this once the user has approved.
 *      The runner then POSTs the reply to the sender's webhook (looked up
 *      via the registry) so the original sender finally hears back.
 *
 * The runner is intentionally process-isolated from the MCP server — Claude
 * Desktop killing the MCP child does not kill this process, and a crash here
 * does not poison the MCP. Logs go to ~/.zynd/persona-runner.log.
 */

import { webcrypto } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { ZyndAIAgent, SearchAndDiscoveryManager, AgentConfigSchema } from "zyndai";
import { appendEntry, findEntry, updateStatus, type MailboxEntry } from "./mailbox.js";

if (!globalThis.crypto) {
  (globalThis as Record<string, unknown>).crypto = webcrypto;
}

interface PersonaConfig {
  entity_id: string;
  agent_name: string;
  keypair_path: string;
  registry_url: string;
  webhook_port: number;
  /** Public URL the persona is registered with — used for sanity logging only. */
  entity_url: string;
  /** 127.0.0.1 port the MCP talks to for /internal/reply. */
  internal_port: number;
  use_ngrok?: boolean;
  ngrok_auth_token?: string;
  pricing?: { amount_usd: number; currency: string };
}

function logFile(): string {
  return path.join(process.env["ZYND_HOME"] ?? path.join(os.homedir(), ".zynd"), "persona-runner.log");
}

function log(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
  try {
    fs.appendFileSync(logFile(), line);
  } catch {
    // best-effort
  }
  process.stderr.write(line);
}

function loadConfig(): PersonaConfig {
  const p = process.env["ZYND_PERSONA_CONFIG"];
  if (!p) throw new Error("ZYND_PERSONA_CONFIG env var not set — runner cannot start without persona context");
  return JSON.parse(fs.readFileSync(p, "utf-8")) as PersonaConfig;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  log("starting persona runner", { entity_id: cfg.entity_id, port: cfg.webhook_port });

  const agentConfig = AgentConfigSchema.parse({
    name: cfg.agent_name,
    description: `Claude-hosted persona for ${cfg.agent_name}`,
    keypairPath: cfg.keypair_path,
    webhookPort: cfg.webhook_port,
    registryUrl: cfg.registry_url,
    entityUrl: cfg.entity_url,
    useNgrok: cfg.use_ngrok ?? false,
    ngrokAuthToken: cfg.ngrok_auth_token,
    tags: ["claude-persona", "mcp-client", "human-in-the-loop"],
    category: "persona",
    ...(cfg.pricing
      ? {
          entityPricing: {
            base_price_usd: cfg.pricing.amount_usd,
            currency: cfg.pricing.currency,
          },
        }
      : {}),
  });
  const agent = new ZyndAIAgent(agentConfig);

  // Inbound message handler: file the message in the mailbox, ack the
  // /webhook/sync request immediately so the sender isn't blocked, and
  // surface the message via MCP for the human to review.
  agent.webhook.addMessageHandler(async (msg) => {
    const entry: MailboxEntry = {
      message_id: msg.messageId,
      sender_id: msg.senderId,
      sender_public_key: msg.senderPublicKey,
      content: msg.content,
      conversation_id: msg.conversationId,
      metadata: msg.metadata,
      received_at: new Date().toISOString(),
      status: "pending",
    };
    appendEntry(cfg.entity_id, entry);
    log("inbound", { message_id: msg.messageId, sender: msg.senderId });

    // Sync callers get an immediate "queued" ack instead of waiting 30s.
    // Real reply is delivered out-of-band to the sender's webhook once the
    // human approves it — see /internal/reply below.
    agent.webhook.setResponse(
      msg.messageId,
      "queued: this persona is human-in-the-loop. Reply will be delivered to your webhook when the user approves.",
    );
  });

  await agent.start();
  log("agent started", { url: cfg.entity_url });

  // Internal HTTP server — only the MCP server (running on the same machine
  // as the user) calls this, so it binds to 127.0.0.1 and rejects everything
  // else. No auth beyond loopback because the OS already isolates by user.
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/internal/reply") {
      res.writeHead(404).end("not found");
      return;
    }
    let body = "";
    req.setEncoding("utf-8");
    for await (const chunk of req) body += chunk as string;
    let parsed: { message_id: string; response: string; approve: boolean };
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }

    const entry = findEntry(cfg.entity_id, parsed.message_id);
    if (!entry) {
      res.writeHead(404).end(JSON.stringify({ error: "no such message" }));
      return;
    }

    try {
      if (parsed.approve) {
        await deliverReply(agent, cfg, entry, parsed.response);
        updateStatus(cfg.entity_id, parsed.message_id, {
          status: "answered",
          response: parsed.response,
        });
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ status: "delivered" }),
        );
      } else {
        updateStatus(cfg.entity_id, parsed.message_id, { status: "rejected" });
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ status: "rejected" }),
        );
      }
    } catch (err) {
      log("reply failed", String(err));
      res.writeHead(500).end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(cfg.internal_port, "127.0.0.1", () => {
    log("internal reply server", { port: cfg.internal_port });
  });

  const shutdown = async (signal: string): Promise<void> => {
    log("shutdown", signal);
    server.close();
    await agent.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (err) => log("uncaught", String(err)));
}

async function deliverReply(
  agent: ZyndAIAgent,
  cfg: PersonaConfig,
  entry: MailboxEntry,
  response: string,
): Promise<void> {
  // Look up the sender's webhook URL on the registry.
  const search = new SearchAndDiscoveryManager(cfg.registry_url);
  const senderCard = await search.getAgentById(entry.sender_id).catch((e) => {
    throw new Error(`sender ${entry.sender_id} not resolvable on registry: ${String(e)}`);
  });

  const senderEntityUrl = pickSenderUrl(senderCard);
  if (!senderEntityUrl) {
    throw new Error(`sender card has no usable webhook endpoint for ${entry.sender_id}`);
  }

  await agent.webhook.sendMessage(senderEntityUrl, response, {
    receiverId: entry.sender_id,
    metadata: {
      in_reply_to: entry.message_id,
      persona: cfg.entity_id,
      ...(entry.conversation_id ? { conversation_id: entry.conversation_id } : {}),
    },
    messageType: "response",
  });
}

function pickSenderUrl(card: Record<string, unknown> | null): string | null {
  if (!card) return null;
  const endpoints = card["endpoints"] as Record<string, unknown> | undefined;
  if (endpoints) {
    const async_ = endpoints["invoke_async"];
    if (typeof async_ === "string") return async_;
    const sync_ = endpoints["invoke"];
    if (typeof sync_ === "string") return sync_;
  }
  const entityUrl = card["entity_url"];
  if (typeof entityUrl === "string") {
    return `${entityUrl.replace(/\/+$/, "")}/webhook`;
  }
  return null;
}

main().catch((err) => {
  log("fatal", String(err));
  process.exit(1);
});
