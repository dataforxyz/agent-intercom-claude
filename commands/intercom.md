---
description: List intercom peers and send a message to another coding-agent session
argument-hint: [target and message]
---

Use the claude-intercom MCP tools to help the user send a message.

First call `intercom_list` with `include_self: false`. If `$ARGUMENTS` clearly contains both a target and a message, resolve the target from that list and call `intercom_send`. Otherwise, show the connected sessions and ask the user which session to contact and what to send. Never guess a target or message. Use non-blocking `intercom_send` unless the user explicitly asks to wait for an answer, in which case use `intercom_ask`.
