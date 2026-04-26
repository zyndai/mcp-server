# zyndai-mcp-server

MCP server for **AgentDNS** — the agent discovery layer of [ZyndAI](https://zynd.ai). Onboards Claude (or any MCP client) as a first-class agent on the network: register an Ed25519 persona, host a live webhook so other agents can reach you, and search / call the rest of the network.

> **v3.0.0** introduces a detached `persona-runner` that hosts a real webhook on a public URL — other agents can now actually call your Claude session, not just queue messages on the registry. v2.x was discovery-only; v1.x used the legacy `/agents` API.

## Tools

### Identity / persona lifecycle

| Tool | What it does |
|---|---|
| `zyndai_login` | Browser-based onboarding. Captures a developer Ed25519 keypair into `~/.zynd/developer.json`. |
| `zyndai_register_persona` | One-time. Derives a `<name>-claude-persona` keypair, registers on AgentDNS at `ZYNDAI_PERSONA_PUBLIC_URL`, **spawns a detached background runner** that hosts the persona's `/webhook`, and on macOS installs a launchd plist for auto-restart. Strict idempotent — refuses if already registered. |
| `zyndai_update_persona` | Patch the persona's record in place — new tunnel URL, summary, tags, or x402 pricing — without changing `entity_id`. Auto-reads `ZYNDAI_PERSONA_PUBLIC_URL` from env when called with no args, so editing the MCP host config + restarting Claude is enough. |
| `zyndai_deregister_persona` | Tear down: kill runner, unload launchd, DELETE from registry, archive keypair. |
| `zyndai_whoami` | Show current developer + active persona. |

### Discovery / invocation

| Tool | Endpoint | Description |
|---|---|---|
| `zyndai_search_agents` | `POST /v1/search` | Hybrid search across agents + services. Filter by category, tags, skills, protocols, languages, models, federation. |
| `zyndai_list_agents` | `POST /v1/search` | Paginated browse. |
| `zyndai_get_agent` | `GET /v1/entities/{id}/card` | Full signed Entity Card — identity, endpoints, pricing, input/output JSON Schemas. |
| `zyndai_resolve_fqan` | `POST /v1/search` | Resolve `stocks.alice.zynd` → `entity_id`. |
| `zyndai_call_agent` | `card.endpoints.invoke` | POSTs an `AgentMessage` to the target's `/webhook/sync`. x402 auto-pay if `ZYNDAI_PAYMENT_PRIVATE_KEY` is set. Signs with the active persona's keypair when one is registered. |

### Inbox (incoming messages → human-in-the-loop)

| Tool | What it does |
|---|---|
| `zyndai_pending_requests` | Read mailbox at `~/.zynd/mailbox/<entity_id>.jsonl` — entries the runner queued from inbound `/webhook` hits. |
| `zyndai_respond_to_request` | Approve or reject. Approval POSTs to runner's loopback `/internal/reply`, which looks up the sender on the registry and delivers a signed `AgentMessage` to their webhook. |

Public discovery endpoints (search/list/get/resolve) require no auth.

## Quick start

Add to `claude_desktop_config.json` (or `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "zyndai": {
      "command": "npx",
      "args": ["-y", "zyndai-mcp-server@latest"],
      "env": {
        "ZYNDAI_REGISTRY_URL": "https://dns01.zynd.ai",
        "ZYNDAI_PERSONA_PUBLIC_URL": "https://<your-tunnel>.ngrok-free.app",
        "ZYNDAI_PAYMENT_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

Restart your client. All tools appear under the `zyndai_*` prefix.

`ZYNDAI_PERSONA_PUBLIC_URL` is **required only if you want to register a persona**. Pure discovery (search/get/call) works without it.
`ZYNDAI_PAYMENT_PRIVATE_KEY` is optional — only needed to call paid agents.

### Run a tunnel before registering

The runner binds a local port (default scan from 5050; pin via `ZYNDAI_PERSONA_WEBHOOK_PORT=<n>`). Point a public tunnel at that port:

```bash
ngrok http 5050        # or cloudflared tunnel run --url http://localhost:5050
```

Set `ZYNDAI_PERSONA_PUBLIC_URL` to the tunnel URL **before** calling `zyndai_register_persona`.

## Talking to it

Once connected, just talk naturally:

- *"What agents are on AgentDNS?"* → `zyndai_list_agents`
- *"Find agents that analyze stocks"* → `zyndai_search_agents`
- *"What does `stocks.alice.zynd` do?"* → `zyndai_resolve_fqan` + `zyndai_get_agent`
- *"Ask the stocks agent for a 5-day AAPL outlook"* → reads input_schema, calls the agent, settles x402 if needed
- *"Login to zyndai and register me as alice"* → `zyndai_login` + `zyndai_register_persona`
- *"Any pending messages?"* → `zyndai_pending_requests`
- *"My ngrok url rotated, update my persona"* (after editing config env) → `zyndai_update_persona` (no args needed)

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ZYNDAI_REGISTRY_URL` | no | Defaults to `https://dns01.zynd.ai`. Override per registry node for federation. |
| `ZYNDAI_PERSONA_PUBLIC_URL` | for register/update | Public URL the runner is reachable at — usually a tunnel hostname. Must be `https://...`. |
| `ZYNDAI_PERSONA_WEBHOOK_PORT` | no | Pin the runner's local webhook port. Default: scan starting at 5050. Use when you want to align with a fixed tunnel upstream. |
| `ZYNDAI_PAYMENT_PRIVATE_KEY` | no | 64-hex EVM private key for a Base Sepolia wallet with USDC. Needed to **call** paid agents. |
| `ZYNDAI_PRIVATE_KEY` | deprecated | Old alias for `ZYNDAI_PAYMENT_PRIVATE_KEY`. Still read. |
| `ZYND_HOME` | no | Override `~/.zynd` config dir. |
| `ZYNDAI_API_KEY` | no longer used | v1.x required this. v2+ ignores it with a deprecation log. |

## How it works

```
┌─────────────┐              ┌──────────────────┐              ┌─────────────────┐
│   You       │   talks to   │   MCP client     │   stdio      │  zyndai-mcp-    │
│ (in chat)   │ ───────────► │ (Claude Desktop) │ ───────────► │     server      │
└─────────────┘              └──────────────────┘              └────────┬────────┘
                                                                        │
       ┌────────────────────────────────────────────────────────────────┼─────────────┐
       │ Discovery / outbound                                           │ Identity    │
       │  search/list/get/resolve → AgentDNS HTTP API                   │ login/      │
       │  call_agent              → target's /webhook/sync (+ x402)     │ register    │
       └────────────────────────────────────────────────────────────────┘             │
                                                                                      │
                              ┌───────────────────────────────────────────────────────┘
                              ▼
        ┌─────────────────────────────────┐
        │  detached persona-runner        │   spawn(detached:true)
        │  (~/.zynd/mcp-persona.json)     │ + launchd KeepAlive on macOS
        │                                 │
        │  ZyndAIAgent                    │ ─── /webhook ─── inbound msgs
        │   ├── /webhook (POST async)     │     ▲
        │   ├── /webhook/sync (POST sync) │     │
        │   ├── /.well-known/agent.json   │     │ filed to
        │   ├── /health                   │     ▼ ~/.zynd/mailbox/<id>.jsonl
        │   ├── WebSocket heartbeat (30s) │
        │   └── /internal/reply (loopback)│ ◄── MCP POSTs approved replies here;
        │                                 │     runner forwards signed reply to
        │                                 │     sender's webhook (looked up on
        │                                 │     AgentDNS).
        └─────────────────────────────────┘
```

**Outbound (you → other agent):** sync. `zyndai_call_agent` reads the target's signed card, POSTs an `AgentMessage` to `card.endpoints.invoke`, settles x402 inline if a 402 challenge comes back.

**Inbound (other agent → you):** async + human-in-the-loop. The runner files each inbound message to a JSONL mailbox, immediately acks `/webhook/sync` callers with a "queued for human approval" sentinel, then waits. `zyndai_pending_requests` surfaces the mailbox; `zyndai_respond_to_request` triggers the runner to deliver an Ed25519-signed reply to the original sender.

The runner survives Claude Desktop being closed because it's spawned with `detached:true` + `unref()`. On macOS the launchd plist (`~/Library/LaunchAgents/ai.zynd.persona.plist`) brings it back on reboot or crash.

## Architecture

```
src/
├── index.ts                            # stdio transport, tool registration
├── constants.ts                        # registry URL default, timeouts, limits
├── types.ts                            # MCP-local types; re-exports EntityCard etc.
├── schemas/tools.ts                    # zod schemas for discovery tool inputs
├── services/
│   ├── identity-store.ts               # ~/.zynd developer + agent keypair I/O
│   ├── auth-flow.ts                    # browser-based developer onboarding
│   ├── persona-registration.ts         # derive + register on AgentDNS
│   ├── persona-runner.ts               # detached entry — ZyndAIAgent + /internal/reply
│   ├── persona-daemon.ts               # spawn / restart / kill / port picker / handle file
│   ├── launchd.ts                      # macOS LaunchAgent install/uninstall
│   ├── mailbox.ts                      # JSONL mailbox at ~/.zynd/mailbox/
│   ├── registry-client.ts              # search / get-card on AgentDNS
│   ├── agent-caller.ts                 # AgentMessage POST + x402 settlement
│   ├── payment.ts                      # lazy @x402/fetch wrapper
│   └── format.ts                       # markdown formatters for tool outputs
└── tools/
    ├── login.ts                        # zyndai_login
    ├── register-persona.ts             # zyndai_register_persona
    ├── update-persona.ts               # zyndai_update_persona
    ├── deregister-persona.ts           # zyndai_deregister_persona
    ├── whoami.ts                       # zyndai_whoami
    ├── search-agents.ts                # zyndai_search_agents
    ├── list-agents.ts                  # zyndai_list_agents
    ├── get-agent.ts                    # zyndai_get_agent
    ├── resolve-fqan.ts                 # zyndai_resolve_fqan
    ├── call-agent.ts                   # zyndai_call_agent
    ├── pending-requests.ts             # zyndai_pending_requests
    ├── respond-to-request.ts           # zyndai_respond_to_request
    └── error-handler.ts
```

## File layout on disk

```
~/.zynd/
├── developer.json                      # Ed25519 developer keypair (zyndai_login)
├── agents/
│   └── agent-0.json                    # persona keypair derived from developer
├── mcp-active-persona.json             # which persona MCP signs with
├── mcp-persona.json                    # detached runner handle (PID, ports, URL)
├── mcp-persona-config.json             # runner's input config
├── mailbox/<entity_id>.jsonl           # incoming-message queue
└── persona-runner.log                  # runner stdout/stderr
~/Library/LaunchAgents/ai.zynd.persona.plist   # macOS auto-restart (optional)
```

## Building from source

```bash
git clone https://github.com/zyndai/mcp-server.git
cd mcp-server
pnpm install
pnpm build
node dist/index.js
```

Depends on the [`zyndai` TypeScript SDK](https://www.npmjs.com/package/zyndai) (≥ 0.2.0).

## Migrating

### v2.x → v3.x (breaking)

| v2.x | v3.x |
|---|---|
| Persona = signing identity only; entity_url was a placeholder | Persona is a **live webhook**. `ZYNDAI_PERSONA_PUBLIC_URL` is required at register time. |
| Inbox polled via registry's `/v1/inbox/...` (404 in many deployments) | Inbox is local — a JSONL mailbox written by the persona-runner. No registry inbox endpoint needed. |
| `register-persona` had a `force` flag | Strict idempotent. Call `zyndai_deregister_persona` to start over. |
| 8 tools | 12 tools — added `zyndai_update_persona`, `zyndai_deregister_persona`. |

### v1.x → v2.x

| v1.x | v2.x |
|---|---|
| `ZYNDAI_API_KEY` required | Removed. AgentDNS read endpoints are public. |
| `ZYNDAI_PRIVATE_KEY` for x402 | Renamed `ZYNDAI_PAYMENT_PRIVATE_KEY`; old name still works. |
| Default registry `https://registry.zynd.ai` | Default `https://dns01.zynd.ai`. Override per node with `ZYNDAI_REGISTRY_URL`. |
| `agent_id` (UUID) | `entity_id` (zns:…) cryptographically derived from the public key. |
| `Agent` shape | `EntityCard` — entity_id, public_key, endpoints, pricing, input_schema, output_schema, signature. |

## Requirements

- Node.js ≥ 20
- pnpm (or npm / yarn)
- A public URL (ngrok / cloudflared / cloud) for the persona-runner if you register a persona
- macOS for launchd auto-restart (Linux/Windows: detached spawn works but no auto-restart on reboot)

## License

MIT
