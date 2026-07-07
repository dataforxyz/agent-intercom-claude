---
name: claude-intercom
description: |
  Coordinate with local Pi, Codex, or Claude coding-agent sessions through
  claude-intercom MCP tools. Use for same-machine planner-worker workflows,
  direct peer questions, cross-session context sharing, and checking or
  replying to pending asks.
---

# Claude Intercom

Use this skill when you need to coordinate with another local coding-agent
session through the `claude-intercom` MCP server. It speaks the same broker
protocol as `pi-intercom` and `codex-intercom`, so Pi, Codex, and Claude
sessions can all message each other.

A plain Claude Code MCP session does not receive unsolicited turns. Inbound
messages are queued by the MCP server while it is running. Check
`intercom_pending` at natural boundaries: before starting delegated work, and
when you expect a response.

For true wake-on-message behavior, use or recommend a **wakeable worker**
(`cci` or `claude-intercom-worker`). Messages to a worker start a fresh
headless `claude -p` turn that resumes the worker's own conversation, so the
worker can read files, run commands, and reply on its own.

## Tools

- `intercom_whoami`: show this session's intercom ID, name, cwd, and model.
- `intercom_status`: connection, active session count, unread messages, pending asks.
- `intercom_list`: list connected Pi, Codex, and Claude sessions.
- `intercom_set_summary`: publish a short discoverable status.
- `intercom_send`: fire-and-forget direct message.
- `intercom_ask`: send a question and wait for the target's reply (blocking, bounded).
- `intercom_pending`: read queued inbound messages and pending asks.
- `intercom_reply`: reply to a pending inbound ask.

## Workflow

1. Call `intercom_status` or `intercom_whoami` to confirm this session is connected.
2. Call `intercom_set_summary` with a concise status so peers can discover your role.
3. Call `intercom_list` to choose a target. Prefer exact names or full IDs when duplicates are possible.
4. Use `intercom_send` for non-blocking updates and handoffs.
5. Use `intercom_ask` only when you need the answer before continuing.
6. Call `intercom_pending` before ending a coordination turn, then answer blocking asks with `intercom_reply`.

## Patterns

Planner delegates to a wakeable worker without blocking:

```typescript
intercom_send({
  to: "worker",
  message: "Task-3: add retry logic in src/api/client.ts. Ask if the retry scope is unclear."
})
```

Ask a worker and wait for its answer (the worker's final message comes back as the reply):

```typescript
intercom_ask({
  to: "worker",
  message: "Inspect the failing test in test/auth.test.ts and reply with the most likely cause."
})
```

Reply to an inbound ask:

```typescript
intercom_pending({ mark_read: false })
intercom_reply({ message: "Use GET/PUT/DELETE only, max 3 retries." })
```

When multiple asks are pending, pass `to` or `reply_to`:

```typescript
intercom_reply({ reply_to: "message-id-from-intercom_pending", message: "Proceed." })
```

## Boundaries

- Do not assume push delivery into a plain MCP session. Check `intercom_pending`.
- A plain MCP session cannot wake itself from idle. Use a wakeable worker (`cci`) for wake-on-message.
- Do not use `intercom_ask` to poll files, ports, or process completion — use normal shell checks.
- Keep messages concise; include file paths, command-output summaries, and decision options when useful.
