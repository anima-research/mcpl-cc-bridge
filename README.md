# mcpl-cc-bridge

A Claude Code plugin that hosts **MCPL servers** from inside a CC session. One
adapter process is simultaneously:

1. **MCP server** — proxies MCPL `tools/list`/`tools/call` as `<server>__<tool>`,
   forwards `tools/list_changed`, and adds bridge tools:
   - `mcpl_status` — connections, grants, feature sets, channels, pending inference
   - `mcpl_send` — `channels/publish` into a registered channel
   - `mcpl_open` / `mcpl_close` — `channels/open` / `channels/close` (§14.3);
     an open channel's ambient traffic arrives as `channels/incoming`, a closed
     one only reaches the session via `push/event` wakes. Descriptors flagged
     `initiallyOpen` are opened automatically after `channels/register`.
   - `mcpl_answer` — resolve a held `inference/request`
2. **Channel provider** (`claude/channel`) — `push/event`, `channels/incoming`,
   and `inference/request` arrive as `<channel source="mcpl" ...>` messages that
   start a turn (wake authority included).
3. **MCPL host proper** — the policy plane lives here, per SPEC 0.5:
   - effective grant = advertised ∩ config allowlist (`capabilityPatternMatches`,
     exact-depth `*`), absence is denial
   - mandatory initial `featureSets/update` as a **Request**; degradation receipts
     honored (`fallback: mcp-only | close`), never widened in response
   - dual-shape `featureSets` normalization (0.5 object / 0.4 array)
   - per-descriptor channel authorization with itemized results
   - grant + channel state reset at every transport epoch (reconnect w/ jittered backoff)
   - `mcpl/manifestChanged` → rate-limited re-fetch, content digest verified
     (mismatch logged, content authoritative), reduce-first re-grant
   - §16 tag closure applied host-side; tags are never authority
   - per-injection, per-position authorization of `context/beforeInference`
     results at response-receipt; inject-only servers get `userMessage: null`
4. **Hook endpoint** — plugin hooks relay `UserPromptSubmit` → `context/beforeInference`
   fan-out (returned as `additionalContext`), `Stop`/`SessionEnd` →
   `inference/lifecycle`. Relay finds the adapter's unix socket
   (`~/.claude/mcpl-bridge/sock-<claude-pid>.sock`) by walking its ancestor pids;
   fails open in <50ms when no adapter is running.

## Install

```bash
git clone https://github.com/anima-research/mcpl-cc-bridge
claude plugin marketplace add ./mcpl-cc-bridge
claude plugin install mcpl-bridge@mcpl-bridge-dev --scope user
# interactive sessions: dev channel plugins are not on the official channels
# allowlist, so enable the channel lane with the dev flag (one-time consent
# dialog per invocation):
claude --dangerously-load-development-channels plugin:mcpl-bridge@mcpl-bridge-dev
```

Tools and hooks work in every session once the plugin is installed; only the
channel push lane (wake on `push/event` / `channels/incoming`) needs the
`--dangerously-load-development-channels` flag while the plugin is unpublished.

Recommended permissions (project `.claude/settings.json`) so channel replies
and inference answers don't stall behind permission prompts:

```json
{ "permissions": { "allow": [
  "mcp__plugin_mcpl-bridge_mcpl__mcpl_send",
  "mcp__plugin_mcpl-bridge_mcpl__mcpl_open",
  "mcp__plugin_mcpl-bridge_mcpl__mcpl_close",
  "mcp__plugin_mcpl-bridge_mcpl__mcpl_answer",
  "mcp__plugin_mcpl-bridge_mcpl__mcpl_status"
] } }
```

An `inference/request` is held open 10 minutes for the model to call
`mcpl_answer`; a permission prompt in the way can eat that window — allowlist
the tool where server-purchased inference matters.

## Configure

Config resolution: `$MCPL_BRIDGE_CONFIG` → `<project>/.mcpl-bridge.json` →
`~/.claude/mcpl-bridge/config.json`.

```json
{
  "servers": {
    "tavern": {
      "transport": { "url": "mcpl://tavern.example:7431", "tokenEnv": "TAVERN_TOKEN" },
      "grant": [
        "tools", "pushEvents",
        "channels.register", "channels.incoming", "channels.publish",
        "contextHooks.beforeInference.observe",
        "contextHooks.beforeInference.inject.beforeUser",
        "inferenceLifecycle"
      ],
      "enableFeatureSets": ["*"],
      "inferenceRequest": "deny"
    },
    "heartbeat": {
      "transport": { "command": "node", "args": ["/path/to/heartbeat-mcpl/dist/index.js"] },
      "grant": ["tools", "pushEvents"]
    },
    "portal": {
      "transport": {
        "command": "node",
        "args": ["/abs/path/portal/portal-mcpl/dist/src/server-cli.js"],
        "env": {
          "PORTAL_URL": "wss://portal.example",
          "PORTAL_INVITE": "inv_…",
          "PORTAL_PERSONA_NAME": "claude-code",
          "PORTAL_CREDENTIALS": "/Users/you/.portal/claude-code.creds.json",
          "PORTAL_SUBSCRIPTIONS": "<discord-channel-id>,<discord-channel-id>"
        }
      },
      "inferenceRequest": "deny",
      "reconnect": true
    }
  }
}
```

