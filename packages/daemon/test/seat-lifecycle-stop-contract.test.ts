import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SelfAttachService } from "../src/domain/self-attach-service.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// P20 — R6h stop-contract fork patch (docs/reference/R6h-stop-contract.md, sha256
// e17d4fd8a9531a6138c2bf337ede97fe537dbb840179ad4095155e38aef7fc8f). §4 acceptance
// cases as scoped to the fork CAN list (§6): R1 generation keying (pair per §1.3a),
// R2 over the DB surfaces (a)/(b) + drain snapshot, R3 promptness, R4 source pins,
// R5.1/R6 idempotence, and the §5.3c capability echo.
//
// THE FENCE (corrected in P20b; the f9655a22c header claimed single-writer SQLite +
// "one JS turn" and that was the wrong mechanism): what serializes a checked stop
// against every in-process new-occupant path is the SeatDeliveryGuard PER-NODE SERIAL
// LEASE. The stop holds guard.lifecycle([nodeId]) from its in-lease selection()
// through the awaited tmux kill (killSession joins the same lease via guardedInput)
// and the final transaction; launchNode, handover, runtime-switch, claim/bind and
// restore take the same lease, so none of them can mint while the kill is in flight.
// Side fences outside the lease: claim reconcileSession commits through
// guard.reconcileBinding, which REFUSES while the node's tail is hot; self-attach
// refuses already_bound while a binding exists (attachToNode reads the binding and writes in one
// synchronous turn), and a checked stop of an UNBOUND node refuses before any effect. NOT fenced, named: a SECOND daemon process on the same
// DB (tails/leases are per-process) and humans running tmux directly. The B4→B5 test
// below is therefore a FAIL-SAFE demonstration (the final-transaction selection()
// fences the RECORD; it cannot un-kill tmux), not the fence itself.
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
  let absentNames = new Set<string>();
  let killGate: { promise: Promise<void>; release: () => void } | undefined;
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
    absentNames = new Set<string>();
    killGate = undefined;
    adapter = new TmuxAdapter(async command => {
      commands.push(command);
      const argv = Array.isArray(command) ? command.map(String) : String(command).split(/\s+/);
      const tAt = argv.indexOf("-t");
      const target = tAt >= 0 ? argv[tAt + 1]?.replace(/^'+|'+$/g, "") : undefined; // strip shellQuote's quotes
      if (argv.includes("has-session")) {
        const bare = target?.startsWith("=") ? target.slice(1) : target;
        if (bare !== undefined && absentNames.has(bare)) throw new Error(`can't find session: ${target}`);
        onProbe?.(); return "";
      }
      if (argv.includes("list-panes")) { onPanes?.(); return "%1|0|/project|120|40|1"; }
      if (argv.includes("display-message")) return "$7";
      if (argv.includes("detach-client")) { onDetach?.(); return ""; }
      if (argv.includes("kill-session")) { onKill?.(); absentNames.add(name); // the kill targets the immutable $N; the seat's session NAME is what has-session then reports absent
        if (killGate) await killGate.promise; return ""; }
      if (argv.includes("new-session")) return "%2"; // -P -F #{pane_id}
      if (argv.includes("show-environment") || argv.includes("set-environment")) return ""; // global env empty; no inherited identity
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
    absentNames.add(name); // tmux positively reports absence for the seat's session
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

  it("unguarded mint B4→B5: record fenced, kill not — the final-transaction selection is a fail-safe, not the fence", async () => {
    const generation = gen();
    // A DIRECT registry call (no real path can do this while the lease is held) mints a successor
    // inside the kill's await. This demonstrates what B5 guarantees — the RECORD is fenced: the
    // stop refuses, the successor's world is untouched, and the partial effect (tmux kill already
    // ran) is reported as such — and what it does NOT guarantee: the kill itself is not prevented.
    // The real fence is the guard lease (see the launchNode/self-attach contention tests below);
    // every real mint path takes it, so this interleaving is reachable only by bypassing the
    // guard, a second daemon process, or direct tmux.
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

  it("P20b(a) a real self-attach racing the kill of a BOUND node answers already_bound; the stop is unaffected", async () => {
    // Characterization of the already_bound side fence (MiniMax round): attachToNode reads the
    // binding and refuses in the same synchronous turn — with the binding present it can never
    // reach the mint, so the checked stop's kill cannot lose its node to an attach.
    const rigId = (db.prepare("SELECT rig_id FROM nodes WHERE id=?").get(node.id) as { rig_id: string }).rig_id;
    const attach = new SelfAttachService({ db, rigRepo: repo, podRepo: new PodRepository(db), sessionRegistry: registry, eventBus: bus, tmuxAdapter: adapter });
    let attachResult: Awaited<ReturnType<typeof attach.attachToNode>> | undefined;
    onKill = () => { attachResult = undefined; };
    // Fire the attach from the kill window via the gate: hold the kill, run the attach to
    // completion, then release.
    let releaseKill!: () => void;
    killGate = { promise: new Promise<void>(r => { releaseKill = r; }), release: releaseKill };
    let signal!: () => void;
    const killed = new Promise<void>(r => { signal = r; });
    onKill = () => { signal(); void attach.attachToNode({ rigId, logicalId: "dev.a" }).then(r => { attachResult = r; releaseKill(); }); };
    const result = await stop({ nodeId: node.id, sessionId: session.id, occupantGeneration: gen() });
    await killed;
    expect(attachResult).toBeDefined();
    expect(attachResult).toMatchObject({ ok: false, code: "already_bound" });
    expect(result).toMatchObject({ ok: true, sessionId: session.id }); // the kill proceeded and committed
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE node_id=?").get(node.id) as { n: number }).n).toBe(1); // no minted row
    expect(registry.getBindingForNode(node.id)).toBeNull(); // the stop's own binding clear
  });

  it("P20b(b) a checked stop of an UNBOUND node refuses before any effect, so no self-attach can bind into a kill", async () => {
    // MiniMax's REJECT needs a checked stop that STARTS while the node has no binding and then loses
    // the node to a self-attach during its kill. Observed: it never reaches the kill. With no
    // binding the guard target has no recorded pane, so the in-lease check refuses with
    // selection_changed (partialEffect false, stopPhase none) after only has-session + list-panes.
    // Both interleavings are asserted: the attach before the stop, and the attach inside the stop.
    registry.clearBinding(node.id);
    const attach = new SelfAttachService({ db, rigRepo: repo, podRepo: new PodRepository(db), sessionRegistry: registry, eventBus: bus, tmuxAdapter: adapter });
    const effects = () => commands.filter(c => c.includes("kill-session") || c.includes("detach-client"));
    const alone = await stop({ nodeId: node.id, sessionId: session.id, occupantGeneration: gen() });
    expect(alone).toMatchObject({ ok: false, code: "selection_changed", partialEffect: false, stopPhase: "none" });
    expect(effects()).toHaveLength(0);
    expect(status(session.id)).toBe("running");
    expect(events()).toHaveLength(0);
    // Attach started in the same turn as the stop: whichever wins, the stop has no effect to lose.
    const generation = gen();
    const attachDuring = attach.attachToNode({ rigId: rigIdOf(), logicalId: "dev.a" });
    const raced = await stop({ nodeId: node.id, sessionId: session.id, occupantGeneration: generation });
    expect(raced).toMatchObject({ ok: false, code: "selection_changed" });
    expect((raced as { partialEffect?: boolean }).partialEffect).not.toBe(true);
    expect(effects()).toHaveLength(0); // still nothing killed or detached
    expect(await attachDuring).toMatchObject({ ok: true }); // the attach binds, outside any kill window
    expect(events()).toHaveLength(0);
  });

  it("P20b(c) lease contention: a real launchNode for the same node queues behind the stop and mints only after it releases", async () => {
    // F2: the fence is the guard lease, so prove it with a REAL competing lifecycle operation —
    // launchNode from outside the stop's async scope (the HTTP-handler position) while the kill
    // is in flight. It must not mint (or touch tmux) until the stop releases the node.
    const generation = gen();
    let signal!: () => void;
    const killed = new Promise<void>(r => { signal = r; });
    onKill = () => signal();
    let releaseKill!: () => void;
    killGate = { promise: new Promise<void>(r => { releaseKill = r; }), release: releaseKill };
    const stopPromise = stop({ nodeId: node.id, sessionId: session.id, occupantGeneration: generation });
    await killed; // the stop now holds the lease, kill in flight
    const launcher = new NodeLauncher({ db, rigRepo: repo, sessionRegistry: registry, eventBus: bus, tmuxAdapter: adapter });
    // keepPane lets the launch pass the already_bound early check (same pane + same derived
    // session name) so it reaches guard.lifecycle and queues behind the stop — the lease, not the
    // binding, is what is under test.
    const launchPromise = launcher.launchNode(rigIdOf(), "dev.a", { keepPane: "%1" });
    await new Promise(r => setTimeout(r, 25)); // let the launch reach its queue point
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE node_id=?").get(node.id) as { n: number }).n;
    expect(count()).toBe(1); // RED if the launch mints through the stop's lease
    expect(commands.some(c => Array.isArray(c) && c.includes("new-session"))).toBe(false); // no tmux work either
    releaseKill();
    const stopped = await stopPromise;
    expect(stopped).toMatchObject({ ok: true });
    // After the release the queued launch re-resolves the guard target and REFUSES: the stop
    // legitimately changed the node (binding cleared, tenure ended), so a blind mint is refused
    // and the operator retries. The fence holds in the strongest form: no mint during, none after.
    await expect(launchPromise).rejects.toMatchObject({ code: "guard_target_changed" });
    expect(count()).toBe(1); // never minted
    expect(commands.some(c => Array.isArray(c) && c.includes("new-session"))).toBe(false); // no tmux work at all
  });

  it("P20b(F3) a continuation relaunch (same generation, NEW session) fails the pair with selection_changed and kills nothing", async () => {
    // §1.3a: the generation alone survives a relaunch, so a generation-only check would stop the
    // reincarnation the operator never reviewed. The pair's sessionId half catches it.
    const generation = gen();
    const reviewed = precondition();
    registry.updateStatus(session.id, "exited");
    const relaunch = registry.registerSession(node.id, name, "initial", generation); // same generation, new session row
    registry.updateStatus(relaunch.id, "running");
    registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: name, tmuxPane: "%1" });
    expect(gen()).toBe(generation);
    expect(relaunch.id).not.toBe(session.id);
    const before = commands.length;
    const result = await stop({ ...reviewed, occupantGeneration: generation });
    expect(result).toMatchObject({ ok: false, code: "selection_changed" });
    expect(commands.slice(before).filter(c => c.includes("kill-session") || c.includes("detach-client"))).toEqual([]);
    expect(status(relaunch.id)).toBe("running");
  });

  function rigIdOf(): string {
    return (db.prepare("SELECT rig_id FROM nodes WHERE id=?").get(node.id) as { rig_id: string }).rig_id;
  }

  function status(id: string) {
    return (db.prepare("SELECT status FROM sessions WHERE id=?").get(id) as { status: string }).status;
  }
});
