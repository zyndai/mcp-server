# `zynd-mcp-server` ← `zyndai@0.3.0` (A2A) Migration Notes

**Date:** 2026-05-02
**Subject:** `zynd-mcp-server` v4.0.0 (`/Users/swapnilshinde/Desktop/p3ai/mcp-server`)
**Against:** `zyndai@^0.3.0` — the A2A protocol release of the SDK.

---

## 1. What changed in the SDK (the parts that touch us)

The SDK pivoted from a bespoke `/webhook` POST flow to **A2A**: JSON-RPC
2.0 over HTTPS at `<base>/a2a/v1`, signed with `x-zynd-auth` (Ed25519
per-message), and modeled around **Tasks** (artifacts, state machine)
instead of opaque request/response strings.

Everything in the table below was either renamed, restructured, or
removed in 0.3.0.

| Pre-A2A | Post-A2A | Notes |
|---|---|---|
| `agent.webhook.addMessageHandler(fn)` | `agent.onMessage((input, task) => any)` | New handler signature; return value auto-becomes the artifact |
| `agent.webhook.setResponse(id, text)` | return value from `onMessage` | No more `setResponse` — the SDK ships the return as the task artifact |
| `agent.webhook.sendMessage(url, text, opts)` | `new A2AClient(...).sync({url, text, ...})` | Outbound goes through the dedicated client now |
| `webhookHost`, `webhookPort` config fields | `serverHost`, `serverPort`, `a2aPath`, `authMode` | And ngrok fields are gone |
| `useNgrok` / `ngrokAuthToken` | (gone) | Use a real tunnel out-of-band |
| `summary`, `capabilities`, `framework`, `language` config fields | (gone — auto-derived from description / payload Zod schema) | Smaller scaffolded configs |
| `WebhookCommunicationManager` / `AgentCommunicationManager` | (stubbed; raise NotImplementedError) | A2AServer replaces both |
| `AgentMessage(content, sender, ...)` constructor still works | unchanged for handler-side reading | But A2A Message is the wire shape; AgentMessage is just a wrapper |
| `/.well-known/agent.json` | `/.well-known/agent-card.json` | Try the new path first, fall back |
| `card.endpoints.invoke` / `invoke_async` / `health` / `agent_card` | `card.url` (canonical), `card.additionalInterfaces[]` | Plus optional `entity_url` for the public base |
| `card.signature` (single string) | `card.signatures[]` (JWS-detached array) | Multiple signers possible (developer + agent) |
| `DNSRegistryClient.updateEntity({ fields })` | `DNSRegistryClient.updateEntity({ updates })` | Param rename to match registry wire |
| `https://dns01.zynd.ai` default | `https://zns01.zynd.ai` default | Org rebrand |

The SDK also added cross-SDK guarantees:
- **JCS canonical bytes are byte-identical between Python and TS** — a
  message signed in Python verifies in TS and vice versa (the test
  harness lives in `zyndai-agent/tests/cross_sdk/`).
