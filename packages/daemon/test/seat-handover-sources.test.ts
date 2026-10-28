import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SEAT_HANDOVER_SOURCE_CAPABILITIES } from "../src/domain/seat-handover-planner.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { observeCodexSandbox } from "../src/domain/permission-drift.js";
import { buildRebuildPrimingChain } from "../src/domain/rebuild-priming-chain.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// OPR.0.5.5.5 (05-handover-sources-real) — fork/rebuild handover sources EXECUTE
// the plan they print. The v0 B3 refusal (`source_not_supported`) is replaced by
// real execution: fork carries incumbent context through the native-fork launch
// seam (launchHarness forkSource), rebuild primes a fresh successor from the
// seat's durable artifact chain and records exactly what it found. Every pin
// here runs the REAL service path over a real DB — fakes only at tmux/adapter.
describe("SeatHandoverService source execution (OPR.0.5.5.5)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let discoveryRepo: DiscoveryRepository;
  let eventBus: EventBus;
  let hasSession: ReturnType<typeof vi.fn>;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let respawnPane: ReturnType<typeof vi.fn>;
  let setRemainOnExit: ReturnType<typeof vi.fn>;
  let signalPaneProcess: ReturnType<typeof vi.fn>;
  let isPaneDead: ReturnType<typeof vi.fn>;
  let sendText: ReturnType<typeof vi.fn>;
  let sendKeys: ReturnType<typeof vi.fn>;
  let capturePaneScreen: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let readSidecar: ReturnType<typeof vi.fn>;
  let captureCodexThreadId: ReturnType<typeof vi.fn>;
  let getDefaultShell: ReturnType<typeof vi.fn>;
  let getPaneCommand: ReturnType<typeof vi.fn>;
  let rebuildChain: ReturnType<typeof vi.fn>;
  let artifactExists: ReturnType<typeof vi.fn>;
  let service: SeatHandoverService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    discoveryRepo = new DiscoveryRepository(db);
    eventBus = new EventBus(db);
    hasSession = vi.fn(async () => true);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    respawnPane = vi.fn(async () => ({ ok: true }));
    setRemainOnExit = vi.fn(async () => ({ ok: true }));
    signalPaneProcess = vi.fn(async () => ({ ok: true }));
    isPaneDead = vi.fn(async () => true);
    sendText = vi.fn(async () => ({ ok: true }));
    sendKeys = vi.fn(async () => ({ ok: true }));
    capturePaneScreen = vi.fn(async () => "predecessor screen tail");
    launchHarness = vi.fn(async () => ({
      ok: true,
      resumeToken: "post-launch-tok",
      resumeType: "codex_id",
      appliedLaunch: observeCodexSandbox(" -s workspace-write"),
    }));
    checkReady = vi.fn(async () => ({ ready: true }));
    readSidecar = vi.fn(() => ({ ok: true, data: { session_id: "claude-sid-123" } }));
    captureCodexThreadId = vi.fn(async () => "codex-discovered-tok");
    getDefaultShell = vi.fn(async () => "/bin/zsh");
    getPaneCommand = vi.fn(async () => "zsh");
    rebuildChain = vi.fn(() => ({
      artifacts: [
        { address: "/seats/dev-impl/RECAP.md", label: "authored recap (chain depth 2)" },
        { address: "/seats/dev-impl/LEARNED.md", label: "seat lineage lessons" },
      ],
    }));
    artifactExists = vi.fn(() => true);
    service = newService();
  });

  afterEach(() => {
    db.close();
  });

  function tmux(): TmuxAdapter {
    return { hasSession, createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, sendText, sendKeys, capturePaneScreen, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
  }

  function codexAdapter(): RuntimeAdapter {
    return { runtime: "codex", launchHarness, checkReady } as unknown as RuntimeAdapter;
  }

  function newService(): SeatHandoverService {
    return new SeatHandoverService({
      db,
      rigRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: tmux(),
      now: () => new Date("2026-04-24T18:30:00.000Z"),
      newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { codex: codexAdapter() },
      contextUsageStore: { readSidecar } as never,
      resumeTokenCapturer: { captureCodexThreadId } as never,
      rebuildPrimingResolver: rebuildChain as never,
      rebuildArtifactExists: artifactExists as never,
      readinessTimeoutMs: 50,
      sleep: async () => {},
    });
  }

  function seedSeat(opts?: { resumeToken?: string | null }) {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%0" });
    if (opts?.resumeToken) {
      sessionRegistry.updateResumeToken(session.id, "codex_id", opts.resumeToken, "scrape");
    }
    return { rig, node, sessionId: session.id };
  }

  function nodeRow(nodeId: string) {
    return db.prepare("SELECT continuity_outcome, handover_result FROM nodes WHERE id = ?").get(nodeId) as Record<string, string | null>;
  }

  it("rebuild handover uses the cwd selected through set-cwd for the same seat", async () => {
    const { node, rig, sessionId } = seedSeat();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "openrig-handover-cwd-")));
    const cwd = join(root, "isolated seat");
    db.prepare(`INSERT INTO node_startup_context
      (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime)
      VALUES (?, '[]', '[]', '[]', 'codex')`).run(node.id);
    const lifecycle = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux(),
      runtimeAdapters: { codex: { ...codexAdapter(),
        project: async () => ({ projected: [], skipped: [], failed: [] }),
        deliverStartup: async () => ({ delivered: 0, failed: [] }),
      } } });
    try {
      expect(await lifecycle.setCwd({ seatRef: "dev-impl@seat-rig", cwd, reason: "isolate workspace" })).toMatchObject({ ok: true });
      expect(launchHarness).not.toHaveBeenCalled();
      expect(await service.handover({ seatRef: "dev-impl@seat-rig", source: "rebuild", reason: "carry durable context" })).toMatchObject({ ok: true });
      expect(respawnPane).toHaveBeenCalledWith("%9", expect.any(String), expect.objectContaining({ cwd }));
      expect(launchHarness).toHaveBeenCalledWith(expect.objectContaining({ nodeId: node.id, cwd }), expect.any(Object));
      expect(rigRepo.getRig(rig.id)!.nodes.map(n => n.id)).toEqual([node.id]);
      expect(sessionRegistry.getSessionsForRig(rig.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sessionId, status: "superseded" }),
      ]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // ── Mini-req 1: FORK EXECUTES ────────────────────────────────────────────

  it("fork: executes the cutover with the incumbent's native id carried through the fork launch seam, records continuity_outcome=forked", async () => {
    const { node } = seedSeat({ resumeToken: "native-abc" });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:dev-impl@seat-rig",
      operator: "orch-lead@seat-rig",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    // Seat identity preserved: the successor occupies the SAME seat session name
    // (cutover-in-place), the binding moved, the seat/occupant split stays honest.
    expect(result.result).toMatchObject({
      ok: true,
      mutated: true,
      source: { mode: "fork", ref: "dev-impl@seat-rig" },
      currentStatus: { continuityOutcome: "forked", handoverResult: "complete" },
    });
    expect(nodeRow(node.id)).toEqual({ continuity_outcome: "forked", handover_result: "complete" });
    // The launch was a FORK launch: the adapter received the resolved native id,
    // never a blank fresh launch silently reported as a fork.
    const launchOpts = launchHarness.mock.calls.at(-1)?.[1];
    expect(launchOpts).toMatchObject({ forkSource: { kind: "native_id", value: "native-abc" } });
    // The NEW post-fork token (adapter result) is what commit persists — never
    // the parent's token.
    const successor = sessionRegistry.getBindingForNode(node.id);
    expect(successor?.tmuxSession).toBe("dev-impl@seat-rig");
  });

  it("fork: refuses honestly BEFORE any respawn when no native resume id is discoverable — no successor is created, the seat is untouched", async () => {
    seedSeat({ resumeToken: null });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:dev-impl@seat-rig",
    });

    expect(result).toMatchObject({ ok: false, code: "resume_token_unavailable" });
    if (result.ok) throw new Error("expected refusal");
    expect(result.message).toContain("dev-impl@seat-rig");
    // Honest refusal is PRE-mutation: the departing pane was never respawned and
    // no harness launch was attempted.
    expect(respawnPane).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
  });

  // ── Mini-req 2: REBUILD EXECUTES ─────────────────────────────────────────

  it("rebuild: executes a fresh launch primed from the durable chain, records the exact priming artifacts and continuity_outcome=rebuilt", async () => {
    const { node } = seedSeat();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(result.result).toMatchObject({
      ok: true,
      mutated: true,
      source: { mode: "rebuild" },
      currentStatus: { continuityOutcome: "rebuilt", handoverResult: "complete" },
    });
    expect(nodeRow(node.id)).toEqual({ continuity_outcome: "rebuilt", handover_result: "complete" });
    // The recorded priming set is EXACTLY what resolved on disk.
    expect(result.result.sourceOutcome).toMatchObject({
      primedArtifacts: [
        expect.objectContaining({ address: "/seats/dev-impl/RECAP.md" }),
        expect.objectContaining({ address: "/seats/dev-impl/LEARNED.md" }),
      ],
      gaps: [],
    });
    // The delivered priming packet names the artifacts (delivered via the same
    // shipped tmux delivery seam as the fresh restore packet).
    const delivered = sendText.mock.calls.map((call) => String(call[1] ?? call[0])).join("\n");
    expect(delivered).toContain("/seats/dev-impl/RECAP.md");
    expect(delivered).toContain("/seats/dev-impl/LEARNED.md");
    // Rebuild is a fresh runtime conversation — never a fork/resume launch.
    const launchOpts = launchHarness.mock.calls.at(-1)?.[1];
    expect(launchOpts?.forkSource).toBeUndefined();
    expect(launchOpts?.resumeToken).toBeUndefined();
  });

  it("rebuild: a declared artifact missing on disk is recorded as a GAP, not silently dropped and not fatal", async () => {
    seedSeat();
    artifactExists.mockImplementation((path: string) => !String(path).includes("LEARNED"));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(result.result.sourceOutcome).toMatchObject({
      primedArtifacts: [expect.objectContaining({ address: "/seats/dev-impl/RECAP.md" })],
      gaps: ["/seats/dev-impl/LEARNED.md"],
    });
  });

  it("rebuild: an EMPTY durable chain still executes and says so by name — in the result AND in the delivered packet", async () => {
    const { node } = seedSeat();
    rebuildChain.mockImplementation(() => ({ emptyReason: "no recap chain, no LEARNED, no restore packet for this seat" }));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(nodeRow(node.id)).toEqual({ continuity_outcome: "rebuilt", handover_result: "complete" });
    expect(result.result.sourceOutcome).toMatchObject({
      primedArtifacts: [],
      gaps: [],
      emptyChainReason: "no recap chain, no LEARNED, no restore packet for this seat",
    });
    const delivered = sendText.mock.calls.map((call) => String(call[1] ?? call[0])).join("\n");
    expect(delivered).toContain("no recap chain, no LEARNED, no restore packet for this seat");
  });

  // ── Mini-req 3: PLAN AND EXECUTION AGREE ─────────────────────────────────

  it("plan/executor equality: no source the dry-run plan renders a mutation plan for is refused by execution as source_not_supported", async () => {
    const sources = ["fresh", "fork:dev-impl@seat-rig", "rebuild"];
    for (const source of sources) {
      seedSeat({ resumeToken: "native-abc" });
      const plan = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source, dryRun: true });
      expect(plan, `dry-run plan for --source ${source}`).toMatchObject({ ok: true });
      const executed = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source });
      if (!executed.ok) {
        expect(executed.code, `execution of --source ${source} refused a source its own plan promised`).not.toBe("source_not_supported");
      }
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      discoveryRepo = new DiscoveryRepository(db);
      eventBus = new EventBus(db);
      service = newService();
    }
  });

  it("the ONE shared source-capability table: every source mode has a row, and the dry-run plan renders its create-successor step FROM the table", async () => {
    // Exhaustive Record over SeatHandoverSourceMode — a new mode cannot compile
    // without declaring a row; this pin makes the row's truth reach the plan.
    expect(Object.keys(SEAT_HANDOVER_SOURCE_CAPABILITIES).sort()).toEqual(["discovered", "fork", "fresh", "rebuild"]);
    for (const row of Object.values(SEAT_HANDOVER_SOURCE_CAPABILITIES)) {
      expect(row.executes).toBe(true);
    }
    for (const source of ["fresh", "rebuild", "fork:dev-impl@seat-rig"]) {
      seedSeat();
      const planned = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source, dryRun: true });
      expect(planned.ok).toBe(true);
      if (!planned.ok || !("plan" in planned)) throw new Error("expected plan");
      const step = planned.plan.phases.flatMap((phase) => phase.steps).find((candidate) => candidate.id === "create-successor");
      const mode = source.startsWith("fork") ? "fork" : source;
      expect(step?.description).toContain(SEAT_HANDOVER_SOURCE_CAPABILITIES[mode as keyof typeof SEAT_HANDOVER_SOURCE_CAPABILITIES].contextCarrier);
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      discoveryRepo = new DiscoveryRepository(db);
      eventBus = new EventBus(db);
      service = newService();
    }
  });


  // ── Fix round B2: the durable event IS the audit trail ───────────────────

  function lastHandoverEventPayload(): Record<string, unknown> {
    const row = db.prepare("SELECT payload FROM events WHERE type = 'seat.handover_completed' ORDER BY seq DESC LIMIT 1").get() as { payload: string } | undefined;
    if (!row) throw new Error("no persisted seat.handover_completed event");
    return JSON.parse(row.payload);
  }

  it("B2: a rebuild's exact primed set and gaps persist on the seat.handover_completed EVENT, not just the transient response", async () => {
    seedSeat();
    artifactExists.mockImplementation((path: string) => !String(path).includes("LEARNED"));

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "degraded-incumbent", source: "rebuild" });

    expect(result).toMatchObject({ ok: true });
    expect(lastHandoverEventPayload().sourceOutcome).toMatchObject({
      mode: "rebuild",
      primedArtifacts: [expect.objectContaining({ address: "/seats/dev-impl/RECAP.md" })],
      gaps: ["/seats/dev-impl/LEARNED.md"],
    });
  });

  it("B2: an empty rebuild chain's named reason persists on the durable event", async () => {
    seedSeat();
    rebuildChain.mockImplementation(() => ({ emptyReason: "no recap chain, no LEARNED, no restore packet for this seat" }));

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "degraded-incumbent", source: "rebuild" });

    expect(result).toMatchObject({ ok: true });
    expect(lastHandoverEventPayload().sourceOutcome).toMatchObject({
      mode: "rebuild",
      primedArtifacts: [],
      emptyChainReason: "no recap chain, no LEARNED, no restore packet for this seat",
    });
  });

  it("B2: fork provenance persists on the durable event in the same shape", async () => {
    seedSeat({ resumeToken: "native-abc" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fork:dev-impl@seat-rig" });

    expect(result).toMatchObject({ ok: true });
    expect(lastHandoverEventPayload().sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: "dev-impl@seat-rig" });
  });

  // ── Mini-req 4: MID-SWAP FAILURE IS HONEST ───────────────────────────────

  it("fork: an induced launch failure mid-swap reports the failing step, leaves the binding unchanged and the seat recoverable — never a false complete", async () => {
    const { node } = seedSeat({ resumeToken: "native-abc" });
    launchHarness.mockImplementation(async () => ({ ok: false, error: "induced: harness died mid-launch" }));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:dev-impl@seat-rig",
    });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("induced: harness died mid-launch");
    // Recorded partial state: the registry binding never moved and the node row
    // records no false completion.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(nodeRow(node.id).handover_result).not.toBe("complete");
    expect(result.guidance).toMatch(/re-wakeable|binding is unchanged/);
  });

  it("rebuild: an induced priming-delivery failure unwinds the successor candidate and reports the step — binding unchanged", async () => {
    const { node } = seedSeat();
    sendText.mockImplementation(async () => ({ ok: false, error: "induced: tmux delivery down" }));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: false, code: "context_delivery_failed" });
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(nodeRow(node.id).handover_result).not.toBe("complete");
  });

  // #981: each composer handover respawns into the seat's own pane (%9 here). The first commit claims
  // that pane's discovery row for this node, and a rescan upsert keeps the claim (#237).
  function liveSessionId(nodeId: string) {
    const row = db.prepare("SELECT id FROM sessions WHERE node_id = ? AND status NOT IN ('superseded', 'detached', 'exited') ORDER BY id DESC").get(nodeId) as { id: unknown } | undefined;
    return row?.id;
  }
  function seatPaneRows() {
    return db.prepare("SELECT id, status, claimed_node_id FROM discovered_sessions WHERE tmux_session = ? AND tmux_pane = ?").all("dev-impl@seat-rig", "%9");
  }

  it.each(["rebuild", "fresh"] as const)("%s twice in a row: the second handover succeeds and the seat follows each new occupant (#981)", async (source) => {
    const { node, sessionId } = seedSeat();

    const first = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "a", source });
    expect(first).toMatchObject({ ok: true, result: { mutated: true } });
    const firstOccupant = liveSessionId(node.id);
    expect(firstOccupant).not.toBe(sessionId);
    expect(seatPaneRows()).toEqual([expect.objectContaining({ status: "claimed", claimed_node_id: node.id })]);

    const second = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "b", source });
    expect(second).toMatchObject({ ok: true, result: { mutated: true } });
    const secondOccupant = liveSessionId(node.id);
    expect(secondOccupant).not.toBe(firstOccupant);
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(seatPaneRows()).toEqual([expect.objectContaining({ status: "claimed", claimed_node_id: node.id })]);
    expect(respawnPane).toHaveBeenCalledTimes(2);
  });

  it("a seat-pane discovery row claimed by another node still refuses the handover (#237 holds)", async () => {
    const { rig, node, sessionId } = seedSeat();
    const other = rigRepo.addNode(rig.id, "dev.other", { runtime: "codex", cwd: "/project" });
    const row = discoveryRepo.upsertDiscoveredSession({ tmuxSession: "dev-impl@seat-rig", tmuxPane: "%9", runtimeHint: "codex", confidence: "high" });
    discoveryRepo.markClaimed(row.id, other.id);

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "a", source: "rebuild" });

    expect(result).toMatchObject({ ok: false, code: "discovered_not_active" });
    expect(liveSessionId(node.id)).toBe(sessionId);
    expect(discoveryRepo.getDiscoveredSession(row.id)).toMatchObject({ status: "claimed", claimedNodeId: other.id });
  });

  // P14 (R4 D-B): a terminal-runtime successor is a BLANK SHELL. Its agent (Pi's chat screen) is started by the seat's
  // persisted after_ready send_text, so the packet must not be typed until the pane has left the shell. Typed early, it
  // lands in bash and the launch fires afterwards. The pane here is a small state machine: a shell until the launch
  // command has been typed and submitted, then `node`.
  describe("a terminal-runtime successor: the agent is up before the packet", () => {
    const LAUNCH = "env HOME=/h PI_CODING_AGENT_DIR=/h/state/pi/dev-impl@seat-rig/agent pi --no-approve --continue";
    const launchAction = (value = LAUNCH, over: Record<string, unknown> = {}) =>
      ({ type: "send_text", value, phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true, ...over });
    let log: string[];
    let agentUp: boolean;
    let agentExitsAfterPolls: number | null;
    let polls: number;

    beforeEach(() => {
      log = []; agentUp = false; agentExitsAfterPolls = null; polls = 0;
      let lastText = "";
      sendText.mockImplementation(async (_session: string, text: string) => {
        lastText = text;
        log.push(text.startsWith("# Seat rebuild handover") || text.startsWith("=== OpenRig seat handover") ? "packet" : text === LAUNCH ? "launch" : `text:${text.slice(0, 24)}`);
        return { ok: true };
      });
      sendKeys.mockImplementation(async (_session: string, keys: string[]) => {
        log.push(`keys:${keys.join("+")}`);
        if (lastText === LAUNCH && keys.includes("Enter")) agentUp = true;
        return { ok: true };
      });
      getPaneCommand.mockImplementation(async () => {
        polls += agentUp ? 1 : 0;
        if (agentUp && agentExitsAfterPolls !== null && polls > agentExitsAfterPolls) agentUp = false;
        const command = agentUp ? "node" : "zsh";
        log.push(`pane:${command}`);
        return command;
      });
    });

    function terminalService(): SeatHandoverService {
      return new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: tmux(),
        now: () => new Date("2026-04-24T18:30:00.000Z"),
        newSuccessorId: () => "01SUCCID0",
        runtimeAdapters: { terminal: { runtime: "terminal", launchHarness: async () => ({ ok: true }), checkReady: async () => ({ ready: true }) } as never },
        contextUsageStore: { readSidecar } as never,
        rebuildPrimingResolver: rebuildChain as never,
        rebuildArtifactExists: artifactExists as never,
        readinessTimeoutMs: 50,
        sleep: async () => {},
      });
    }

    /** A terminal seat with its persisted startup context: `actions` as the JSON array, or "missing" / "malformed". */
    function seedTerminalSeat(actions: unknown[] | "missing" | "malformed" = [launchAction()]) {
      const rig = rigRepo.createRig("seat-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", cwd: "/project" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
      sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%0" });
      if (actions !== "missing") {
        db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', ?, 'terminal')")
          .run(node.id, actions === "malformed" ? "{not json" : JSON.stringify(actions));
      }
      return { node };
    }
    const handover = (source: "rebuild" | "fresh") => terminalService().handover({ seatRef: "dev-impl@seat-rig", reason: "degraded-incumbent", source });
    const failed = (result: Awaited<ReturnType<typeof handover>>) => {
      expect(result).toMatchObject({ ok: false, code: "context_delivery_failed" });
      if (result.ok) throw new Error("expected a failure");
      // The same unwind as a failed delivery: the successor candidate is vanished, the preserved seat is never killed.
      const candidate = db.prepare("SELECT status FROM discovered_sessions WHERE tmux_session = ?").get("dev-impl@seat-rig") as { status: string } | undefined;
      expect(candidate?.status).toBe("vanished");
      expect(killSession).not.toHaveBeenCalled();
      return result as { message: string; guidance: string };
    };
    const typedIntoShell = () => log.filter((entry) => entry === "packet");

    it.each(["rebuild", "fresh"] as const)("%s: the persisted launch action is typed, the pane is seen to leave the shell, and only then is the packet typed", async (source) => {
      seedTerminalSeat();
      const result = await handover(source);
      expect(result).toMatchObject({ ok: true });
      const launch = log.indexOf("launch");
      const up = log.indexOf("pane:node");
      const packet = log.indexOf("packet");
      expect(launch).toBeGreaterThanOrEqual(0);
      expect(up).toBeGreaterThan(launch);
      expect(packet).toBeGreaterThan(up);
      expect(log[launch + 1]).toBe("keys:Enter"); // the launch is submitted, not just typed
    });

    it("the agent must be seen up twice in a row: one flash of a process that then falls back to the shell is not readiness", async () => {
      seedTerminalSeat();
      agentExitsAfterPolls = 1; // up for one poll, then back to the shell
      const err = failed(await handover("rebuild"));
      expect(err.message).toContain("agent_not_up");
      expect(typedIntoShell()).toEqual([]);
    });

    it("rebuild: a pane that never leaves the shell fails by name, types no packet into it, and unwinds the successor", async () => {
      const { node } = seedTerminalSeat([launchAction("pi --this-never-starts")]); // the pane never changes: agentUp stays false
      const err = failed(await handover("rebuild"));
      expect(err.message).toContain("agent_not_up");
      expect(err.message).toMatch(/shell|"zsh"/);
      expect(typedIntoShell()).toEqual([]);
      expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
      expect(nodeRow(node.id).handover_result).not.toBe("complete");
    });

    it("a pane whose command cannot be read is not evidence", async () => {
      seedTerminalSeat();
      // The launcher's own blank-shell check still sees the shell; once the launch command is typed, the pane cannot be read.
      getPaneCommand.mockImplementation(async () => (agentUp ? null : "zsh"));
      const err = failed(await handover("rebuild"));
      expect(err.message).toContain("agent_not_up");
      expect(typedIntoShell()).toEqual([]);
    });

    it.each(["rebuild", "fresh"] as const)("%s: a terminal seat with NO persisted launch action is refused by name before anything is typed", async (source) => {
      seedTerminalSeat([]);
      const err = failed(await handover(source));
      expect(err.message).toContain("no_launch_action");
      expect(log.filter((entry) => entry.startsWith("text:") || entry === "packet" || entry === "launch")).toEqual([]);
    });

    it("a missing or malformed startup context is refused by name, never read as 'nothing to launch'", async () => {
      seedTerminalSeat("missing");
      expect(failed(await handover("rebuild")).message).toContain("startup_context_missing");
      db.prepare("DELETE FROM sessions").run(); db.prepare("DELETE FROM nodes").run(); db.prepare("DELETE FROM rigs").run();
      log = [];
      seedTerminalSeat("malformed");
      expect(failed(await handover("rebuild")).message).toContain("startup_context_malformed");
      expect(typedIntoShell()).toEqual([]);
    });

    it("only an after_ready send_text that applies to a fresh start is run: not after_files, a startup proof, a restore-only action or a slash command", async () => {
      seedTerminalSeat([
        launchAction("echo after-files", { phase: "after_files" }),
        launchAction("echo restore-only", { appliesOn: ["restore"] }),
        launchAction("/status", { type: "slash_command" }),
        launchAction("proof", { type: "startup_proof" }),
        launchAction(),
      ]);
      expect(await handover("rebuild")).toMatchObject({ ok: true });
      expect(log.filter((entry) => entry.startsWith("text:"))).toEqual([]);
      expect(log.filter((entry) => entry === "launch")).toHaveLength(1);
    });

    it("a launch action that cannot be typed fails by name and types no packet", async () => {
      seedTerminalSeat();
      sendText.mockImplementation(async () => ({ ok: false, error: "induced: tmux down" }));
      const err = failed(await handover("rebuild"));
      expect(err.message).toContain("launch_action_failed");
      expect(typedIntoShell()).toEqual([]);
    });

    // P14c: after the launch was typed and the agent did not come up, our own launch is interrupted in the seat's pane
    // (never a kill of the pane or session), and the outcome is named. `cc` counts the Ctrl-C keys that reached the pane.
    describe("a launch that did not come up is interrupted in the seat's own pane", () => {
      let cc: number;
      /** A launch that starts late: the shell is read for the whole wait, then the agent appears and stays until `needs` Ctrl-C. */
      function lateAgent(needs: number | null) {
        cc = 0;
        let enteredAt: number | null = null;
        sendKeys.mockImplementation(async (_s: string, keys: string[]) => {
          log.push(`keys:${keys.join("+")}`);
          if (keys.includes("C-c")) cc += 1;
          return { ok: true };
        });
        getPaneCommand.mockImplementation(async () => {
          const sent = log.includes("launch");
          if (!sent) return "zsh";
          enteredAt = (enteredAt ?? polls);
          polls += 1;
          const waitOver = polls - enteredAt > 60;
          const up = waitOver && (needs === null || cc < needs);
          return up ? "node" : "zsh";
        });
      }

      it.each([1, 2])("an agent that appears late and needs %i Ctrl-C is interrupted until the pane is at the shell, and the outcome is named", async (needs) => {
        seedTerminalSeat();
        lateAgent(needs);
        const err = failed(await handover("rebuild"));
        expect(err.message).toContain("agent_not_up");
        expect(cc).toBe(needs);
        expect(err.message).toMatch(/interrupted/i);
        expect(err.message).toContain("%9");
        expect(typedIntoShell()).toEqual([]);
        expect(killSession).not.toHaveBeenCalled();
      });

      it("an agent that survives every Ctrl-C is named with the pane id and what it is running, and still nothing is killed", async () => {
        const { node } = seedTerminalSeat();
        lateAgent(null);
        const err = failed(await handover("rebuild"));
        expect(cc).toBeGreaterThanOrEqual(2);
        expect(cc).toBeLessThanOrEqual(5);
        expect(err.message).toContain("agent_not_up");
        expect(err.message).toContain("%9");
        expect(err.message).toContain("node");
        expect(err.message).toMatch(/could not|still running|check/i);
        expect(err.guidance).toContain("%9");
        expect(killSession).not.toHaveBeenCalled();
        expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%0");
      });

      it("a launch whose Enter failed is interrupted too, so the typed command does not stay on the line", async () => {
        seedTerminalSeat();
        cc = 0;
        sendKeys.mockImplementation(async (_s: string, keys: string[]) => {
          if (keys.includes("C-c")) { cc += 1; return { ok: true }; }
          return keys.includes("Enter") && log.includes("launch") ? { ok: false, error: "induced" } : { ok: true };
        });
        getPaneCommand.mockImplementation(async () => "zsh");
        const err = failed(await handover("rebuild"));
        expect(err.message).toContain("launch_action_failed");
        expect(cc).toBeGreaterThanOrEqual(1);
      });

      it("nothing was typed, nothing is interrupted: no launch action, a launch that cannot be typed, and a healthy start send no Ctrl-C", async () => {
        seedTerminalSeat([]);
        lateAgent(1);
        failed(await handover("rebuild"));
        expect(cc).toBe(0);
        db.prepare("DELETE FROM sessions").run(); db.prepare("DELETE FROM nodes").run(); db.prepare("DELETE FROM rigs").run();
        log = [];
        seedTerminalSeat();
        sendText.mockImplementation(async () => ({ ok: false, error: "induced: tmux down" }));
        failed(await handover("rebuild"));
        expect(cc).toBe(0);
        expect(log.filter((e) => e === "keys:C-c")).toEqual([]);
      });
    });

    it("other runtimes are untouched: a codex seat gets its packet at once, with no launch action and no pane polling for an agent", async () => {
      seedSeat();
      sendText.mockImplementation(async (_s: string, text: string) => { log.push(text.startsWith("# Seat rebuild handover") ? "packet" : "other"); return { ok: true }; });
      expect(await service.handover({ seatRef: "dev-impl@seat-rig", reason: "degraded-incumbent", source: "rebuild" })).toMatchObject({ ok: true });
      expect(log.filter((entry) => entry === "packet")).toHaveLength(1);
      expect(log).not.toContain("launch");
    });
  });

  // P14b: the rebuild priming packet goes through the same paste-then-submit tail as the restore packet, so a packet left
  // staged in a Claude composer is a named failure with the same unwind, not a success. The screen is modelled per Enter
  // count: `afterEnter[n]` is what the composer shows after the n-th Enter (null = the screen cannot be read).
  describe("a claude-code rebuild: the priming packet needs submission evidence", () => {
    let packet: string;
    let enters: number;
    let screens: (string | null)[];
    const emptyComposer = "Claude Code v2.1.303\n❯ \n────────────────────\n  ⏵⏵ accept edits on (shift+tab to cycle)";
    const stagedComposer = () => `Claude Code v2.1.303\n${packet.split("\n").map((line, i) => i === 0 ? `❯ ${line}` : `  ${line}`).join("\n")}\n────────────────────\n  ⏵⏵ accept edits on (shift+tab to cycle)`;

    function seedClaudeSeat() {
      const rig = rigRepo.createRig("seat-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/project" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
      sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%0" });
      return { node };
    }
    function claudeService(): SeatHandoverService {
      return new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: tmux(),
        now: () => new Date("2026-04-24T18:30:00.000Z"),
        newSuccessorId: () => "01SUCCID0",
        runtimeAdapters: { "claude-code": { runtime: "claude-code", launchHarness: async () => ({ ok: true, resumeToken: "tok", resumeType: "claude_name" }), checkReady: async () => ({ ready: true }) } as never },
        contextUsageStore: { readSidecar } as never,
        rebuildPrimingResolver: rebuildChain as never,
        rebuildArtifactExists: artifactExists as never,
        readinessTimeoutMs: 50,
        sleep: async () => {},
      });
    }
    const rebuild = () => claudeService().handover({ seatRef: "dev-impl@seat-rig", reason: "degraded-incumbent", source: "rebuild" });

    beforeEach(() => {
      packet = ""; enters = 0; screens = [];
      sendText.mockImplementation(async (_s: string, text: string) => { if (text.startsWith("# Seat rebuild handover")) packet = text; return { ok: true }; });
      sendKeys.mockImplementation(async (_s: string, keys: string[]) => { if (packet && keys.includes("Enter")) enters += 1; return { ok: true }; });
      capturePaneScreen.mockImplementation(async () => {
        if (!packet || enters === 0) return emptyComposer;
        const screen = screens[Math.min(enters, screens.length) - 1];
        return screen === undefined ? emptyComposer : screen === "STAGED" ? stagedComposer() : screen;
      });
    });

    it("a packet still staged in the composer after the guarded retry is a named failure that unwinds the successor", async () => {
      const { node } = seedClaudeSeat();
      screens = ["STAGED", "STAGED"];
      const result = await rebuild();
      expect(result).toMatchObject({ ok: false, code: "context_delivery_failed" });
      if (result.ok) throw new Error("expected a failure");
      expect(result.message).toContain("deliver-rebuild-priming");
      expect(result.message).toContain("the prompt still looked staged in the input box");
      expect(enters).toBe(2);
      expect(db.prepare("SELECT status FROM discovered_sessions WHERE tmux_session = ?").get("dev-impl@seat-rig")).toMatchObject({ status: "vanished" });
      expect(killSession).not.toHaveBeenCalled();
      expect(nodeRow(node.id).handover_result).not.toBe("complete");
    });

    it("a packet submitted at once is delivered: one Enter, no retry, no unconfirmed note", async () => {
      seedClaudeSeat();
      screens = [emptyComposer];
      const result = await rebuild();
      expect(result).toMatchObject({ ok: true, result: { sideEffects: { startupContextDelivered: true } } });
      expect((result as { result: Record<string, unknown> }).result.restorePacket).toBeUndefined();
      expect(enters).toBe(1);
    });

    it("a packet staged after the first Enter and submitted by the guarded retry is delivered", async () => {
      seedClaudeSeat();
      screens = ["STAGED", emptyComposer];
      const result = await rebuild();
      expect(result).toMatchObject({ ok: true, result: { sideEffects: { startupContextDelivered: true } } });
      expect(enters).toBe(2);
    });

    it("an input box that cannot be read does not fail the handover: it is recorded as an unconfirmed priming packet", async () => {
      seedClaudeSeat();
      screens = [null];
      const result = await rebuild();
      expect(result).toMatchObject({ ok: true, result: {
        restorePacket: { status: "unconfirmed", packet: "priming", reason: "the input box could not be observed" },
        sideEffects: { startupContextDelivered: false },
      } });
      expect(enters).toBe(1);
    });

    it("a Claude restore packet keeps its own unconfirmed record, with no packet discriminator", async () => {
      seedClaudeSeat();
      capturePaneScreen.mockImplementation(async () => null);
      sendText.mockImplementation(async (_s: string, text: string) => { if (text.startsWith("=== OpenRig seat handover")) packet = text; return { ok: true }; });
      const result = await claudeService().handover({ seatRef: "dev-impl@seat-rig", reason: "degraded-incumbent", source: "fresh" });
      expect(result).toMatchObject({ ok: true, result: { restorePacket: { status: "unconfirmed", reason: "the input box could not be observed" } } });
      expect((result as { result: { restorePacket: Record<string, unknown> } }).result.restorePacket.packet).toBeUndefined();
    });

    it("a codex rebuild is unchanged: one Enter, the screen is never read for evidence", async () => {
      seedSeat();
      sendText.mockImplementation(async (_s: string, text: string) => { if (text.startsWith("# Seat rebuild handover")) packet = text; return { ok: true }; });
      const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "degraded-incumbent", source: "rebuild" });
      expect(result).toMatchObject({ ok: true, result: { sideEffects: { startupContextDelivered: true } } });
      expect(enters).toBe(1);
      expect((result as { result: Record<string, unknown> }).result.restorePacket).toBeUndefined();
    });
  });
});


