/**
 * macOS launchd integration — keeps the persona-runner alive across reboots,
 * Claude Desktop restarts, and runner crashes.
 *
 * On first register-persona we drop a plist at
 * ~/Library/LaunchAgents/ai.zynd.persona.plist and `launchctl load` it.
 * KeepAlive=true makes launchd respawn the runner if it ever exits non-zero.
 *
 * Linux/Windows: the helpers no-op and surface a hint to the user. Detached
 * `spawn(detached:true)` already gives them session-long persistence, just
 * without auto-restart on reboot.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { zyndDir } from "./identity-store.js";

const LABEL = "ai.zynd.persona";

export function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function isInstalled(): boolean {
  return fs.existsSync(plistPath());
}

function runnerEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "persona-runner.js");
}

function buildPlist(args: { configPath: string; logPath: string }): string {
  const node = process.execPath;
  const runner = runnerEntry();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${runner}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ZYND_PERSONA_CONFIG</key>
    <string>${args.configPath}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${args.logPath}</string>
  <key>StandardErrorPath</key>
  <string>${args.logPath}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function install(args: { configPath: string }): { plistPath: string } {
  if (os.platform() !== "darwin") {
    throw new Error("launchd install is macOS-only");
  }
  const logPath = path.join(zyndDir(), "persona-runner.log");
  const dir = path.dirname(plistPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(plistPath(), buildPlist({ configPath: args.configPath, logPath }), {
    mode: 0o644,
  });
  // bootstrap in case it's already loaded — unload first to pick up changes
  try {
    execFileSync("launchctl", ["unload", plistPath()], { stdio: "ignore" });
  } catch {
    // wasn't loaded — fine
  }
  execFileSync("launchctl", ["load", plistPath()], { stdio: "inherit" });
  return { plistPath: plistPath() };
}

export function uninstall(): { removed: boolean } {
  if (os.platform() !== "darwin") return { removed: false };
  if (!isInstalled()) return { removed: false };
  try {
    execFileSync("launchctl", ["unload", plistPath()], { stdio: "ignore" });
  } catch {
    // best-effort
  }
  fs.unlinkSync(plistPath());
  return { removed: true };
}
