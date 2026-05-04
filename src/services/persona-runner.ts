#!/usr/bin/env node
/**
 * Persona runner — the detached background agent that hosts the user's
 * Claude persona on the Zynd network (post-A2A).
 *
 * The runner is spawned by the MCP server's `register-persona` tool with
 * `child_process.spawn(detached:true)`, so it survives the MCP host (Claude
 * Desktop / Claude Code) being closed. macOS users can additionally install
 * a launchd plist (see launchd.ts) for true 24/7 presence + auto-restart.
 *
 * Lifecycle:
 *   1. Read persona config (entity_id, keypair path, registry, public URL,
 *      A2A bind port, internal-reply port) from $ZYND_PERSONA_CONFIG.
 *   2. Boot a ZyndAIAgent with an A2A handler that:
 *        - files every inbound A2A message in
 *          ~/.zynd/mailbox/<entity_id>.jsonl
 *        - immediately returns a "queued for human approval" sentinel so
 *          the original caller's HTTP request settles fast and doesn't
 *          hold a connection open while the user is asleep.
 *   3. Expose a 127.0.0.1-only HTTP server on `internalPort` with a single
 *      route POST /internal/reply { message_id, response, approve } — the
 *      MCP `respond-to-request` tool calls this once the user has approved.
 *      The runner then sends a NEW signed A2A message to the original
 *      sender (resolved via the registry) so they finally hear back.
 *
 * Why push-OUT instead of A2A's input-required loopback:
 *   The human-in-the-loop pattern can take hours/days. A2A's
 *   `input-required` state expects the SAME caller to keep polling or hold
 *   an SSE stream open — that's not the right shape for asynchronous human
 *   approval. Sending a fresh A2A message back to the sender also lets the
 *   sender's own A2A server thread it via `contextId` if they care.
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
import {
  A2AClient,
  AgentConfigSchema,
  SearchAndDiscoveryManager,
  ZyndAIAgent,
  type HandlerInput,
  type TaskHandle,
} from "zyndai";
import { appendEntry, findEntry, updateStatus, type MailboxEntry } from "./mailbox.js";
import { findOutboundTask, recordAsyncReply } from "./outbound-tasks.js";

if (!globalThis.crypto) {
  (globalThis as Record<string, unknown>).crypto = webcrypto;
}

interface PersonaConfig {
  entity_id: string;
  agent_name: string;
  keypair_path: string;
  registry_url: string;
  /** A2A bind port (0.0.0.0:<port>). */
  server_port: number;
  /** Public URL the persona is registered with — used for sanity logging only. */
  entity_url: string;
  /** 127.0.0.1 port the MCP talks to for /internal/reply. */
  internal_port: number;
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

const QUEUED_RESPONSE =
  "queued: this persona is human-in-the-loop. The user will be asked, and if approved a reply will be delivered out-of-band as a new A2A message.";

