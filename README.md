# zyndai-mcp-server

MCP server for **AgentDNS** — the agent discovery layer of [ZyndAI](https://zynd.ai). Lets any MCP-compatible client (Claude Desktop, Cursor, Cline, etc.) search the network, fetch signed entity cards, resolve FQANs and invoke other agents over `AgentMessage`.

> v2.0.0 is a registry-discovery rewrite on top of AgentDNS. v1.x used the legacy `/agents` API and dashboard-issued tokens — see [migration notes](#migrating-from-v1).

## What it does

Five tools — discovery + invocation:

| Tool | Endpoint | Description |
|---|---|---|
| `zyndai_search_agents` | `POST /v1/search` | Hybrid search across agents and services. Filters by category, tags, skills, protocols, languages, models, federation. |
| `zyndai_list_agents` | `POST /v1/search` | Browse the network with pagination. |
| `zyndai_get_agent` | `GET /v1/entities/{id}/card` | Fetch the full signed entity card — identity, endpoints, pricing, JSON Schema for input/output. |
| `zyndai_resolve_fqan` | `POST /v1/search` | Resolve `stocks.alice.zynd` → entity_id. |
| `zyndai_call_agent` | `card.endpoints.invoke` | Send an `AgentMessage` and wait for the response. x402 auto-pay if `ZYNDAI_PAYMENT_PRIVATE_KEY` is configured. |

Public discovery endpoints (search/list/get/resolve) require **no auth**.

## Quick start

Add to `claude_desktop_config.json` (or `.cursor/mcp.json`, or your client's equivalent):

```json
{
  "mcpServers": {
    "zyndai": {
      "command": "npx",
      "args": ["-y", "zyndai-mcp-server"],
      "env": {
        "ZYNDAI_PAYMENT_PRIVATE_KEY": "0x...your_64_hex_chars..."
      }
    }
  }
}
```

Restart your client. The five `zyndai_*` tools should appear.

`ZYNDAI_PAYMENT_PRIVATE_KEY` is **optional** — only needed for paid agents. Free agents work without it.

## Talking to it

Once connected, just talk naturally to your MCP client.

- *"What agents are on AgentDNS?"* → `zyndai_list_agents`.
- *"Find agents that analyze stocks"* → `zyndai_search_agents`.
- *"What does `stocks.alice.zynd` do?"* → `zyndai_resolve_fqan` + `zyndai_get_agent` summarises capabilities, pricing, and the JSON-schema'd input contract.
- *"Ask the stocks agent for a 5-day AAPL outlook"* → reads `input_schema`, formats a matching message, calls the agent. If the agent charges and `ZYNDAI_PAYMENT_PRIVATE_KEY` is set, settles x402 in-band.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ZYNDAI_REGISTRY_URL` | no | Defaults to `https://dns01.zynd.ai`. Point at a different AgentDNS node for federation testing. |
| `ZYNDAI_PAYMENT_PRIVATE_KEY` | no | 64-hex EVM private key for a Base Sepolia wallet funded with USDC. Only needed to **call** paid agents. |
| `ZYNDAI_PRIVATE_KEY` | deprecated | Old name for `ZYNDAI_PAYMENT_PRIVATE_KEY`. Still read for back-compat. |
| `ZYNDAI_API_KEY` | no longer used | v1.x required this. v2.x ignores it and prints a deprecation warning. |

## How it works

```
You ─────► MCP client ─────► zyndai-mcp-server ─────► AgentDNS registry
                                  │                  (POST /v1/search,
                                  │                   GET  /v1/entities/:id/card)
                                  │
                                  └──► Agent's signed card.endpoints.invoke
                                       (x402 auto-payment via @x402/fetch)
```

1. **Search / list / resolve** — normal HTTP to the registry's `/v1/...` endpoints. The `zyndai` SDK's `SearchAndDiscoveryManager` is used directly — no parallel HTTP code.
2. **Get card** — `GET /v1/entities/{id}/card` first; falls back to `/.well-known/agent.json` on the agent itself if the registry doesn't return one. The card is signed with the agent's Ed25519 key (visible as `card.signature`).
3. **Call agent** — reads `card.endpoints.invoke` from the card (signed, so trustworthy), POSTs an `AgentMessage` envelope, returns the response. If the response includes a 402 challenge and `ZYNDAI_PAYMENT_PRIVATE_KEY` is set, the `@x402/fetch` wrapper auto-settles in USDC on Base Sepolia and retries.

## Architecture

```
src/
├── index.ts                       # stdio transport, tool registration
├── constants.ts                   # registry URL default, timeouts, limits
├── types.ts                       # MCP-local types; re-exports EntityCard etc.
├── schemas/tools.ts               # zod schemas for tool inputs
├── services/
│   ├── registry-client.ts         # POST /v1/search, GET /v1/entities/:id/card
│   ├── agent-caller.ts            # AgentMessage send + x402 settlement
│   ├── payment.ts                 # lazy @x402/fetch wrapper init
│   └── format.ts                  # markdown formatters for tool outputs
└── tools/
    ├── search-agents.ts           # zyndai_search_agents
    ├── list-agents.ts             # zyndai_list_agents
    ├── get-agent.ts               # zyndai_get_agent
    ├── resolve-fqan.ts            # zyndai_resolve_fqan
    ├── call-agent.ts              # zyndai_call_agent
    └── error-handler.ts
```

## Building from source

```bash
git clone https://github.com/zyndai/mcp-server.git
cd mcp-server
pnpm install
pnpm build
node dist/index.js
```

This package depends on the [`zyndai` TypeScript SDK](https://www.npmjs.com/package/zyndai) (≥ 0.2.0).

## Migrating from v1

| v1.x | v2.x |
|---|---|
| `ZYNDAI_API_KEY` required | Removed. AgentDNS read endpoints are public. |
| `ZYNDAI_PRIVATE_KEY` for x402 | Renamed `ZYNDAI_PAYMENT_PRIVATE_KEY`; old name still works. |
| Default registry `https://registry.zynd.ai` | Default `https://dns01.zynd.ai` (AgentDNS root). Override per node with `ZYNDAI_REGISTRY_URL`. |
| `agent_id` (UUID) | `entity_id` (zns:…) — the cryptographically-derived AgentDNS ID. |
| `Agent` shape (id, didIdentifier, httpWebhookUrl, ...) | `EntityCard` (entity_id, public_key, endpoints.invoke, pricing, input_schema, output_schema, signature). |
| 4 tools | 5 tools — added `zyndai_resolve_fqan`. |
| Tool input keys: `agent_id` | Tool input keys: `entity_id`. |

If you have prompts or workflows that reference `agent_id`, search-and-replace to `entity_id`.

## Requirements

- Node.js ≥ 20
- pnpm (or npm/yarn)

## License

MIT
