#!/usr/bin/env bash
# Proves a MINIMAL cci worker (--minimal => --safe-mode woken turns) can still
# delegate to a built-in subagent via the Task tool, with real system access.
set -u
MODEL="${1:-sonnet}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJ="${TMPDIR:-/tmp}/cci-min-sa"
WORKER="e2e-min-sa"
CLAUDE_BIN="$(command -v claude)"
WLOG="$PROJ/worker.log"
HOST="$(hostname)"

echo "######## MINIMAL + SUBAGENT model=$MODEL host=$HOST ########"
rm -rf "$PROJ"; mkdir -p "$PROJ"
cd "$REPO"
CLAUDE_INTERCOM_CLAUDE_COMMAND="$CLAUDE_BIN" \
  node dist/cci.mjs --minimal --name "$WORKER" --id "$WORKER" --cwd "$PROJ" --model "$MODEL" \
  --state "$PROJ/state.json" \
  --instructions "Terse test worker." >"$WLOG" 2>&1 &
WP=$!
trap 'kill "$WP" 2>/dev/null' EXIT
for i in $(seq 1 40); do grep -q "running 1 agent" "$WLOG" 2>/dev/null && break; sleep 0.5; done
echo "--- worker startup ---"; cat "$WLOG"

PROBE_TARGET="$WORKER" PROBE_ASK="Use the Task tool to spawn a general-purpose subagent whose prompt is: run the shell command \`hostname\` and return only its output. Then reply with exactly: SUBAGENT_HOST=<that output>. If you truly have no Task/Agent tool, reply NO_TASK_TOOL." \
  timeout 260 npx --no-install tsx "$REPO/test/e2e/ask-once.ts"; RC=$?

echo "--- worker log (final) ---"; cat "$WLOG"
kill "$WP" 2>/dev/null; trap - EXIT
echo "MINIMAL_SUBAGENT: rc=$RC (expected the reply to contain SUBAGENT_HOST=$HOST)"
