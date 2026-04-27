# `zynd-mcp-server` <- `zyndai@0.2.1` Compatibility Audit

**Date:** 2026-04-27
**Subject:** `zynd-mcp-server` v3.0.1 (`/Users/swapnilshinde/Desktop/p3ai/mcp-server`)
**Against:** `zyndai@0.2.1` (`/Users/swapnilshinde/Desktop/p3ai/zyndai-ts-sdk`, also `github.com/zyndai/zyndai-ts-sdk`)

---

## 1. Verdict

**SAFE WITH DEP BUMP.**

No source code edits are required. The MCP server uses only the public API surface that survived 0.2.0 -> 0.2.1 unchanged:

- It instantiates `ZyndAIAgent` exactly once with a single `(config)` argument — no positional drift across the new `(config, validation?, entityType?, entityLabel?)` signature.
- It never instantiates `ZyndService` and never subclasses `ZyndBase`, so the protected-field-init reordering doesn't reach it.
- It never calls `generateEntityId(...)` directly — registration goes through `DNSRegistryClient.registerEntity({ entityType: "agent", ... })`, which the registry already echoes back as `zns:<hex>` (correct for agents in both 0.2.0 and 0.2.1).
- Entity IDs are treated as opaque strings everywhere — no regex like `^zns:[a-f0-9]+$` that would reject the new `zns:svc:<hex>` service prefix.
- `DEFAULT_REGISTRY_URL` already points at the canonical `https://dns01.zynd.ai`.

The existing `"zyndai": "^0.2.0"` SemVer range *technically* admits 0.2.1, but I bumped the floor to `^0.2.1` to (a) signal intent, (b) document that the persona-runner depends on the fixes baked into 0.2.1 (heartbeat-sig timestamp format, register-409 -> update fallback, service entity_id), and (c) guarantee fresh installs land on the fixed release.

---

## 2. What I checked

Source files (every `import` from `"zyndai"` traced):

- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/package.json`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/tsconfig.json`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/.gitignore`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/index.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/constants.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/types.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/schemas/tools.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/identity-store.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/auth-flow.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/persona-registration.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/persona-runner.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/persona-daemon.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/launchd.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/mailbox.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/registry-client.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/agent-caller.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/payment.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/services/format.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/error-handler.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/login.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/register-persona.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/update-persona.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/deregister-persona.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/whoami.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/search-agents.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/list-agents.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/get-agent.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/resolve-fqan.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/call-agent.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/pending-requests.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/src/tools/respond-to-request.ts`
- `/Users/swapnilshinde/Desktop/p3ai/mcp-server/README.md`

SDK reference surface inspected to validate the call sites above:

- `/Users/swapnilshinde/Desktop/p3ai/zyndai-ts-sdk/src/index.ts` (public exports)
- `/Users/swapnilshinde/Desktop/p3ai/zyndai-ts-sdk/src/base.ts` (the changed constructor)
- `/Users/swapnilshinde/Desktop/p3ai/zyndai-ts-sdk/src/agent.ts`
- `/Users/swapnilshinde/Desktop/p3ai/zyndai-ts-sdk/src/service.ts`
- `/Users/swapnilshinde/Desktop/p3ai/zyndai-ts-sdk/src/identity.ts` (`generateEntityId` semantics)
- `/Users/swapnilshinde/Desktop/p3ai/zyndai-ts-sdk/src/registry.ts`
- `/Users/swapnilshinde/Desktop/p3ai/zyndai-ts-sdk/src/search.ts`
- `/Users/swapnilshinde/Desktop/p3ai/zyndai-ts-sdk/src/types.ts`
- `/Users/swapnilshinde/Desktop/p3ai/zyndai-ts-sdk/src/webhook.ts`

Symbols checked (each cross-referenced against the SDK definition):

