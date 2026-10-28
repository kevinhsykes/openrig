// Queue dedupe_key — conditional create (D4222 primitive A).
//
// At most one OPEN row (pending, in-progress, blocked) may hold a key per destination. A create that finds one returns
// it and writes nothing. A closed row frees the key. Rows without a key are untouched. The pins:
//   - the repository path: hit, miss after close, a race in one tick, other destination, no key, source and body
//     mismatch, a retried forward (same id, same key), same id with another destination (still id reuse);
//   - the refusals are named, never a raw constraint error: dedupe_key_conflict, dedupe_key_open_elsewhere,
//     dedupe_unsupported (a database without the column), invalid_dedupe_key;
//   - the unique index itself holds when the code check is bypassed (the database-level guarantee);
//   - a pod-fallback re-route into a destination that already has the key must still deliver (the key is dropped);
//   - the route: 201 then 200 with deduped, the key echoed, 409 and 400 statuses, and the cross-host forward carries
//     the field unchanged.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemDedupeKeySchema } from "../src/db/migrations/141_queue_item_dedupe_key.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import { lastMeaningfulTransition } from "../src/domain/queue-waiting.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const BASE_MIGRATIONS = [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema];
const A = { sourceSession: "raiser@rig", destinationSession: "owner@rig", body: "alarm", nudge: false } as const;

function count(db: Database.Database, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { c: number }).c;
}
const rows = (db: Database.Database) => count(db, "SELECT COUNT(*) c FROM queue_items");

function close(repo: QueueRepository, qitemId: string) {
  repo.update({ qitemId, actorSession: "owner@rig", state: "done", closureReason: "no-follow-on" });
}

async function rejection(p: Promise<unknown> | (() => unknown)): Promise<QueueRepositoryError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(QueueRepositoryError);
    return err as QueueRepositoryError;
  }
  throw new Error("expected a QueueRepositoryError, but nothing was thrown");
}

describe("migration 141 — queue_items.dedupe_key", () => {
  it("adds a nullable column and a partial unique index, and leaves existing rows without a key", () => {
    const db = createDb();
    migrate(db, BASE_MIGRATIONS);
    const bus = new EventBus(db);
    const repo = new QueueRepository(db, bus, { validateRig: () => true });
    return repo.create({ ...A }).then((before) => {
      migrate(db, [...BASE_MIGRATIONS, queueItemDedupeKeySchema]);
      const col = (db.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string; notnull: number }>)
        .find((c) => c.name === "dedupe_key");
      expect(col).toMatchObject({ name: "dedupe_key", notnull: 0 });
      expect(db.prepare("SELECT dedupe_key FROM queue_items WHERE qitem_id = ?").get(before.qitemId))
        .toEqual({ dedupe_key: null });
      const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_queue_items_open_dedupe'")
        .get() as { sql: string } | undefined;
      expect(idx?.sql).toMatch(/UNIQUE/i);
      expect(idx?.sql).toMatch(/destination_session, dedupe_key/);
      expect(idx?.sql).toMatch(/WHERE dedupe_key IS NOT NULL AND state IN \('pending', ?'in-progress', ?'blocked'\)/);
      db.close();
    });
  });
});

