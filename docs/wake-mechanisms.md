# Waking a Claude Code session

Delivering a message to a *running* coding-agent session unprompted is the hard
part of any intercom. Codex exposes a long-lived app-server that can start a
turn in an existing thread over a socket. Claude Code does not expose an
equivalent stable programmatic turn-start API, so `claude-intercom` uses the
most robust primitive that exists today and documents the alternatives.

## What `claude-intercom` uses: headless `claude -p` workers

The wakeable worker (`cci` / `claude-intercom-worker`) shells out to the Claude
Code CLI:

```
claude -p --output-format json --resume <session-id> \
  --permission-mode bypassPermissions ...   # message text on stdin
```

- **Genuine system access.** The woken turn is a full Claude Code turn: Bash,
  Read, Edit, Grep, everything, subject to the worker's permission mode.
- **Continuity.** `--output-format json` returns a stable `session_id`. The
  worker persists it and passes `--resume <session-id>` next time, so a worker
  is one long, resumable conversation. Attach with `claude --resume <id>`.
- **Intercom tools included.** Normal `cci` workers automatically pass the
  packaged MCP server to each headless turn, including proxy-backed profiles
  with an isolated `CLAUDE_CONFIG_DIR`. `ccim` deliberately omits MCP because
  Claude's `--safe-mode` disables it.
- **No experimental features.** Works on any Claude Code that supports `-p`.
- **Trade-off.** It wakes a *fresh background worker*, not a session you are
  personally sitting in. Headless turns can't answer interactive permission
  prompts, which is why the default posture is `--dangerously-skip-permissions`
  (opt out with `--safe`).

## Alternatives for waking a *live* session

These deliver into a session you are actively watching. `claude-intercom` does
not depend on them, but they are worth knowing.

### Claude Code's `Monitor` tool (community: `claude-code-inter-session`)

A live session runs a small socket/WebSocket client as a background process via
the `Monitor` tool. Each inbound message is one stdout line, which Claude Code
turns into a native monitor notification injected into the live session — no
polling, low latency, zero idle cost. This is the most effective community
approach for waking an already-running session, but it requires the human to
have started the monitored client in that session.

### Native Channels (experimental)

Claude Code has a research-preview `notifications/claude/channel` mechanism: an
MCP server declares the `experimental["claude/channel"]` capability and can push
notifications over stdio that surface as a `<channel>` block in the live
session. It is the "correct" native primitive, but as of this writing delivery
is best-effort and has known drop bugs, especially for idle sessions and in
`stream-json` mode. Treat it as fire-and-forget if you build on it.

### `PreToolUse` hook polling (community: Pigeon)

A `PreToolUse` hook checks a signal file for unread mail on each tool call.
Zero-cost when empty and simple, but it can only piggyback on the recipient's
*next* tool call — it cannot wake a truly idle session.

## Summary

| Mechanism                     | Wakes idle? | System access | Needs live session | Experimental | Shipped as |
|-------------------------------|-------------|---------------|--------------------|--------------|------------|
| Headless `claude -p` worker   | n/a (spawns fresh worker) | full | no | no | `cci` (default) |
| `Monitor` inbox (plugin)      | yes (if running) | full (live session) | yes | no | **`cci --tui`** |
| Native Channels               | sometimes   | full (live session) | yes | yes | — |
| `PreToolUse` hook polling      | no          | full (live session) | yes | no | — |

`claude-intercom` ships the first two rows: `cci` (headless worker) and `cci
--tui` (live interactive session woken in place via a local plugin monitor).

### How `cci --tui` uses the Monitor mechanism

`cci --tui` launches `claude --plugin-dir <repo>` with an intercom identity and
`CLAUDE_INTERCOM_INBOX=<path>` in the environment. The bundled plugin's MCP
server owns the broker identity and appends each inbound message to that inbox
file; the plugin's auto-armed monitor (`monitors/monitors.json`, `when:
"always"`) runs `dist/inbox-monitor.mjs`, which tails the inbox and prints one
line per new message. Claude Code's Monitor machinery injects each line into the
live session, which then answers with `intercom_reply`. This is purely local —
no Anthropic channel relay — so it works behind a custom `ANTHROPIC_BASE_URL`.

Channels (`notifications/claude/channel`) would be a cleaner two-way path, but it
routes through Anthropic's notification infrastructure and may be gated behind a
custom base URL, so it is left as a possible future add-on.
