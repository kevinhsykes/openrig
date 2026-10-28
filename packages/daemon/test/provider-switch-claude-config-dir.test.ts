import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import type { ClaudeSeatTokenRef } from "../src/domain/claude-seat-token.js";
import type { CredentialPrecedence } from "../src/domain/claude-credential-precedence.js";
import type { ClaudeSeatRelaunch } from "../src/domain/provider/provider-service.js";
import type { ClaudeConfigDirLogin } from "../src/domain/provider/claude-config-dir.js";

// `rig provider switch --seat --config-dir` for a Claude seat: the seat moves to another account by its own CLAUDE_CONFIG_DIR,
// then restore's own resume path relaunches it in its pane on the same conversation. Every check is about the TARGET home (it
// exists, its login reads as a claude.ai subscription, nothing outranks that login), and nothing changes until they all pass.
// The relaunch, the seat's env and the login probe are fakes: no real claude binary, no real home.

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

const SEAT = "dev-a@rig";
const CLEAR: CredentialPrecedence = { conflicts: [], checked: ["the launch environment"], notChecked: ["managed settings (a managed-settings.json file, MDM or the server)"] };
type Relaunched = Awaited<ReturnType<ClaudeSeatRelaunch["relaunchInPane"]>>;
const RESUMED: Relaunched = { ok: true, status: "resumed", warnings: [] };
const LOGGED_IN: ClaudeConfigDirLogin = { state: "logged_in", email: null, subscriptionType: "max" };