- **`A2AClient.ask(url, text)`** is the new convenience for "send a
  one-shot signed message and read the reply text" — it reads from
  `task.artifacts[].parts` (NOT `task.history`, which would echo back
  the caller's own outbound and trigger LLM tool loops).

---

## 2. What changed in the MCP server

### `src/services/persona-runner.ts` — full rewrite

Replaces the `agent.webhook.addMessageHandler` flow with `agent.onMessage`:

- Handler now takes `(input: HandlerInput, task: TaskHandle)` and
  returns the queued sentinel directly — no `agent.webhook.setResponse`.
- The push-OUT human-in-the-loop pattern (the runner sends the
  approved reply as a fresh A2A message addressed to the original
  sender) now goes through `A2AClient.sync({url, text, contextId,
  blocking: false})`.
- Sender resolution looks at the AgentCard's `url` first, then the
  `additionalInterfaces[]` array, then reconstructs from `entity_url`
  for legacy cards.
- Drops `useNgrok` / `ngrokAuthToken` config fields. `serverPort`
  replaces `webhookPort`.

### `src/services/persona-daemon.ts`

- `SpawnOpts.webhookPort` → `SpawnOpts.serverPort`.
- `DaemonHandle.webhook_port` → `DaemonHandle.server_port`.
- `readHandle()` accepts both old and new field names so a developer
  who upgrades mid-flight doesn't lose their running daemon.
- Drops `useNgrok` / `ngrokAuthToken` fields.

### `src/services/agent-caller.ts` — rewritten

- Outbound now uses `A2AClient.sync({url, text, contextId})` instead
  of a hand-rolled `fetch(.../webhook/sync, body=AgentMessage.toDict())`.
- Endpoint resolution prefers `card.url` (the post-A2A field), falls
  back to `additionalInterfaces[].url` where `transport === "JSONRPC"`,
  then to `${entity_url}/a2a/v1`.
- Reply text comes from `taskReplyText(task)` (the SDK helper that
  reads `task.artifacts` first, status message second, history last
  — fixes the infinite-loop class of bugs).
- x402 settlement metadata is captured by transient-monkey-patching
  `globalThis.fetch` for the call's lifetime, since `A2AClient.sync`
  uses the global fetch directly. Reverted in `finally`.
- Anonymous senders (no active persona) get a one-shot generated
  keypair so the outbound `x-zynd-auth` signature is still valid.

### `src/services/registry-client.ts`

- Card hydration tries `/.well-known/agent-card.json` first, falls
  back to `/.well-known/agent.json` for legacy agents.
- Pulls the entity base URL from either `card.entity_url` (legacy) or
  by stripping the `/a2a/v\d+` suffix off `card.url` (post-A2A).
- Drops the `EntityCard` import (the symbol is gone in the new SDK);
  uses the local `AgentCard` interface in `src/types.ts` instead.

### `src/services/format.ts`

- `formatEntityCard` rewritten to handle the flat post-A2A AgentCard
  shape (top-level `url`, `additionalInterfaces[]`, `signatures[]`,
  `inputSchema`/`outputSchema` camelCase, `paymentMethods` camelCase)
  while still rendering legacy cards (`endpoints.invoke`,
  `signature`, `payment_methods`, etc.) when those fields are present.
- New `**Skills**` section surfaces the A2A `skills[]` array.

### `src/types.ts`

- New local `AgentCard` interface (the SDK no longer exports a
  single named card type).
- `EntityCard` retained as a back-compat alias of `AgentCard` so
  existing imports don't break.
- `WebhookSyncResponse` removed — no more raw webhook envelopes.
- `CallAgentResult` gained `taskId`, `taskState`, full `task: ATask`
  + renamed `conversationId` → `contextId` to match A2A's vocabulary.

### `src/tools/register-persona.ts`

- `webhookPort` → `serverPort` end-to-end.
- New `ZYNDAI_PERSONA_SERVER_PORT` env var (legacy
  `ZYNDAI_PERSONA_WEBHOOK_PORT` still honored for back-compat).
- Tool docstring updated to describe the A2A endpoint
  (`<PUBLIC_URL>/a2a/v1`) instead of `/webhook`.

### `src/tools/update-persona.ts`

- `currentDaemon.webhook_port` → `currentDaemon.server_port` when
  restarting the daemon with a new public URL.
- `DNSRegistryClient.updateEntity({ fields })` → `{ updates }` to
  match the registry's wire spelling. (The `as unknown as ...` cast
  keeps the call working against either SDK shape until the global
  rename lands.)

### `src/tools/call-agent.ts`

- Passes `params.conversation_id` through as `contextId` (A2A's name
  for the same thing).
- Format result now reads `result.contextId` (the A2A field) instead
  of the old `conversationId` field.
- Tool description rewritten to reference A2A semantics: signed
  `message/send`, the artifact-extraction rule, the `contextId`
  thread continuation.

### `src/constants.ts`

- `DEFAULT_REGISTRY_URL`: `dns01.zynd.ai` → `zns01.zynd.ai`.

### `package.json`

- Version bumped: `3.0.2` → `4.0.0` (major: drops legacy webhook).
- `zyndai`: `^0.2.1` → `^0.3.0`.

---

## 3. What's untouched

The auth / identity surface stayed stable across the A2A pivot:

- `src/services/identity-store.ts` — Ed25519 keypair I/O
- `src/services/auth-flow.ts` — browser-based onboarding
- `src/services/persona-registration.ts` — `DNSRegistryClient.registerEntity`
  takes the same shape post-A2A (developer_proof, derivation, etc.)
- `src/services/mailbox.ts` — pure JSONL append/read
- `src/services/launchd.ts` — macOS plist installer
- All read-side tools: `search-agents`, `list-agents`, `get-agent`,
  `resolve-fqan`, `whoami`

---

## 4. Verification

```bash
cd ~/Desktop/p3ai/mcp-server
pnpm install         # picks up zyndai@^0.3.0
pnpm build           # tsc — should be clean
node dist/index.js   # boot the MCP server
```

Run the typecheck against the local SDK build:

```bash
# Temporarily swap node_modules/zyndai for the local dist (since the
# new version isn't published yet):
mv node_modules/zyndai node_modules/zyndai.published.bak
cp -r ~/Desktop/p3ai/zyndai-ts-sdk/dist ~/Desktop/p3ai/zyndai-ts-sdk/package.json node_modules/zyndai/
node node_modules/typescript/bin/tsc --noEmit
# Then restore:
mv node_modules/zyndai node_modules/zyndai.local.bak
mv node_modules/zyndai.published.bak node_modules/zyndai
```

Both compile and full build pass against `zyndai@0.2.6` (the local
build of the feat/a2a branch).
