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
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { queueItemDedupeKeySchema } from "../src/db/migrations/141_queue_item_dedupe_key.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
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

  it("a second create with the same key returns the open row and writes nothing", async () => {
    const first = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    const second = await repo.create({ ...A, dedupeKey: "alarm:disk" });
    expect(second.qitemId).toBe(first.qitemId);
    expect(second).toMatchObject({ deduped: true, dedupeKey: "alarm:disk" });
    expect(first.deduped).toBeUndefined();
    expect(rows(db)).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM events WHERE type = 'queue.created'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions")).toBe(1);
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
