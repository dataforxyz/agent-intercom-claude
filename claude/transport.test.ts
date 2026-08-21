import assert from "node:assert/strict";
import test from "node:test";
import {
  isNativeClaudeVersionCompatible,
  parseClaudeIntercomTransport,
  parseClaudeVersion,
  resolveClaudeIntercomTransport,
  type ClaudeVersionProbe,
} from "./transport.ts";

const compatibleProbe: ClaudeVersionProbe = {
  command: "claude",
  version: "2.1.220",
  compatible: true,
  reason: "verified",
};
const incompatibleProbe: ClaudeVersionProbe = {
  command: "claude",
  version: "2.1.227",
  compatible: false,
  reason: "not verified",
};

test("transport parser accepts only auto, native, and mcp", () => {
  assert.equal(parseClaudeIntercomTransport(undefined), "auto");
  assert.equal(parseClaudeIntercomTransport("auto"), "auto");
  assert.equal(parseClaudeIntercomTransport("native"), "native");
  assert.equal(parseClaudeIntercomTransport("mcp"), "mcp");
  assert.throws(() => parseClaudeIntercomTransport("monitor"), /auto, native, or mcp/);
});

test("Claude native compatibility requires the minimum version without a future ceiling", () => {
  assert.equal(parseClaudeVersion("2.1.220 (Claude Code)"), "2.1.220");
  assert.equal(parseClaudeVersion("Claude Code v2"), null);
  assert.equal(isNativeClaudeVersionCompatible("2.1.219"), false);
  assert.equal(isNativeClaudeVersionCompatible("2.1.220"), true);
  assert.equal(isNativeClaudeVersionCompatible("2.1.224"), true);
  assert.equal(isNativeClaudeVersionCompatible("2.1.235"), true);
  assert.equal(isNativeClaudeVersionCompatible("2.1.236"), true);
  assert.equal(isNativeClaudeVersionCompatible("99.0.0"), true);
});

test("auto selects native only after a compatible version probe", () => {
  assert.equal(resolveClaudeIntercomTransport({ probe: () => compatibleProbe }).selected, "native");
  assert.equal(resolveClaudeIntercomTransport({ probe: () => incompatibleProbe }).selected, "mcp");
});

test("explicit MCP remains selectable regardless of Claude version", () => {
  const resolution = resolveClaudeIntercomTransport({ requested: "mcp", probe: () => incompatibleProbe });
  assert.equal(resolution.requested, "mcp");
  assert.equal(resolution.selected, "mcp");
});

test("explicit native fails closed on an unverified Claude version", () => {
  assert.throws(
    () => resolveClaudeIntercomTransport({ requested: "native", probe: () => incompatibleProbe }),
    /Native Claude intercom transport was requested.*not verified/,
  );
});

test("transport selection reads CLAUDE_INTERCOM_TRANSPORT", () => {
  const resolution = resolveClaudeIntercomTransport({
    env: { CLAUDE_INTERCOM_TRANSPORT: "mcp" },
    probe: () => compatibleProbe,
  });
  assert.equal(resolution.requested, "mcp");
  assert.equal(resolution.selected, "mcp");
});
