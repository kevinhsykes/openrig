import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// P20 — R6h stop-contract fork patch (docs/reference/R6h-stop-contract.md, sha256
// e17d4fd8a9531a6138c2bf337ede97fe537dbb840179ad4095155e38aef7fc8f). §4 acceptance
// cases as scoped to the fork CAN list (§6): R1 generation keying (pair per §1.3a),
// R2 over the DB surfaces (a)/(b) + drain snapshot, R3 promptness, R4 source pins,
// R5.1/R6 idempotence, and the §5.3c capability echo. The race seam (B4→B5) is
// exercised with the harness's mid-flight hooks: every new-occupant path inserts a
// session row and mints the tenure in one synchronous turn (session-registry
// registerSession/registerClaimedSession), so the final-transaction selection()
// re-check fences any interleaved handover — serialized single-writer SQLite.
describe("P20 R6h stop-contract (checked stop)", () => {
  let db: Database.Database;
  let repo: RigRepository;
  let registry: SessionRegistry;
  let bus: EventBus;
  let adapter: TmuxAdapter;
  let service: SeatLifecycleService;
  let commands: string[];
  let onProbe: (() => void) | undefined;
  let onPanes: (() => void) | undefined;
  let onDetach: (() => void) | undefined;
  let onKill: (() => void) | undefined;
  let absentAfterKill = false;
  let node: ReturnType<RigRepository["addNode"]>;
  let name: string;
  let session: ReturnType<SessionRegistry["registerSession"]>;

  beforeEach(() => {
    db = createFullTestDb();
    db.exec(outboxEntriesSchema.sql);
    db.exec(seatDeliveryGuardSchema.sql);
    repo = new RigRepository(db);
    registry = new SessionRegistry(db);
    bus = new EventBus(db);
    commands = [];
    onProbe = onPanes = onDetach = onKill = undefined;
    absentAfterKill = false;
    adapter = new TmuxAdapter(async command => {
      commands.push(command);
      if (command.includes("has-session")) { if (absentAfterKill) throw new Error(`can't find session: ${name}`); onProbe?.(); return ""; }
      if (command.includes("list-panes")) { onPanes?.(); return "%1|0|/project|120|40|1"; }
      if (command.includes("display-message")) return "$7";
      if (command.includes("detach-client")) { onDetach?.(); return ""; }
      if (command.includes("kill-session")) { onKill?.(); absentAfterKill = true; return ""; }
      throw new Error(`unexpected tmux command: ${command}`);
    });
    adapter.deliveryGuard = new SeatDeliveryGuard(db, n => resolveGuardTarget(db, n));
    service = new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: registry, eventBus: bus, tmuxAdapter: adapter });
    const rig = repo.createRig("checked");
    node = repo.addNode(rig.id, "dev.a", { runtime: "claude-code", cwd: "/project" });
    name = "dev-a@checked";
    session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: name, tmuxPane: "%1" });
  });
  afterEach(() => db.close());

  const gen = () => registry.currentOccupantTenure(node.id)?.generationUuid ?? null;
  const precondition = () => {
    const pre = service.stopPrecondition(name);
    if (!("contract" in pre)) throw new Error(pre.message);
    return pre.expected;
  };
  const stop = (expected: unknown) => service.stopSeat({ seatRef: name, reason: "p20 contract", expected });
  const events = () => db.prepare("SELECT type, payload FROM events WHERE type='session.stopped'").all() as { type: string; payload: string }[];
  const seedClaimedRow = (generation: string, qitemId: string) => {
    db.prepare(
      "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, claimed_by_generation_uuid) VALUES (?, ?, ?, ?, ?, 'in-progress', 'p20 fixture', ?)",
    ).run(qitemId, new Date().toISOString(), new Date().toISOString(), name, name, generation);
  };

  it("(a) unsettled generation refuses generation_not_settled naming surfaces; drained stop succeeds and records the drain snapshot", async () => {
    const generation = gen();
    expect(generation).toBeTruthy();
    seedClaimedRow(generation!, "qitem-p20-a1");
    db.prepare("INSERT INTO queue_transition_wakes (qitem_id, phase, wake_kind, wake_ref) VALUES (?, 'armed', 'watchdog', 'p20-a1')").run("qitem-p20-a1");
    const unsettled = await stop({ ...precondition(), occupantGeneration: generation });
    expect(unsettled).toMatchObject({ ok: false, code: "generation_not_settled" });
    expect(String(unsettled.message)).toContain("claimed_rows=1");
    expect(String(unsettled.message)).toContain("pending_wakes=1");
    expect(String(unsettled.message)).toContain("unobserved"); // (c)/(d) honesty, §5.2
    expect(commands.filter(c => c.includes("kill-session") || c.includes("detach-client"))).toEqual([]); // must not kill
    // drain: close the row (its wake disarm/deletion follows the row's close)
    db.prepare("UPDATE queue_items SET state='done', closure_reason='drained', claimed_by_generation_uuid=NULL WHERE qitem_id='qitem-p20-a1'").run();
    db.prepare("DELETE FROM queue_transition_wakes WHERE qitem_id='qitem-p20-a1'").run();
    const drained = await stop({ ...precondition(), occupantGeneration: generation });
    expect(drained).toMatchObject({ ok: true, sessionName: name, sessionId: session.id, enforcedOccupantGeneration: generation });
    expect(commands.some(c => c.includes("kill-session"))).toBe(true);
    const stopped = events();
    expect(stopped).toHaveLength(1);
    expect(JSON.parse(stopped[0].payload).drain).toMatchObject({ generation, claimedRows: 0, pendingWakes: 0, schemaKnown: true, guardLeases: null, stagedTyping: null });
    expect(registry.getBindingForNode(node.id)).toBeNull();
  });

  it("(a/R2.3a) column-absent schema makes settle UNKNOWN and refuses — never 'settled'", async () => {
    db.exec("ALTER TABLE queue_items DROP COLUMN claimed_by_generation_uuid");
    const before = commands.length;
    const result = await stop(precondition());
    expect(result).toMatchObject({ ok: false, code: "generation_not_settled" });
    expect(String(result.message)).toContain("UNKNOWN");
    expect(commands.slice(before).filter(c => c.includes("kill-session") || c.includes("detach-client"))).toEqual([]);
  });

  it("(b) generation N never touches N+1: mid-flight handover refuses before the kill", async () => {
    const generation = gen();
    onPanes = () => { onPanes = undefined; const successor = registry.registerSession(node.id, name); registry.updateStatus(successor.id, "running"); }; // successor tenure minted pre-boundary
    const result = await stop({ nodeId: node.id, sessionId: session.id, occupantGeneration: generation });
    expect(result).toMatchObject({ ok: false, code: "selection_changed", occupantGeneration: gen() });
    expect(result.occupantGeneration).not.toBe(generation); // refusal names the LIVE generation (R5.2)
    expect(commands.some(c => c.includes("kill-session"))).toBe(false);
    const successor = (db.prepare("SELECT status FROM sessions WHERE id != ? AND node_id = ?").get(session.id, node.id) as { id: string; status: string });
    expect(successor.status).toBe("running"); // untouched
    expect(registry.getBindingForNode(node.id)?.tmuxSession).toBe(name);
  });

  it("(b/h-i) a fabricated generation is selection_changed, a malformed one invalid_stop_precondition — both kill nothing", async () => {
    const fabricated = "00000000-0000-4000-8000-000000000000";
    const refused = await stop({ nodeId: node.id, sessionId: session.id, occupantGeneration: fabricated });
    expect(refused).toMatchObject({ ok: false, code: "selection_changed" });
    expect(commands).toEqual([]);
    const malformed = await stop({ nodeId: node.id, sessionId: session.id, occupantGeneration: "not-a-uuid" });
    expect(malformed).toMatchObject({ ok: false, code: "invalid_stop_precondition" });
    expect(commands).toEqual([]);
  });

  it("(c) already-exited is prompt: one probe, no retry loop, no writes", async () => {
    absentAfterKill = true; // tmux positively reports absence for the seat's session
    const result = await stop(precondition());
    expect(result).toMatchObject({ ok: false, code: "session_not_live" });
    expect(commands.filter(c => c.includes("has-session")).length).toBeLessThanOrEqual(2); // probe + no retry loop (the detach sequence re-probes once at most)
    expect(commands.some(c => c.includes("kill-session") || c.includes("detach-client"))).toBe(false);
    expect(events()).toHaveLength(0);
    expect(registry.getBindingForNode(node.id)?.tmuxSession).toBe(name);
  });

  it("(d) hold-mode refusal leaves the seat byte-identical", async () => {
    await adapter.deliveryGuard!.set(node.id, { mode: "hold" }, "operator", "protect draft");
    const before = {
      session: db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id),
      binding: registry.getBindingForNode(node.id),
      eventCount: (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
    };
    const result = await stop(precondition());
    expect(result).toMatchObject({ ok: false, code: "typing_guard_enabled" });
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id)).toEqual(before.session);
    expect(registry.getBindingForNode(node.id)).toEqual(before.binding);
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(before.eventCount);
    expect(commands).toEqual([]);
  });

  it("(e-ii) source pin: the stop chain resolves killSession only through stopManagedTmuxSeat and never passes override", () => {
    // R4.2 scoped pin: the CHAIN stopSeat/stopSeatChecked -> stopManagedTmuxSeat -> killSession.
    const src = readFileSync(join(import.meta.dirname, "../src/domain/seat-lifecycle-service.ts"), "utf8");
    const entriesStart = src.indexOf("async stopSeat(input:");
    const entriesEnd = src.indexOf("async cleanSeat(input:");
    const effectStart = src.indexOf("private async stopManagedTmuxSeat(");
    const effectEnd = src.indexOf("private nonTerminalSessions(");
    expect(entriesStart).toBeGreaterThan(0);
    expect(entriesEnd).toBeGreaterThan(entriesStart);
    expect(effectStart).toBeGreaterThan(entriesEnd);
    expect(effectEnd).toBeGreaterThan(effectStart);
    // Entry surfaces: no kill at all before the shared effect, and no guard bypass.
    const entries = src.slice(entriesStart, entriesEnd);
    expect(entries).not.toContain("killSession(");
    expect(entries).not.toContain("override:"); // R4.1: no guard bypass in the chain
    // The single effect site: killSession reached only here, via the adapter.
    const effect = src.slice(effectStart, effectEnd);
    // the ONE effect site, written twice by the checked/unchecked ternary; no other killSession here
    expect(effect.match(/killSession\(/g)?.length).toBe(2);
    expect(effect.match(/this\.tmuxAdapter\.killSession\(/g)?.length).toBe(2);
    expect(effect).not.toContain("override:");
    expect(entries).toContain("occupantGeneration"); // the R1 pair lives in this chain's selection()
    expect(entries).toContain("stopManagedTmuxSeat(");
  });

  it("(f) idempotence: second stop is already-exited, one event, one binding clear, at most one extra probe", async () => {
    const first = await stop(precondition());
    expect(first).toMatchObject({ ok: true });
    const probesAfterFirst = commands.filter(c => c.includes("has-session")).length;
    const second = await stop(precondition());
    expect(second).toMatchObject({ ok: false, code: "session_not_live" });
    expect(commands.filter(c => c.includes("has-session")).length - probesAfterFirst).toBeLessThanOrEqual(2);
    expect(events()).toHaveLength(1);
    const third = await stop(precondition());
    expect(third).toMatchObject({ ok: false, code: "session_not_live" }); // identical response shape
    expect(registry.getBindingForNode(node.id)).toBeNull();
  });

  it("(g) refusals carry the live generation for retry visibility", async () => {
    const generation = gen();
    seedClaimedRow(generation!, "qitem-p20-g1");
    const unsettled = await stop({ ...precondition(), occupantGeneration: generation });
    expect(unsettled).toMatchObject({ ok: false, code: "generation_not_settled", occupantGeneration: generation });
    const stale = await stop({ nodeId: node.id, sessionId: session.id, occupantGeneration: "00000000-0000-4000-8000-000000000000" });
    expect(stale).toMatchObject({ ok: false, code: "selection_changed" });
    expect(typeof stale.occupantGeneration).toBe("string");
  });

  it("race seam B4→B5: a handover that completes during the kill is fenced by the final-transaction selection and never cleared", async () => {
    const generation = gen();
    // The hook runs inside the adapter's killSession (the B4 await); the successor's session row +
    // tenure mint happen there — the exact interleaving window. The stop must refuse at B5 without
    // clearing the successor's world: single-writer SQLite serializes the handover's insert+mint
    // turn against this transaction, and selection() sees the moved latest session.
    onKill = () => { const successor = registry.registerSession(node.id, name); registry.updateStatus(successor.id, "running"); };
    const result = await stop({ nodeId: node.id, sessionId: session.id, occupantGeneration: generation });
    expect(result).toMatchObject({ ok: false, code: "selection_changed", partialEffect: true, stopPhase: "kill_attempted" });
    expect(result.occupantGeneration).toBe(gen()); // the successor's live generation, not N
    const successor = (db.prepare("SELECT status FROM sessions WHERE id != ? AND node_id = ?").get(session.id, node.id) as { status: string });
    expect(successor.status).toBe("running");
    expect(registry.getBindingForNode(node.id)?.tmuxSession).toBe(name); // not cleared
    expect(events()).toHaveLength(0); // no session.stopped for N
    expect(status(session.id)).toBe("running");
  });

  function status(id: string) {
    return (db.prepare("SELECT status FROM sessions WHERE id=?").get(id) as { status: string }).status;
  }
});