// ── Fix round B3: the production chain includes the latest restore packet ──

describe("buildRebuildPrimingChain (production resolver, OPR.0.5.5.5 fix B3)", () => {
  let topologyRoot: string;
  let openrigHome: string;
  let seatDir: string;
  const SEAT = "dev-impl@seat-rig";

  function markerPath(): string {
    return join(openrigHome, "compaction", "restore-pending", "dev-impl@seat-rig.json");
  }

  function chain(): Array<{ address: string; label: string }> {
    const result = buildRebuildPrimingChain(SEAT, { topologyRoot, openrigHome });
    if (!("artifacts" in result)) throw new Error(`expected artifacts, got: ${JSON.stringify(result)}`);
    return result.artifacts;
  }

  beforeEach(() => {
    topologyRoot = mkdtempSync(join(tmpdir(), "s05b3-topo-"));
    openrigHome = mkdtempSync(join(tmpdir(), "s05b3-home-"));
    seatDir = join(topologyRoot, "rigs", "seat-rig", "seats", "dev-impl");
    mkdirSync(seatDir, { recursive: true });
    mkdirSync(join(openrigHome, "compaction", "restore-pending"), { recursive: true });
  });

  afterEach(() => {
    rmSync(topologyRoot, { recursive: true, force: true });
    rmSync(openrigHome, { recursive: true, force: true });
  });

  it("a valid restore-pending marker's packet is NAMED in the chain — after LEARNED, before the superseded recaps", () => {
    const packetDir = join(openrigHome, "packet-x");
    mkdirSync(packetDir, { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({ version: 1, createdAt: "2026-08-27T00:00:00Z", outputDir: packetDir }));
    mkdirSync(join(seatDir, "recap-superseded"), { recursive: true });
    writeFileSync(join(seatDir, "recap-superseded", "RECAP-1000.md"), "old recap");

    const addresses = chain().map((artifact) => artifact.address);
    expect(addresses).toEqual([
      join(seatDir, "RECAP.md"),
      join(seatDir, "LEARNED.md"),
      packetDir,
      join(seatDir, "recap-superseded", "RECAP-1000.md"),
    ]);
    const packet = chain().find((artifact) => artifact.address === packetDir);
    expect(packet?.label).toContain("restore packet");
  });

  it("a marker whose packet dir is GONE still declares the address (the service records it as a named gap, never silently dropped)", () => {
    const goneDir = join(openrigHome, "packet-deleted");
    writeFileSync(markerPath(), JSON.stringify({ version: 1, outputDir: goneDir }));

    const addresses = chain().map((artifact) => artifact.address);
    expect(addresses).toContain(goneDir);
  });

  it("an unparseable marker is named HONESTLY: the marker file itself is declared with an invalid label — never fabricated continuity", () => {
    writeFileSync(markerPath(), "{not json");

    const marker = chain().find((artifact) => artifact.address === markerPath());
    expect(marker, "invalid marker named, not silently skipped").toBeDefined();
    expect(marker?.label.toLowerCase()).toContain("invalid");
  });

  it("REGRESSION: absent marker leaves the existing precedence exactly as shipped (RECAP, LEARNED, superseded newest-first)", () => {
    mkdirSync(join(seatDir, "recap-superseded"), { recursive: true });
    writeFileSync(join(seatDir, "recap-superseded", "RECAP-1000.md"), "older");
    writeFileSync(join(seatDir, "recap-superseded", "RECAP-2000.md"), "newer");

    expect(chain().map((artifact) => artifact.address)).toEqual([
      join(seatDir, "RECAP.md"),
      join(seatDir, "LEARNED.md"),
      join(seatDir, "recap-superseded", "RECAP-2000.md"),
      join(seatDir, "recap-superseded", "RECAP-1000.md"),
    ]);
  });

  it("an unparseable seat ref is a NAMED empty chain, never a guess", () => {
    const result = buildRebuildPrimingChain("not a canonical ref", { topologyRoot, openrigHome });
    expect(result).toMatchObject({ emptyReason: expect.stringContaining("did not parse as canonical") });
  });
});
