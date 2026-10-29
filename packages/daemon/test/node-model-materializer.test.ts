import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeModelMaterializer } from "../src/domain/node-model-materializer.js";
import type { RunCommand } from "../src/domain/model-resolver.js";

/** P25 slice 3a: a rail request becomes the literal model at launch, or the launch is refused with the resolver's reason. */
const ok = (launch: string, extra: Record<string, unknown> = {}): RunCommand => async () => ({ code: 0, stdout: JSON.stringify({ refuse: false, pick: { launch, ...extra } }), stderr: "", timedOut: false });
const refuse: RunCommand = async () => ({ code: 3, stdout: JSON.stringify({ refuse: true, requested_verdict: "EXHAUSTED", requested_reason: "no window left" }), stderr: "", timedOut: false });

describe("NodeModelMaterializer (P25)", () => {
  let db: Database.Database; let repo: RigRepository; let bus: EventBus; let rigId: string;
  beforeEach(() => { db = createFullTestDb(); repo = new RigRepository(db); bus = new EventBus(db); rigId = repo.createRig("r").id; });
  afterEach(() => { db.close(); });
  const make = (run: RunCommand, installed?: (n: string, r: string | null, m: string) => boolean | null) =>
    new NodeModelMaterializer({ db, rigRepo: repo, eventBus: bus, resolver: { argv: ["resolver", "{rail}"], run, now: () => new Date("2026-10-29T00:00:00Z") }, ...(installed ? { installed } : {}) });
  const seat = (name = "dev.a") => repo.addNode(rigId, name, { runtime: "pi", modelRequest: "rail:minimax" });
  const row = (id: string) => db.prepare("SELECT model, model_request AS q, model_resolution_json AS r FROM nodes WHERE id = ?").get(id) as { model: string | null; q: string | null; r: string | null };
  const events = () => (db.prepare("SELECT payload FROM events WHERE type = 'node.model_changed'").all() as Array<{ payload: string }>).map((e) => JSON.parse(e.payload));

  it("a seat with no request is untouched and the resolver is never called", async () => {
    const lit = repo.addNode(rigId, "dev.lit", { runtime: "pi", model: "a/b" });
    const run = vi.fn(ok("x/y"));
    expect(await make(run).materialize(lit.id)).toEqual({ ok: true, changed: false, model: "a/b" });
    expect(run).not.toHaveBeenCalled();
    expect(row(lit.id)).toEqual({ model: "a/b", q: null, r: null });
  });

  it("resolves the rail, writes the literal and its provenance together, and records one event", async () => {
    const n = seat();
    const out = await make(ok("minimax/MiniMax-M3", { effort: "high" })).materialize(n.id);
    expect(out).toMatchObject({ ok: true, changed: true, model: "minimax/MiniMax-M3" });
    const r = row(n.id);
    expect(r.model).toBe("minimax/MiniMax-M3");
    expect(r.q).toBe("rail:minimax");
    expect(JSON.parse(r.r!)).toMatchObject({ requested: "rail:minimax", model: "minimax/MiniMax-M3", effort: "high", resolvedAt: "2026-10-29T00:00:00.000Z" });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ from: null, to: "minimax/MiniMax-M3" });
  });

  it("a resolver that refuses writes nothing and names the reason", async () => {
    const n = seat();
    const out = await make(refuse).materialize(n.id);
    expect(out).toMatchObject({ ok: false, code: "model_rail_gate_refused" });
    expect((out as { message: string }).message).toContain("EXHAUSTED");
    expect(row(n.id).model).toBeNull();
    expect(row(n.id).r).toBeNull();
    expect(events()).toHaveLength(0);
  });

  it("a refusal never falls back to the previous model", async () => {
    const n = seat();
    await make(ok("minimax/MiniMax-M3")).materialize(n.id);
    const out = await make(refuse).materialize(n.id);
    expect(out.ok).toBe(false);
    expect(row(n.id).model).toBe("minimax/MiniMax-M3");   // untouched, and the caller is told not to launch
  });

  it("an unreachable resolver is its own named failure", async () => {
    const n = seat();
    const out = await make(async () => ({ code: null, stdout: "", stderr: "", timedOut: false, startError: "ENOENT" })).materialize(n.id);
    expect(out).toMatchObject({ ok: false, code: "model_rail_unresolved" });
    expect(row(n.id).model).toBeNull();
  });

  it("a model the seat cannot start is refused, whether the list says no or cannot be read", async () => {
    const n = seat();
    for (const verdict of [false, null]) {
      const out = await make(ok("minimax/MiniMax-M3"), () => verdict).materialize(n.id);
      expect(out).toMatchObject({ ok: false, code: "model_not_installed" });
      expect(row(n.id).model).toBeNull();
    }
    expect(await make(ok("minimax/MiniMax-M3"), () => true).materialize(n.id)).toMatchObject({ ok: true, changed: true });
  });

  it("resolving to the model already held records no second event", async () => {
    const n = seat();
    const m = make(ok("minimax/MiniMax-M3"));
    await m.materialize(n.id);
    expect(await m.materialize(n.id)).toMatchObject({ ok: true, changed: true });
    expect(events()).toHaveLength(1);
  });

  it("hasRequest is true only for a seat that asked for a rail", () => {
    const lit = repo.addNode(rigId, "dev.l", { runtime: "pi", model: "a/b" });
    expect(make(ok("x/y")).hasRequest(seat("dev.r").id)).toBe(true);
    expect(make(ok("x/y")).hasRequest(lit.id)).toBe(false);
  });
});
