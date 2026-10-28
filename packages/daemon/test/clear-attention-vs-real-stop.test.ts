import { describe, expect, it } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatAttentionReconciler } from "../src/domain/seat-attention-reconciler.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";

// P20c (minimax round 3): the REAL SeatLifecycleService.stopSeat and the REAL SeatAttentionReconciler.clearAttention on one
// DB, one SeatDeliveryGuard and one TmuxAdapter, interleaved through awaited tmux seams:
//   1. clearAttention starts and parks inside its pane-pid read (it has already seen the binding);
//   2. the checked stop starts, takes the node's lease, and parks inside kill-session;
//   3. the kill returns and the stop commits its final transaction (session exited, binding cleared);
//   4. the pane-pid read returns and clearAttention reaches the write it would make.
// Unfenced, step 4 writes the stale binding back onto the stopped session. Fenced, it refuses.
function gate() {
  let release!: () => void; let reached!: () => void;
  const open = new Promise<void>(r => { release = r; });
  const arrived = new Promise<void>(r => { reached = r; });
  return { open, arrived, release, reached };
}

describe("real clearAttention vs real checked stop (P20c)", () => {
  it.each(["stop commits first", "clearAttention writes first"])("%s: the stop always wins, the binding ends cleared", async order => {
    const db = createFullTestDb();
    db.exec(outboxEntriesSchema.sql);
    db.exec(seatDeliveryGuardSchema.sql);
    try {
      const repo = new RigRepository(db), registry = new SessionRegistry(db), bus = new EventBus(db);
      const rig = repo.createRig("race2");
      const node = repo.addNode(rig.id, "dev.worker", { runtime: "claude-code", cwd: "/project" });
      const name = "dev-worker@race2";
      const session = registry.registerSession(node.id, name);
      registry.updateStatus(session.id, "running");
      registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: name, tmuxPane: "%1" });
      new SeatIdentityStore(db).upsert({ nodeId: node.id, sessionName: name, verdict: "mismatch", evidenceSource: "pane_process",
        reason: "process_identity_mismatch", observedAt: new Date().toISOString(),
        evidence: { registeredPane: "%1", observedPid: 100, observedCommand: "bash", matchedLayer: null } });

      const readGate = gate(), killGate = gate();
      const absent = new Set<string>(); const effects: string[] = [];
      const adapter = new TmuxAdapter(async command => {
        const argv = Array.isArray(command) ? command.map(String) : String(command).split(/\s+/);
        const tAt = argv.indexOf("-t");
        const target = tAt >= 0 ? argv[tAt + 1]?.replace(/^'+|'+$/g, "") : undefined;
        if (argv.includes("has-session")) { if (absent.has(name)) throw new Error(`can't find session: ${target}`); return ""; }
        if (argv.includes("list-panes")) return "%1|0|/project|120|40|1";
        if (argv.includes("display-message")) {
          const format = argv[argv.length - 1] ?? "";
          if (format.includes("pane_pid")) { readGate.reached(); await readGate.open; return "100"; }   // clearAttention's read parks here
          if (format.includes("pane_current_command")) return "bash";
          return "$7";
        }
        if (argv.includes("detach-client")) { effects.push("detach"); return ""; }
        if (argv.includes("kill-session")) { effects.push("kill"); killGate.reached(); await killGate.open; absent.add(name); return ""; }
        throw new Error(`unexpected tmux command: ${command}`);
      });
      adapter.deliveryGuard = new SeatDeliveryGuard(db, n => resolveGuardTarget(db, n));
      const service = new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: registry, eventBus: bus, tmuxAdapter: adapter });
      const reconciler = new SeatAttentionReconciler({ db, sessionRegistry: registry, eventBus: bus,
        agentActivityStore: new AgentActivityStore({ db, eventBus: bus }), tmux: adapter,
        listProcesses: async () => [{ pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "bash", startedAt: "t" }],
        sendVerify: async () => { throw new Error("unexpected input"); } });

      const pre = service.stopPrecondition(name);
      if (!("contract" in pre)) throw new Error(pre.message);

      const clearP = reconciler.clearAttention(name);
      await readGate.arrived;                                   // 1. clearAttention is parked inside its read
      const stopP = service.stopSeat({ seatRef: name, reason: "p20c race", expected: pre.expected });
      await killGate.arrived;                                   // 2. the stop holds the lease and is inside kill-session
      let stopped: Awaited<typeof stopP>, cleared: Awaited<typeof clearP>;
      if (order === "stop commits first") {
        killGate.release();
        stopped = await stopP;                                  // 3. the stop commits its final transaction
        expect(registry.getBindingForNode(node.id)).toBeNull();
        readGate.release();
        cleared = await clearP;                                 // 4. clearAttention reaches its write
        expect(cleared.ok).toBe(false);                         // refused: the seat it read is gone
      } else {
        readGate.release();
        cleared = await clearP;                                 // clearAttention writes while the stop is still in kill-session
        killGate.release();
        stopped = await stopP;                                  // the stop's final transaction then clears whatever was written
      }
      expect(stopped).toMatchObject({ ok: true });
      expect(registry.getBindingForNode(node.id)).toBeNull();   // RED unfenced in the first order: the stale binding is back
      expect(effects).toEqual(["detach", "kill"]);   // exactly the stop's two tmux effects, once each, in order; clearAttention adds none
      expect((db.prepare("SELECT status FROM sessions WHERE id=?").get(session.id) as { status: string }).status).toBe("exited");
    } finally { db.close(); }
  });
});
