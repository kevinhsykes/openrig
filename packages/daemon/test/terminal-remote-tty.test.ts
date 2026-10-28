import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeView } from "../src/domain/terminal/view-composer.js";

// Native Windows is not a supported OpenRig runtime. Git's POSIX shell lets this
// isolated quoting fixture run there too, without WSL, a daemon or an SSH server.
const shell = process.platform === "win32"
  ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const posix = (s: string) => s.replace(/\\/g, "/");
const quote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";

describe("remote terminal PTY allocation", () => {
  it("forces a PTY through the real OpenSSH config parser, overriding RequestTTY no", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-ssh-tty-"));
    const config = join(root, "config");
    writeFileSync(config, "Host *\n  RequestTTY no\n  CanonicalizeHostname no\n");
    try {
      const command = composeView("fixture", [{
        seat: "operator-agent@kernel", label: "operator", tmuxSession: "operator-agent@kernel",
        host: "edge", readOnly: true, alive: true,
      }], { resolveHost: () => ({ id: "edge", transport: "ssh", target: "fixture.invalid", user: "fixture-user" }) }).opened[0]!.paneCommand;
      // Read configuration only (-G); neither invocation connects to a host.
      const baseline = execFileSync("ssh", ["-G", "-F", config, "fixture.invalid"], { encoding: "utf8" });
      expect(baseline).toMatch(/^requesttty false$/m);
      const parsed = execFileSync(shell, ["-c", command.replace(/^ssh /, `ssh -G -F ${quote(posix(config))} `)], { encoding: "utf8" });
      expect(parsed).toMatch(/^requesttty force$/m);
      expect(parsed).toMatch(/^user fixture-user$/m);
      expect(parsed).toMatch(/^hostname fixture.invalid$/m);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps destination, exact sessions and read-only mode through both shell boundaries", () => {
    expect(existsSync(shell)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "openrig-ssh-shell-"));
    const args = posix(join(root, "args"));
    const dest = posix(join(root, "dest"));
    const marker = posix(join(root, "must-not-exist"));
    const bin = posix(join(root, "bin"));
    mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), `#!/bin/sh
case $1 in display-message) target=$4; target=\${target#=}; printf '7 session-id:%s\\n' "\${target%:}";; show-environment) exit 1;; attach) shift; printf '%s\\n' "$@" > ${quote(args)};; esac
`, { mode: 0o700 });
    try {
      for (const session of ["operator-agent@kernel", "work-author@openrig-project-01a15766", "seat space", `seat'quote; touch ${marker}`]) {
        for (const readOnly of [false, true]) {
          const view = composeView("fixture", [{ seat: session, label: session, tmuxSession: session, host: "edge", readOnly, alive: true }], {
            resolveHost: () => ({ id: "edge", transport: "ssh", target: "fixture target", user: "user'quoted" }),
            localTmux: "/must-not-reach-remote/tmux", localTmuxServer: ["-L", "must-not-reach-remote"],
          });
          // The fork's remote command is a /bin/sh script that probes tmux, so the synthetic
          // remote tmux is a stub on PATH. Both shells parse real command strings; this asserts
          // argv, not a live remote attachment.
          const fixture = `ssh() { [ "$1" = -tt ] || { echo 'open terminal failed: not a terminal' >&2; return 91; }; shift; printf '%s' "$1" > ${quote(dest)}; shift; PATH=${quote(bin)}:$PATH /bin/sh -c "$*"; }; ${view.opened[0]!.paneCommand}`;
          const result = spawnSync(shell, ["-c", fixture], { encoding: "utf8" });
          expect(result.status, result.stderr).toBe(0);
          expect(readFileSync(dest, "utf8")).toBe("user'quoted@fixture target");
          expect(readFileSync(args, "utf8").trimEnd().split("\n")).toEqual([...(readOnly ? ["-r"] : ["-f", "ignore-size"]), "-t", "session-id"]);
          expect(view.opened[0]!.paneCommand).not.toContain("must-not-reach-remote");
          expect(existsSync(marker)).toBe(false);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
