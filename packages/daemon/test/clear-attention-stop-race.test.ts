import { describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatAttentionReconciler, currentBindingGuard } from "../src/domain/seat-attention-reconciler.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// P20b (minimax round 2): clearAttention re-resolves a seat's pane with awaited tmux/process reads and then writes the
// binding. It does not take the per-node guard lease, so a checked stop can run to its final transaction (session
// exited, binding cleared) while those reads are in flight, and the late write would put a binding back on a stopped
// session. The write is now conditional on the same current selection the stop's final transaction clears.
function seat() {
  const db = createFullTestDb();
  const registry = new SessionRegistry(db), eventBus = new EventBus(db), rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig("race");
  const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "claude-code" });
  const name = "dev-worker@race", session = registry.registerSession(node.id, name);
  registry.updateStatus(session.id, "running");
  registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
  new SeatIdentityStore(db).upsert({ nodeId: node.id, sessionName: name, verdict: "mismatch", evidenceSource: "pane_process",
    reason: "process_identity_mismatch", observedAt: new Date().toISOString(),
    evidence: { registeredPane: "%1", observedPid: 100, observedCommand: "bash", matchedLayer: null } });
  return { db, registry, eventBus, node, name, session };
}
// The repair case: the daemon's identity verdict is pane_missing because no pane was ever recorded (registeredPane null),
// and the binding has no pane (or no binding row at all). That is the only way the identity branch of clearAttention is
// active without a recorded pane (seat-attention-reconciler.ts getActiveIdentityVerdict: registeredPane must equal the
// binding's pane, null === null here), and it is what `rig reconcile-session --repair-missing-pane` points at.
function seatWithoutRecordedPane(dropBindingRow: boolean) {
  const s = seat();
  s.registry.clearBinding(s.node.id);
  if (!dropBindingRow) s.registry.updateBinding(s.node.id, { attachmentType: "tmux", tmuxSession: s.name });   // a row, no pane
  new SeatIdentityStore(s.db).upsert({ nodeId: s.node.id, sessionName: s.name, verdict: "pane_missing", evidenceSource: "pane_process",
    reason: "pane_missing", observedAt: new Date().toISOString(),
    evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null } } as never);
  return s;
}
const startedAt = "Fri Oct 9 12:00:00 2026";
const listProcesses = async () => [
  { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "bash", startedAt },
  { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: "/fixture/claude", startedAt },
];
function reconciler(s: ReturnType<typeof seat>, duringRead?: () => void) {
  const tmux = {
    listSessions: vi.fn(async () => [{ name: s.name }]), listPanes: vi.fn(async () => [{ id: "%7" }]),
    getPanePid: vi.fn(async () => { duringRead?.(); return 100; }), getPaneCommand: vi.fn(async () => "bash"),
    hasSession: vi.fn(async () => true), probeSession: vi.fn(async () => ({ state: "present" })),
    capturePaneContent: vi.fn(async () => "Claude Code\n❯"),
    sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
  } as unknown as TmuxAdapter;
  return new SeatAttentionReconciler({ db: s.db, sessionRegistry: s.registry, eventBus: s.eventBus,
    agentActivityStore: new AgentActivityStore({ db: s.db, eventBus: s.eventBus }), tmux, listProcesses,
    sendVerify: async () => { throw new Error("unexpected input"); } });
}

describe("clearAttention against a concurrent checked stop (P20b)", () => {
  it("healthy arm: with no stop in flight the pane is rebound to the live pane", async () => {
    const s = seat();
    try {
      await reconciler(s).clearAttention(s.name);
      expect(s.registry.getBindingForNode(s.node.id)?.tmuxPane).toBe("%7");
    } finally { s.db.close(); }
  });

  it("a stop that reaches its final transaction during the reads is not undone by a late rebind", async () => {
    const s = seat();
    try {
      // what the checked stop's final transaction does: session exited, binding cleared
      const stopCommits = () => { s.registry.updateStatus(s.session.id, "exited"); s.registry.clearBinding(s.node.id); };
      const result = await reconciler(s, stopCommits).clearAttention(s.name);
      expect(s.registry.getBindingForNode(s.node.id)).toBeNull(); // RED if the late write restores a binding
      expect(result.ok).toBe(false);
    } finally { s.db.close(); }
  });
});

