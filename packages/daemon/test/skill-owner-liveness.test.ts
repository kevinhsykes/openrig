import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ownerLiveness } from "../src/domain/skill-owner-liveness.js";
import { skillsRoutes } from "../src/routes/skills.js";

/** P37b: is the seat that owns a kept skill selection still there? Anything unclear reads "unknown", which callers treat as live. */
describe("ownerLiveness", () => {
  let db: Database.Database; let repo: RigRepository; let sessions: SessionRegistry;
  beforeEach(() => { db = createFullTestDb(); repo = new RigRepository(db); sessions = new SessionRegistry(db); });
  afterEach(() => { db.close(); });
  const seat = (rigName: string, logicalId: string, statuses: string[]) => {
    const rig = repo.findRigsByName(rigName)[0] ?? repo.createRig(rigName);
    const node = repo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    statuses.forEach((status, i) => { const s = sessions.registerSession(node.id, `${logicalId.replace(".", "-")}@${rigName}`); db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, s.id); void i; });
    return { rig, node };
  };

  it("a seat with a running session is live", () => {
    seat("kernel", "operator.agent", ["running"]);
    expect(ownerLiveness(db, ["operator-agent@kernel"])).toEqual({ "operator-agent@kernel": { state: "live" } });
  });
  it("a stopped seat, or one never launched, is live: it comes back and selects again", () => {
    seat("r", "dev.a", ["exited"]);
    seat("r", "dev.b", []);
    expect(ownerLiveness(db, ["dev-a@r", "dev-b@r"])).toEqual({ "dev-a@r": { state: "live" }, "dev-b@r": { state: "live" } });
  });
  it("a seat whose every session was superseded is orphaned", () => {
    seat("r", "dev.a", ["superseded", "superseded"]);
    expect(ownerLiveness(db, ["dev-a@r"])["dev-a@r"]).toEqual({ state: "orphaned", reason: "dev-a@r has only superseded sessions" });
  });
  it("one live session among superseded ones keeps the seat live", () => {
    seat("r", "dev.a", ["superseded", "running"]);
    expect(ownerLiveness(db, ["dev-a@r"])["dev-a@r"]).toEqual({ state: "live" });
  });
  it("two nodes answer to one name (a replaced rig of the same name): one live node keeps the owner live", () => {
    repo.createRig("r"); repo.createRig("r");
    const [first, second] = repo.findRigsByName("r");
    for (const [rig, status] of [[first!, "superseded"], [second!, "running"]] as const) {
      const node = repo.addNode(rig.id, "dev.a", { runtime: "claude-code" });
      const session = sessions.registerSession(node.id, "dev-a@r");
      db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, session.id);
    }
    expect(ownerLiveness(db, ["dev-a@r"])["dev-a@r"]).toEqual({ state: "live" });
  });
  it("an owner no node answers to is orphaned, naming the owner (the dev-claude@kpc-fleet case: only workers-dev-claude exists)", () => {
    seat("kpc-fleet", "workers.dev-claude", ["exited", "superseded"]);
    expect(ownerLiveness(db, ["dev-claude@kpc-fleet"])["dev-claude@kpc-fleet"]).toEqual({ state: "orphaned", reason: "no node named dev-claude@kpc-fleet in any rig" });
    expect(ownerLiveness(db, ["workers-dev-claude@kpc-fleet"])["workers-dev-claude@kpc-fleet"].state).toBe("live");
  });
  it("a seat only in an archived rig is orphaned", () => {
    const { rig } = seat("old", "dev.a", ["exited"]);
    db.prepare("UPDATE rigs SET archived_at = datetime('now') WHERE id = ?").run(rig.id);
    expect(ownerLiveness(db, ["dev-a@old"])["dev-a@old"]).toEqual({ state: "orphaned", reason: "dev-a@old exists only in an archived rig" });
  });
  it("an owner that is not a seat identity is unknown, never orphaned", () => {
    expect(ownerLiveness(db, ["workspace"])["workspace"]).toEqual({ state: "unknown", reason: "not a seat identity" });
  });
  it("a state read that fails is unknown for every owner (fail closed)", () => {
    db.exec("DROP TABLE sessions");
    const out = ownerLiveness(db, ["dev-a@r", "x@y"]);
    expect(Object.values(out).map((o) => o.state)).toEqual(["unknown", "unknown"]);
  });
});

describe("GET /api/skills/owners", () => {
  it("answers per owner, deduplicated, and refuses an empty or oversized ask", async () => {
    const db = createFullTestDb();
    try {
      const app = new Hono();
      app.use("*", async (c, next) => { c.set("db" as never, db as never); await next(); });
      app.route("/api/skills", skillsRoutes());
      const ok = await app.request("/api/skills/owners?owner=a%40nowhere&owner=a%40nowhere");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ owners: { "a@nowhere": { state: "orphaned", reason: "no node named a@nowhere in any rig" } } });
      expect((await app.request("/api/skills/owners")).status).toBe(400);
      expect((await app.request(`/api/skills/owners?owner=${"x".repeat(201)}`)).status).toBe(400);
    } finally { db.close(); }
  });
});
