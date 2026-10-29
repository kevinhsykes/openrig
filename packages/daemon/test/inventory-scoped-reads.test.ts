import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ASSIGNED_WORK_COVERING_HINT, ASSIGNED_WORK_SQL, getNodeInventory, readAssignedWorkBySession } from "../src/domain/node-inventory.js";
import { buildOrientedMap } from "../src/domain/startup-proof.js";

// P23: GET /api/rigs/:id/nodes read the queue and the startup-proof history of EVERY rig on every call. On a cold cache
// each is hundreds of random page reads (measured: ~50 ms and ~65-105 ms per call on a 272 MB database). Both reads now
// take the rig's own keys/nodes, and must return exactly what the unscoped read returns for them.
function fixture() {
  const db = createFullTestDb();
  const repo = new RigRepository(db);
  const a = repo.createRig("alpha"), b = repo.createRig("beta");
  const na = repo.addNode(a.id, "dev.a", { runtime: "claude-code" });
  const nb = repo.addNode(b.id, "dev.b", { runtime: "claude-code" });
  const qitem = (id: string, dest: string, state: string) => db.prepare(
    "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES (?, ?, ?, 'x@y', ?, ?, 'b')",
  ).run(id, "2026-10-28T00:00:00Z", "2026-10-28T00:00:00Z", dest, state);
  qitem("q1", "dev-a@alpha", "pending"); qitem("q2", "dev-a@alpha", "in-progress"); qitem("q3", "dev-b@beta", "blocked");
  qitem("q4", "dev-b@beta", "done"); qitem("q5", "other@elsewhere", "pending");
  const ev = (nodeId: string, rigId: string, type: string, payload: object) => db.prepare(
    "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)").run(rigId, nodeId, type, JSON.stringify(payload));
  ev(na.id, a.id, "node.startup_challenged", { challengeId: "c1", nonce: "n1" });
  ev(nb.id, b.id, "node.startup_challenged", { challengeId: "c2", nonce: "n2" });
  return { db, a, b, na, nb };
}

describe("rig-scoped inventory reads (P23)", () => {
  it("the active-work read uses the covering index and returns what the plain query returns", () => {
    const { db } = fixture();
    try {
      const plan = db.prepare("EXPLAIN QUERY PLAN " + ASSIGNED_WORK_SQL(ASSIGNED_WORK_COVERING_HINT)).all().map(r => (r as { detail: string }).detail).join(" | ");
      expect(plan).toContain("COVERING INDEX idx_queue_items_destination_state");   // RED if the hint is dropped
      const plain = db.prepare(ASSIGNED_WORK_SQL("")).all();
      const hinted = db.prepare(ASSIGNED_WORK_SQL(ASSIGNED_WORK_COVERING_HINT)).all();
      expect(new Set(hinted.map(r => JSON.stringify(r)))).toEqual(new Set(plain.map(r => JSON.stringify(r))));
      const map = readAssignedWorkBySession(db);
      expect(map.get("dev-a@alpha")).toMatchObject({ assignedWorkCount: 2, pendingWorkCount: 1, inProgressWorkCount: 1 });
      expect(map.get("dev-b@beta")).toMatchObject({ assignedWorkCount: 1, blockedWorkCount: 1 });
    } finally { db.close(); }
  });

  it("a database without that index still answers", () => {
    const { db } = fixture();
    try {
      db.exec("DROP INDEX idx_queue_items_destination_state");
      expect(readAssignedWorkBySession(db).get("dev-a@alpha")).toMatchObject({ assignedWorkCount: 2 });
    } finally { db.close(); }
  });

  it("the oriented map scoped to a rig has that rig's nodes, with the same value as the fleet map", () => {
    const { db, a, na, nb } = fixture();
    try {
      const fleet = buildOrientedMap(db);
      const scoped = buildOrientedMap(db, a.id);
      expect([...scoped.keys()]).toEqual([na.id]);                                // RED if the filter is dropped
      expect(scoped.get(na.id)).toEqual(fleet.get(na.id));
      expect(fleet.has(nb.id)).toBe(true);
    } finally { db.close(); }
  });

  it("a single-rig inventory read prepares only the rig-scoped proof query", () => {
    const { db, a, na } = fixture();
    try {
      const seen: string[] = [];
      const real = db.prepare.bind(db);
      (db as unknown as { prepare: unknown }).prepare = (sql: string) => { seen.push(sql); return real(sql); };
      const entries = getNodeInventory(db, a.id);
      expect(entries.map(e => e.nodeId)).toEqual([na.id]);
      const proofQueries = seen.filter(sql => sql.includes("'node.startup_challenged'") && sql.includes("ORDER BY node_id"));
      expect(proofQueries.length).toBeGreaterThan(0);
      expect(proofQueries.every(sql => sql.includes("rig_id = ?"))).toBe(true);   // RED if getNodeInventory stops passing the rig
    } finally { db.close(); }
  });
});