describe("currentBindingGuard (the shared fence for binding writes that follow awaited reads)", () => {
  it("holds while nothing changes, and fails once the seat is stopped, handed over, or unbound", () => {
    const hold = () => { const s = seat(); return { s, still: currentBindingGuard(s.registry, s.node.id) }; };
    const a = hold(); expect(a.still()).toBe(true); a.s.db.close();
    const stopped = hold(); stopped.s.registry.updateStatus(stopped.s.session.id, "exited"); expect(stopped.still()).toBe(false); stopped.s.db.close();
    const unbound = hold(); unbound.s.registry.clearBinding(unbound.s.node.id); expect(unbound.still()).toBe(false); unbound.s.db.close();
    const handedOver = hold();
    const successor = handedOver.s.registry.registerSession(handedOver.s.node.id, "dev-worker@race");
    handedOver.s.registry.updateStatus(successor.id, "running");
    expect(handedOver.still()).toBe(false); handedOver.s.db.close();
  });
  it("fails when another operation replaces the pane or session name of the SAME session (minimax round 3)", () => {
    const swapped = seat(); const still = currentBindingGuard(swapped.registry, swapped.node.id);
    expect(still()).toBe(true);
    swapped.registry.updateBinding(swapped.node.id, { tmuxSession: swapped.name, tmuxPane: "%8" });
    expect(still()).toBe(false); // RED if only the row's existence is compared
    swapped.db.close();
    const renamed = seat(); const stillRenamed = currentBindingGuard(renamed.registry, renamed.node.id);
    renamed.registry.updateBinding(renamed.node.id, { tmuxSession: "other-name", tmuxPane: "%1" });
    expect(stillRenamed()).toBe(false); renamed.db.close();
  });
  it("clearAttention does not write back a stale pane over a same-session replacement made during its reads", async () => {
    const s = seat();
    try {
      const replace = () => s.registry.updateBinding(s.node.id, { tmuxSession: s.name, tmuxPane: "%8" });
      const result = await reconciler(s, replace).clearAttention(s.name);
      expect(s.registry.getBindingForNode(s.node.id)?.tmuxPane).toBe("%8"); // the other operation's pane, not the stale %7
      expect(result.ok).toBe(false);
    } finally { s.db.close(); }
  });
  it("a node with no binding at capture passes while it stays unbound, and fails once anything binds it (P20e)", () => {
    const s = seat(); s.registry.clearBinding(s.node.id);
    try {
      const still = currentBindingGuard(s.registry, s.node.id);
      expect(still()).toBe(true);   // RED if "no binding" never passes: the repair path below would stop working
      s.registry.updateBinding(s.node.id, { tmuxSession: s.name, tmuxPane: "%3" });
      expect(still()).toBe(false);  // a binding made meanwhile by another operation is not overwritten
    } finally { s.db.close(); }
  });
  it("null and undefined binding fields compare equal; a different value does not (explicit field comparison)", () => {
    const s = seat();
    try {
      const still = currentBindingGuard(s.registry, s.node.id);
      expect(still()).toBe(true);
      s.registry.updateBinding(s.node.id, { tmuxSession: s.name, tmuxPane: "%1" });   // the same tuple written again
      expect(still()).toBe(true);
      s.registry.updateBinding(s.node.id, { tmuxSession: s.name, tmuxPane: "%2" });
      expect(still()).toBe(false);
    } finally { s.db.close(); }
  });
  it.each([["a binding row with no pane", false], ["no binding row at all", true]])("clearAttention repairs a seat whose pane was never recorded (%s), as it did at 6863aadf2", async (_l, dropRow) => {
    const s = seatWithoutRecordedPane(dropRow);
    try {
      const result = await reconciler(s).clearAttention(s.name);
      expect(s.registry.getBindingForNode(s.node.id)?.tmuxPane).toBe("%7");   // the live pane was recorded
      expect(result).toMatchObject({ ok: true });
    } finally { s.db.close(); }
  });
  it("...but not over a binding that another operation made while clearAttention was reading", async () => {
    const s = seatWithoutRecordedPane(true);
    try {
      const bindElsewhere = () => s.registry.updateBinding(s.node.id, { attachmentType: "tmux", tmuxSession: s.name, tmuxPane: "%9" });
      const result = await reconciler(s, bindElsewhere).clearAttention(s.name);
      expect(s.registry.getBindingForNode(s.node.id)?.tmuxPane).toBe("%9");   // the other operation's binding survives
      expect(result.ok).toBe(false);
    } finally { s.db.close(); }
  });
  it("a node with no session never passes", () => {
    const s = seat();
    try { s.db.prepare("DELETE FROM sessions").run(); expect(currentBindingGuard(s.registry, s.node.id)()).toBe(false); } finally { s.db.close(); }
  });
});
