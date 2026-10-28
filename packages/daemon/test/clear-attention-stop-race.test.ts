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
  it("a node with no session never passes", () => {
    const s = seat();
    try { s.db.prepare("DELETE FROM sessions").run(); expect(currentBindingGuard(s.registry, s.node.id)()).toBe(false); } finally { s.db.close(); }
  });
});
