import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { physicalSessionName } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { migrationsForFullTestDb } from "./helpers/test-app.js";

// P23: physicalSessionName resolves an address with a join over every node, and an inventory read calls it once per
// node from several places (~100 statements per GET /nodes). It is now kept per connection and dropped whenever the
// database changes. These tests pin both halves: it IS cached while nothing changes, and it is NEVER stale after a
// change made through this connection or any other.
describe("physicalSessionName cache (P23)", () => {
  let dir: string;
  let db: Database.Database;
  let other: Database.Database;
  let registry: SessionRegistry;
  let nodeId: string;
  const ADDRESS = "dev-a@cache";

  const bind = (sessionName: string) => {
    const s = registry.registerSession(nodeId, sessionName);
    registry.updateStatus(s.id, "running");
    registry.updateBinding(nodeId, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
  };
  const countStatements = <T>(fn: () => T): { value: T; statements: number } => {
    let statements = 0;
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => { statements++; return real(sql); };
    try { return { value: fn(), statements }; } finally { (db as unknown as { prepare: unknown }).prepare = real; }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "p23-cache-"));
    const file = join(dir, "db.sqlite");
    db = new Database(file);
    db.pragma("journal_mode = WAL");
    migrate(db, migrationsForFullTestDb);
    other = new Database(file); // a second connection, like another process on the same file
    registry = new SessionRegistry(db);
    const repo = new RigRepository(db);
    void new EventBus(db);
    nodeId = repo.addNode(repo.createRig("cache").id, "dev.a", { runtime: "claude-code", cwd: "/p" }).id;
    bind("r01-one");
  });
  afterEach(() => { db.close(); other.close(); rmSync(dir, { recursive: true, force: true }); });

  it("resolves a team address to the node's current physical session", () => {
    expect(physicalSessionName(db, ADDRESS)).toBe("r01-one");
    expect(physicalSessionName(db, "plain-name")).toBe("plain-name"); // no '@': returned untouched
  });

  it("a second lookup with no change in between issues no resolution statement", () => {
    physicalSessionName(db, ADDRESS);
    const { value, statements } = countStatements(() => physicalSessionName(db, ADDRESS));
    expect(value).toBe("r01-one");
    expect(statements).toBe(0); // RED if the cache is removed: the join is prepared again
  });

  it("a change through the same connection is seen at once", () => {
    expect(physicalSessionName(db, ADDRESS)).toBe("r01-one");
    bind("r02-two");
    expect(physicalSessionName(db, ADDRESS)).toBe("r02-two"); // RED if only data_version were checked
  });

  it("a change committed by another connection is seen at once", () => {
    expect(physicalSessionName(db, ADDRESS)).toBe("r01-one");
    const id = "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"; // sorts after any real id, so it is the latest session
    other.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, 'r03-three')").run(id, nodeId);
    other.prepare("UPDATE bindings SET tmux_session='r03-three' WHERE node_id=?").run(nodeId);
    expect(physicalSessionName(db, ADDRESS)).toBe("r03-three"); // RED if only total_changes were checked
  });

  it("a rolled-back change does not leave a stale answer behind", () => {
    expect(physicalSessionName(db, ADDRESS)).toBe("r01-one");
    const tx = db.transaction(() => { bind("r09-nine"); expect(physicalSessionName(db, ADDRESS)).toBe("r09-nine"); throw new Error("abort"); });
    expect(() => tx()).toThrow("abort");
    expect(physicalSessionName(db, ADDRESS)).toBe("r01-one");
  });

  it("a minimal connection with no pragma() still resolves, uncached (test doubles and read models)", () => {
    // Several suites hand physicalSessionName a fake {prepare} object. Not being able to compute the change token must
    // mean "do not cache", never an exception.
    let resolutions = 0;
    const fake = { prepare: (sql: string) => ({ get: () => { if (sql.includes("sqlite_master")) return { 1: 1 }; return undefined; },
      all: () => { resolutions++; return []; } }) } as unknown as Database.Database;
    expect(physicalSessionName(fake, ADDRESS)).toBe(ADDRESS);
    expect(physicalSessionName(fake, ADDRESS)).toBe(ADDRESS);
    expect(resolutions).toBe(2); // asked twice: nothing was cached
  });
});

