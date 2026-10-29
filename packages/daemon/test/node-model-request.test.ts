import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, migrationsForFullTestDb } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { nodeModelRequestSchema } from "../src/db/migrations/142_node_model_request.js";
import { RigRepository } from "../src/domain/rig-repository.js";

/**
 * P25: a seat that asks for its model by rail. `model_request` holds the canonical request, `nodes.model` stays the literal
 * the seat launches with (NULL until the first launch resolves it), and `model_resolution_json` records where that literal came
 * from. Existing seats are untouched.
 */
describe("nodes.model_request (P25)", () => {
  let db: Database.Database;
  let repo: RigRepository;
  let rigId: string;
  beforeEach(() => {
    db = createFullTestDb();
    repo = new RigRepository(db);
    rigId = repo.createRig("r").id;
  });
  afterEach(() => { db.close(); });

  it("a seat that names a literal model has no request and no resolution, as every seat did before", () => {
    const n = repo.addNode(rigId, "dev.a", { runtime: "claude-code", model: "opus" });
    expect(repo.getNodeModelRequest(n.id)).toEqual({ request: null, resolutionJson: null });
    expect((db.prepare("SELECT model FROM nodes WHERE id = ?").get(n.id) as { model: string }).model).toBe("opus");
  });

  it("a rail request is stored, and nodes.model stays NULL until a launch resolves it", () => {
    const n = repo.addNode(rigId, "dev.b", { runtime: "pi", modelRequest: "rail:minimax" });
    expect(repo.getNodeModelRequest(n.id).request).toBe("rail:minimax");
    expect((db.prepare("SELECT model FROM nodes WHERE id = ?").get(n.id) as { model: string | null }).model).toBeNull();
  });

  it("a seat cannot name both a literal model and a request, and the refusal leaves no node behind", () => {
    expect(() => repo.addNode(rigId, "dev.c", { runtime: "pi", model: "x/y", modelRequest: "rail:minimax" })).toThrow(/not both/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id = 'dev.c'").get()).toEqual({ c: 0 });
  });

  it("setNodeModelResolution writes the launch value and its provenance together, and only for a seat with a request", () => {
    const req = repo.addNode(rigId, "dev.d", { runtime: "pi", modelRequest: "rail:minimax" });
    const lit = repo.addNode(rigId, "dev.e", { runtime: "pi", model: "a/b" });
    expect(repo.setNodeModelResolution(req.id, "minimax/MiniMax-M3", '{"resolved":"minimax/MiniMax-M3"}')).toBe(true);
    expect(db.prepare("SELECT model, model_resolution_json AS r, model_request AS q FROM nodes WHERE id = ?").get(req.id))
      .toEqual({ model: "minimax/MiniMax-M3", r: '{"resolved":"minimax/MiniMax-M3"}', q: "rail:minimax" });
    expect(repo.setNodeModelResolution(lit.id, "z/z", "{}")).toBe(false);
    expect((db.prepare("SELECT model FROM nodes WHERE id = ?").get(lit.id) as { model: string }).model).toBe("a/b");
  });

  it("a database without migration 142 reads as 'no request' and refuses to store one by name", () => {
    const old = createDb();
    migrate(old, migrationsForFullTestDb.filter((m) => m !== nodeModelRequestSchema));
    const r = new RigRepository(old);
    const rig = r.createRig("old");
    const n = r.addNode(rig.id, "dev.f", { runtime: "pi", model: "m" });
    expect(r.getNodeModelRequest(n.id)).toEqual({ request: null, resolutionJson: null });
    expect(r.setNodeModelResolution(n.id, "x", "{}")).toBe(false);
    expect(() => r.addNode(rig.id, "dev.g", { runtime: "pi", modelRequest: "rail:minimax" })).toThrow(/migration 142/);
    old.close();
  });

  it("migration 142 is additive: existing rows stay NULL", () => {
    const d = createDb();
    migrate(d, migrationsForFullTestDb.filter((m) => m !== nodeModelRequestSchema));
    const r = new RigRepository(d);
    const rig = r.createRig("pre");
    r.addNode(rig.id, "dev.h", { runtime: "pi", model: "m" });
    migrate(d, migrationsForFullTestDb);
    expect(d.prepare("SELECT model, model_request AS q, model_resolution_json AS r FROM nodes").get()).toEqual({ model: "m", q: null, r: null });
    d.close();
  });
});
