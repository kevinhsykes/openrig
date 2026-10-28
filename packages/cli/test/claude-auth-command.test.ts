// `rig auth status|list --runtime claude`: the declared Claude accounts (config-dir homes), each with its dir, whether it exists,
// and its login state from ONE bounded `claude auth status` with that dir selected. The probe is a fake: no real claude binary.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authCommand, CLAUDE_ACCOUNTS_FILE_ENV } from "../src/commands/auth.js";

let root: string, fleet: string, pro: string, file: string;
const probed: string[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-cmd-"));
  fleet = path.join(root, ".claude-fleet"); pro = path.join(root, ".claude-pro");
  fs.mkdirSync(fleet);
  // `max` is declared but its dir doesn't exist; `pro` exists with a credentials file that must never be read as login state.
  fs.mkdirSync(pro);
  fs.writeFileSync(path.join(pro, ".credentials.json"), "SECRET-CREDENTIAL-CONTENT");
  file = path.join(root, "claude-accounts.json");
  fs.writeFileSync(file, JSON.stringify({ schema: "claude-accounts.v2", accounts: {
    golisano: { dir: fleet, label: "Golisano Enterprise", has_credentials: true, token: "SECRET-TOKEN-IN-FEED" },
    pro: { dir: pro, label: "Personal Pro", has_credentials: true },
    max: { dir: path.join(root, ".claude-max"), label: "Max", has_credentials: true } } }));
  probed.length = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ out: string; code: number | undefined }> {
  const chunks: string[] = [];
  const origLog = console.log, origErr = console.error, origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  let code: number | undefined;
  try {
    const cmd = authCommand({ env: { HOME: root, ...env }, claudeProbe: async (dir) => {
      probed.push(dir);
      return dir === fleet ? { state: "logged_in", email: "someone@example.test", subscriptionType: "max" } : { state: "not_logged_in" };
    } });
    await cmd.parseAsync(args, { from: "user" });
    code = process.exitCode as number | undefined;
  } finally {
    console.log = origLog; console.error = origErr; process.exitCode = origExit;
  }
  return { out: chunks.join("\n"), code };
}

describe("rig auth status --runtime claude", () => {
  it("prints each declared account's label, config dir, presence and login state, probing only dirs that exist", async () => {
    const { out, code } = await run(["status", "--runtime", "claude", "--accounts-file", file]);
    expect(code).toBeUndefined();
    expect(out).toContain(`account: golisano\nlabel: Golisano Enterprise\nconfig_dir: ${fleet}\nconfig_dir_present: yes\nlogin_state: logged_in`);
    expect(out).toContain(`account: pro\nlabel: Personal Pro\nconfig_dir: ${pro}\nconfig_dir_present: yes\nlogin_state: not_logged_in`);
    expect(out).toContain(`account: max\nlabel: Max\nconfig_dir: ${path.join(root, ".claude-max")}\nconfig_dir_present: no\nlogin_state: n/a (config dir missing)`);
    // One probe per existing dir, and none for the missing one.
    expect(probed.sort()).toEqual([fleet, pro].sort());
  });

  it("never prints a token, a credentials file's contents, the feed's has_credentials, or an email", async () => {
    const { out } = await run(["status", "--runtime", "claude", "--accounts-file", file]);
    for (const secret of ["SECRET-CREDENTIAL-CONTENT", "SECRET-TOKEN-IN-FEED", "has_credentials", "someone@example.test"]) expect(out).not.toContain(secret);
  });

  it("an unreadable probe is unavailable with its reason, never logged in", async () => {
    const chunks: string[] = [];
    const orig = console.log; console.log = (...a: unknown[]) => void chunks.push(a.join(" "));
    try {
      await authCommand({ env: {}, claudeProbe: async () => ({ state: "unreadable", reason: "binary_not_found", detail: "no claude" }) })
        .parseAsync(["status", "--runtime", "claude", "--accounts-file", file], { from: "user" });
    } finally { console.log = orig; }
    expect(chunks.join("\n")).toContain("login_state: unavailable (binary_not_found)");
    expect(chunks.join("\n")).not.toContain("login_state: logged_in");
  });

  it("takes the accounts file from the environment, and says what to name when there is none or it can't be used", async () => {
    expect((await run(["status", "--runtime", "claude"], { [CLAUDE_ACCOUNTS_FILE_ENV]: file })).out).toContain("account: golisano");
    const none = await run(["status", "--runtime", "claude"]);
    expect(none.code).toBe(1);
    expect(none.out).toContain(`name the accounts file: --accounts-file <path> or ${CLAUDE_ACCOUNTS_FILE_ENV}`);
    const bad = await run(["status", "--runtime", "claude", "--accounts-file", path.join(root, "missing.json")]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("can't be read");
    const remote = await run(["status", "--runtime", "claude", "--accounts-file", file, "--host", "pi"]);
    expect(remote.code).toBe(1);
    expect(remote.out).toContain("--host isn't supported with --runtime claude");
  });
});

describe("rig auth list --runtime claude", () => {
  it("prints one tab-separated line per account: key, label, config dir, present, login state", async () => {
    const { out } = await run(["list", "--runtime", "claude", "--accounts-file", file]);
    expect(out.split("\n")).toEqual([
      ["golisano", "Golisano Enterprise", fleet, "yes", "logged_in"].join("\t"),
      ["pro", "Personal Pro", pro, "yes", "not_logged_in"].join("\t"),
      ["max", "Max", path.join(root, ".claude-max"), "no", "n/a (config dir missing)"].join("\t"),
    ]);
  });
});

describe("--runtime claude is for status and list only", () => {
  it("save, switch, validate and seats keep refusing with the same unsupported_runtime text, and codex stays the default", async () => {
    for (const v of [["save", "p"], ["switch", "p"], ["validate", "p"], ["seats", "list"], ["seats", "show", "s"], ["seats", "report"]]) {
      const { out, code } = await run([...v, "--runtime", "claude"]);
      expect(out).toContain("unsupported_runtime claude (MVP supports: codex)");
      expect(code).toBe(1);
    }
    expect(probed).toEqual([]);
  });
});
