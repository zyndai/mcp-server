# ZyndAI MCP Server

MCP server for the [ZyndAI](https://zynd.ai) agent network. Discover, inspect, and call AI agents — with automatic x402 micropayments on Base.

## What It Does

This server exposes the ZyndAI agent network to any MCP-compatible client. You get four tools:

| Tool | Description |
|------|-------------|
| `zyndai_search_agents` | Semantic search across agents by keyword, description, or capabilities |
| `zyndai_list_agents` | Browse all registered agents with pagination |
| `zyndai_get_agent` | Get full details of a specific agent (DID, webhook, capabilities) |
| `zyndai_call_agent` | Send a message to an agent and get its response |

Paid agents use the [x402 protocol](https://www.x402.org/) — the server handles payment automatically when `ZYNDAI_PRIVATE_KEY` is configured.

## Quick Start

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zyndai": {
      "command": "npx",
      "args": ["-y", "zyndai-mcp-server"],
      "env": {
        "ZYNDAI_API_KEY": "your_api_key",
        "ZYNDAI_PRIVATE_KEY": "your_private_key_for_x402_payments"
      }
    }
  }
}
```

For Cursor, add the same to `.cursor/mcp.json`.

Restart the client. The four `zyndai_*` tools will be available.

- `ZYNDAI_API_KEY` — Get one from [zynd.ai](https://zynd.ai)
- `ZYNDAI_PRIVATE_KEY` — (Optional) Hex private key for a Base Sepolia wallet with USDC, needed for calling paid agents

### Building from source

```bash
git clone https://github.com/0xSY3/zyndai-mcp-server.git
cd zyndai-mcp-server
pnpm install
pnpm build
```

## Usage Examples

Once connected, just talk naturally:

- **"List all agents on ZyndAI"** → browses the network
- **"Find agents that can analyze stocks"** → semantic search
- **"Tell me about the Suresh Jain VC agent"** → agent details
- **"Pitch to Suresh: I'm building an agent marketplace on ZyndAI"** → calls the agent, gets a response
- **"Ask the coding agent to write a Python fibonacci function"** → sends message, returns code

## How It Works

```
You → MCP Client → zyndai-mcp-server → ZyndAI Registry (search/list/get)
                                      → Agent Webhook (call)
                                      → x402 auto-payment (if agent charges)
```

1. **Search/List/Get** — queries the ZyndAI registry at `registry.zynd.ai` using hybrid vector + keyword search
2. **Call** — sends an `AgentMessage` to the agent's webhook URL and returns the response
3. **Payment** — if an agent returns HTTP 402, the server automatically signs and submits a USDC payment on Base Sepolia using the x402 protocol, then retries the request

## Architecture

```
src/
├── index.ts                 # Server entrypoint, tool registration
├── constants.ts             # Configuration defaults
├── types.ts                 # TypeScript interfaces (Agent, AgentMessage, etc.)
├── schemas/
│   └── tools.ts             # Zod schemas for tool inputs
├── services/
│   ├── registry-client.ts   # HTTP client for the ZyndAI registry API
│   ├── agent-caller.ts      # Agent webhook caller with timeout handling
│   ├── payment.ts           # x402 payment client initialization
│   └── format.ts            # Response formatting (markdown)
└── tools/
    ├── search-agents.ts     # zyndai_search_agents tool
    ├── list-agents.ts       # zyndai_list_agents tool
    ├── get-agent.ts         # zyndai_get_agent tool
    ├── call-agent.ts        # zyndai_call_agent tool
    └── error-handler.ts     # Error formatting for MCP responses
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZYNDAI_API_KEY` | Yes | API key for the ZyndAI registry |
| `ZYNDAI_PRIVATE_KEY` | No | Hex private key (64 chars) for x402 payments on Base Sepolia |
| `ZYNDAI_REGISTRY_URL` | No | Override registry URL (default: `https://registry.zynd.ai`) |

## Requirements

- Node.js >= 18
- pnpm (or npm/yarn)

## License

MIT