- `ZyndBase` constructor — not used (no subclassing in mcp-server).
- `ZyndAIAgent` constructor — used once.
- `ZyndService` constructor — not used.
- `generateEntityId` — not imported anywhere in mcp-server.
- `generateDeveloperId` — used in three tools, only ever called with `publicKeyBytes`.
- `DNSRegistryClient.registerEntity` — used in persona registration, passes `entityType: "agent"`.
- `DNSRegistryClient.updateEntity` / `deleteEntity` — used, no entity_id format dependency.
- `SearchAndDiscoveryManager` — used in persona-runner for sender lookup; treats entity IDs opaquely.
- `AgentMessage` — used in agent-caller; no entity_id parsing.
- `AgentConfigSchema`, `keypairFromPrivateBytes`, `Ed25519Keypair` (type) — used; no behavior change in 0.2.1.
- `EntityCard`, `AgentSearchResponse`, `SearchRequest`, `SearchResult` (types) — used; shape unchanged.
- `_entityType` / `_entityLabel` — never accessed (would be a protected-access violation anyway; mcp-server doesn't subclass `ZyndBase`).

---

## 3. Findings (file:line, with one-line note each)

Every contact point with the changed surface:

- `package.json:50` — `"zyndai": "^0.2.0"` admits 0.2.1 by SemVer. **Bumped to `^0.2.1`** for clarity (see Section 5).
- `src/services/persona-runner.ts:102` — `new ZyndAIAgent(agentConfig)` — single positional arg; new `(config, validation?, entityType?, entityLabel?)` signature is fully back-compat. **Safe.**
- `src/services/persona-runner.ts:36` — imports `ZyndAIAgent`, `SearchAndDiscoveryManager`, `AgentConfigSchema` — all still exported from the SDK barrel. **Safe.**
- `src/services/persona-runner.ts:107` — `agent.webhook.addMessageHandler(...)` — the webhook surface is unchanged in 0.2.1. **Safe.**
- `src/services/persona-runner.ts:124` — `agent.webhook.setResponse(...)` — unchanged. **Safe.**
- `src/services/persona-runner.ts:130` — `await agent.start()` — internally now also runs the registry-409 -> update fallback and the loopback-URL warning. Both are runtime-only changes; no API impact. **Safe (and now more idempotent).**
- `src/services/persona-runner.ts:202` — `new SearchAndDiscoveryManager(cfg.registry_url)` — unchanged. **Safe.**
- `src/services/persona-runner.ts:203` — `search.getAgentById(entry.sender_id)` — accepts any string entity_id, including the new `zns:svc:<hex>` service form. **Safe.**
- `src/services/persona-runner.ts:212` — `agent.webhook.sendMessage(senderEntityUrl, ...)` — unchanged signature. **Safe.**
- `src/services/persona-registration.ts:21-22` — imports `DNSRegistryClient`, `createDerivationProof`, `deriveAgentKeypair`, `generateDeveloperId`, `Ed25519Keypair` (type-only). All unchanged. **Safe.**
- `src/services/persona-registration.ts:79` — `deriveAgentKeypair(opts.developerKeypair.privateKeyBytes, index)` — unchanged. **Safe.**
- `src/services/persona-registration.ts:80` — `createDerivationProof(developerKeypair, personaPubKey, index)` — unchanged. **Safe.**
- `src/services/persona-registration.ts:85` — `generateDeveloperId(publicKeyBytes)` — unchanged; not entity-type-dependent. **Safe.**
- `src/services/persona-registration.ts:105-117` — `DNSRegistryClient.registerEntity({ entityType: "agent", ... })`. Passes `"agent"` explicitly, so registration is unaffected by the service-id-prefix fix. **Safe.**
- `src/services/identity-store.ts:21-23` — imports `keypairFromPrivateBytes` and the `Ed25519Keypair` type only. Both unchanged. **Safe.**
- `src/services/auth-flow.ts:33` — imports `keypairFromPrivateBytes`, `Ed25519Keypair` type. Unchanged. **Safe.**
- `src/services/registry-client.ts:9-15` — imports `DNSRegistryClient`, `AgentSearchResponse`, `EntityCard`, `SearchRequest`, `SearchResult` (types). Unchanged shapes. **Safe.**
- `src/services/agent-caller.ts:17` — imports `AgentMessage` and `EntityCard` (type). Unchanged. **Safe.**
- `src/services/agent-caller.ts:48-60` — `new AgentMessage({ ... })` — constructor surface unchanged. **Safe.**
- `src/services/agent-caller.ts:51` — `receiverId: card.entity_id` — opaque string passthrough; `zns:svc:<hex>` works the same as `zns:<hex>`. **Safe.**
- `src/services/mailbox.ts:50` — `entityId.replace(/[^a-zA-Z0-9:_-]/g, "_")` — sanitizing regex used to derive a filename. Both `zns:abc...` and `zns:svc:abc...` consist entirely of allowed characters, so the regex is a no-op for either form. **Safe.**
- `src/tools/login.ts:3` — `import { generateDeveloperId } from "zyndai"` — used once at line 77 with `publicKeyBytes`. **Safe.**
- `src/tools/whoami.ts:3` — same import, used at line 53. **Safe.**
- `src/tools/update-persona.ts:3` — `import { DNSRegistryClient }` — uses `updateEntity({ ... })`. **Safe.**
- `src/tools/deregister-persona.ts:4` — `import { DNSRegistryClient }` — uses `deleteEntity(...)`. **Safe.**
- `src/tools/register-persona.ts` — does **not** import directly from `"zyndai"`; delegates to `services/persona-registration.ts`. **Safe by transitivity.**
- `src/types.ts:6,8` — re-exports `EntityCard`, `AgentSearchResponse` from `"zyndai"`. Both type shapes unchanged. **Safe.**
- `src/schemas/tools.ts` — local zod schemas; no SDK import. **Safe.**
- `src/constants.ts:10` — `DEFAULT_REGISTRY_URL = "https://dns01.zynd.ai"`. **Already canonical.** No occurrences of the legacy `https://registry.zynd.ai` anywhere in the source tree.
- `.gitignore:4` — `dist/` is ignored. **Reported only, no action needed.**

No findings flagged "needs change" or "unsure".

---

## 4. Required edits

None — verdict is SAFE WITH DEP BUMP, not BREAKING. The only edit applied is the dependency-floor bump and the host-package version bump described in Section 5.

---

## 5. Version bump recommendation

**`zynd-mcp-server`: 3.0.1 -> 3.0.2 (patch).**

Reasoning:

- **External MCP tool contract is unchanged.** The 12 tools registered in `src/index.ts` keep the same names, input schemas, output shapes, and error envelopes. A user editing `claude_desktop_config.json` notices nothing.
- **Behavior change is purely upstream-runtime.** The persona-runner now (a) emits second-precision heartbeat timestamps that the registry actually accepts, (b) recovers from a 409 on initial register by falling back to update, and (c) treats `zns:svc:<hex>` and `zns:<hex>` interchangeably in search results. None of those are API-shape changes — they're correctness fixes that ride on the dep bump.
- **No persona re-registration is required.** mcp-server has only ever registered personas as `entityType: "agent"`, which the SDK has always emitted with the bare `zns:<hex>` prefix. The service-prefix fix doesn't touch any persona registered through this MCP. (If a registry operator finds stale `zns:<hex>` IDs that *should* be `zns:svc:<hex>` from old service registrations made through the SDK directly, that's an operator-side cleanup, not an MCP-side migration.)
- **Search results may now contain `zns:svc:<hex>` IDs.** This is the one externally visible change, but mcp-server formats those IDs back to the model verbatim and the model passes them back into `zyndai_get_agent` / `zyndai_call_agent`, which the SDK accepts as opaque strings. No user-visible breakage; if anything, it's a fix — services that were registered under bogus `zns:<hex>` IDs in 0.2.0 will now show up correctly.

