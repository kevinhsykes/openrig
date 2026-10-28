import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { claudeSeatConfigDirHooks } from "../src/domain/provider/claude-seat-switch.js";
import type { ClaudeSeatRelaunch } from "../src/domain/provider/provider-service.js";
import type { CredentialPrecedence } from "../src/domain/claude-credential-precedence.js";

// A refused relaunch (effect "none") puts the seat's config dir back. It must put back the MEMBER's own declaration, not whatever
// the seat resolves to: a dir the RIG declares is not the member's, and writing it into the member's env would shadow the rig.
// Real database and the route's real config-dir hooks; only the relaunch (a refusal), the snapshot and the login probe are fakes.

const SEAT = "dev-a@rig";
const CLEAR: CredentialPrecedence = { conflicts: [], checked: ["the launch environment"], notChecked: [] } as never;

let db: Database.Database;
let rigRepo: RigRepository;
let root: string;
beforeEach(() => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  rigRepo = new RigRepository(db);
  root = mkdtempSync(path.join(tmpdir(), "claude-rollback-"));
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

const memberEnv = (nodeId: string) => (db.prepare("SELECT env_json FROM nodes WHERE id = ?").get(nodeId) as { env_json: string | null }).env_json;
const rigEnv = (rigId: string) => (db.prepare("SELECT env_json FROM rigs WHERE id = ?").get(rigId) as { env_json: string | null }).env_json;

function fixture(env: { rig?: Record<string, string>; member?: Record<string, string> }) {
  const rig = rigRepo.createRig("rig");
  const node = rigRepo.addNode(rig.id, "dev-a", { runtime: "claude-code", cwd: root });
  if (env.rig) rigRepo.setRigEnv(rig.id, env.rig);
  if (env.member) db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?").run(JSON.stringify(env.member), node.id);
  const target = path.join(root, "target");
  mkdirSync(target);
  const claudeSeat: ClaudeSeatRelaunch = {
    seat: () => ({ nodeId: node.id, rigId: rig.id, rigName: "rig", logicalId: "dev-a", running: true, pane: "%1" }),
    tokenRef: () => null,
    setTokenRef: () => {},
    ...claudeSeatConfigDirHooks(rigRepo),
    // This file is about the ROLLBACK after a refused relaunch. The conversation gate (T3 652bdcf7f, P28) would refuse these
    // synthetic dirs before the relaunch is reached; it has its own tests (claude-seat-config-dir-hooks, provider-switch-claude-config-dir).
    canResumeInConfigDir: () => true,
    snapshot: () => ({ snapshotId: "snap-1", resumes: true as const, conversation: "conv-1" }),
    exclusive: (_nodeId, fn) => fn(),
    // The relaunch refuses before touching the process.
    relaunchInPane: async () => ({ ok: false, effect: "none", code: "seat_busy", message: "the seat is busy" }),
  };
  const svc = new ProviderServiceImpl({ db: {} as never, listRigs: () => [], claudePrecedence: async () => CLEAR,
    claudeConfigDirProbe: async () => ({ state: "logged_in", email: null, subscriptionType: "max" }) });
  const seatRestart = { plan: async () => { throw new Error("unused"); }, run: async () => { throw new Error("unused"); } };
  const move = () => svc.switchAccount({ seat: SEAT, toAccount: "max", configDir: target, forceUnsafe: false }, seatRestart, claudeSeat);
  return { rig, node, move };
}

describe("a refused relaunch restores the member's own CLAUDE_CONFIG_DIR, not the rig's", () => {
  it("the rig declares it and the member declares nothing: the member's env is empty again and the rig's is untouched", async () => {
    const f = fixture({ rig: { CLAUDE_CONFIG_DIR: "/homes/rig-claude", OTHER: "kept" } });
    const r = await f.move();
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["relaunch_seat_busy"] });
    expect(memberEnv(f.node.id)).toBeNull();
    expect(JSON.parse(rigEnv(f.rig.id)!)).toEqual({ CLAUDE_CONFIG_DIR: "/homes/rig-claude", OTHER: "kept" });
  });

  it("the member declares it (and the rig another): restored exactly, other member variables kept", async () => {
    const f = fixture({ rig: { CLAUDE_CONFIG_DIR: "/homes/rig-claude" }, member: { CLAUDE_CONFIG_DIR: "/homes/member-claude", KEEP: "me" } });
    const r = await f.move();
    expect(r).toMatchObject({ outcome: "failed_safely" });
    expect(JSON.parse(memberEnv(f.node.id)!)).toEqual({ CLAUDE_CONFIG_DIR: "/homes/member-claude", KEEP: "me" });
  });

  it("a member value that isn't an absolute path (the seat sets it aside) is still restored exactly", async () => {
    const f = fixture({ rig: { CLAUDE_CONFIG_DIR: "/homes/rig-claude" }, member: { CLAUDE_CONFIG_DIR: "relative/claude" } });
    await f.move();
    expect(JSON.parse(memberEnv(f.node.id)!)).toEqual({ CLAUDE_CONFIG_DIR: "relative/claude" });
  });

  it("nobody declares it: the member's env is empty again", async () => {
    const f = fixture({});
    await f.move();
    expect(memberEnv(f.node.id)).toBeNull();
  });

  it("while the relaunch runs the member holds the target dir (the write happened), so the test can fail", async () => {
    const f = fixture({ rig: { CLAUDE_CONFIG_DIR: "/homes/rig-claude" } });
    let during: string | null = "unset";
    const hooks = claudeSeatConfigDirHooks(rigRepo);
    const spy: ClaudeSeatRelaunch = { seat: () => ({ nodeId: f.node.id, rigId: f.rig.id, rigName: "rig", logicalId: "dev-a", running: true, pane: "%1" }),
      tokenRef: () => null, setTokenRef: () => {}, ...hooks, canResumeInConfigDir: () => true,   // the gate has its own tests
      snapshot: () => ({ snapshotId: "s", resumes: true as const, conversation: null }), exclusive: (_n, fn) => fn(),
      relaunchInPane: async () => { during = memberEnv(f.node.id); return { ok: false, effect: "none", code: "x", message: "m" }; } };
    const svc = new ProviderServiceImpl({ db: {} as never, listRigs: () => [], claudePrecedence: async () => CLEAR,
      claudeConfigDirProbe: async () => ({ state: "logged_in", email: null, subscriptionType: "max" }) });
    await svc.switchAccount({ seat: SEAT, toAccount: "max", configDir: path.join(root, "target"), forceUnsafe: false }, { plan: async () => { throw new Error("u"); }, run: async () => { throw new Error("u"); } }, spy);
    expect(JSON.parse(during!)).toEqual({ CLAUDE_CONFIG_DIR: path.join(root, "target") });
    expect(memberEnv(f.node.id)).toBeNull();
  });
});
