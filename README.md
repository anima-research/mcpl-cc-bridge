# mcpl-cc-bridge

A Claude Code plugin that hosts **MCPL servers** from inside a CC session. One
adapter process is simultaneously:

1. **MCP server** — proxies MCPL `tools/list`/`tools/call` as `<server>__<tool>`,
   forwards `tools/list_changed`, and adds bridge tools:
   - `mcpl_status` — connections, grants, feature sets, registered channel
     count, open channels (by label), held count, pending inference
   - `mcpl_channels` — registered channels as `label — id`, filterable
   - `mcpl_send` — `channels/publish` into a registered channel
   - `mcpl_open` / `mcpl_close` — `channels/open` / `channels/close` on a
     registered channel (subscribe to / leave its ordinary traffic)

   Everywhere a channel is named (`channel_id`), the channel's registered
   **label** is accepted as well as its id — display form == address form.
   `mcpl_channels` and the `channel="…"` attribute on delivered messages print
   exactly the string to pass back. Matching is exact after trimming, a leading
   `#` optional, case-insensitive, and a label's trailing ` (qualifier)` may be
   dropped when the rest is unique; there is no fuzzy matching, and an ambiguous
   reference is an error quoting each match's label and id.
   - `mcpl_answer` — resolve a held `inference/request`
