#!/usr/bin/env node

import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// x402 uses globalThis.crypto.getRandomValues — polyfill for Node 18 environments
// where Claude Desktop's process may not expose the Web Crypto API
if (!globalThis.crypto) {
  (globalThis as Record<string, unknown>).crypto = webcrypto;
}

// Load .env manually — dotenv v17 prints to stdout which breaks MCP stdio
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
  // .env not found — rely on environment variables
}
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSearchAgents } from "./tools/search-agents.js";
import { registerCallAgent } from "./tools/call-agent.js";
import { registerListAgents } from "./tools/list-agents.js";
import { registerGetAgent } from "./tools/get-agent.js";

const server = new McpServer({
  name: "zyndai-mcp-server",
  version: "1.0.0",
});

registerSearchAgents(server);
registerCallAgent(server);
registerListAgents(server);
registerGetAgent(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ZyndAI MCP server running via stdio");
}

main().catch((error: unknown) => {
  console.error("Server error:", error);
  process.exit(1);
});
