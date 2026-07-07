import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { ClaudeIntercomRuntime } from "./runtime.ts";
import { handleMcpRequest } from "./mcp-protocol.ts";

const runtime = new ClaudeIntercomRuntime();

const rl = readline.createInterface({
  input: stdin,
  crlfDelay: Infinity,
});

let shuttingDown = false;
let pendingRequests = 0;

function writeResponse(response: Record<string, unknown> | undefined): void {
  if (!response) return;
  stdout.write(`${JSON.stringify(response)}\n`);
}

function maybeShutdown(): void {
  if (!shuttingDown || pendingRequests > 0) return;
  void runtime.disconnect().finally(() => process.exit(0));
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  pendingRequests += 1;
  void (async () => {
    try {
      const request = JSON.parse(trimmed);
      writeResponse(await handleMcpRequest(request, runtime));
    } catch (error) {
      writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  })().finally(() => {
    pendingRequests -= 1;
    maybeShutdown();
  });
});

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  rl.close();
  maybeShutdown();
};

rl.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("disconnect", shutdown);
