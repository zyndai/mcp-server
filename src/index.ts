#!/usr/bin/env node

import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// x402 uses globalThis.crypto.getRandomValues — polyfill for Node 18 environments
// where Claude Desktop's process may not expose the Web Crypto API.
if (!globalThis.crypto) {
  (globalThis as Record<string, unknown>).crypto = webcrypto;
}

// Load .env manually — dotenv prints to stdout which breaks MCP stdio.
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
try {
  const envFile = readFileSync(envPath, "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — rely on environment variables passed by the host.
}

// Warn early if the user is still passing the legacy API key — AgentDNS
// search/list/get are public endpoints that don't need it. Doesn't fail
// startup; just makes the deprecation visible in the MCP host's logs.
if (process.env["ZYNDAI_API_KEY"]) {
  console.error(
    "ZYNDAI_API_KEY is set but no longer used by zyndai-mcp-server >= 2.0.0. " +
      "Search/list/get on AgentDNS are public; remove it from your config to silence this warning.",
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Identity / persona lifecycle — must come before discovery tools so a
// brand-new user is naturally guided through login → register before
// calling other agents.
import { registerLoginTool } from "./tools/login.js";
import { registerRegisterPersonaTool } from "./tools/register-persona.js";
import { registerUpdatePersonaTool } from "./tools/update-persona.js";
import { registerDeregisterPersonaTool } from "./tools/deregister-persona.js";
import { registerWhoamiTool } from "./tools/whoami.js";

// Discovery / call tools.
import { registerSearchAgents } from "./tools/search-agents.js";
import { registerListAgents } from "./tools/list-agents.js";
import { registerGetAgent } from "./tools/get-agent.js";
import { registerResolveFqan } from "./tools/resolve-fqan.js";
import { registerCallAgent } from "./tools/call-agent.js";

// Inbox — incoming messages other agents send to this persona.
import { registerPendingRequestsTool } from "./tools/pending-requests.js";
import { registerRespondToRequestTool } from "./tools/respond-to-request.js";

const server = new McpServer({
  name: "zyndai-mcp-server",
  version: "3.0.0",
});

// Identity
registerLoginTool(server);
registerRegisterPersonaTool(server);
registerUpdatePersonaTool(server);
registerDeregisterPersonaTool(server);
registerWhoamiTool(server);

// Discovery + invocation
registerSearchAgents(server);
registerListAgents(server);
registerGetAgent(server);
registerResolveFqan(server);
registerCallAgent(server);

// Inbox
registerPendingRequestsTool(server);
registerRespondToRequestTool(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("zyndai-mcp-server 3.0.0 (AgentDNS, live persona-runner) running on stdio");
}

main().catch((error: unknown) => {
  console.error("Server error:", error);
  process.exit(1);
});
