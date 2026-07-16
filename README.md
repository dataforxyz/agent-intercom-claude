# Claude Intercom

**Agent Intercom** is a cross-harness, same-machine messaging system for coding agents. Its Pi, Codex, Claude Code, and OpenCode adapters share one local broker and protocol, so sessions can discover and message each other regardless of which harness they run in.

| Harness | Repository |
|---|---|
| Pi | [`agent-intercom-pi`](https://github.com/dataforxyz/agent-intercom-pi) |
| Codex | [`agent-intercom-codex`](https://github.com/dataforxyz/agent-intercom-codex) |
| Claude Code | [`agent-intercom-claude`](https://github.com/dataforxyz/agent-intercom-claude) |
| OpenCode | [`agent-intercom-opencode`](https://github.com/dataforxyz/agent-intercom-opencode) |
| Fleet lifecycle | [`agent-intercom-orchestrator`](https://github.com/dataforxyz/agent-intercom-orchestrator) |

## Origin and thanks

Agent Intercom grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom). A sincere thank you to Nico and the original contributors for creating the Pi extension and the foundation this cross-harness family builds on.

This repository contains the Claude Code adapter. Version 0.2 uses the shared strict `pi-intercom` protocol v3. Any adapter may start the broker first; incompatible legacy brokers are detected and replaced. Sends are retained in a durable per-session outbox and replayed after reconnect, while receiver acknowledgement distinguishes broker acceptance from durable receipt.

When running `cci` or `ccim` in an attached terminal, press **Alt+M** to choose a connected session and send it a message, or **Alt+I** to copy that worker's intercom contact target. The MCP plugin cannot register native Claude Code keyboard shortcuts because Claude Code does not expose plugin keybinding registration; the plugin instead provides `/claude-intercom:intercom` and `/claude-intercom:intercom-id`. Detached worker-daemon mode has no terminal shortcuts.

Claude Intercom adds local messaging between Claude Code, Codex, Pi, OpenCode,
and other coding-agent sessions on the same machine. It speaks the same local broker
protocol as [`pi-intercom`](https://github.com/dataforxyz/agent-intercom-pi) and
[`codex-intercom`](https://github.com/dataforxyz/agent-intercom-codex), so sessions
can discover each other, send updates, ask blocking questions, read pending
messages, and reply to asks across all four supported harnesses.

The project has two related pieces:

- `claude-intercom-mcp`: an MCP server that exposes intercom tools inside a
  normal Claude Code session.
- `cci` / `claude-intercom-worker`: a **wakeable Claude worker**. It registers
  an intercom identity, and when another session sends it work, it starts a
  fresh headless `claude -p` turn that resumes the worker's own conversation —
  so the worker can read files, run commands, edit code, and reply on its own.

Use plain MCP when you only need tools inside an already-active Claude turn. Use
a wakeable worker when you want another session to wake Claude automatically and
have it act with real system access.

## Status

Preview. This is the Claude-side adapter, built alongside `pi-intercom` and
`codex-intercom`.

A plain Claude Code MCP session does not receive unsolicited visible turns.
Incoming messages are queued while the MCP server is running; call
`intercom_pending` to read them. Wake-on-message workflows use `cci` /
`claude-intercom-worker`.

## How Claude gets woken

Claude Code has no long-lived programmatic "app-server" the way Codex does, so
the worker uses the most robust primitive available: the headless CLI.

1. The worker registers an intercom identity on the local broker and idles.
2. When a message arrives, the worker runs
   `claude -p --output-format json --resume <session-id> ...`, feeding the
   message text on stdin. Normal `cci` workers automatically receive the
   packaged Intercom MCP server, even under an isolated `CLAUDE_CONFIG_DIR` or
   custom `ANTHROPIC_BASE_URL`.
3. Claude runs a full turn — it can use Bash, Read, Edit, and every other
   Claude Code tool, subject to the worker's permission mode — and prints a
   final result plus a stable `session_id`.
4. The worker persists that `session_id` so the next message resumes the same
   conversation, and (for blocking asks) sends the final assistant message back
   to the asker as the reply.

This gives a woken worker genuine access to the system while keeping each worker
a continuous, resumable conversation. You can attach to a worker's conversation
at any time with `claude --resume <session-id>`.

> Alternative for **live** sessions: community tools such as
> `claude-code-inter-session` deliver messages into an already-running session
> using Claude Code's `Monitor` tool, and Claude Code's experimental Channels
> feature can push notifications over MCP stdio. Those wake a session you are
> actively watching; the headless worker here wakes an autonomous background
> worker with full tool access and needs no experimental features. See
> [docs/wake-mechanisms.md](docs/wake-mechanisms.md).

## Install

Install the package so the command-line entry points are on `PATH`:

```bash
npm install -g @dataforxyz/agent-intercom-claude
```

This provides:

- `claude-intercom-mcp`
- `claude-intercom-worker`
- `cci` — start a normal wakeable worker
- `ccim` — start a minimal wakeable worker (`cci --minimal`)

To let a Pi manager create Claude workers with owned systemd cgroups, leases, model/effort selection, logs, and verified cleanup, install the companion Pi packages:

```bash
pi install npm:@dataforxyz/agent-intercom-pi
pi install npm:@dataforxyz/agent-intercom-orchestrator
```

Restart Pi or run `/reload`, then call `agent_fleet({ action: "doctor" })`. The orchestrator invokes the installed `cci`/`ccim` commands; it does not replace this Claude adapter.

`cci` and `ccim` are the recommended entry points when you want an attached,
wakeable Claude session. Unlike a plain MCP session or a detached headless
worker, the attached wrappers provide the **Alt+M** session picker/message
composer and the **Alt+I** contact-copy shortcut; they also keep an intercom
identity online so another agent can wake the worker.
If you use the same worker profiles repeatedly, add memorable shell aliases
with your own portable project paths and stable IDs:

```bash
alias claude-reviewer='cci --cwd "$HOME/src/my-project" --name reviewer --id reviewer'
alias claude-reviewer-min='ccim --cwd "$HOME/src/my-project" --name reviewer-min --id reviewer-min'
```

Put aliases in your shell startup file (for example `~/.bashrc` or `~/.zshrc`).
They are optional convenience shortcuts: the installed `cci` and `ccim`
commands work directly, but aliases make stable identities and project-specific
defaults easier to reuse without copying a long command.

For a plain, already-active Claude Code session, add the MCP server explicitly:

```bash
claude mcp add claude-intercom -- claude-intercom-mcp
```

`cci` does this automatically for each normal headless worker. `ccim` intentionally
uses Claude's `--safe-mode`, which disables MCP servers along with plugins, hooks,
and skills.

Optional identity variables can be attached at registration time:

```bash
claude mcp add claude-planner \
  --env CLAUDE_INTERCOM_NAME=planner \
  --env CLAUDE_INTERCOM_SESSION_ID=claude-planner \
  --env CLAUDE_INTERCOM_MODEL=opus \
  -- claude-intercom-mcp
```

## Plugin Use

The repo also ships Claude Code plugin metadata:

- `.claude-plugin/plugin.json`
- `.mcp.json`
- `skills/claude-intercom/SKILL.md`
- `commands/intercom.md` and `commands/intercom-id.md`

The plugin packages the MCP server and the bundled `claude-intercom` skill (which
gives Claude copy-paste coordination patterns). It also installs these Claude
Code slash commands:

- `/claude-intercom:intercom [target and message]` — list sessions and send a
  message. Without arguments, Claude asks which peer to contact and what to send.
- `/claude-intercom:intercom-id` — print this session's stable, copyable
  intercom target.

Claude custom commands are model-driven prompt commands, not native modal UI.
Claude namespaces plugin commands by plugin name, so an installed plugin cannot
claim the unqualified `/intercom` command globally.
They call the same MCP tools and work in a normal Claude Code session, but only
the attached `cci`/`ccim` wrappers can own the terminal and provide an immediate
Alt+M picker. Load the plugin for a single session with `--plugin-dir`:

```bash
claude --plugin-dir /path/to/agent-intercom-claude      # this session only
```

For the minimal tool surface, prefer plain MCP registration
(`claude mcp add claude-intercom -- claude-intercom-mcp`) so you get the intercom
tools without the skill.

## Tools

- `intercom_whoami`: show this session's intercom ID, name, cwd, and model.
- `intercom_team`: show the current manager and live coworkers owned by that manager.
- `intercom_status`: show connection status and pending message counts.
- `intercom_list`: list local Pi, Codex, and Claude sessions globally.
- `intercom_set_summary`: publish a short discoverable status.
- `intercom_send`: send a non-blocking message.
- `intercom_ask`: send a question and wait for the target's reply.
- `intercom_pending`: read queued inbound messages and unresolved asks.
- `intercom_reply`: reply to a pending inbound ask.

Example:

```typescript
intercom_team({})
// Manager: manager-id [connected]
// You: worker-a
// Coworkers: reviewer target=reviewer (codex, reviewer, running) [connected]

intercom_ask({
  to: "worker-a",
  message: "Please inspect the failing test and reply with the likely cause.",
  timeout_ms: 45000
})
```

Blocking asks default to a short bounded wait and reject waits over 120 seconds.
For longer work, use `intercom_send` and check later with `intercom_pending`.

## Wakeable Workers With `cci`

`cci` (Claude Code Intercom) starts a single wakeable worker in the foreground.
It registers the worker on the broker. For every inbound message, the attached
terminal visibly prints the sender and message, a working indicator, and the
final Claude result or error. Blocking asks still receive that final result as
their automatic intercom reply. Press **Alt+M** for a numbered list of connected
peers, then choose one and enter a message. Press **Alt+I** to copy the worker's
contact target.

This is an attached worker console, not Claude Code's interactive TUI: woken
turns run through `claude -p`, and their final output is mirrored into the
console. To continue or inspect the full Claude conversation, run `claude
--resume <session-id>` using the session ID printed with the completed turn.
`ccim` has the same visible wake behavior and shortcuts.

Start a named worker:

```bash
cci --name worker-a --id worker-a
```

Flags (all optional; `ccim` accepts the same set):

| Flag | Meaning |
|------|---------|
| `--name <name>` | Discoverable session name other sessions target |
| `--id <id>` | Stable intercom session id (defaults to a git-derived id) |
| `--cwd <dir>` | Working directory for the worker's turns (default: cwd) |
| `--model <model>` | Model for woken turns (`opus`, `sonnet`, `haiku`, or a full id) |
| `--effort <level>` | Claude effort for every woken turn (`low`, `medium`, `high`, `xhigh`, or `max`) |
| `--instructions <text>` | System-prompt guidance appended to every woken turn |
| `--tui` / `--live` | Run as a LIVE interactive Claude session woken in place (see below) instead of a headless `claude -p` worker |
| `--minimal` / `--bare` | Run woken turns with `--safe-mode` (see below); implied by `ccim` (ignored with `--tui`) |
| `--safe` | Use standard permission prompts instead of the yolo default |
| `--permission-mode <mode>` | Explicit permission mode (`acceptEdits`, `plan`, …) |
| `--add-dir <dir>` | Extra directory the worker may access (repeatable) |
| `--mcp-config <json\|file>` | Extra MCP servers for woken turns (e.g. to give the worker intercom tools) |
| `--state <path>` | Where to persist the worker's session id (default under `~/.pi/agent/intercom/`) |
| `--claude <cmd>` | Claude Code executable to invoke (default `claude`) |

```bash
cci --cwd /path/to/project --instructions "Reply tersely. Ask before destructive changes."
cci --model opus --effort max --name reviewer --id reviewer
cci --safe --name safe-worker --id safe-worker      # standard permission prompts instead of yolo
cci --add-dir ../shared-lib --name worker-a --id worker-a
```

By default `cci` runs the woken turns with
`--dangerously-skip-permissions` so the worker can actually act on the system in
headless mode (headless turns cannot answer interactive permission prompts). Use
`--safe` to switch to the standard permission mode, or `--permission-mode
<mode>` to choose one explicitly. Only run yolo workers on a machine account you
trust.

## Live TUI Mode (`cci --tui`)

Default `cci` is a headless worker: each message spawns a `claude -p` turn. With
`--tui`, `cci` instead opens a **live interactive Claude session that you sit in
and that is woken in place** — the Codex `coi` experience. Inbound intercom
messages are injected into the running session and it replies over the broker;
you see everything and can type alongside it.

```bash
cci --tui --name worker-a --id worker-a
```

Claude Code has no Codex-style app-server, so this uses Claude Code's local
**Monitor** mechanism (no Anthropic channel relay — works behind a custom
`ANTHROPIC_BASE_URL`/proxy). Under the hood `cci --tui` launches `claude
--plugin-dir <this repo>` with an intercom identity in the environment; the
bundled plugin supplies:

- the intercom **MCP server** (registers this session's identity + sends replies),
- a durable **inbox** the server appends inbound messages to, and
- an auto-armed **monitor** (`monitors/monitors.json`) that tails the inbox and
  injects each new message into the live session.

When someone `intercom_ask`s the session, the woken turn answers with the
`intercom_reply` tool (an appended system prompt explains this). `--minimal` is
ignored here because `--safe-mode` would disable the very MCP server and monitor
this mode relies on.

Requirements/caveats: needs a built checkout (`npm run build`); requires an
interactive terminal (Monitor is interactive-only); and Monitor must be enabled
in your Claude Code (it is unavailable when `DISABLE_TELEMETRY` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, or on Bedrock/Vertex/Foundry).
See [docs/wake-mechanisms.md](docs/wake-mechanisms.md).

## Normal And Minimal Workers

Like Codex's `coi` (normal) and `coim` (minimal), `cci` has a minimal mode. Codex
needs a dedicated `CODEX_HOME` and a hand-written `config.toml` to strip
memories, plugins, skills, and browser surfaces (while keeping `multi_agent`).
Claude Code has this built in: `cci --minimal` runs every woken turn with Claude
Code's `--safe-mode`, which disables CLAUDE.md, skills, plugins, hooks, and MCP
servers while keeping auth, built-in tools (Bash/Read/Edit/…), and permissions
working normally. It is the focused-worker profile: less prompt and tool surface,
same coding ability.

**Subagents are retained in minimal mode.** `--safe-mode` only disables *custom*
agent-type definitions (`.claude/agents/`), not the built-in `Task` tool — so a
minimal worker can still delegate to general-purpose subagents, matching Codex
minimal's `multi_agent = true`. This is verified end-to-end
(`test/e2e/minimal-subagent.sh`): a minimal worker spawns a subagent that runs a
shell command and reports back.

`cci` and `ccim` are installed as a matched pair (like Codex's `coi` and `coim`):
`ccim` is exactly `cci --minimal` — same flags, same identity handling, minimal
by default. You do not need an alias to enable minimal mode; aliases are useful
only for reusable names, IDs, paths, or permission settings.

```bash
cci  --name reviewer --id reviewer                 # normal: full config, CLAUDE.md, skills, MCP
ccim --name lean-worker --id lean-worker           # minimal: --safe-mode woken turns
ccim --safe --name lean-safe --id lean-safe        # minimal + standard permission prompts
cci --minimal --name worker-a --id worker-a        # equivalent to `ccim ...`
```

Because minimal mode disables MCP in the woken turn, a minimal worker cannot use
the intercom tools to message other sessions itself — it still receives work and
replies normally (the worker daemon captures its final message and sends the
reply). Use a normal worker when you want the woken turn to reach out to peers on
its own.

## Manager And Worker Pattern

Use one Claude Code session as the manager and one or more `cci` workers.

Launch a worker in `tmux`:

```bash
tmux new-session -d -s worker-a 'cd /path/to/project && cci --name worker-a --id worker-a'
```

Then, from the manager session, delegate through the intercom tools:

```typescript
intercom_ask({
  to: "worker-a",
  message: "Create a plan for adding retries to src/api/client.ts, then report your first step.",
  timeout_ms: 60000
})
```

For non-blocking delegation, use `intercom_send` and check back with
`intercom_pending`. For a decision you need before continuing, use
`intercom_ask`.

## Worker Daemon (multiple workers)

Use `claude-intercom-worker` when you want one process to publish several
configured workers without a launcher per worker.

Create a config:

```json
{
  "statePath": "/path/to/intercom/claude-worker-state.json",
  "claudeCommand": "claude",
  "agents": [
    {
      "id": "claude-worker",
      "name": "claude-worker",
      "cwd": "/path/to/project",
      "model": "sonnet",
      "instructions": "Reply concisely. Ask before making destructive changes.",
      "permissionMode": "bypassPermissions"
    }
  ]
}
```

Start it:

```bash
claude-intercom-worker --config "$HOME/.pi/agent/intercom/claude-worker.json"
```

Each worker's `session_id` is persisted in `statePath`, so later messages resume
the same Claude conversation. The daemon reads a single worker's config from the
environment when no config file is given (`CLAUDE_INTERCOM_WORKER_ID`, `…_NAME`,
`…_CWD`, `…_MODEL`, `…_INSTRUCTIONS`, `…_STATE`).

## Environment Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `CLAUDE_INTERCOM_NAME` | MCP server | Discoverable session name |
| `CLAUDE_INTERCOM_SESSION_ID` | MCP server | Stable intercom id |
| `CLAUDE_INTERCOM_MODEL` | MCP server | Model label shown to peers |
| `CLAUDE_INTERCOM_EFFORT` | `cci` / `ccim` | Effort level forwarded to every Claude turn |
| `CLAUDE_INTERCOM_CWD` / `_INSTRUCTIONS` | `cci` / `ccim` | Defaults for `--cwd` / `--instructions` |
| `CLAUDE_INTERCOM_CLAUDE_COMMAND` | workers | Claude Code executable (default `claude`) |
| `CLAUDE_INTERCOM_WORKER_ID` / `_NAME` / `_CWD` / `_MODEL` / `_INSTRUCTIONS` / `_STATE` | `claude-intercom-worker` | Single-worker config when no `--config` file is given |
| `CLAUDE_INTERCOM_WORKER_CONFIG` | `claude-intercom-worker` | Path to the worker config JSON |
| `PI_INTERCOM_ASK_TIMEOUT_MS` | all | Default blocking-ask timeout (≤ 120000) |
| `PI_CODING_AGENT_DIR` | all | Overrides the `~/.pi/agent` base dir (broker socket + config live under it) |

The `PI_*` names are shared with the Pi, Codex, and OpenCode adapters on purpose —
all four read the same broker location and ask-timeout so they interoperate.

## Development

```bash
git clone https://github.com/dataforxyz/agent-intercom-claude.git
cd agent-intercom-claude
npm install
npm run build
npm test
```

For MCP development, register the TypeScript source directly:

```bash
claude mcp add claude-intercom-dev -- npx --no-install tsx ./claude/server.ts
```

## Agent Intercom Compatibility

`agent-intercom-pi` is the Pi-native adapter with overlays and inline rendering.
`agent-intercom-codex` is the Codex MCP/plugin adapter plus wake-on-message Codex
app-server sidecars. This repository, `agent-intercom-claude`, is the Claude Code
MCP/plugin adapter plus wake-on-message headless `claude -p` workers.
`agent-intercom-opencode` provides the native OpenCode plugin.

All four vendor the compatible local broker/client protocol and share one broker
socket, so a single session list spans Pi, Codex, Claude Code, and OpenCode.

## Releasing

Releases are automated from version tags. Update `package.json`, the lockfile when
present, and `CHANGELOG.md` on `main`, then push an annotated tag that exactly
matches the package version:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The release workflow verifies that the tag points into `main`, runs typecheck,
tests, and the build, publishes the public npm package with trusted OIDC
provenance, and creates the GitHub Release. Existing npm versions and GitHub
Releases are skipped safely when a workflow is rerun.

## License

The current project is licensed under the [GNU Affero General Public License
v3.0 or later](LICENSE) (`AGPL-3.0-or-later`). If you modify this software and
make the modified version available to users over a network, the AGPL requires
you to offer those users the corresponding source code.

Portions derived from the original MIT-licensed `pi-intercom` project retain
their original notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[licenses/MIT-pi-intercom.txt](licenses/MIT-pi-intercom.txt). Versions already
published under MIT remain available under their original terms. See
[LICENSE_TRANSITION.md](LICENSE_TRANSITION.md) for the exact commit and tag boundary.
