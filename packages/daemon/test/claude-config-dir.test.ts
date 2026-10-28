import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeAuthReader } from "../src/domain/provider/claude-auth-status-reader.js";
import { claudeConfigDirPresent, claudeConfigDirProblem, parseClaudeAccounts, readClaudeAccountsFile, realClaudeConfigDirProbe } from "../src/domain/provider/claude-config-dir.js";

// The secret-safe half of moving a seat between Claude accounts: the declared config-dir homes, the shape a home's path must
// have, and one login probe per home. The declared file may carry other fields; only each entry's dir and label are kept.

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), "claude-config-dir-unit-")); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };

describe("parseClaudeAccounts", () => {
  it("keeps each account's key, label and normalized dir, and nothing else the file carries", () => {
    const read = parseClaudeAccounts({ schema: "claude-accounts.v2", accounts: {
      pro: { dir: "/home/u/.claude-pro", label: "Personal Pro", has_credentials: true, token: "must-not-survive", notes: "x" },
      max: { dir: "/home/u/.claude-max/", label: "Max", available: true } } });
    expect(read).toEqual({ ok: true, accounts: [
      { key: "pro", label: "Personal Pro", dir: "/home/u/.claude-pro" },
      { key: "max", label: "Max", dir: "/home/u/.claude-max" } ] });
    expect(JSON.stringify(read)).not.toContain("must-not-survive");
  });

  it("falls back to the key for a missing label, and refuses a file that names no usable account", () => {
    expect(parseClaudeAccounts({ accounts: { solo: { dir: "/d" } } })).toEqual({ ok: true, accounts: [{ key: "solo", label: "solo", dir: "/d" }] });
    for (const bad of [null, [], {}, { accounts: [] }, { accounts: {} }, { accounts: { a: "x" } }, { accounts: { a: { dir: "relative" } } }, { accounts: { a: { dir: "/d\nx" } } }]) {
      expect(parseClaudeAccounts(bad).ok).toBe(false);
    }
  });

  it("refuses two accounts on one dir, so one account per home stays provable", () => {
    const read = parseClaudeAccounts({ accounts: { a: { dir: "/same" }, b: { dir: "/same/" } } });
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('account "b" repeats the config dir /same') });
  });
});

describe("readClaudeAccountsFile / claudeConfigDirProblem / claudeConfigDirPresent", () => {
  it("reads a file, and names an unreadable or non-JSON one without throwing", () => {
    const dir = tmp();
    const good = path.join(dir, "accounts.json"), bad = path.join(dir, "bad.json");
    writeFileSync(good, JSON.stringify({ accounts: { a: { dir: "/d" } } }));
    writeFileSync(bad, "{ nope");
    expect(readClaudeAccountsFile(good).ok).toBe(true);
    expect(readClaudeAccountsFile(bad)).toEqual({ ok: false, reason: expect.stringContaining("isn't JSON") });
    expect(readClaudeAccountsFile(path.join(dir, "missing.json"))).toEqual({ ok: false, reason: expect.stringContaining("can't be read (ENOENT)") });
  });

  it("a config dir path must be an absolute single line, and presence means an existing directory", () => {
    expect(claudeConfigDirProblem("/a/b")).toBeNull();
    for (const bad of ["", "rel", "/a\u0000b", `/${"x".repeat(5000)}`, undefined, 3]) expect(claudeConfigDirProblem(bad)).not.toBeNull();
    const dir = tmp(), file = path.join(dir, "f");
    writeFileSync(file, "x"); mkdirSync(path.join(dir, "d"));
    expect([claudeConfigDirPresent(path.join(dir, "d")), claudeConfigDirPresent(file), claudeConfigDirPresent(path.join(dir, "nope"))]).toEqual([true, false, false]);
  });
});

describe("realClaudeConfigDirProbe maps the auth-status answer for one dir, keeping only state, plan and the account's own address", () => {
  const at = "2026-10-27T00:00:00Z";
  it("logged in, not logged in, and every other failure as unreadable with its reason", async () => {
    const seen: string[] = [];
    const probe = (answers: Record<string, Awaited<ReturnType<ClaudeAuthReader>>>) =>
      realClaudeConfigDirProbe({ reader: (dir) => async () => { seen.push(dir); return answers[dir]!; } });
    const p = probe({
      "/in": { ok: true, observedAt: at, auth: { loggedIn: true, authMethod: "claude.ai", email: "a@example.test", orgId: "o", orgName: "Org", subscriptionType: "max" } },
      "/out": { ok: false, at, reason: "not_logged_in", detail: "none" },
      "/api": { ok: false, at, reason: "not_subscription_login", detail: "the login is not a claude.ai subscription (apiKey)" },
    });
    expect(await p("/in")).toEqual({ state: "logged_in", email: "a@example.test", subscriptionType: "max" });
    expect(await p("/out")).toEqual({ state: "not_logged_in" });
    expect(await p("/api")).toEqual({ state: "unreadable", reason: "not_subscription_login", detail: "the login is not a claude.ai subscription (apiKey)" });
    expect(seen).toEqual(["/in", "/out", "/api"]);
  });

  it("a reader that throws reads as unreadable, never as logged in", async () => {
    const p = realClaudeConfigDirProbe({ reader: () => async () => { throw new Error("boom"); } });
    expect(await p("/x")).toEqual({ state: "unreadable", reason: "spawn_failed", detail: "the reader failed: boom" });
  });
});
