import { spawn, spawnSync } from "node:child_process";
import type { SessionInfo } from "../types.ts";

export function formatContactInstruction(current: SessionInfo, sessions: SessionInfo[]): string {
  const name = current.name?.trim();
  const duplicate = Boolean(name && sessions.some((session) => session.id !== current.id && session.name?.trim().toLowerCase() === name.toLowerCase()));
  return name && !duplicate
    ? `Intercom target: ${name}\nStable session ID: ${current.id}`
    : `Intercom target: ${current.id}`;
}

export function copyTextToClipboard(text: string): boolean {
  const candidates: Array<[string, string[]]> = process.platform === "darwin"
    ? [["pbcopy", []]]
    : process.platform === "win32"
      ? [["clip.exe", []]]
      : [
          ...(process.env.WAYLAND_DISPLAY ? [["wl-copy", []] as [string, string[]]] : []),
          ...(process.env.DISPLAY ? [["xclip", ["-selection", "clipboard"]] as [string, string[]], ["xsel", ["--clipboard", "--input"]] as [string, string[]]] : []),
          ["clip.exe", []],
        ];
  for (const [command, args] of candidates) {
    if (spawnSync("which", [command], { stdio: "ignore" }).status !== 0) continue;
    if (command === "wl-copy") {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.end(text);
      child.unref();
      return true;
    }
    if (spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] }).status === 0) return true;
  }
  return false;
}
