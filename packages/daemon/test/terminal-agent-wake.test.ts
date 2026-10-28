import { describe, it, expect, beforeEach } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { isBoundTerminalSeat, isBareTerminalSeat, terminalSeatHostsAgent, AGENT_PANE_COMMANDS } from "../src/domain/terminal-seat.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";

// P27 (live regression after the 22:09Z install): OpenRig 0.7.1 refuses every queue wake to a `runtime: terminal` seat
// (#1100: a shell would run the wake text as a command line). On KPC the Pi agents are declared runtime terminal, so 119 of
// them stopped being woken. A terminal seat hosts an agent when what holds its pane is recorded as a known agent command.
// Not the startup record: the human's TUI (`rig tui`) has a fresh-start action too, and its pane is `node`.
const EVIDENCE = "evidence/x.md";

function seat(db: ReturnType<typeof createFullTestDb>, logicalId: string, session: string, opts: { runtime?: string; command?: string | null; recordedPane?: string; boundPane?: string } = {}) {
  db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES ('rig-t', 'rigt')").run();
  const nodeId = `node-${logicalId}`;
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'rig-t', ?, ?)").run(nodeId, logicalId, opts.runtime ?? "terminal");
  db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run(`sess-${logicalId}`, nodeId, session);
  db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, 'tmux', ?, ?)").run(`b-${logicalId}`, nodeId, session, opts.boundPane ?? "%5");
  if (opts.command !== undefined) {
    db.prepare("INSERT INTO seat_identity_verdicts (node_id, verdict, observed_command, registered_pane, session_name, observed_at) VALUES (?, 'verified', ?, ?, ?, ?)")
      .run(nodeId, opts.command, opts.recordedPane ?? opts.boundPane ?? "%5", session, new Date().toISOString());
  }
}

describe("terminalSeatHostsAgent / isBareTerminalSeat", () => {
  let db: ReturnType<typeof createFullTestDb>;
  beforeEach(() => { db = createFullTestDb(); });

  it.each(["pi", "command-code", "Vibe", "claude", "codex", "-pi"])("a terminal seat recorded as %s hosts an agent and is not bare", (command) => {
    seat(db, "workers.a", "workers-a@rigt", { command });
    expect(isBoundTerminalSeat(db, "workers-a@rigt")).toBe(true);   // still a terminal seat: P18's live check keys on this
    expect(terminalSeatHostsAgent(db, "workers-a@rigt")).toBe(true);
    expect(isBareTerminalSeat(db, "workers-a@rigt")).toBe(false);
  });

  it.each([["node"], ["bash"], ["zsh"], ["python3"], ["rig"], [null], [""]])("a terminal seat recorded as %j is bare", (command) => {
    seat(db, "ops.c", "ops-c@rigt", { command });
    expect(terminalSeatHostsAgent(db, "ops-c@rigt")).toBe(false);
    expect(isBareTerminalSeat(db, "ops-c@rigt")).toBe(true);
  });

  it("a terminal seat with no record at all is bare", () => {
    seat(db, "ops.d", "ops-d@rigt");
    expect(isBareTerminalSeat(db, "ops-d@rigt")).toBe(true);
  });

  it("a record for a different pane than the one bound now is ignored (a stale record never marks an agent)", () => {
    seat(db, "workers.s", "workers-s@rigt", { command: "pi", recordedPane: "%9", boundPane: "%5" });
    expect(terminalSeatHostsAgent(db, "workers-s@rigt")).toBe(false);
    expect(isBareTerminalSeat(db, "workers-s@rigt")).toBe(true);
  });

  it("a seat of another runtime is not a bare terminal seat", () => {
    seat(db, "dev.c", "dev-c@rigt", { runtime: "claude-code", command: "node" });
    expect(isBareTerminalSeat(db, "dev-c@rigt")).toBe(false);
  });

  it("the allowlist holds only agent commands, no shell and no generic runtime", () => {
    for (const bad of ["node", "bash", "sh", "zsh", "python3", "rig", "tmux"]) expect(AGENT_PANE_COMMANDS.has(bad)).toBe(false);
  });

  it("a database that cannot answer reads as bare, never as an agent", () => {
    const empty = createFullTestDb();
    empty.exec("DROP TABLE seat_identity_verdicts");
    seat(empty, "workers.x", "workers-x@rigt");
    expect(terminalSeatHostsAgent(empty, "workers-x@rigt")).toBe(false);
    expect(isBareTerminalSeat(empty, "workers-x@rigt")).toBe(true);
  });
});

describe("the queue wake to a terminal seat", () => {
  function harness() {
    const db = createFullTestDb();
    db.exec(outboxEntriesSchema.sql);
    const sends: Array<{ session: string; text: string }> = [];
    const repo = new QueueRepository(db, new EventBus(db), {
      transport: { send: async (session: string, text: string) => { sends.push({ session, text }); return { ok: true, verified: true }; } },
    } as never);
    repo.attachOutbox(new OutboxHandler(db));
    return { db, repo, sends };
  }
  const make = (h: ReturnType<typeof harness>, session: string) => h.repo.create({ sourceSession: "dev-a@rigt", destinationSession: session, summary: "x; touch /tmp/should-not-run", evidenceRef: EVIDENCE, body: "b", nudge: true });

  it("a Pi seat declared runtime terminal is woken: the wake is typed and is not a terminal-seat refusal", async () => {
    const h = harness();
    seat(h.db, "workers.pi", "workers-pi@rigt", { command: "pi" });
    const item = await make(h, "workers-pi@rigt");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sends.map((s) => s.session)).toEqual(["workers-pi@rigt"]);
    expect(h.repo.getById(item.qitemId)!.lastNudgeResult ?? "").not.toMatch(/terminal-seat/);
  });

  it.each([["a shell", "bash"], ["the human's TUI (node)", "node"], ["no record", null]])("%s: nothing is typed and the refusal is unchanged", async (_l, command) => {
    const h = harness();
    seat(h.db, "ops.shell", "ops-shell@rigt", command === null ? {} : { command });
    const item = await make(h, "ops-shell@rigt");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sends).toEqual([]);
    expect(h.repo.getById(item.qitemId)!.lastNudgeResult).toMatch(/^failed:terminal-seat: /);
  });
});