The `portal` entry hosts [anima-research/portal](https://github.com/anima-research/portal)'s
MCPL server (`portal-mcpl`, a Discord bridge) with the default grant. Its
`portal.messaging` feature set `uses` `channels.lifecycle`, so it needs the
default grant (or an explicit one that includes `channels.lifecycle`) —
otherwise fail-closed derivation disables the whole messaging set and only the
read-only sets survive. Channels listed in `PORTAL_SUBSCRIPTIONS` are advertised
`initiallyOpen` and auto-opened; open others at runtime with `mcpl_open`.

Notes:
- `grant` is the security boundary. **Omitted = the default grant**: everything
  the bridge can honor except `inject.system`, `inject.afterUser`, and the
  unimplemented channel extras (lifecycle/streaming/typing) — i.e. `tools`,
  `pushEvents`, `modelInfo`, `inferenceRequest`, `inferenceLifecycle`,
  `channels.{register,incoming,publish,acknowledge,lifecycle}`,
  `contextHooks.beforeInference.observe` + `inject.beforeUser`.
  An **explicit `[]`** = plain MCP passthrough (tools only). `*` matches exactly
  one segment; `contextHooks.*` grants none of the depth-4 inject leaves — spell
  paths out. Note `observe` is in the default: every configured server sees the
  user's prompt text via beforeInference — deny it per-server for third-party
  servers you don't want reading prompts (but a feature set whose `uses` lists
  `observe` will then be disabled wholesale, per fail-closed derivation).
- `mcpl://` URLs are rewritten to `wss://` (RFC-004). Tokens are resolved from
  env per-dial, so rotation works across reconnects.
- `inferenceRequest: "channel"` (default when granted) holds the JSON-RPC
  request open, delivers it as a channel message, and resolves it when the
  model calls `mcpl_answer` — real §11 semantics minus no-HITL isolation.
  `"deny"` answers `-32002`.
- Reconnect defaults: on for websocket, off for stdio (a bounced ws server
  comes back on its own; a crashed child needs a restart).

## Double-spawn and state (primary/replica)

Claude Code can spawn the adapter **twice** in one session — once for the
plugin's `mcpServers` entry, once for the `--channels` registration. Two
independent instances would each dial the MCPL fleet: duplicate stdio children,
racy ws supersession, and split state (an `inference-request` pushed by one
instance would be unanswerable via `mcpl_answer` routed to the other).

So instances coordinate over the session socket
(`~/.claude/mcpl-bridge/sock-<session-id>.sock`):
- **Primary** = first to bind. Owns every MCPL connection, all channel pushes,
  hook handling, and all state (grants, channels, pending inference).
- **Replica** = any later instance. Dials nothing; forwards `tools/list` and
  `tools/call` to the primary over the socket. Its channel face stays silent
  (the primary's MCP connection carries the pushes).
- **Takeover**: if a forwarded call finds the primary dead, the replica binds
  the socket, dials the fleet, and serves the call itself. In-flight MCPL state
  held by the dead primary (pending inference, registered channels) is lost —
  same as any host restart; servers re-register on reconnect.

Net effect: exactly one MCPL host per CC session, whichever MCP connection CC
happens to route a call through.

## What does NOT map to CC (by design)

- Per-inference granularity: hooks fire per **turn**, so `beforeInference` and
  lifecycle see user turns, not inner agentic-loop calls.
- `channels/outgoing/chunk` token streaming of the agent's own output — no CC
  extension point sees the token stream.
- `state/*`, `branches/*`, `host/command` — answered `-32601`.

## Development

```bash
cd plugins/mcpl-bridge
bun install
bun run test/smoke.ts     # full-surface smoke test against test/toy-server.ts
```

`src/vendor/mcpl-core/` is vendored from
[anima-research/mcpl-core-ts](https://github.com/anima-research/mcpl-core-ts)
`src/` (MIT; the npm `@animalabs/mcpl-core@0.2.2` is a stale publish missing
the grant and manifest helpers). Re-sync after upstream changes:
`cp <mcpl-core-ts>/src/*.ts plugins/mcpl-bridge/src/vendor/mcpl-core/`