2. **Channel provider** (`claude/channel`) — `push/event`, `channels/incoming`,
   and `inference/request` arrive as `<channel source="mcpl" ...>` messages that
   start a turn (wake authority included), subject to the per-server
   [wake policy](#wake-policy).
3. **MCPL host proper** — the policy plane lives here, per SPEC 0.5:
   - effective grant = advertised ∩ config allowlist (`capabilityPatternMatches`,
     exact-depth `*`), absence is denial
   - mandatory initial `featureSets/update` as a **Request**; degradation receipts
     honored (`fallback: mcp-only | close`), never widened in response
   - dual-shape `featureSets` normalization (0.5 object / 0.4 array)
   - per-descriptor channel authorization with itemized results; host-owned
     desired-open state reconciled through `channels/open` at every registration
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
    }
  }
}
```

Notes:
- `grant` is the security boundary. **Omitted = the default grant**: everything
  the bridge can honor except `inject.system`, `inject.afterUser`, and the
  unimplemented channel extras (streaming/typing) — i.e. `tools`,
  `pushEvents`, `modelInfo`, `inferenceRequest`, `inferenceLifecycle`,
  `channels.{register,lifecycle,incoming,publish,acknowledge}`,
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
- `wake` — when a delivery starts a turn; see [Wake policy](#wake-policy).
  Default `"all"`.
- `openOnAddressed` — open a closed channel when addressed there (default
  `true`); see [Opening channels](#opening-channels).
- `openChannelsOnly` — drop pushes from channels not in the open set (default
  `false`); see [Opening channels](#opening-channels).
- `openChannels` — registered channel ids to hold open across restarts; see
  [Opening channels](#opening-channels).

## Wake policy

Every `push/event` and every `channels/incoming` on a known channel is admitted
by the grant first; the wake policy then decides only *when* the session sees
it: now, as its own turn, or held and folded into the next turn as context.
It routes on the §16 `chat:*` tags after the host's closure (`chat:mention` ⇒
`chat:addressed`, and so on). Tags are never authority; they only order time.

```json
"wake": "chat"
```

- `"all"` (default) — every delivery wakes. Right for a heartbeat, a queue, a
  server whose events are all for you.
- `"chat"` — the loop-break preset for chat-shaped servers:
  `chat:dm` wakes; `chat:from-bot` + `chat:reply`, `chat:from-bot` +
  `chat:mention`, and `chat:ambient` are held; everything else wakes. Two
  agents on the same channel can't ping-pong each other awake, and an open
  channel's ordinary traffic accrues instead of starting a turn per message.
  A mention or reply carrying no `chat:from-*` tag still wakes — a producer
  that doesn't say who spoke is outside the rule's reach.
- an object — your own rules, each an AND-set of tags, `wake` checked before
  `hold`, default wake:

  ```json
  "wake": { "wake": [["chat:dm"], ["chat:mention"]], "hold": [["chat:ambient"]], "holdCap": 100 }
  ```

Held deliveries are late, not lost. They ride in at the top of the next wake
for that server as a `<held server="…" count="N">` block, one line each with
timestamp, message id, channel, author and (trimmed) text, and the same block
reaches the next user turn through the `UserPromptSubmit` hook. `mcpl_status`
shows `held=N` while anything is waiting. `holdCap` (default 50) bounds the
buffer per server; past it the oldest are dropped and the block says
`evicted="K"` so the loss is visible. `inference/request` is never held — a
server is blocked on the answer — and held items don't fold into one, since it
asks for a completion rather than opening a conversation.

## Opening channels

A registered channel delivers only what addresses the agent (mentions, replies,
DMs) until the host opens it; `channels/open` is what subscribes the session to
its ordinary traffic, delivered as `channels/incoming`. Desired-open state is
the host's (SPEC §14): the bridge keeps a per-server set seeded from
`openChannels` in config, adjusted by `mcpl_open` / `mcpl_close` for the
session, and reconciled against every `channels/register` — so a reconnect
re-opens what you had open. A server's `initiallyOpen` hint on a descriptor is
honored only when the config carries no `openChannels` at all.

Being addressed in a closed channel opens it (`openOnAddressed`, default on):
a `push/event` tagged `chat:addressed` from a registered, closed channel
triggers `channels/open`, so the conversation *between* mentions reaches the
session instead of only the mentions. Pair it with `"wake": "chat"` and that
ambient traffic is held for the next wake rather than waking per message. The
open lasts the session (it joins the desired-open set); set `"openOnAddressed":
false` to keep the closed-until-opened behaviour.

The strict form is `"openChannelsOnly": true`: the open set (`openChannels`
plus anything opened with `mcpl_open` this session) becomes a whitelist, and a
`push/event` or `channels/incoming` from any other registered channel is
dropped — not delivered, not held, not opened, and the server sees
`accepted: false`. Being addressed outside the whitelist then never wakes the
session. Off by default.

```json
"grant": ["tools", "pushEvents", "channels.register", "channels.lifecycle", "channels.incoming", "channels.publish"],
"openChannels": ["discord:1526641224692400339:1526641225124544753"]
```

`channels.lifecycle` must be in the grant and advertised by the server; when
either is missing, `mcpl_open` says so and the reconcile logs it rather than
failing the connection. `mcpl_open` takes an optional `history_limit` and
returns what the server hands back with the open, oldest first.

`push/event` carries an opaque `origin`; chat-shaped producers put the routing
facts there. The bridge passes the common ones through as message meta
(`channel_id` — the MCPL id when the producer supplies one, with the raw id as
`native_channel_id` — `channel` (the registered label, when the id is known),
`message_id`, `author`, `author_id`, `thread_id`, `channel_name`, `guild`), so
a wake is addressable without a history call.

## Reloading config

The bridge reads its config once at start, then reconciles on demand — no
session restart to add a server:

- `mcpl_reload` tool (from a replica it is forwarded to the primary),
- `SIGHUP` to the primary adapter process,
- or just save the file: the primary watches the config's directory and
  reloads ~300 ms after a change (`MCPL_BRIDGE_WATCH=0` disables).

Reconcile is per server and in place: added servers connect, removed servers
close, servers whose entry changed in any way (key order aside) are closed and
re-dialed; everything else keeps its connection, open channels, pending
inference and held deliveries. Claude Code is told `tools/list_changed` when
the proxied tool set moves. A file that fails to parse or validate is rejected
whole and the running config stays — `mcpl_reload` returns the reason, and
`mcpl_status` shows which file is live and whether it is watched. Held
deliveries of a removed or changed server are dropped and counted in the
reload summary.

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
bun run test/smoke.ts     # full-surface smoke test against test/toy-server.ts (wake policy, open/close included)
```

`src/vendor/mcpl-core/` is vendored from
[anima-research/mcpl-core-ts](https://github.com/anima-research/mcpl-core-ts)
`src/` (MIT; the npm `@animalabs/mcpl-core@0.2.2` is a stale publish missing
the grant and manifest helpers). Re-sync after upstream changes:
`cp <mcpl-core-ts>/src/*.ts plugins/mcpl-bridge/src/vendor/mcpl-core/`
