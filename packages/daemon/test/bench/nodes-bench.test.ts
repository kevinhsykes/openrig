import { describe, it } from "vitest";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { ALL_MIGRATIONS } from "../../src/db/all-migrations.js";
import { migrate } from "../../src/db/migrate.js";
import { createTestApp } from "../helpers/test-app.js";

// P23 measurement harness (not a unit test): runs GET /api/rigs/:id/nodes for every rig against a COPY of a real
// daemon database and reports per-request time, event-loop delay and the SQL that costs the most. Skipped unless
// P23_DB names a copy (never the live file): P23_DB=/path/copy.sqlite npx vitest run test/bench/nodes-bench.test.ts
// P23_ROUNDS (default 3) sets how many sweeps over all rigs; P23_OUT writes the JSON report.
const SOURCE = process.env["P23_DB"];

describe.skipIf(!SOURCE)("P23 /nodes bench", () => {
  it("measures GET /api/rigs/:id/nodes on a database copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p23-"));
    const file = join(dir, "work.sqlite");
    copyFileSync(SOURCE!, file);
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    migrate(db, ALL_MIGRATIONS);

    const callers = new Map<string, number>();
    const sqlTime = new Map<string, { n: number; ms: number; max: number }>();
    const rawPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const stmt = rawPrepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const m of ["all", "get", "run"]) {
        const orig = stmt[m]!.bind(stmt);
        stmt[m] = (...a: unknown[]) => {
          const t0 = performance.now();
          try { return orig(...a); } finally {
            const dt = performance.now() - t0;
            const key = sql.replace(/\s+/g, " ").slice(0, 160);
            if (process.env["P23_STACK"] && key.includes(process.env["P23_STACK"])) {
              // callers of the statement, innermost src/ frames only, counted across the run
              const frames = (new Error().stack ?? "").split("\n").filter(f => f.includes("/src/")).slice(1, 4)
                .map(f => f.trim().replace(/^at /, "").replace(/\(?\/.*\/packages\/daemon\//, "("));
              const where = frames.join(" <- ");
              callers.set(where, (callers.get(where) ?? 0) + 1);
            }
            const e = sqlTime.get(key) ?? { n: 0, ms: 0, max: 0 };
            e.n++; e.ms += dt; e.max = Math.max(e.max, dt); sqlTime.set(key, e);
          }
        };
      }
      return stmt as never;
    };

    const { app, rigRepo } = createTestApp(db);
    const rigs = rigRepo.listRigs();
    const rounds = Number(process.env["P23_ROUNDS"] ?? 3);
    // P23_WRITE_EVERY=n: a second connection (like the daemon's own pollers or another process) commits one row after every
    // n requests, so the database changes between requests the way a live daemon's does. Deterministic on purpose: a timer
    // cannot fire inside this sequential loop. Default off.
    const writeEvery = Number(process.env["P23_WRITE_EVERY"] ?? 0);
    let noiseWrites = 0;
    const writer = writeEvery ? new Database(file) : undefined;
    writer?.exec("CREATE TABLE IF NOT EXISTS p23_noise (n INTEGER)");
    // P23_COLD=1: before each request, drop the database file's pages from the OS cache (posix_fadvise via dd), so SQLite
    // reads come from disk the way they do when the host is swapping. Needs the file on a real filesystem (set TMPDIR).
    const cold = process.env["P23_COLD"] === "1";
    let requestNo = 0;
    const h = monitorEventLoopDelay({ resolution: 5 });
    const times: number[] = [];
    const perRig: Record<string, number[]> = {};
    h.enable();
    for (let r = 0; r < rounds; r++) {
      for (const rig of rigs) {
        if (writer && requestNo++ % writeEvery === 0) { writer.prepare("INSERT INTO p23_noise VALUES (1)").run(); noiseWrites++; }
        if (cold) spawnSync("/usr/bin/dd", ["if=/dev/null", `of=${file}`, "oflag=nocache", "conv=notrunc", "count=0"], { stdio: "ignore" });
        const t0 = performance.now();
        const res = await app.request(`/api/rigs/${rig.id}/nodes`);
        await res.text();
        const dt = performance.now() - t0;
        times.push(dt);
        (perRig[rig.name] ??= []).push(dt);
      }
    }
    h.disable();
    writer?.close();
    times.sort((a, b) => a - b);
    const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))]!;
    const topSql = [...sqlTime.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12)
      .map(([sql, e]) => ({ sql, calls: e.n, totalMs: +e.ms.toFixed(1), maxMs: +e.max.toFixed(1) }));
    const report = {
      rigs: rigs.length, requests: times.length,
      requestMs: { p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +times[times.length - 1]!.toFixed(1), total: +times.reduce((a, b) => a + b, 0).toFixed(1) },
      eventLoopDelayMs: { p99: +(h.percentile(99) / 1e6).toFixed(1), max: +(h.max / 1e6).toFixed(1) },
      noiseWrites,
      sqlTotalMs: +[...sqlTime.values()].reduce((a, e) => a + e.ms, 0).toFixed(1),
      topSql,
    };
    if (callers.size) console.log("P23_CALLERS " + JSON.stringify([...callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8), null, 1));
    console.log("P23_REPORT " + JSON.stringify(report, null, 1));
    if (process.env["P23_OUT"]) writeFileSync(process.env["P23_OUT"], JSON.stringify(report, null, 1));
    db.close();
  }, 600_000);
});
