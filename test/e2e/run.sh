#!/usr/bin/env bash
# Self-contained E2E for a single model.
#   usage: run.sh <model> <slug>
# Exercises: (1) a claude -p "manager" waking a cci worker via intercom_ask to
# read a file + run a shell command (real system access), and (2) two-turn
# session continuity. Uses a unique worker id + isolated project dir per run so
# multiple models can run in parallel against the shared broker. Cleans up its
# own worker by PID (never pkill).
set -u
MODEL="${1:?usage: run.sh <model> <slug>}"
SLUG="${2:?usage: run.sh <model> <slug>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJ="${TMPDIR:-/tmp}/cci-e2e-$SLUG"
WORKER="e2e-$SLUG"
MGR_ID="mgr-$SLUG"
CLAUDE_BIN="$(command -v claude)"
WLOG="$PROJ/worker.log"; MGR="$PROJ/manager.json"; MGRERR="$PROJ/manager.err"

echo "######## E2E model=$MODEL slug=$SLUG ########"
rm -rf "$PROJ"; mkdir -p "$PROJ"
printf 'The magic passphrase is: BLUE-HERON-42\n' > "$PROJ/secret.txt"
printf '# scratch e2e project\n' > "$PROJ/README.md"

cd "$REPO"
CLAUDE_INTERCOM_CLAUDE_COMMAND="$CLAUDE_BIN" \
  node dist/cci.mjs --name "$WORKER" --id "$WORKER" --cwd "$PROJ" --model "$MODEL" \
  --state "$PROJ/state.json" \
  --instructions "You are a terse test worker. Do exactly what is asked and report the result plainly." \
  >"$WLOG" 2>&1 &
WP=$!
trap 'kill "$WP" 2>/dev/null' EXIT

for i in $(seq 1 40); do grep -q "running 1 agent" "$WLOG" 2>/dev/null && break; sleep 0.5; done
echo "--- worker startup ---"; cat "$WLOG"

echo "== [1/3] manager ($MODEL) asks worker to read a file + run a command =="
MCP_JSON="{\"mcpServers\":{\"claude-intercom\":{\"command\":\"node\",\"args\":[\"$REPO/dist/claude-server.mjs\"],\"env\":{\"CLAUDE_INTERCOM_NAME\":\"$MGR_ID\",\"CLAUDE_INTERCOM_SESSION_ID\":\"$MGR_ID\"}}}}"
cd "$PROJ"
# Manager blocks inside intercom_ask waiting for the worker's full turn, so give
# the ask a bounded timeout_ms (120s) and the manager process generous headroom
# (300s) so a slow worker turn yields a JSON error rather than a silent SIGTERM.
timeout 300 "$CLAUDE_BIN" -p \
  "Use the intercom_ask tool to ask the session named '$WORKER' this exact task: 'Read secret.txt and run \`uname -s\`. Reply with the passphrase from the file and the kernel name.' Pass timeout_ms 120000. Then report verbatim what the worker replied." \
  --output-format json --model "$MODEL" \
  --mcp-config "$MCP_JSON" --strict-mcp-config \
  --allowedTools "mcp__claude-intercom__intercom_ask,mcp__claude-intercom__intercom_list" \
  --permission-mode bypassPermissions >"$MGR" 2>"$MGRERR"
MGR_RC=$?
echo "manager exit=$MGR_RC  manager.json bytes=$(wc -c <"$MGR" 2>/dev/null)"
MGR_TEXT="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).result||"")}catch(e){console.log("")}' "$MGR")"
echo "manager result text: $MGR_TEXT"
echo "manager stderr (tail): $(tail -3 "$MGRERR" 2>/dev/null)"

echo "== [2/3] session continuity (two sequential asks) =="
cd "$REPO"
PROBE_TARGET="$WORKER" PROBE_CODEWORD="PURPLE-OTTER-$SLUG" \
  timeout 300 npx --no-install tsx test/e2e/probe.ts; PROBE_RC=$?

echo "== [3/3] verdict =="
echo "--- worker log (final) ---"; cat "$WLOG"
ACCESS_OK=0
echo "$MGR_TEXT" | grep -q "BLUE-HERON-42" && echo "$MGR_TEXT" | grep -qi "Linux" && ACCESS_OK=1
kill "$WP" 2>/dev/null; trap - EXIT

echo "RESULTS[$MODEL]: system_access=$([ $ACCESS_OK = 1 ] && echo PASS || echo FAIL) continuity=$([ $PROBE_RC = 0 ] && echo PASS || echo FAIL)"
[ $ACCESS_OK = 1 ] && [ $PROBE_RC = 0 ] && { echo "OVERALL[$MODEL]: PASS"; exit 0; } || { echo "OVERALL[$MODEL]: FAIL"; exit 1; }
