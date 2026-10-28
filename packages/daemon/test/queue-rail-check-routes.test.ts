import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTransitionsArchiveSchema } from "../src/db/migrations/054_queue_transitions_archive.js";
import { ownerNotificationLevelsSchema } from "../src/db/migrations/076_owner_notification_levels.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { occupantTenuresSchema } from "../src/db/migrations/060_occupant_tenures.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { QueueDestinationChecker, type RunHook } from "../src/domain/queue-rail-check.js";
import { queueRoutes } from "../src/routes/queue.js";

// P29: the destination rail check on every route that picks a destination (create, handoff, handoff-and-complete, fallback).
// Warn-only by default: the row is always written and the warning travels with the response; a refuse mode exists, off by
// default, refuses only on the listed codes, and has a per-request override that the row records.
const ENV_WARN = { OPENRIG_QUEUE_DESTINATION_CHECK: '["checker","{session}"]' };
const ENV_REFUSE = { ...ENV_WARN, OPENRIG_QUEUE_DESTINATION_CHECK_MODE: "refuse", OPENRIG_QUEUE_DESTINATION_CHECK_REFUSE_CODES: "[3]" };

function harness(env: Record<string, string>, run: RunHook) {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, externalCliAttachmentSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema,
    outboxEntriesSchema, queueTransitionsArchiveSchema, ownerNotificationLevelsSchema, rigArchiveSchema, occupantTenuresSchema]);
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, {
    transport: { send: async () => ({ ok: true, verified: true }) },
    validateRig: () => true,
    loadHumanRegistry: () => ({ ok: true as const, entities: [] }),
  } as never);
  repo.attachOutbox(new OutboxHandler(db));
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig1')").run();
  for (const [id, logical, session] of [["node-a", "dev.a", "dev-a@rig1"], ["node-b", "dev.b", "dev-b@rig1"]] as const) {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'rig-1', ?, 'claude-code')").run(id, logical);
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run(`sess-${id}`, id, session);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session) VALUES (?, ?, 'tmux', ?)").run(`b-${id}`, id, session);
  }
  const calls: string[] = [];
  const checker = new QueueDestinationChecker({ env: () => env, run: async (argv, t) => { calls.push(argv[argv.length - 1]!); return run(argv, t); } });
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("eventBus", bus); set("queueRepo", repo); set("queueRailChecker", checker);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  const post = (path: string, body: Record<string, unknown>) => {
    const sender = body["sourceSession"] ?? body["fromSession"] ?? "dev-a@rig1";
    return app.request(path, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": String(sender) }, body: JSON.stringify(body) });
  };
  const rows = () => db.prepare("SELECT qitem_id AS id, destination_session AS dest, tags FROM queue_items ORDER BY ts_created").all() as Array<{ id: string; dest: string; tags: string | null }>;
  return { db, repo, post, rows, calls };
}

// only dev-b is exhausted; dev-a (where the helper opens the first row) is fine
const exhausted: RunHook = async (argv) => argv[argv.length - 1] === "dev-b@rig1"
  ? { code: 3, stdout: "dev-b@rig1: rail EXHAUSTED, resets 2026-11-03", timedOut: false }
  : { code: 0, stdout: "", timedOut: false };
const fine: RunHook = async () => ({ code: 0, stdout: "", timedOut: false });
const create = (to: string, extra: Record<string, unknown> = {}) => ({ sourceSession: "dev-a@rig1", destinationSession: to, body: "work", summary: "s", evidenceRef: "evidence/x.md", nudge: false, ...extra });