A minor bump would over-signal change. A major bump would be incorrect (no breaking external surface). Patch is the right call.

### Edits applied

1. `/Users/swapnilshinde/Desktop/p3ai/mcp-server/package.json`:
   - `"version": "3.0.1"` -> `"version": "3.0.2"`
   - `"zyndai": "^0.2.0"` -> `"zyndai": "^0.2.1"`

User must run `pnpm install` (or equivalent) to update the lockfile. No other action required.

---

## 6. Open questions / things to revisit

- **Heartbeats on the persona-runner.** mcp-server doesn't emit heartbeats itself, but the persona-runner (which boots `ZyndAIAgent` -> `ZyndBase.start()`) now does. The 0.2.0 -> 0.2.1 timestamp fix means any persona-runner currently failing to maintain a registry heartbeat (silently looking offline) should self-heal once redeployed against 0.2.1. Worth noting in release notes for users running an old runner via launchd: `launchctl unload ~/Library/LaunchAgents/ai.zynd.persona.plist && launchctl load ...` after upgrading.
- **The pinned `version` string in `src/index.ts:67` and `:90`** still says `"3.0.0"`. Cosmetic only — the `name`/`version` fields here are the MCP `serverInfo` object that flows back to clients in `initialize`. Not part of the audit scope, but the `zynd-mcp-server` package version is now 3.0.2 in `package.json` and these strings will drift. Consider sourcing them from `package.json` at build time, or updating them by hand on the next pass.
- **Stale `dist/`.** `dist/` is gitignored. There's no `prepublishOnly` issue: `pnpm build` is wired correctly. Reported only — nothing to do.
- **Lockfile.** `pnpm-lock.yaml` was not touched. The user is expected to regenerate it with their next `pnpm install`.