describe("queue dedupe_key — repository", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [...BASE_MIGRATIONS, queueItemDedupeKeySchema]);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => db.close());

  it("a second create with the same key returns the open row: no new row, event or wake, one coalesced-raise transition", async () => {
    const first = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    const second = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    expect(second.qitemId).toBe(first.qitemId);
    expect(second).toMatchObject({ deduped: true, dedupeKey: "alarm:disk", coalescedCount: 1 });
    expect(first.deduped).toBeUndefined();
    expect(rows(db)).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM events WHERE type = 'queue.created'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions")).toBe(2);
  });

  it("a closed row frees the key: the next create is a new row with its own id", async () => {
    const first = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    close(repo, first.qitemId);
    const next = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    expect(next.qitemId).not.toBe(first.qitemId);
    expect(next.deduped).toBeUndefined();
    expect(rows(db)).toBe(2);
  });

  it("a blocked or in-progress row still holds the key", async () => {
    const first = await repo.create({ ...A, dedupeKey: "k" });
    repo.update({ qitemId: first.qitemId, actorSession: "owner@rig", state: "blocked", blockedOn: "external:ci" });
    expect((await repo.create({ ...A, dedupeKey: "k" })).qitemId).toBe(first.qitemId);
  });

  it("two creates in one tick leave exactly one row, and both answers name it", async () => {
    const [a, b] = await Promise.all([repo.create({ ...A, dedupeKey: "race" }), repo.create({ ...A, dedupeKey: "race" })]);
    expect(rows(db)).toBe(1);
    expect(a.qitemId).toBe(b.qitemId);
    expect([a.deduped, b.deduped].filter(Boolean)).toHaveLength(1);
  });

  it("another destination gets its own row; rows without a key are never merged", async () => {
    const one = await repo.create({ ...A, dedupeKey: "k" });
    const other = await repo.create({ ...A, destinationSession: "second@rig", dedupeKey: "k" });
    expect(other.qitemId).not.toBe(one.qitemId);
    await repo.create({ ...A });
    await repo.create({ ...A });
    expect(rows(db)).toBe(4);
    expect(("dedupeKey" in (await repo.create({ ...A })))).toBe(false);
  });

  it("the same key from another source is a named conflict, and writes nothing", async () => {
    await repo.create({ ...A, dedupeKey: "k" });
    const err = await rejection(repo.create({ ...A, sourceSession: "intruder@rig", dedupeKey: "k" }));
    expect(err.code).toBe("dedupe_key_conflict");
    expect(rows(db)).toBe(1);
  });

  it("a different body on a hit is reported, not saved", async () => {
    const first = await repo.create({ ...A, dedupeKey: "k" });
    const again = await repo.create({ ...A, body: "a different alarm text", dedupeKey: "k" });
    expect(again.qitemId).toBe(first.qitemId);
    expect(again.body).toBe("alarm");
    expect(again.createWarning).toMatchObject({ code: "qitem_body_not_saved" });
  });

  it("a retried forward (same id, same key) returns the row; the same id for another destination is still id reuse", async () => {
    const first = await repo.create({ ...A, qitemId: "qitem-fixed-1", dedupeKey: "k" });
    const retry = await repo.create({ ...A, qitemId: "qitem-fixed-1", dedupeKey: "k" });
    expect(retry.qitemId).toBe(first.qitemId);
    expect(rows(db)).toBe(1);
    const reuse = await rejection(repo.create({ ...A, qitemId: "qitem-fixed-1", destinationSession: "x@rig", dedupeKey: "k" }));
    expect(reuse.code).toBe("qitem_id_reuse");
  });

  it("a different id with the same key, while the id is supplied, is a hit and not a raw error", async () => {
    const first = await repo.create({ ...A, qitemId: "qitem-a", dedupeKey: "k" });
    const second = await repo.create({ ...A, qitemId: "qitem-b", dedupeKey: "k" });
    expect(second.qitemId).toBe(first.qitemId);
    expect(db.prepare("SELECT 1 FROM queue_items WHERE qitem_id = 'qitem-b'").get()).toBeUndefined();
  });

  it("reopening a closed row while another open row holds the key is a named refusal; it works once the key is free", async () => {
    const old = await repo.create({ ...A, dedupeKey: "k" });
    close(repo, old.qitemId);
    const live = await repo.create({ ...A, dedupeKey: "k" });
    const reopen = () => repo.update({ qitemId: old.qitemId, actorSession: "owner@rig", state: "pending", reopen: true, transitionNote: "repair" });
    const err = await rejection(reopen);
    expect(err.code).toBe("dedupe_key_open_elsewhere");
    expect(err.meta).toMatchObject({ qitemId: old.qitemId, otherQitemId: live.qitemId });
    expect(repo.getById(old.qitemId)?.state).toBe("done");
    close(repo, live.qitemId);
    expect(reopen().state).toBe("pending");
  });

  it("a pod-fallback re-route into a destination that already has the key still delivers, and drops the key", async () => {
    const moving = await repo.create({ ...A, dedupeKey: "k" });
    const there = await repo.create({ ...A, destinationSession: "fallback@rig", dedupeKey: "k" });
    const moved = repo.routeToFallback(moving.qitemId, "fallback@rig", "seat unreachable");
    expect(moved.destinationSession).toBe("fallback@rig");
    expect(repo.getById(moving.qitemId)?.dedupeKey).toBeUndefined();
    expect(repo.getById(there.qitemId)?.dedupeKey).toBe("k");
    // With no collision the key travels with the row.
    const solo = await repo.create({ ...A, dedupeKey: "solo" });
    repo.routeToFallback(solo.qitemId, "third@rig", "seat unreachable");
    expect(repo.getById(solo.qitemId)?.dedupeKey).toBe("solo");
  });

  it("refuses keys that are empty, too long, or hold control characters", async () => {
    for (const bad of ["", "   ", "x".repeat(201), "a\nb", "a\u0000b"]) {
      const err = await rejection(repo.create({ ...A, dedupeKey: bad }));
      expect(err.code, JSON.stringify(bad)).toBe("invalid_dedupe_key");
    }
    expect(rows(db)).toBe(0);
    expect((await repo.create({ ...A, dedupeKey: "x".repeat(200) })).dedupeKey).toBe("x".repeat(200));
  });

  it("the unique index holds on its own: an insert that skips the code check still fails", async () => {
    await repo.create({ ...A, dedupeKey: "k" });
    const raw = () => db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, dedupe_key)
       VALUES ('qitem-raw', 'now', 'now', 'x@rig', 'owner@rig', 'pending', 'routine', 'b', 'k')`).run();
    expect(raw).toThrow(/UNIQUE constraint failed: queue_items\.destination_session, queue_items\.dedupe_key/);
  });
});

describe("queue dedupe_key — a database without the column", () => {
  it("refuses a keyed create and writes nothing; a create without a key is unchanged", async () => {
    const db = createDb();
    migrate(db, BASE_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const err = await rejection(repo.create({ ...A, dedupeKey: "k" }));
    expect(err.code).toBe("dedupe_unsupported");
    expect(rows(db)).toBe(0);
    expect((await repo.create({ ...A })).qitemId).toBeTruthy();
    expect(rows(db)).toBe(1);
    db.close();
  });
});

describe("queue dedupe_key — route", () => {
  const REGISTRY: HostRegistry = { hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433" }] };
  let db: Database.Database;

  function makeApp(fetchImpl?: typeof fetch): Hono {
    const bus = new EventBus(db);
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    const app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (k: string, v: unknown) => void;
      set("eventBus", bus);
      set("queueRepo", queueRepo);
      set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
      if (fetchImpl) set("remoteFetchImpl", fetchImpl);
      await next();
    });
    app.route("/api/queue", queueRoutes());
    return app;
  }
  const post = (app: Hono, body: Record<string, unknown>) => app.request("/api/queue/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": String(body["sourceSession"] ?? A.sourceSession) },
    body: JSON.stringify({ sourceSession: A.sourceSession, destinationSession: A.destinationSession, body: A.body, nudge: false, ...body }),
  });

  beforeEach(() => {
    db = createDb();
    migrate(db, [...BASE_MIGRATIONS, queueItemDedupeKeySchema]);
  });
  afterEach(() => db.close());

  it("answers 201 for the row it creates and 200 with deduped for the row it finds, echoing the key", async () => {
    const app = makeApp();
    const first = await post(app, { dedupeKey: "alarm:disk" });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { qitemId: string; dedupeKey: string; deduped?: boolean };
    expect(firstBody.dedupeKey).toBe("alarm:disk");
    expect(firstBody.deduped).toBeUndefined();
    const second = await post(app, { dedupeKey: "alarm:disk" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ qitemId: firstBody.qitemId, dedupeKey: "alarm:disk", deduped: true });
    expect(rows(db)).toBe(1);
  });

  it("maps the named refusals: another source 409, a bad key 400, a database without the column 409", async () => {
    const app = makeApp();
    await post(app, { dedupeKey: "k" });
    const conflict = await post(app, { sourceSession: "intruder@rig", dedupeKey: "k" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "dedupe_key_conflict" });
    const bad = await post(app, { dedupeKey: "   " });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_dedupe_key" });
    const plain = createDb();
    migrate(plain, BASE_MIGRATIONS);
    const old = db;
    db = plain;
    const unsupported = await post(makeApp(), { dedupeKey: "k" });
    expect(unsupported.status).toBe(409);
    expect(await unsupported.json()).toMatchObject({ error: "dedupe_unsupported" });
    db = old;
    plain.close();
  });

  it("a create without a key behaves as before: 201 and no dedupeKey field", async () => {
    const res = await post(makeApp(), {});
    expect(res.status).toBe(201);
    expect("dedupeKey" in (await res.json() as object)).toBe(false);
  });

  it("the cross-host forward carries the key unchanged, with the host envelope stripped and the id minted", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const app = makeApp((async (_url: string | URL | Request, init?: RequestInit) => {
      seen.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ qitemId: "from-origin" }), { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch);
    const res = await post(app, { dedupeKey: "alarm:disk", hostId: "vps-b" });
    expect(res.status).toBe(201);
    expect(seen.body).toMatchObject({ dedupeKey: "alarm:disk", qitemId: expect.stringMatching(/^qitem-/) });
    expect("hostId" in (seen.body ?? {})).toBe(false);
    expect(rows(db)).toBe(0);
  });
});


// D4222 amendment (conditions 2 and 4): a stale close is refused loudly, and a coalesced raise is on the record.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const trail = (db: Database.Database, qitemId: string) => db.prepare(
  "SELECT transition_id id, state, actor_session actor, transition_note note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id",
).all(qitemId) as Array<{ id: number; state: string; actor: string; note: string | null }>;

describe("queue — a stale close", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    db = createDb();
    migrate(db, [...BASE_MIGRATIONS, queueItemDedupeKeySchema]);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => db.close());

  const shapes: Array<[string, Record<string, unknown>]> = [
    ["with closure fields", { closureReason: "no-follow-on" }],
    ["without closure fields", {}],
  ];

  it.each(shapes)("raise, close, re-raise: a stale close of the OLD id %s never reaches the new row", async (_label, extra) => {
    const old = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    close(repo, old.qitemId);
    const fresh = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    expect(fresh.qitemId).not.toBe(old.qitemId);
    const before = trail(db, fresh.qitemId).length;
    const attempt = () => repo.update({ qitemId: old.qitemId, actorSession: "owner@rig", state: "done", transitionNote: "again", ...extra });
    if ("closureReason" in extra) {
      const err = await rejection(attempt);
      expect(err.code).toBe("note_append_fields_not_admitted");
      expect(err.meta).toMatchObject({ currentState: "done" });
    } else {
      const answer = attempt(); // the legacy same-state reassertion: an append on the OLD row (S8a), now said out loud
      expect(answer.qitemId).toBe(old.qitemId);
      expect(answer.alreadyTerminal).toBe(true);
    }
    // Either way the close resolved by row id and the new row was never reached.
    expect(repo.getById(fresh.qitemId)?.state).toBe("pending");
    expect(trail(db, fresh.qitemId)).toHaveLength(before);
  });

  it("the lifecycle: a stale closer WITH the token is refused; WITHOUT it, on the old id, is told alreadyTerminal and the new row stays open", async () => {
    const old = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    const closerSaw = repo.getById(old.qitemId)!.lastTransitionId!;       // the closer reads the alarm
    close(repo, old.qitemId);                                              // someone else closes it
    const fresh = await repo.create({ ...A, dedupeKey: "alarm:disk" });    // the alarm is raised again: a new row
    expect(fresh.qitemId).not.toBe(old.qitemId);
    const freshTrail = trail(db, fresh.qitemId);

    // WITH the token: refused loudly, nothing written anywhere.
    const oldTrail = trail(db, old.qitemId);
    const refused = await rejection(() => repo.update({
      qitemId: old.qitemId, actorSession: "owner@rig", state: "done", transitionNote: "closing", expectedTransitionId: closerSaw,
    }));
    expect(refused.code).toBe("stale_transition");
    expect(refused.meta).toMatchObject({ currentState: "done", expectedTransitionId: closerSaw });
    expect(trail(db, old.qitemId)).toEqual(oldTrail);

    // WITHOUT the token: S8a keeps it an append, but the answer says nothing was closed, and names the state and the token.
    const told = repo.update({ qitemId: old.qitemId, actorSession: "owner@rig", state: "done", transitionNote: "closing" });
    expect(told.alreadyTerminal).toBe(true);
    expect(told.updateWarning?.code).toBe("already_terminal");
    expect(told.updateWarning?.message).toContain("was already 'done'");
    expect(told.updateWarning?.message).toContain(`newest transition is now ${told.lastTransitionId}`);
    expect(told.state).toBe("done");

    // In both arms the new row was never reached.
    expect(repo.getById(fresh.qitemId)?.state).toBe("pending");
    expect(trail(db, fresh.qitemId)).toEqual(freshTrail);
  });

  it("only a same-state reassertion carries the warning: a real close, a note and a reopen do not", async () => {
    const row = await repo.create({ ...A });
    const closed = repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: "done", closureReason: "no-follow-on" });
    expect("alreadyTerminal" in closed).toBe(false);
    expect("updateWarning" in repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", transitionNote: "a note" })).toBe(false);
    const reopened = repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: "pending", reopen: true, transitionNote: "repair" });
    expect("alreadyTerminal" in reopened).toBe(false);
    expect("alreadyTerminal" in repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: "in-progress", transitionNote: "working" })).toBe(false);
  });

  it("the writes of a same-state reassertion are exactly what S8a pins: one transition and one event, the row itself untouched", async () => {
    const row = await repo.create({ ...A });
    close(repo, row.qitemId);
    const rowBefore = db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(row.qitemId);
    const transitions = trail(db, row.qitemId).length;
    repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: "done", transitionNote: "confirm" });
    expect(db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(row.qitemId)).toEqual(rowBefore);
    expect(trail(db, row.qitemId)).toHaveLength(transitions + 1);
  });

  it("a note with no state is still an append on a closed row (legacy custody notes)", async () => {
    const row = await repo.create({ ...A });
    close(repo, row.qitemId);
    const before = trail(db, row.qitemId).length;
    expect(repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", transitionNote: "custody verification" }).state).toBe("done");
    expect(trail(db, row.qitemId)).toHaveLength(before + 1);
  });

  it("closing a row that is open still works, with or without a precondition", async () => {
    const row = await repo.create({ ...A });
    const token = repo.getById(row.qitemId)!.lastTransitionId!;
    expect(repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: "done", closureReason: "no-follow-on", expectedTransitionId: token }).state).toBe("done");
  });
});

describe("queue — expectedTransitionId", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    db = createDb();
    migrate(db, [...BASE_MIGRATIONS, queueItemDedupeKeySchema]);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => db.close());

  it("a row shows lastTransitionId, the newest transition it has, and every write advances it", async () => {
    const row = await repo.create({ ...A });
    const newest = () => count(db, "SELECT MAX(transition_id) c FROM queue_transitions WHERE qitem_id = ?", row.qitemId);
    expect(repo.getById(row.qitemId)?.lastTransitionId).toBe(newest());
    repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", transitionNote: "looked at it" });
    expect(repo.getById(row.qitemId)?.lastTransitionId).toBe(newest());
    const other = await repo.create({ ...A, destinationSession: "second@rig" });
    expect(other.lastTransitionId).toBeGreaterThan(row.lastTransitionId!);
  });

  it("a mismatched token refuses loudly with the current id and state, and closes nothing", async () => {
    const row = await repo.create({ ...A });
    const stale = repo.getById(row.qitemId)!.lastTransitionId!;
    repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", transitionNote: "someone touched it" });
    const before = trail(db, row.qitemId);
    const err = await rejection(() => repo.update({
      qitemId: row.qitemId, actorSession: "owner@rig", state: "done", closureReason: "no-follow-on", expectedTransitionId: stale,
    }));
    expect(err.code).toBe("stale_transition");
    expect(err.meta).toMatchObject({ qitemId: row.qitemId, expectedTransitionId: stale, currentState: "pending",
      currentTransitionId: repo.getById(row.qitemId)!.lastTransitionId });
    expect(repo.getById(row.qitemId)?.state).toBe("pending");
    expect(trail(db, row.qitemId)).toEqual(before);
  });

  it("the stale closer of a reopened row is refused; the same closer with a fresh token succeeds", async () => {
    const row = await repo.create({ ...A, dedupeKey: "k" });
    close(repo, row.qitemId);
    const seenByCloser = repo.getById(row.qitemId)!.lastTransitionId!;
    repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: "pending", reopen: true, transitionNote: "repair" });
    const err = await rejection(() => repo.update({
      qitemId: row.qitemId, actorSession: "owner@rig", state: "done", closureReason: "no-follow-on", expectedTransitionId: seenByCloser,
    }));
    expect(err.code).toBe("stale_transition");
    expect(repo.getById(row.qitemId)?.state).toBe("pending");
    const fresh = repo.getById(row.qitemId)!.lastTransitionId!;
    expect(repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: "done", closureReason: "no-follow-on", expectedTransitionId: fresh }).state).toBe("done");
  });

  it("a note append is held to the token too, and a token of the wrong kind is refused", async () => {
    const row = await repo.create({ ...A });
    const stale = repo.getById(row.qitemId)!.lastTransitionId!;
    repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", transitionNote: "first" });
    expect((await rejection(() => repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", transitionNote: "second", expectedTransitionId: stale }))).code)
      .toBe("stale_transition");
    for (const bad of [0, -3, 1.5, Number.NaN, "7" as unknown as number]) {
      const err = await rejection(() => repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", transitionNote: "x", expectedTransitionId: bad }));
      expect(err.code, String(bad)).toBe("invalid_expected_transition");
    }
  });

  it("an update with no token behaves as before", async () => {
    const row = await repo.create({ ...A });
    repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", transitionNote: "one" });
    expect(repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: "done", closureReason: "no-follow-on" }).state).toBe("done");
  });
});

describe("queue dedupe_key — a coalesced raise is recorded", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    db = createDb();
    migrate(db, [...BASE_MIGRATIONS, queueItemSummarySchema, queueItemDedupeKeySchema]);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => db.close());

  it("the second raise is on the surviving row's transitions, with its source and the sha256 of the body it sent", async () => {
    const first = await repo.create({ ...A, dedupeKey: "alarm:disk", summary: "disk is full", tags: ["mission:ops"] });
    const second = await repo.create({ ...A, sourceSession: A.sourceSession, body: "alarm", dedupeKey: "alarm:disk" });
    expect(second).toMatchObject({ deduped: true, qitemId: first.qitemId, coalescedCount: 1 });
    const last = trail(db, first.qitemId).at(-1)!;
    expect(last.note).toBe(`coalesced raise from ${A.sourceSession}, body sha256 ${sha("alarm")}`);
    expect(last.state).toBe("pending");
  });

  it("the count grows with each raise and is read from the transitions, not stored", async () => {
    const first = await repo.create({ ...A, dedupeKey: "k" });
    expect((await repo.create({ ...A, dedupeKey: "k" })).coalescedCount).toBe(1);
    expect((await repo.create({ ...A, dedupeKey: "k" })).coalescedCount).toBe(2);
    expect((await repo.create({ ...A, dedupeKey: "k" })).coalescedCount).toBe(3);
    expect(trail(db, first.qitemId).filter((t) => t.note?.startsWith("coalesced raise from ")).length).toBe(3);
    expect(db.prepare("PRAGMA table_info(queue_items)").all().some((c) => (c as { name: string }).name === "coalesced_count")).toBe(false);
  });

  it("the surviving row's body, summary and tags are never overwritten, even by a raise with different content", async () => {
    const first = await repo.create({ ...A, dedupeKey: "k", summary: "original summary", tags: ["mission:ops"] });
    const again = await repo.create({ ...A, body: "a different alarm text", summary: "new summary", tags: ["other"], dedupeKey: "k" });
    expect(again).toMatchObject({ body: "alarm", summary: "original summary", tags: ["mission:ops"], deduped: true });
    expect(again.createWarning).toMatchObject({ code: "qitem_body_not_saved" });
    const after = repo.getById(first.qitemId)!;
    expect({ body: after.body, summary: after.summary, tags: after.tags }).toEqual({ body: "alarm", summary: "original summary", tags: ["mission:ops"] });
    // The record carries the hash of what was offered, not the text.
    expect(trail(db, first.qitemId).at(-1)?.note).toBe(`coalesced raise from ${A.sourceSession}, body sha256 ${sha("a different alarm text")}`);
  });

  it("a note typed by hand that looks like one does not move the count", async () => {
    const first = await repo.create({ ...A, dedupeKey: "k" });
    repo.update({ qitemId: first.qitemId, actorSession: "owner@rig", transitionNote: `coalesced raise from forged@rig, body sha256 ${sha("x")}` });
    expect((await repo.create({ ...A, dedupeKey: "k" })).coalescedCount).toBe(1);
  });

  it("it is the system's note, not the raiser's act: it does not move the row's last meaningful change", async () => {
    const first = await repo.create({ ...A, dedupeKey: "k" });
    const before = lastMeaningfulTransition(db, first.qitemId);
    await repo.create({ ...A, dedupeKey: "k" });
    expect(lastMeaningfulTransition(db, first.qitemId)).toEqual(before);
    expect(trail(db, first.qitemId).at(-1)?.actor).toBe("daemon@kernel");
  });

  it("it advances lastTransitionId, so a closer that read the row before the raise is told", async () => {
    const first = await repo.create({ ...A, dedupeKey: "k" });
    const seen = repo.getById(first.qitemId)!.lastTransitionId!;
    await repo.create({ ...A, dedupeKey: "k" });
    const err = await rejection(() => repo.update({
      qitemId: first.qitemId, actorSession: "owner@rig", state: "done", closureReason: "no-follow-on", expectedTransitionId: seen,
    }));
    expect(err.code).toBe("stale_transition");
  });

  it("only a real second raise is recorded: a retried forward, another source's conflict and a closed holder are not", async () => {
    const first = await repo.create({ ...A, qitemId: "qitem-fixed-9", dedupeKey: "k" });
    await repo.create({ ...A, qitemId: "qitem-fixed-9", dedupeKey: "k" }); // the same id again is a retry
    await rejection(repo.create({ ...A, sourceSession: "intruder@rig", dedupeKey: "k" }));
    expect(trail(db, first.qitemId)).toHaveLength(1);
    close(repo, first.qitemId);
    const next = await repo.create({ ...A, dedupeKey: "k" });
    expect(next.deduped).toBeUndefined();
    expect(trail(db, next.qitemId)).toHaveLength(1);
  });

  it("the record is visible through the transitions route, and the create route answers with the count", async () => {
    const bus = new EventBus(db);
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    const app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (k: string, v: unknown) => void;
      set("eventBus", bus); set("queueRepo", queueRepo);
      await next();
    });
    app.route("/api/queue", queueRoutes());
    const raise = () => app.request("/api/queue/create", {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": A.sourceSession },
      body: JSON.stringify({ sourceSession: A.sourceSession, destinationSession: A.destinationSession, body: A.body, nudge: false, dedupeKey: "alarm:disk" }),
    });
    const first = await (await raise()).json() as { qitemId: string };
    const hit = await raise();
    expect(hit.status).toBe(200);
    expect(await hit.json()).toMatchObject({ deduped: true, qitemId: first.qitemId, coalescedCount: 1 });
    const transitions = await (await app.request(`/api/queue/${first.qitemId}/transitions`)).json() as Array<{ transitionNote: string | null }>;
    expect(transitions.map((t) => t.transitionNote)).toContain(`coalesced raise from ${A.sourceSession}, body sha256 ${sha("alarm")}`);
    // the update route: a stale token is 409 stale_transition and a malformed one is 400
    const row = await (await app.request(`/api/queue/${first.qitemId}`)).json() as { lastTransitionId: number };
    const post = (body: Record<string, unknown>) => app.request(`/api/queue/${first.qitemId}/update`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "owner@rig" }, body: JSON.stringify(body),
    });
    const stale = await post({ state: "done", closureReason: "no-follow-on", expectedTransitionId: row.lastTransitionId - 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale_transition", currentTransitionId: row.lastTransitionId, currentState: "pending" });
    expect((await post({ state: "done", closureReason: "no-follow-on", expectedTransitionId: row.lastTransitionId })).status).toBe(200);
    const again = await post({ state: "done", transitionNote: "again" });
    expect(again.status).toBe(200); // S8a: still an append
    expect(await again.json()).toMatchObject({ alreadyTerminal: true, state: "done", updateWarning: { code: "already_terminal", message: expect.stringContaining("was already 'done'") } });
    expect((await post({ state: "done", expectedTransitionId: "x" })).status).toBe(400);
  });
});

// kevinsykes-ai's six checks on the close path, and its conditions 1, 3 and 5, at the route a closer really calls.
describe("queue close path — the six checks, through the route", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let app: Hono;
  beforeEach(() => {
    db = createDb();
    migrate(db, [...BASE_MIGRATIONS, queueItemSummarySchema, queueItemDedupeKeySchema]);
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (k: string, v: unknown) => void;
      set("eventBus", bus); set("queueRepo", repo);
      await next();
    });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(() => db.close());

  const post = (id: string, body: Record<string, unknown>, query = "") => app.request(`/api/queue/${id}/update${query}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "owner@rig" }, body: JSON.stringify(body),
  });
  /** The scene: an alarm raised, read by a closer, closed by someone else, and raised again as a NEW row. */
  async function reRaised() {
    const old = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    const closerSaw = repo.getById(old.qitemId)!.lastTransitionId!;
    close(repo, old.qitemId);
    const fresh = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    expect(fresh.qitemId).not.toBe(old.qitemId);
    return { old, fresh, closerSaw };
  }
  const freshUntouched = (fresh: { qitemId: string }, before: ReturnType<typeof trail>) => {
    expect(repo.getById(fresh.qitemId)?.state).toBe("pending");
    expect(trail(db, fresh.qitemId)).toEqual(before);
  };

  it("(i) the target is the row id in the path and nothing else: a key or a destination in the body or the query is ignored, even with the NEW row's token", async () => {
    const { old, fresh } = await reRaised();
    const before = trail(db, fresh.qitemId);
    const freshToken = repo.getById(fresh.qitemId)!.lastTransitionId!;
    // A closer that resolved 'the open row for destination+key' would hold the fresh row's token. Addressed to the old id,
    // that token is the wrong row's, so the close is refused and the new row is never reached.
    const withFreshToken = await post(old.qitemId, {
      state: "done", closureReason: "no-follow-on", dedupeKey: "alarm:disk", destinationSession: A.destinationSession, expectedTransitionId: freshToken,
    }, "?dedupeKey=alarm%3Adisk&destination=owner%40rig");
    expect(withFreshToken.status).toBe(409);
    expect(await withFreshToken.json()).toMatchObject({ error: "stale_transition", qitemId: old.qitemId, currentState: "done" });
    freshUntouched(fresh, before);
    // With no token at all, the same key and query change nothing about which row is addressed.
    const noToken = await post(old.qitemId, { state: "done", transitionNote: "closing", dedupeKey: "alarm:disk" }, "?dedupeKey=alarm%3Adisk");
    expect(noToken.status).toBe(200);
    expect(await noToken.json()).toMatchObject({ qitemId: old.qitemId, alreadyTerminal: true });
    freshUntouched(fresh, before);
  });

  it("(i) nothing in the update route or the update path resolves a row by key", () => {
    const route = fs.readFileSync(path.resolve(__dirname, "../src/routes/queue.ts"), "utf8");
    const start = route.indexOf('app.post("/:qitemId/update"');
    const handler = route.slice(start, route.indexOf('app.post("/:qitemId/handoff"', start));
    expect(start).toBeGreaterThan(0);
    expect(handler).not.toMatch(/dedupe/i);
    const repoSrc = fs.readFileSync(path.resolve(__dirname, "../src/domain/queue-repository.ts"), "utf8");
    const update = repoSrc.slice(repoSrc.indexOf("private updateInTransactionalContext("), repoSrc.indexOf("private updateInTransactionalContext(") + 2400);
    expect(update).toContain("this.getById(input.qitemId)");
    expect(update).not.toMatch(/openDedupeHolder|dedupeHit|dedupe_key/);
  });

  it("(ii) a stale token is 409 stale_transition, the target is unchanged, and nothing is written", async () => {
    const row = await repo.create({ ...A });
    const stale = repo.getById(row.qitemId)!.lastTransitionId!;
    repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", transitionNote: "someone touched it" });
    const before = trail(db, row.qitemId);
    const res = await post(row.qitemId, { state: "done", closureReason: "no-follow-on", expectedTransitionId: stale });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "stale_transition", expectedTransitionId: stale, currentState: "pending",
      currentTransitionId: repo.getById(row.qitemId)!.lastTransitionId });
    expect(repo.getById(row.qitemId)?.state).toBe("pending");
    expect(trail(db, row.qitemId)).toEqual(before);
    expect(count(db, "SELECT COUNT(*) c FROM events WHERE type = 'queue.updated'")).toBe(1); // only the earlier note
  });

  it("(iii) no token on a terminal row: 200 with alreadyTerminal and a machine-readable warning, state unchanged, the re-raised row untouched", async () => {
    const { old, fresh } = await reRaised();
    const before = trail(db, fresh.qitemId);
    const res = await post(old.qitemId, { state: "done", transitionNote: "closing" });
    expect(res.status).toBe(200);
    const body = await res.json() as { state: string; alreadyTerminal: boolean; lastTransitionId: number; updateWarning: Record<string, unknown> };
    expect(body).toMatchObject({ state: "done", alreadyTerminal: true });
    expect(body.updateWarning).toMatchObject({ code: "already_terminal", currentState: "done", lastTransitionId: body.lastTransitionId });
    expect(typeof body.updateWarning.message).toBe("string");
    freshUntouched(fresh, before);
  });

  it("(iv) the current token on a live row closes it normally, with no warning", async () => {
    const row = await repo.create({ ...A });
    const current = repo.getById(row.qitemId)!.lastTransitionId!;
    const res = await post(row.qitemId, { state: "done", closureReason: "no-follow-on", expectedTransitionId: current });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect("alreadyTerminal" in body).toBe(false);
    expect("updateWarning" in body).toBe(false);
  });

  it("(v) S8a stays: an auditor restating a cancel appends one transition, leaves the row alone, and is told it closed nothing", async () => {
    const row = await repo.create({ ...A });
    repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: "canceled", transitionNote: "not needed" });
    const rowBefore = db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(row.qitemId);
    const transitions = trail(db, row.qitemId).length;
    const res = await post(row.qitemId, { state: "canceled", transitionNote: "confirm cancellation" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "canceled", alreadyTerminal: true, updateWarning: { code: "already_terminal", currentState: "canceled" } });
    expect(db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(row.qitemId)).toEqual(rowBefore);
    expect(trail(db, row.qitemId)).toHaveLength(transitions + 1);
    expect(trail(db, row.qitemId).at(-1)?.note).toBe("confirm cancellation");
  });

  it("(vi) a coalesced raise is on the ledger and does not overwrite the surviving row", async () => {
    const first = await repo.create({ ...A, dedupeKey: "k", summary: "disk is full", tags: ["mission:ops"] });
    await repo.create({ ...A, body: "other text", summary: "other", tags: ["x"], dedupeKey: "k" });
    const row = repo.getById(first.qitemId)!;
    expect({ body: row.body, summary: row.summary, tags: row.tags }).toEqual({ body: "alarm", summary: "disk is full", tags: ["mission:ops"] });
    expect(trail(db, first.qitemId).map((t) => t.note)).toContain(`coalesced raise from ${A.sourceSession}, body sha256 ${sha("other text")}`);
  });

  it("condition 1: a second raise of the same destination and key returns the EXISTING open row's id, and does not drop the raise", async () => {
    const first = await repo.create({ ...A, dedupeKey: "k" });
    const second = await repo.create({ ...A, dedupeKey: "k" });
    expect(second.qitemId).toBe(first.qitemId);
    expect(rows(db)).toBe(1);
    expect(second.coalescedCount).toBe(1); // the raise is counted, not lost
  });

  it("condition 5: the open-row invariant is per destination and key; a done, canceled or handed-off row frees the key", async () => {
    const one = await repo.create({ ...A, dedupeKey: "k" });
    const other = await repo.create({ ...A, destinationSession: "second@rig", dedupeKey: "k" });
    expect(other.qitemId).not.toBe(one.qitemId);
    for (const how of ["done", "canceled", "handed-off"] as const) {
      const row = await repo.create({ ...A, destinationSession: `free-${how}@rig`, dedupeKey: "k" });
      if (how === "done") close(repo, row.qitemId);
      else if (how === "canceled") repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: how, transitionNote: "not needed" });
      else repo.update({ qitemId: row.qitemId, actorSession: "owner@rig", state: how, closureReason: "handed_off_to", closureTarget: "next@rig" });
      const next = await repo.create({ ...A, destinationSession: `free-${how}@rig`, dedupeKey: "k" });
      expect(next.qitemId, how).not.toBe(row.qitemId);
      expect(next.deduped, how).toBeUndefined();
    }
  });
});