async function main(): Promise<void> {
  const cfg = loadConfig();
  log("starting persona runner", { entity_id: cfg.entity_id, port: cfg.server_port });

  const agentConfig = AgentConfigSchema.parse({
    name: cfg.agent_name,
    description: `Claude-hosted persona for ${cfg.agent_name}`,
    keypairPath: cfg.keypair_path,
    serverHost: "0.0.0.0",
    serverPort: cfg.server_port,
    authMode: "permissive",
    registryUrl: cfg.registry_url,
    entityUrl: cfg.entity_url,
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

  // Inbound A2A handler: file the message in the mailbox, ack the caller
  // immediately so they aren't blocked, and surface the message via MCP for
  // the human to review. Auth (x-zynd-auth signature, replay, expiry) is
  // verified by the SDK BEFORE this fires.
  agent.onMessage(async (input: HandlerInput, _task: TaskHandle) => {
    const message = input.message;
    const senderEntityId = message.senderId || "unknown";
    const senderPublicKey = message.senderPublicKey;
    const messageId = message.messageId;
    const contextId = message.conversationId;

    // ---- Distinguish push callbacks from fresh inbound -------------------
    //
    // Two shapes of inbound traffic land here:
    //
    //   1. A fresh message from another agent who wants to talk to the
    //      user → file in the mailbox, ack, wait for human review.
    //   2. A push notification for a task Claude initiated → look up our
    //      outbound-task ledger, capture the result, ack quietly. No
    //      human review needed because Claude was the one who asked.
    //
    // The wire shape of a push callback is a signed A2A message wrapping
    // a `status-update` event in a DataPart. Detect that, and if the
    // referenced taskId matches one we registered, route as a callback.
    const callbackEvent = detectPushCallback(message);
    if (callbackEvent) {
      const ours = findOutboundTask(callbackEvent.taskId);
      if (ours) {
        const reply =
          callbackEvent.replyText ?? null;
        recordAsyncReply({
          task_id: callbackEvent.taskId,
          context_id: callbackEvent.contextId,
          state: callbackEvent.state,
          reply,
          received_at: new Date().toISOString(),
          status_timestamp: callbackEvent.timestamp,
        });
        log("push-callback", {
          task_id: callbackEvent.taskId,
          state: callbackEvent.state,
          target: ours.target_entity_id,
        });
        return { response: "ack: callback recorded" };
      }
      // It looks like a callback but wasn't for one of our tasks — fall
      // through to the human-review path so the user can decide.
      log("unknown-callback", {
        task_id: callbackEvent.taskId,
        sender: senderEntityId,
      });
    }

    const entry: MailboxEntry = {
      message_id: messageId,
      sender_id: senderEntityId,
      sender_public_key: senderPublicKey,
      content: message.content,
      conversation_id: contextId,
      metadata: {
        ...message.metadata,
        // Stash A2A-specific fields so deliverReply can thread the answer
        // back into the same conversation.
        _a2a_context_id: contextId,
        _a2a_signed: input.signed,
      },
      received_at: new Date().toISOString(),
      status: "pending",
    };
    appendEntry(cfg.entity_id, entry);
    log("inbound", { message_id: messageId, sender: senderEntityId, signed: input.signed });

    // Returning a string (or {response: string}) auto-completes the task —
    // the SDK ships it as the task's first artifact. The original caller's
    // `message/send` request settles right away; the real reply is pushed
    // out-of-band when the human approves.
    return { response: QUEUED_RESPONSE };
  });

  await agent.start();
  log("agent started", { url: cfg.entity_url, a2a: agent.a2aUrl });

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

/**
 * Send a fresh signed A2A message to the original sender containing the
 * human-approved reply. Threaded into the same `contextId` (when known)
 * so the sender's own conversation memory groups it with the original
 * message.
 */
async function deliverReply(
  agent: ZyndAIAgent,
  cfg: PersonaConfig,
  entry: MailboxEntry,
  response: string,
): Promise<void> {
  // Resolve the sender's public AgentCard via the registry so we know
  // where to send the reply.
  const search = new SearchAndDiscoveryManager(cfg.registry_url);
  const senderCard = await search.getAgentById(entry.sender_id).catch((e) => {
    throw new Error(`sender ${entry.sender_id} not resolvable on registry: ${String(e)}`);
  });

  const senderEndpoint = pickSenderA2AEndpoint(senderCard);
  if (!senderEndpoint) {
    throw new Error(`sender card has no A2A endpoint for ${entry.sender_id}`);
  }

  const client = new A2AClient({
    keypair: agent.keypair,
    entityId: cfg.entity_id,
  });

  const contextId =
    typeof entry.metadata?.["_a2a_context_id"] === "string"
      ? (entry.metadata["_a2a_context_id"] as string)
      : entry.conversation_id;

  await client.sync({
    url: senderEndpoint,
    text: response,
    contextId: contextId ?? undefined,
    blocking: false,
    timeoutMs: 30_000,
  });
}

/**
 * Read the A2A endpoint URL from a registry-returned AgentCard. Tries the
 * canonical `url` field first, then the `additionalInterfaces[]` array,
 * then reconstructs from `entity_url`.
 */
function pickSenderA2AEndpoint(card: Record<string, unknown> | null): string | null {
  if (!card) return null;
  if (typeof card["url"] === "string" && card["url"]) return card["url"] as string;

  const ifaces = card["additionalInterfaces"];
  if (Array.isArray(ifaces)) {
    for (const i of ifaces) {
      if (
        i &&
        typeof i === "object" &&
        typeof (i as Record<string, unknown>)["url"] === "string" &&
        typeof (i as Record<string, unknown>)["transport"] === "string" &&
        ((i as Record<string, unknown>)["transport"] as string).toUpperCase() === "JSONRPC"
      ) {
        return (i as Record<string, unknown>)["url"] as string;
      }
    }
  }

  const entityUrl = card["entity_url"];
  if (typeof entityUrl === "string" && entityUrl) {
    return `${entityUrl.replace(/\/+$/, "")}/a2a/v1`;
  }
  return null;
}

/**
 * Inspect an incoming AgentMessage to see if it's a push-notification
 * callback (i.e. a `status-update` event the deployer / SDK emits when
 * a task settles). Returns the parsed event or null when it doesn't
 * look like one.
 *
 * The push payload format is documented in zyndai-agent's a2a/server.py
 * `_deliver_push_if_configured` — a signed A2A message whose only part
 * is a DataPart with `kind: "status-update"`, carrying taskId / contextId
 * / status / final.
 */
function detectPushCallback(message: {
  metadata?: Record<string, unknown> | null;
  taskId?: string;
  conversationId?: string;
  content?: string;
}): {
  taskId: string;
  contextId: string;
  state: string;
  timestamp: string | null;
  replyText: string | null;
} | null {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;

  // Some SDKs (the Python A2AClient.sync push delivery) inline the
  // status-update under metadata.parts; others put it in the content
  // (after the adapter joined data parts into a JSON string fallback).
  // We look at both.

  // Case A: metadata carries a parsed `data` field with kind=status-update.
  for (const candidate of [meta["data"], meta["status-update"], meta["status_update"]]) {
    if (candidate && typeof candidate === "object") {
      const event = candidate as Record<string, unknown>;
      if (event["kind"] === "status-update" && typeof event["taskId"] === "string") {
        return {
          taskId: event["taskId"] as string,
          contextId:
            (event["contextId"] as string | undefined) ??
            message.conversationId ??
            "",
          state:
            ((event["status"] as Record<string, unknown> | undefined)?.["state"] as string) ??
            "unknown",
          timestamp:
            ((event["status"] as Record<string, unknown> | undefined)?.["timestamp"] as string) ??
            null,
          replyText: null,
        };
      }
    }
  }

  // Case B: the content was JSON.stringify-ed by the inbound adapter.
  if (typeof message.content === "string" && message.content.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(message.content) as Record<string, unknown>;
      if (obj["kind"] === "status-update" && typeof obj["taskId"] === "string") {
        return {
          taskId: obj["taskId"] as string,
          contextId:
            (obj["contextId"] as string | undefined) ??
            message.conversationId ??
            "",
          state:
            ((obj["status"] as Record<string, unknown> | undefined)?.["state"] as string) ??
            "unknown",
          timestamp:
            ((obj["status"] as Record<string, unknown> | undefined)?.["timestamp"] as string) ??
            null,
          replyText: null,
        };
      }
    } catch {
      // not JSON — not a callback
    }
  }

  return null;
}

main().catch((err) => {
  log("fatal", String(err));
  process.exit(1);
});