describe("the destination rail check on the queue routes (P29)", () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h?.db.close());

  it("create: a warn code writes the row AND carries the hook's words as an advisory", async () => {
    h = harness(ENV_WARN, exhausted);
    const res = await h.post("/api/queue/create", create("dev-b@rig1"));
    expect(res.status).toBe(201);
    const body = await res.json() as { advisories?: Array<Record<string, unknown>> };
    expect(body.advisories).toContainEqual(expect.objectContaining({ code: "destination_rail_unavailable", destinationSession: "dev-b@rig1", exitCode: 3, overridden: false, message: expect.stringContaining("EXHAUSTED") }));
    expect(h.rows()).toHaveLength(1);
  });

  it("create: exit 0 writes the row with no rail advisory", async () => {
    h = harness(ENV_WARN, fine);
    const body = await (await h.post("/api/queue/create", create("dev-b@rig1"))).json() as { advisories?: Array<{ code: string }> };
    expect((body.advisories ?? []).some((a) => a.code === "destination_rail_unavailable")).toBe(false);
    expect(h.rows()).toHaveLength(1);
  });

  it("create: no hook configured means no check is run at all", async () => {
    h = harness({}, exhausted);
    expect((await h.post("/api/queue/create", create("dev-b@rig1"))).status).toBe(201);
    expect(h.calls).toEqual([]);
  });

  it("create: a hook that times out never blocks the write", async () => {
    h = harness(ENV_WARN, async () => ({ code: null, stdout: "", timedOut: true }));
    const res = await h.post("/api/queue/create", create("dev-b@rig1"));
    expect(res.status).toBe(201);
    expect(h.rows()).toHaveLength(1);
  });

  it("create: a human or @external destination skips the hook", async () => {
    h = harness(ENV_WARN, exhausted);
    await h.post("/api/queue/create", create("kevin@external"));   // may be refused or accepted by validation; the hook must not run either way
    expect(h.calls).toEqual([]);
  });

  it("create: the second create to the same seat inside the window does not run the hook again", async () => {
    h = harness(ENV_WARN, exhausted);
    await h.post("/api/queue/create", create("dev-b@rig1"));
    await h.post("/api/queue/create", create("dev-b@rig1"));
    expect(h.calls).toEqual(["dev-b@rig1"]);
    expect(h.rows()).toHaveLength(2);
  });

  describe("refuse mode", () => {
    it("create: a refusing code answers 409 destination_rail_exhausted and writes nothing", async () => {
      h = harness(ENV_REFUSE, exhausted);
      const res = await h.post("/api/queue/create", create("dev-b@rig1"));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "destination_rail_exhausted", destinationSession: "dev-b@rig1", message: expect.stringContaining("EXHAUSTED") });
      expect(h.rows()).toHaveLength(0);
    });

    it("create: allowExhaustedDestination writes the row, tags the override, and still warns", async () => {
      h = harness(ENV_REFUSE, exhausted);
      const res = await h.post("/api/queue/create", create("dev-b@rig1", { allowExhaustedDestination: true }));
      expect(res.status).toBe(201);
      const body = await res.json() as { advisories?: Array<Record<string, unknown>> };
      expect(body.advisories).toContainEqual(expect.objectContaining({ code: "destination_rail_unavailable", overridden: true }));
      expect(h.rows()[0]!.tags).toContain("allow-exhausted-destination");
    });

    it("create: an UNKNOWN code (4, warn-only) is never refused, even in refuse mode", async () => {
      h = harness(ENV_REFUSE, async () => ({ code: 4, stdout: "dev-b@rig1: rail UNKNOWN", timedOut: false }));
      const res = await h.post("/api/queue/create", create("dev-b@rig1"));
      expect(res.status).toBe(201);
      expect(h.rows()).toHaveLength(1);
    });

    it("create: refuse mode with no refuse codes configured never refuses", async () => {
      h = harness({ ...ENV_WARN, OPENRIG_QUEUE_DESTINATION_CHECK_MODE: "refuse" }, exhausted);
      expect((await h.post("/api/queue/create", create("dev-b@rig1"))).status).toBe(201);
    });
  });

  describe("handoff, handoff-and-complete and fallback", () => {
    async function open(h2: ReturnType<typeof harness>) {
      const first = await (await h2.post("/api/queue/create", create("dev-a@rig1"))).json() as { qitemId: string };
      return first.qitemId;
    }
    const transitions = (db: ReturnType<typeof harness>["db"]) => db.prepare("SELECT transition_note AS note FROM queue_transitions ORDER BY ts DESC").all().map((r) => (r as { note: string | null }).note ?? "");

    it("handoff: warns, writes the new row, and the transition note carries the warning", async () => {
      h = harness(ENV_WARN, exhausted);
      const id = await open(h);
      const res = await h.post(`/api/queue/${id}/handoff`, { fromSession: "dev-a@rig1", toSession: "dev-b@rig1", body: "next", nudge: false });
      expect(res.status).toBe(201);
      expect((await res.json() as { advisories?: Array<{ code: string }> }).advisories).toContainEqual(expect.objectContaining({ code: "destination_rail_unavailable" }));
      expect(transitions(h.db).join("\n")).toContain("[destination check] dev-b@rig1: rail EXHAUSTED");
    });

    it("handoff: refuse mode answers 409 and closes nothing; the override goes through and the note names it", async () => {
      h = harness(ENV_REFUSE, exhausted);
      const id = await open(h);
      const refused = await h.post(`/api/queue/${id}/handoff`, { fromSession: "dev-a@rig1", toSession: "dev-b@rig1", body: "next", nudge: false });
      expect(refused.status).toBe(409);
      expect(h.rows().filter((r) => r.dest === "dev-b@rig1")).toHaveLength(0);
      const ok = await h.post(`/api/queue/${id}/handoff`, { fromSession: "dev-a@rig1", toSession: "dev-b@rig1", body: "next", nudge: false, allowExhaustedDestination: true });
      expect(ok.status).toBe(201);
      expect(transitions(h.db).join("\n")).toContain("OVERRIDDEN with allow-exhausted-destination");
    });

    it("handoff-and-complete: warns and records the warning in the transition note", async () => {
      h = harness(ENV_WARN, exhausted);
      const id = await open(h);
      const res = await h.post(`/api/queue/${id}/handoff-and-complete`, { fromSession: "dev-a@rig1", toSession: "dev-b@rig1", body: "next", nudge: false });
      expect(res.status).toBe(201);
      expect(transitions(h.db).join("\n")).toContain("[destination check]");
    });

    it("handoff-and-complete: refuse mode answers 409 before anything changes", async () => {
      h = harness(ENV_REFUSE, exhausted);
      const id = await open(h);
      const res = await h.post(`/api/queue/${id}/handoff-and-complete`, { fromSession: "dev-a@rig1", toSession: "dev-b@rig1", body: "next", nudge: false });
      expect(res.status).toBe(409);
      expect((h.db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(id) as { state: string }).state).not.toBe("done");
    });

    it("fallback: warns beside the routed item", async () => {
      h = harness(ENV_WARN, exhausted);
      const id = await open(h);
      const res = await h.post(`/api/queue/${id}/fallback`, { fallbackDestination: "dev-b@rig1", reason: "manual" });
      expect(res.status).toBe(200);
      expect((await res.json() as { advisories?: Array<{ code: string }> }).advisories).toContainEqual(expect.objectContaining({ code: "destination_rail_unavailable" }));
    });
  });
});