function accountDir(name = "account") {
  const root = mkdtempSync(path.join(tmpdir(), "claude-config-dir-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, name);
  mkdirSync(dir);
  return dir;
}

function harness(opts: {
  running?: boolean; pane?: string | null; ref?: ClaudeSeatTokenRef | null; precedence?: CredentialPrecedence;
  declared?: string | null; effective?: string; login?: ClaudeConfigDirLogin; noHooks?: boolean; noProbe?: boolean;
  snapshot?: { resumes: true; conversation: string | null } | { resumes: false; why: string };
  relaunch?: Relaunched | (() => Promise<Relaunched>);
} = {}) {
  const calls: string[] = [];
  let declared: string | null = opts.declared === undefined ? null : opts.declared;
  const effective = opts.effective ?? "/home/test/.claude";
  let queue: Promise<unknown> = Promise.resolve();
  const claudeSeat: ClaudeSeatRelaunch = {
    seat: () => ({ nodeId: "node-a", rigId: "rig-1", rigName: "rig", logicalId: "dev.a", running: opts.running ?? true, pane: opts.pane === undefined ? "%7" : opts.pane }),
    tokenRef: () => opts.ref ?? null,
    canResumeInConfigDir: () => true,
    setTokenRef: (_nodeId, next) => { calls.push(`setTokenRef ${next ? next.label : "null"}`); },
    ...(opts.noHooks ? {} : {
      configDir: (_nodeId: string) => ({ declared, effective: declared ?? effective }),
      setConfigDir: (_nodeId: string, dir: string | null) => { calls.push(`setConfigDir ${dir}`); declared = dir; },
    }),
    snapshot: (rigId) => { calls.push(`snapshot ${rigId}`); return { snapshotId: "snap-1", ...(opts.snapshot ?? { resumes: true as const, conversation: "conv-1" }) }; },
    exclusive: <T>(nodeId: string, fn: () => Promise<T>): Promise<T> => {
      calls.push(`exclusive ${nodeId}`);
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    },
    relaunchInPane: async (rigId, logicalId, snapshotId) => {
      calls.push(`relaunch ${rigId} ${logicalId} ${snapshotId} on ${declared ?? "no declared dir"}`);
      return typeof opts.relaunch === "function" ? opts.relaunch() : opts.relaunch ?? RESUMED;
    },
  };
  const claudePrecedence = async (nodeId: string, o?: { storedLogin?: boolean; configDir?: string }) => {
    calls.push(`precedence ${nodeId}${o?.storedLogin ? " (stored login)" : ""}${o?.configDir ? ` dir=${o.configDir}` : ""}`);
    return opts.precedence ?? CLEAR;
  };
  const claudeConfigDirProbe = opts.noProbe ? undefined : async (dir: string) => { calls.push(`probe ${dir}`); return opts.login ?? LOGGED_IN; };
  const svc = new ProviderServiceImpl({ db: {} as never, listRigs: () => [], claudePrecedence, ...(claudeConfigDirProbe ? { claudeConfigDirProbe } : {}) });
  const seatRestart = { plan: async () => { throw new Error("the Codex restart isn't used for a Claude seat"); }, run: async () => { throw new Error("unused"); } };
  return { svc, seatRestart, claudeSeat, calls, declared: () => declared };
}

const to = (account: string, configDir: string) => ({ seat: SEAT, toAccount: account, configDir, forceUnsafe: false });

describe("rig provider switch --seat --config-dir moves a Claude seat to another account's config dir on the same conversation", () => {
  it("under the seat's lease, checks the target dir, takes a snapshot that resumes the seat, sets its CLAUDE_CONFIG_DIR and relaunches it in its pane", async () => {
    const dir = accountDir();
    const h = harness();
    const r = await h.svc.switchAccount(to("golisano", dir), h.seatRestart, h.claudeSeat);
    expect(h.calls).toEqual([
      "exclusive node-a",
      `precedence node-a (stored login) dir=${dir}`,
      `probe ${dir}`,
      "snapshot rig-1",
      `setConfigDir ${dir}`,
      `relaunch rig-1 dev.a snap-1 on ${dir}`,
    ]);
    expect(r).toMatchObject({ outcome: "rebind_in_progress", message: expect.stringContaining(`on the config dir ${dir} ("golisano")`), seat: {
      seat: SEAT, account: "golisano", configDir: dir, conversation: "conv-1", loginChanged: true,
      undo: `rig provider switch --seat ${SEAT} --config-dir '/home/test/.claude' --inherit-config-dir`,
      next: expect.stringContaining("/status"),
    } });
    expect(h.declared()).toBe(dir);
    // A config-dir move leaves the token reference alone.
    expect(h.calls.some((call) => call.startsWith("setTokenRef"))).toBe(false);
  });

  it("the way back names the dir the seat ran on, declared or not, and quotes a path with a space as one argument", async () => {
    const before = path.join(accountDir("with space's"), "prior");
    const h = harness({ declared: before });
    const r = await h.svc.switchAccount(to("max", accountDir()), h.seatRestart, h.claudeSeat);
    expect(r.seat?.undo).toContain(`--config-dir '${before.replace(/'/g, `'"'"'`)}'`);
    const args = execFileSync("/bin/sh", ["-c", `rig() { printf '%s\\n' "$@"; }\n${r.seat!.undo}`], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" }).trimEnd().split("\n");
    expect(args.slice(args.indexOf("--config-dir") + 1)).toEqual([before]);
  });

  it("a target dir that doesn't exist stops it before anything changes, and the login isn't probed", async () => {
    const h = harness();
    const missing = path.join(accountDir(), "nope");
    const r = await h.svc.switchAccount(to("golisano", missing), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["config_dir_missing"], message: expect.stringContaining("Nothing changed") });
    expect(h.calls).toEqual(["exclusive node-a"]);
  });

  it("a target dir with no login stops it, with the sign-in command, before the seat or its env changes", async () => {
    const dir = accountDir();
    const h = harness({ login: { state: "not_logged_in" } });
    const r = await h.svc.switchAccount(to("golisano", dir), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["config_dir_not_logged_in"], message: expect.stringContaining("claude auth login") });
    expect(h.calls).toEqual(["exclusive node-a", `precedence node-a (stored login) dir=${dir}`, `probe ${dir}`]);
    expect(h.declared()).toBeNull();
  });

  it("a login that couldn't be read or isn't a subscription login stops it, naming why, and isn't taken for a login", async () => {
    const dir = accountDir();
    const h = harness({ login: { state: "unreadable", reason: "not_subscription_login", detail: "the login is not a claude.ai subscription (apiKey)" } });
    const r = await h.svc.switchAccount(to("golisano", dir), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["config_dir_login_unreadable"], message: expect.stringContaining("not_subscription_login") });
    expect(h.declared()).toBeNull();
  });

  it("a credential that would outrank the target dir's login stops it before the login is probed, naming each and its remedy", async () => {
    const dir = accountDir();
    const h = harness({ precedence: { ...CLEAR, conflicts: [{ name: "ANTHROPIC_API_KEY", source: `user settings ${dir}/settings.json`, remedy: "remove it from that file" }] } });
    const r = await h.svc.switchAccount({ ...to("golisano", dir), forceUnsafe: true }, h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["credential_outranks_token"],
      message: expect.stringMatching(/ANTHROPIC_API_KEY.*settings\.json.*remove it from that file/) });
    expect(h.calls).toEqual(["exclusive node-a", `precedence node-a (stored login) dir=${dir}`]);
  });

  it("a CLAUDE_CODE_OAUTH_TOKEN the seat would still receive refuses here: it would keep the seat on the old account", async () => {
    const dir = accountDir();
    const inherited = { name: "CLAUDE_CODE_OAUTH_TOKEN", source: "the daemon's environment, which every managed Claude launch receives", remedy: "unset it where the daemon starts" };
    const h = harness({ precedence: { ...CLEAR, instead: [inherited] } });
    const r = await h.svc.switchAccount(to("golisano", dir), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["credential_outranks_token"], message: expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN") });
    expect(h.declared()).toBeNull();
  });

  it("a seat that holds its own token reference isn't moved, and the message names the way to move it back first", async () => {
    const h = harness({ ref: { label: "work", tokenFile: "/secrets/work.token" } });
    const r = await h.svc.switchAccount(to("golisano", accountDir()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["seat_has_token_reference"], message: expect.stringContaining(`rig provider switch --seat ${SEAT} --stored-login`) });
    expect(h.calls).toEqual(["exclusive node-a"]);
  });

  it("a seat already on that dir isn't relaunched", async () => {
    const dir = accountDir();
    const h = harness({ effective: dir });
    const r = await h.svc.switchAccount(to("golisano", dir), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["already_on_config_dir"] });
    expect(h.calls).toEqual(["exclusive node-a"]);
  });

  it("a path that isn't absolute or one line, or that comes with a token file, is refused as an invalid config dir", async () => {
    const h = harness();
    for (const bad of ["relative/dir", "/abs/with\nnewline", ""]) {
      const r = await h.svc.switchAccount(to("golisano", bad), h.seatRestart, h.claudeSeat);
      expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["invalid_config_dir"] });
    }
    const both = await h.svc.switchAccount({ ...to("golisano", accountDir()), tokenFile: "/secrets/x.token" }, h.seatRestart, h.claudeSeat);
    expect(both).toMatchObject({ outcome: "failed_safely", reasons: ["invalid_config_dir"], message: expect.stringContaining("token file") });
    expect(h.declared()).toBeNull();
  });

  it("a daemon that can't set a seat's config dir or read a login doesn't move it", async () => {
    for (const lacking of [{ noHooks: true }, { noProbe: true }]) {
      const h = harness(lacking);
      const r = await h.svc.switchAccount(to("golisano", accountDir()), h.seatRestart, h.claudeSeat);
      expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["rebind_unsupported_for_runtime"] });
      expect(h.calls.some((call) => call.startsWith("snapshot") || call.startsWith("relaunch"))).toBe(false);
    }
  });

  it("a stopped seat, a seat without a pane, or a snapshot that can't resume stops it before the env changes", async () => {
    const stopped = harness({ running: false });
    expect(await stopped.svc.switchAccount(to("golisano", accountDir()), stopped.seatRestart, stopped.claudeSeat)).toMatchObject({ reasons: ["seat_not_running"] });
    const noPane = harness({ pane: null });
    expect(await noPane.svc.switchAccount(to("golisano", accountDir()), noPane.seatRestart, noPane.claudeSeat)).toMatchObject({ reasons: ["no_bound_pane"] });
    const noResume = harness({ snapshot: { resumes: false, why: "has no resume token for this seat" } });
    expect(await noResume.svc.switchAccount(to("golisano", accountDir()), noResume.seatRestart, noResume.claudeSeat))
      .toMatchObject({ outcome: "failed_safely", reasons: ["conversation_not_resumable"] });
    for (const h of [stopped, noPane, noResume]) expect(h.declared()).toBeNull();
    expect(noResume.calls.some((call) => call.startsWith("setConfigDir"))).toBe(false);
  });

  it("a relaunch refused before the seat was touched puts the seat's own CLAUDE_CONFIG_DIR back as it was", async () => {
    const before = path.join(accountDir("before"));
    const h = harness({ declared: before, relaunch: { ok: false, effect: "none", code: "awaiting-decision", message: "Restore stopped for a decision." } });
    const r = await h.svc.switchAccount(to("golisano", accountDir()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["relaunch_awaiting_decision"], message: expect.stringContaining("on its config dir as it was") });
    expect(h.declared()).toBe(before);
    // A seat that declared nothing has its declaration removed again, not set to the old effective dir.
    const none = harness({ relaunch: { ok: false, effect: "none", code: "awaiting-decision", message: "x" } });
    await none.svc.switchAccount(to("golisano", accountDir()), none.seatRestart, none.claudeSeat);
    expect(none.declared()).toBeNull();
    expect(none.calls.filter((call) => call.startsWith("setConfigDir")).slice(-1)).toEqual(["setConfigDir null"]);
  });

  it("a relaunch that ended the seat's process but didn't resume reads unknown, with the snapshot's recovery and the way back, and isn't retried", async () => {
    const dir = accountDir();
    const h = harness({ relaunch: { ok: false, effect: "unknown", code: "failed", message: "The pane couldn't be respawned." } });
    const r = await h.svc.switchAccount(to("golisano", dir), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "unknown", reasons: ["relaunch_failed"], message: expect.stringContaining("may have been ended"), seat: {
      configDir: dir, loginChanged: true, undo: `rig provider switch --seat ${SEAT} --config-dir '/home/test/.claude' --inherit-config-dir`,
      restart: { recoveryCommand: "rig launch rig dev.a --snapshot-id snap-1", remainingStep: expect.stringContaining(`rig seat stop ${SEAT}`) } } });
    expect(h.declared()).toBe(dir);
    expect(h.calls.filter((call) => call.startsWith("relaunch"))).toHaveLength(1);
  });

  it("a relaunch that throws reads unknown instead of rejecting the switch", async () => {
    const h = harness({ relaunch: async () => { throw new Error("transport failure after the launch request"); } });
    const r = await h.svc.switchAccount(to("golisano", accountDir()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "unknown", reasons: ["relaunch_threw"], seat: { restart: { recoveryCommand: "rig launch rig dev.a --snapshot-id snap-1" } } });
  });

  it("a seat env that can't be written reads as unchanged: the seat's process was never touched", async () => {
    const dir = accountDir();
    const h = harness();
    h.claudeSeat.setConfigDir = () => { throw Object.assign(new Error("the seat's env couldn't be written"), { code: "seat_env_unwritable" }); };
    const r = await h.svc.switchAccount(to("golisano", dir), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["seat_env_unwritable"], message: expect.stringContaining("Nothing changed") });
    expect(h.calls.some((call) => call.startsWith("relaunch"))).toBe(false);
  });

  it("two switches on the same seat run one at a time: the second checks the seat again after the first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let relaunches = 0;
    const h = harness({ relaunch: async () => { if (++relaunches === 1) await gate; return RESUMED; } });
    const a = accountDir("alpha"), b = accountDir("beta");
    const first = h.svc.switchAccount(to("alpha", a), h.seatRestart, h.claudeSeat);
    const second = h.svc.switchAccount(to("beta", b), h.seatRestart, h.claudeSeat);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.filter((call) => call.startsWith("relaunch"))).toEqual([`relaunch rig-1 dev.a snap-1 on ${a}`]);
    release();
    const [ra, rb] = await Promise.all([first, second]);
    expect(h.calls.filter((call) => call.startsWith("relaunch"))).toEqual([`relaunch rig-1 dev.a snap-1 on ${a}`, `relaunch rig-1 dev.a snap-1 on ${b}`]);
    expect(ra).toMatchObject({ outcome: "rebind_in_progress", seat: { account: "alpha" } });
    expect(rb).toMatchObject({ outcome: "rebind_in_progress", seat: { account: "beta", undo: `rig provider switch --seat ${SEAT} --config-dir '${a}'` } });
    expect(h.declared()).toBe(b);
  });

  it("precheck reports the target dir and what was checked, and changes nothing", async () => {
    const dir = accountDir();
    const h = harness();
    expect(await h.svc.precheck({ seat: SEAT, toAccount: "golisano", configDir: dir }, h.seatRestart, h.claudeSeat)).toMatchObject({
      safe: true, claude: { label: "golisano", tokenFile: null, configDir: dir, notChecked: CLEAR.notChecked,
        checked: expect.arrayContaining(["the launch environment", `${dir}/settings.json for credential settings`]) } });
    expect(h.calls).toEqual([`precedence node-a (stored login) dir=${dir}`, `probe ${dir}`]);
    expect(h.declared()).toBeNull();
    const refused = harness({ login: { state: "not_logged_in" } });
    expect(await refused.svc.precheck({ seat: SEAT, toAccount: "golisano", configDir: dir }, refused.seatRestart, refused.claudeSeat))
      .toMatchObject({ safe: false, reasons: ["config_dir_not_logged_in"] });
  });

  it("the report and the refusals never carry a token or a credential's contents", async () => {
    const dir = accountDir();
    const h = harness({ login: { state: "logged_in", email: "someone@example.test", subscriptionType: "max" } });
    const r = await h.svc.switchAccount(to("golisano", dir), h.seatRestart, h.claudeSeat);
    expect(JSON.stringify(r)).not.toContain("someone@example.test");
    // No token variable is named in a move that sets none.
    expect(JSON.stringify(r)).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|sk-ant/);
  });

  it("undo restores an inherited config selection instead of pinning its effective default", async () => {
    const inherited = accountDir("inherited"), target = accountDir("other");
    const h = harness({ effective: inherited });
    Object.assign(h.claudeSeat, { inheritedConfigDir: () => ({ effective: inherited, selected: null }) });
    const moved = await h.svc.switchAccount(to("other", target), h.seatRestart, h.claudeSeat);
    expect(moved.seat?.undo).toContain("--inherit-config-dir");
    const restored = await h.svc.switchAccount({ ...to("inherited", inherited), inheritConfigDir: true }, h.seatRestart, h.claudeSeat);
    expect(restored.outcome).toBe("rebind_in_progress");
    expect(restored.seat?.configDirInherited).toBe(true);
    expect(h.declared()).toBeNull();
    expect(h.calls.at(-1)).toContain("on no declared dir");
  });

  it("a target without the same native conversation refuses before changing the env or process", async () => {
    const h = harness();
    h.claudeSeat.canResumeInConfigDir = () => false;
    const result = await h.svc.switchAccount(to("other", accountDir()), h.seatRestart, h.claudeSeat);
    expect(result).toMatchObject({ outcome: "failed_safely", reasons: ["config_dir_conversation_unavailable"] });
    expect(h.declared()).toBeNull();
    expect(h.calls.some((call) => call.startsWith("setConfigDir") || call.startsWith("relaunch"))).toBe(false);
  });

  it("an undo refuses if the inherited home changed since its command was printed", async () => {
    const old = accountDir("old"), current = accountDir("current");
    const h = harness({ declared: accountDir("selected") });
    Object.assign(h.claudeSeat, { inheritedConfigDir: () => ({ effective: current, selected: current }) });
    const result = await h.svc.switchAccount({ ...to("old", old), inheritConfigDir: true }, h.seatRestart, h.claudeSeat);
    expect(result).toMatchObject({ outcome: "failed_safely", reasons: ["invalid_config_dir"] });
    expect(h.calls).toEqual(["exclusive node-a"]);
  });

  it("a native selection change during login probing refuses even when its directory is identical", async () => {
    const inherited = accountDir("inherited"), selected = accountDir("selected");
    const h = harness({ effective: inherited, declared: selected });
    let reads = 0;
    Object.assign(h.claudeSeat, { inheritedConfigDir: () => ({ effective: inherited, selected: reads++ === 0 ? null : inherited }) });
    const result = await h.svc.switchAccount({ ...to("inherited", inherited), inheritConfigDir: true }, h.seatRestart, h.claudeSeat);
    expect(result).toMatchObject({ outcome: "failed_safely", reasons: ["invalid_config_dir"] });
    expect(h.declared()).toBe(selected);
    expect(h.calls.some((call) => call.startsWith("setConfigDir") || call.startsWith("relaunch"))).toBe(false);
  });

  it("a refused inherited relaunch restores the member override before returning unchanged", async () => {
    const inherited = accountDir("inherited"), selected = accountDir("selected");
    const h = harness({ effective: inherited, declared: selected,
      relaunch: { ok: false, effect: "none", code: "awaiting-decision", message: "decide" } });
    Object.assign(h.claudeSeat, { inheritedConfigDir: () => ({ effective: inherited, selected: inherited }) });
    const result = await h.svc.switchAccount({ ...to("inherited", inherited), inheritConfigDir: true }, h.seatRestart, h.claudeSeat);
    expect(result).toMatchObject({ outcome: "failed_safely" });
    expect(h.declared()).toBe(selected);
    expect(h.calls.filter((call) => call.startsWith("setConfigDir"))).toEqual(["setConfigDir null", `setConfigDir ${selected}`]);
  });
});
