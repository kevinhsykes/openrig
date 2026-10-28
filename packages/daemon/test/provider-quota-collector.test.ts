import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  COLLECTOR_SOURCE_NOT_STATED, isKnownProviderKind, knownProviderKinds, registerProviderKinds, resetRegisteredProviderKinds,
  type CollectorQuotaIdentity, type ProviderUsageAllowance,
} from "../src/domain/provider/provider-types.js";
import { PROVIDER_QUOTA_FILE_ENV, PROVIDER_RAILS_FILE_ENV, parseAllowedRails, registerAllowedRailsFromEnv, type AllowedRail } from "../src/domain/provider/provider-rails.js";
import { COLLECTOR_SIGN_IN_EVIDENCE, QuotaCollectorUsage, QUOTA_FILE_SCHEMA, QUOTA_FILE_MAX_BYTES, QUOTA_READ_TIMEOUT_MS, quotaCollectorFromEnv, sliceRail } from "../src/domain/provider/quota-collector-usage.js";
import { signalEligibleForAutomation } from "../src/domain/provider/provider-policy.js";
import { allowanceKey, crossHostLinkKey, groupUsageAcrossHosts } from "../src/domain/provider/usage-across-hosts.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { providerRoutes } from "../src/routes/provider.js";
import { createFullTestDb } from "./helpers/test-app.js";

// P4 — usage readings for the subscription rails the fleet's quota collector meters, read from its availability file. Advisory only:
// a derived file proves rail-level use, never which account spent it. The fixture is the redacted shape of the live file (account
// fingerprints replaced; no real account ids).

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "quota-collector", "provider-availability.redacted.json"), "utf8")) as Record<string, any>;

// The allowed-rails export's entries: {rail, storeKey, aliases, nativeReader}. The file's keys are STORE keys; the mapping is only here.
const rail = (name: string, storeKey: string, nativeReader = false): AllowedRail => ({ rail: name, storeKey, aliases: [], nativeReader });
const RAILS: AllowedRail[] = [
  rail("zai", "zai"), rail("ollama_cloud", "ollama-cloud"), rail("xai", "xai"), rail("muse_code", "muse-code"), rail("mistralvibe", "mistralvibe"),
  rail("codex", "openai", true), rail("qwen", "qwen"), rail("minimax", "minimax"),
];
const FRESH_NOW = "2026-10-27T21:43:00.000Z";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); resetRegisteredProviderKinds(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fileWith(content: unknown | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-collector-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "provider_availability.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}
const mutated = (fn: (d: Record<string, any>) => void) => { const d = structuredClone(FIXTURE); fn(d); return d; };
const collector = (content: unknown | string, now = FRESH_NOW, rails: AllowedRail[] = RAILS) =>
  new QuotaCollectorUsage({ file: content === null ? path.join(os.tmpdir(), "no-such-dir-quota", "x.json") : fileWith(content), rails, now: () => now });
const rowsOf = (rows: ProviderUsageAllowance[], rail: string) => rows.filter((r) => r.provider === rail);
const windowRow = (rows: ProviderUsageAllowance[], rail: string, window: string) =>
  rows.find((r) => r.provider === rail && (r.identity as CollectorQuotaIdentity | null)?.window === window)!;

function service(enabled: boolean, feed: QuotaCollectorUsage | null = collector(FIXTURE)) {
  const windows = new CodexUsageWindows({ now: () => FRESH_NOW, read: async () => ({ ok: false, at: FRESH_NOW, reason: "no_codex", detail: "no codex in this test" }) });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quota-svc-home-"));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return new ProviderServiceImpl({ db: createFullTestDb(), listRigs: () => [], env: { CODEX_HOME: home } as NodeJS.ProcessEnv, now: () => FRESH_NOW,
    usageWindows: { enabled: () => enabled, windows, ...(feed ? { collector: feed } : {}) } });
}

describe("fresh readings", () => {
  it("serves each window of an allowed rail as its own row: provider is the rail, keyed rail:<rail>:<window>, advisory, carrying reset_at", async () => {
    const c = collector(FIXTURE);
    await c.refreshAll();
    const rows = c.project(FRESH_NOW);
    expect(rowsOf(rows, "zai")).toHaveLength(3);
    const five = windowRow(rows, "zai", "5h");
    expect(five).toMatchObject({
      provider: "zai", source: { kind: "quota_collector_file", host: "local" }, latestFromSource: true, currentAvailability: "known",
      identity: { provider: "zai", rail: "zai", window: "5h", source: "z.ai-live", recordState: "AVAILABLE", unknown: null },
      windows: [{ window: "5h", usedPercent: 21, remainingPercent: 79, resetsAt: "2026-10-28T00:49:11.417000+00:00", observedAt: "2026-10-27T21:42:10.373723+00:00", level: "ok", freshness: "fresh" }],
    });
    expect(windowRow(rows, "zai", "weekly").windows[0]).toMatchObject({ usedPercent: 20 });
    expect(windowRow(rows, "zai", "mcp-tools").windows[0]).toMatchObject({ usedPercent: 1 });
    // The file's store key differs from the rail id for some rails: the row is the rail, the identity keeps the file's key.
    expect(windowRow(rows, "ollama_cloud", "session").identity).toMatchObject({ rail: "ollama_cloud", provider: "ollama-cloud" });
    // `lastRefresh.at` is the time the FILE was read, not the file's updated_at and not a window's observed_at; staleness comes from the windows.
    expect(five.lastRefresh).toMatchObject({ outcome: "ok", at: FRESH_NOW });
    expect(c.summary()).toMatchObject({ readAt: FRESH_NOW, fileUpdatedAt: "2026-10-27T21:42:43Z" });
    expect(five.windows[0]!.observedAt).toBe("2026-10-27T21:42:10.373723+00:00");
    // One reading per window, keyed by rail and window: a second read replaces, never duplicates.
    await c.refreshAll();
    expect(rowsOf(c.project(FRESH_NOW), "zai")).toHaveLength(3);
  });

  it("claims no sign-in, account history or saved profile: the engine's Codex-shaped facts are replaced, and no fingerprint is carried", async () => {
    const c = collector(FIXTURE);
    await c.refreshAll();
    const rows = c.project(FRESH_NOW);
    for (const row of rows) {
      expect(row.signIn).toEqual({ state: "unknown", at: null, evidence: COLLECTOR_SIGN_IN_EVIDENCE });
      expect(COLLECTOR_SIGN_IN_EVIDENCE).toBe("read from the fleet quota collector file; no sign-in through OpenRig");
      expect(row.accountHistory).toBe("unknown");
      expect(row).not.toHaveProperty("savedProfile");
      expect(JSON.stringify(row)).not.toMatch(/CODEX_HOME|account_fingerprint|<redacted>|raw_hash/);
    }
  });

  it("keeps each row's file source string verbatim, never relabeled (another writer's rows and a carried-over reading read as what they are)", async () => {
    const c = collector(FIXTURE);
    await c.refreshAll();
    const rows = c.project(FRESH_NOW);
    expect(windowRow(rows, "muse_code", "monthly").identity).toMatchObject({ source: "muse-msp-usage-read" });
    expect(windowRow(rows, "xai", "weekly").identity).toMatchObject({ source: "grok-cli-unified-jsonl" });
    const carried = windowRow(rows, "mistralvibe", "vibe-code");
    expect((carried.identity as CollectorQuotaIdentity).source).toBe("last-known:mistralvibe (probe failed)");
    // No single label of ours stands in for a producer: no row's source is one invented string, and a window with none says so.
    expect(new Set(rows.flatMap((r) => (r.identity ? [(r.identity as CollectorQuotaIdentity).source] : []))).size).toBeGreaterThan(4);
    const unsourced = collector(mutated((d) => { delete d.providers.zai.quota_windows[1].source; }));
    await unsourced.refreshAll();
    expect(windowRow(unsourced.project(FRESH_NOW), "zai", "5h").identity).toMatchObject({ source: COLLECTOR_SOURCE_NOT_STATED });
    // The carryover is days old, so it reads stale, not current.
    expect(carried.windows[0]).toMatchObject({ freshness: "stale", freshnessReason: expect.stringContaining("min ago") });
    expect(carried.currentAvailability).toBe("unknown");
  });
});

describe("stale readings", () => {
  it("an old file goes stale from each window's own observed_at, and the row says so", async () => {
    const later = "2026-10-27T22:03:00.000Z";
    const c = collector(FIXTURE, later);
    await c.refreshAll();
    const row = windowRow(c.project(later), "zai", "5h");
    expect(row.windows[0]).toMatchObject({ freshness: "stale", freshnessReason: expect.stringMatching(/observed 2\d min ago \(fresh for 15 min\)/), usedPercent: 21 });
    expect(row.currentAvailability).toBe("unknown");
  });
});

describe("exhausted and unknown", () => {
  it("a window at 0 remaining is exhausted, and a latched EXHAUSTED rail is exhausted whatever one window's fraction says, with the file's evidence", async () => {
    const c = collector(FIXTURE);
    await c.refreshAll();
    expect(windowRow(c.project(FRESH_NOW), "xai", "weekly")).toMatchObject({ windows: [{ usedPercent: 100, level: "exhausted", levelReason: "at the limit" }],
      identity: { recordState: "EXHAUSTED" } });
    const latched = collector(mutated((d) => { d.providers.xai.quota_windows[0].remaining_fraction = 0.8; }));
    await latched.refreshAll();
    const row = windowRow(latched.project(FRESH_NOW), "xai", "weekly");
    expect(row.windows[0]).toMatchObject({ usedPercent: 20, level: "exhausted", levelReason: expect.stringContaining("file record state EXHAUSTED, set by hard-fail, expected to clear 2026-10-27T06:14:59Z") });
    expect(row.limitEvidence).toContain("EXHAUSTED");
  });

  it("a window the file marks unknown, or whose fraction isn't a number in 0..1, has no used percent (never 0) and says why", async () => {
    const c = collector(mutated((d) => {
      d.providers["ollama-cloud"].quota_windows = [
        { observed_at: "2026-10-27T21:40:00+00:00", unknown: true, kind: "auth_failed", reason: "login expired", window_id: "session", source: "ollama-cloud-live" },
        { observed_at: "2026-10-27T21:40:00+00:00", remaining_fraction: "0.9", window_id: "weekly", source: "ollama-cloud-live" },
        { observed_at: "2026-10-27T21:40:00+00:00", remaining_fraction: 1.5, window_id: "monthly", source: "ollama-cloud-live" },
        { observed_at: "2026-10-27T21:40:00+00:00", window_id: "daily", source: "ollama-cloud-live" },
      ];
    }));
    await c.refreshAll();
    const rows = rowsOf(c.project(FRESH_NOW), "ollama_cloud");
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.windows[0]!.usedPercent).toBeNull();
      expect(row.windows[0]!.remainingPercent).toBeNull();
      expect(row.windows[0]!.level).toBe("unknown");
      expect(row.currentAvailability).toBe("unknown");
    }
    expect(windowRow(rows, "ollama_cloud", "session").identity).toMatchObject({ unknown: { kind: "auth_failed", reason: "login expired" } });
    expect(windowRow(rows, "ollama_cloud", "weekly").identity).toMatchObject({ unknown: { kind: "remaining_fraction_unreadable", reason: "remaining_fraction was a string" } });
    expect(windowRow(rows, "ollama_cloud", "monthly").identity).toMatchObject({ unknown: { reason: "remaining_fraction was outside 0..1" } });
    expect(windowRow(rows, "ollama_cloud", "daily").identity).toMatchObject({ unknown: { reason: "remaining_fraction was absent" } });
  });
});

describe("unavailable, malformed, unrecognized and set-aside inputs are visible, never silently dropped", () => {
  it("a missing file reads unavailable on every rail, with the reason, and the summary says so", async () => {
    const c = collector(null);
    await c.refreshAll();
    const rows = c.project(FRESH_NOW);
    expect(rows.map((r) => r.provider).sort()).toEqual(["minimax", "mistralvibe", "muse_code", "ollama_cloud", "qwen", "xai", "zai"]);
    for (const row of rows) {
      expect(row).toMatchObject({ identity: null, windows: [], currentAvailability: "unknown", unavailableReason: expect.stringContaining("file_missing") });
    }
    expect(c.summary()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("file_missing") });
  });

  it("an unreadable shape is a visible failure with its reason: not JSON, no providers, another schema version, a row that isn't a mapping", async () => {
    for (const [content, reason] of [
      ["{ not json", "file_malformed"],
      [{ schema_version: QUOTA_FILE_SCHEMA }, "file_malformed"],
      [{ schema_version: "provider-availability.v2", providers: {} }, "unsupported_schema"],
      [{ providers: {} }, "unsupported_schema"],
    ] as const) {
      const c = collector(content as never);
      await c.refreshAll();
      expect(c.summary()).toMatchObject({ state: "unavailable", reason: expect.stringContaining(reason) });
      expect(c.project(FRESH_NOW).every((r) => r.identity === null && r.unavailableReason?.includes(reason))).toBe(true);
    }
    const oneBad = collector(mutated((d) => { d.providers.zai = "oops"; }));
    await oneBad.refreshAll();
    const rows = oneBad.project(FRESH_NOW);
    expect(rowsOf(rows, "zai")[0]).toMatchObject({ identity: null, unavailableReason: expect.stringContaining("unrecognized_shape") });
    // The other rails are served as usual.
    expect(windowRow(rows, "xai", "weekly").windows[0]!.usedPercent).toBe(100);
  });

  it("keeps an earlier reading, marked old, when a later read fails", async () => {
    const file = fileWith(FIXTURE);
    const c = new QuotaCollectorUsage({ file, rails: RAILS, now: () => FRESH_NOW });
    await c.refreshAll();
    fs.writeFileSync(file, "{ broken");
    await c.refreshAll();
    const row = windowRow(c.project("2026-10-27T21:44:00.000Z"), "zai", "5h");
    expect(row.windows[0]).toMatchObject({ usedPercent: 21, freshness: "stale", freshnessReason: expect.stringContaining("refresh failed") });
    expect(row.lastRefresh).toMatchObject({ outcome: "failed", reason: "file_malformed" });
  });

  it("a file rail that isn't allowed is skipped and counted by name; a rail with a native reader is read by it, not here", async () => {
    const c = collector(FIXTURE);
    await c.refreshAll();
    const summary = c.summary();
    expect(summary.unrecognizedRails).toEqual({ count: 2, keys: ["from-account-store", "mystery-vendor"] });
    expect(c.project(FRESH_NOW).some((r) => ["mystery-vendor", "from-account-store"].includes(r.provider))).toBe(false);
    expect(summary.nativeRailsSkipped).toEqual(["codex"]);
    expect(c.project(FRESH_NOW).some((r) => r.provider === "codex")).toBe(false);
    // The export's flag decides, not the rail's name: a family rail flagged nativeReader is excluded and its file row is not "unrecognized".
    const flagged = collector(FIXTURE, FRESH_NOW, [...RAILS, rail("claude_pro", "anthropic-pro", true), rail("golisano", "golisano", true)]);
    await flagged.refreshAll();
    expect(flagged.summary().nativeRailsSkipped).toEqual(["codex", "claude_pro", "golisano"]);
    expect(flagged.project(FRESH_NOW).some((r) => r.provider === "claude_pro" || r.provider === "golisano")).toBe(false);
    expect(summary.rails).toEqual(["zai", "ollama_cloud", "xai", "muse_code", "mistralvibe", "qwen", "minimax"]);
    expect(summary).toMatchObject({ state: "ok", fileUpdatedAt: "2026-10-27T21:42:43Z" });
  });

  it("an allowed rail with no row, or no window, is shown unavailable and named, not dropped", async () => {
    const c = collector(FIXTURE);
    await c.refreshAll();
    expect(c.summary().railsWithoutWindows).toEqual(["qwen", "minimax"]);
    const rows = c.project(FRESH_NOW);
    // One row per rail, state explicit unknown, with the reason; the read time is on the row's lastRefresh.
    expect(rowsOf(rows, "qwen")).toHaveLength(1);
    expect(rowsOf(rows, "qwen")[0]).toMatchObject({ identity: null, currentAvailability: "unknown", windows: [], unavailableReason: "no windows in file", lastRefresh: { outcome: "ok" } });
    expect(rowsOf(rows, "minimax")[0]).toMatchObject({ identity: null, currentAvailability: "unknown", unavailableReason: "no row in file" });
    // A row whose every window was set aside is not "no windows": it says some were set aside.
    const aside = collector(mutated((d) => { d.providers.zai.quota_windows = [{ remaining_fraction: 0.5 }, { window_id: "x" }]; d.providers.zai.quota_observation = null; }));
    await aside.refreshAll();
    expect(rowsOf(aside.project(FRESH_NOW), "zai")[0]).toMatchObject({ identity: null, unavailableReason: "no usable windows in file (2 set aside)" });
  });

  it("a window with no id or observation time, or a repeated id, is set aside and named", () => {
    const slice = sliceRail({ rail: "zai", storeKey: "zai" }, {
      quota_windows: [
        { remaining_fraction: 0.5, observed_at: "2026-10-27T21:00:00Z" },
        { remaining_fraction: 0.5, window_id: "a" },
        { remaining_fraction: 0.5, window_id: "b", observed_at: "not a time" },
        { remaining_fraction: 0.5, window_id: "c", observed_at: "2026-10-27T21:00:00Z" },
        { remaining_fraction: 0.4, window_id: "c", observed_at: "2026-10-27T21:00:00Z" },
        "junk",
      ],
    });
    expect("error" in slice).toBe(false);
    if ("error" in slice) return;
    expect(slice.readings.map((r) => r.identity.window)).toEqual(["c"]);
    expect(slice.skipped).toEqual([
      { rail: "zai", window: null, reason: "no_window_id" }, { rail: "zai", window: "a", reason: "no_observation_time" },
      { rail: "zai", window: "b", reason: "no_observation_time" }, { rail: "zai", window: "c", reason: "duplicate_window_id" },
      { rail: "zai", window: null, reason: "not_a_mapping" },
    ]);
  });

  it("the single quota_observation stands in when there is no window list", () => {
    const slice = sliceRail({ rail: "zai", storeKey: "zai" }, { quota_windows: null, quota_observation: { observed_at: "2026-10-27T21:00:00Z", remaining_fraction: 0.25, window_id: "5h" } });
    expect("error" in slice || slice.readings.map((r) => r.windows[0]!.usedPercent)).toEqual([75]);
  });
});

describe("advisory only, by structure: collector readings are usage rows and never signals", () => {
  it("the feed has no signal output, and its rows carry none of a signal's automation fields", async () => {
    const c = collector(FIXTURE);
    await c.refreshAll();
    expect("signals" in c).toBe(false);
    for (const row of c.project(FRESH_NOW)) {
      expect(row).not.toHaveProperty("sourceClass");
      expect(row).not.toHaveProperty("authority");
      expect(row).not.toHaveProperty("automationUse");
      for (const w of row.windows) expect(w).not.toHaveProperty("automationUse");
    }
  });

  it("a read model with collector rows has no signal for any collector rail, so the automation policy is never given one", async () => {
    const model = await service(true).getReadModel();
    const railIds = RAILS.filter((r) => !r.nativeReader).map((r) => r.rail);
    expect(model.usage!.filter((r) => railIds.includes(r.provider)).length).toBeGreaterThan(8);
    expect(model.signals.filter((sig) => railIds.includes(sig.provider))).toEqual([]);
    // Everything the policy would be asked about came from somewhere else, and none of it is a collector reading.
    for (const sig of model.signals) expect(signalEligibleForAutomation(sig, FRESH_NOW).refusals.length).toBeGreaterThan(0);
    // Unavailable feeds are the same: a missing file adds rows, never signals.
    const missing = await service(true, collector(null)).getReadModel();
    expect(missing.usage!.some((r) => r.provider === "zai")).toBe(true);
    expect(missing.signals.filter((sig) => railIds.includes(sig.provider))).toEqual([]);
  });
});

describe("one read of the file per refresh", () => {
  it("bounds a stalled open and reports unavailable instead of hanging status", async () => {
    vi.useFakeTimers();
    vi.spyOn(fs.promises, "open").mockImplementation(() => new Promise<never>(() => {}));
    const c = collector(FIXTURE);
    const pending = c.refreshAll();
    await vi.advanceTimersByTimeAsync(QUOTA_READ_TIMEOUT_MS + 1);
    await pending;
    expect(c.summary()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("file_read_timeout") });
  });

  it("rejects non-files and files larger than the byte budget", async () => {
    for (const file of [path.dirname(fileWith(FIXTURE)), fileWith("x".repeat(QUOTA_FILE_MAX_BYTES + 1))]) {
      const c = new QuotaCollectorUsage({ file, rails: RAILS, now: () => FRESH_NOW });
      await c.refreshAll();
      expect(c.summary().state).toBe("unavailable");
    }
  });

  // P28: the two above only say "unavailable"; a directory fails with or without the file-type check (the read errors
  // differently). These pin the reason, and use the real thing the check exists for: a FIFO nobody writes to.
  it("a directory at the collector path is refused as not a regular file, by name", async () => {
    const c = new QuotaCollectorUsage({ file: path.dirname(fileWith(FIXTURE)), rails: RAILS, now: () => FRESH_NOW });
    await c.refreshAll();
    expect(c.summary()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("ENOTFILE") });
  });

  it("a FIFO at the collector path is refused as not a regular file, at once, and is never read", async () => {
    const fifo = path.join(path.dirname(fileWith(FIXTURE)), "collector.fifo");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const c = new QuotaCollectorUsage({ file: fifo, rails: RAILS, now: () => FRESH_NOW });
    const started = Date.now();
    await c.refreshAll();
    expect(Date.now() - started).toBeLessThan(QUOTA_READ_TIMEOUT_MS / 2);   // refused, not waited out by the deadline
    expect(c.summary()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("ENOTFILE") });
  });

  it("a read that never finishes is cut off by the deadline, not by the open", async () => {
    vi.useFakeTimers();
    const file = fileWith(FIXTURE);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      vi.spyOn(handle, "stat").mockImplementation((() => new Promise<never>(() => {})) as typeof handle.stat);   // opens, then stalls
      return handle;
    });
    const c = new QuotaCollectorUsage({ file, rails: RAILS, now: () => FRESH_NOW });
    const pending = c.refreshAll();
    await vi.advanceTimersByTimeAsync(QUOTA_READ_TIMEOUT_MS + 1);
    await pending;
    expect(c.summary()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("file_read_timeout") });
  });

  it("enforces the byte budget even if the file grows after its metadata was read", async () => {
    const file = fileWith(FIXTURE);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation((async () => {
        const before = await stat();
        fs.appendFileSync(file, " ".repeat(QUOTA_FILE_MAX_BYTES));
        return before;
      }) as typeof handle.stat);
      return handle;
    });
    const c = new QuotaCollectorUsage({ file, rails: RAILS, now: () => FRESH_NOW });
    await c.refreshAll();
    expect(c.summary()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("file_too_large") });
  });
  it("refreshing every rail reads the file once, and a single rail's refresh reads it once", async () => {
    const c = collector(FIXTURE);
    const spy = vi.spyOn(fs.promises, "open");
    await c.refreshAll();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    expect(await c.refresh("zai")).toMatchObject({ refresh: { outcome: "ok", coalesced: false } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await c.refresh("not-a-rail")).toEqual({ unavailable: true });
    expect(c.handles("zai")).toBe(true);
    expect(c.handles("codex")).toBe(false);
  });

  it("a status read re-reads the file at most once per interval", async () => {
    let t = Date.parse(FRESH_NOW);
    const c = new QuotaCollectorUsage({ file: fileWith(FIXTURE), rails: RAILS, now: () => new Date(t).toISOString(), minReadIntervalMs: 30_000 });
    const spy = vi.spyOn(fs.promises, "open");
    await c.refreshIfStale(); await c.refreshIfStale();
    expect(spy).toHaveBeenCalledTimes(1);
    t += 31_000;
    await c.refreshIfStale();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("rails register at load, and the registry keeps the built-in pair for what needs a native reader", () => {
  it("registered rails join the live list every daemon validator reads; isKnownProviderKind stays codex and claude", () => {
    expect(knownProviderKinds()).toEqual(["codex", "claude"]);
    registerProviderKinds(["zai", "ollama_cloud", "codex", "zai"]);
    expect(knownProviderKinds()).toEqual(["codex", "claude", "zai", "ollama_cloud"]);
    expect(isKnownProviderKind("zai")).toBe(false);
    expect(knownProviderKinds().includes("Zai")).toBe(false);
    expect(() => registerProviderKinds(["Bad Rail"])).toThrow("not a rail id");
    resetRegisteredProviderKinds();
    expect(knownProviderKinds()).toEqual(["codex", "claude"]);
  });

  it("the allowed-rails export is a list of {rail, storeKey, aliases, nativeReader}; it refuses a half-valid one whole", () => {
    const ok = parseAllowedRails({ rails: [
      { rail: "ollama_cloud", storeKey: "ollama-cloud", aliases: ["ollama"], nativeReader: false },
      { rail: "claude_pro", storeKey: "anthropic-pro", nativeReader: true },
      { rail: "codex", storeKey: "openai" },
    ] });
    expect(ok).toEqual({ ok: true, rails: [
      { rail: "ollama_cloud", storeKey: "ollama-cloud", aliases: ["ollama"], nativeReader: false },
      { rail: "claude_pro", storeKey: "anthropic-pro", aliases: [], nativeReader: true },
      // A rail whose id is a built-in kind is native whatever the flag says.
      { rail: "codex", storeKey: "openai", aliases: [], nativeReader: true },
    ] });
    expect(parseAllowedRails([{ rail: "zai", storeKey: "zai" }]).ok).toBe(true);
    for (const bad of [[], {}, "x", ["zai"], [{ rail: "zai" }], [{ rail: "Zai", storeKey: "z" }], [{ rail: "a", storeKey: "k" }, { rail: "a", storeKey: "j" }],
      [{ rail: "a", storeKey: "k" }, { rail: "b", storeKey: "k" }], [{ rail: "a", storeKey: "" }], [{ rail: "a", storeKey: "k", aliases: "x" }], [{ rail: "a", storeKey: "k", nativeReader: "yes" }]]) {
      expect(parseAllowedRails(bad).ok).toBe(false);
    }
  });

  it("the environment loads the export and builds the feed: only collector-served rails register; off when neither variable is set, a visible reason when half-set or unusable", async () => {
    expect(quotaCollectorFromEnv({})).toBeUndefined();
    expect(registerAllowedRailsFromEnv({})).toEqual({ state: "absent" });
    const rails = fileWith({ rails: [{ rail: "zai", storeKey: "zai" }, { rail: "ollama_cloud", storeKey: "ollama-cloud", aliases: [] }, { rail: "claude_pro", storeKey: "anthropic-pro", nativeReader: true }] });
    const quota = fileWith(FIXTURE);
    const feed = quotaCollectorFromEnv({ [PROVIDER_RAILS_FILE_ENV]: rails, [PROVIDER_QUOTA_FILE_ENV]: quota }, () => FRESH_NOW)!;
    expect(knownProviderKinds()).toEqual(["codex", "claude", "zai", "ollama_cloud"]);
    await feed.refreshAll();
    expect(feed.summary().rails).toEqual(["zai", "ollama_cloud"]);
    expect(feed.summary().nativeRailsSkipped).toEqual(["claude_pro"]);
    resetRegisteredProviderKinds();
    expect(quotaCollectorFromEnv({ [PROVIDER_QUOTA_FILE_ENV]: quota })!.summary()).toMatchObject({ state: "unavailable", reason: expect.stringContaining(PROVIDER_RAILS_FILE_ENV) });
    // A valid export with no collector file still registers its rails (the daemon accepts them) and says there is nothing to read.
    expect(quotaCollectorFromEnv({ [PROVIDER_RAILS_FILE_ENV]: rails })!.summary()).toMatchObject({ state: "unavailable", reason: expect.stringContaining(PROVIDER_QUOTA_FILE_ENV) });
    expect(knownProviderKinds()).toContain("zai");
    // An unusable export registers nothing, and the summary says why.
    resetRegisteredProviderKinds();
    expect(quotaCollectorFromEnv({ [PROVIDER_RAILS_FILE_ENV]: fileWith("nope"), [PROVIDER_QUOTA_FILE_ENV]: quota })!.summary())
      .toMatchObject({ state: "unavailable", reason: expect.stringContaining("isn't JSON") });
    expect(knownProviderKinds()).toEqual(["codex", "claude"]);
  });
});

describe("across hosts a collector reading has its own key and never links", () => {
  it("is keyed rail:<rail>:<window>, never through the Claude key function, and has no link key", async () => {
    const c = collector(FIXTURE);
    await c.refreshAll();
    const row = windowRow(c.project(FRESH_NOW), "zai", "5h");
    expect(allowanceKey(row)).toBe("rail:zai:5h");
    expect(crossHostLinkKey(row, "rail:zai:5h", "host-a")).toBeNull();
  });

  it("two collector rails read on two hosts stay four separate rows, each with unknown linkage and its own key, and a note that doesn't speak of Codex", async () => {
    const c = collector(FIXTURE);
    await c.refreshAll();
    const rows = c.project(FRESH_NOW);
    const zai = windowRow(rows, "zai", "5h"), ollama = windowRow(rows, "ollama_cloud", "session");
    const groups = groupUsageAcrossHosts([
      { hostId: "host-a", readAt: FRESH_NOW, row: zai }, { hostId: "host-b", readAt: FRESH_NOW, row: zai },
      { hostId: "host-a", readAt: FRESH_NOW, row: ollama }, { hostId: "host-b", readAt: FRESH_NOW, row: ollama },
    ]);
    expect(groups).toHaveLength(4);
    for (const g of groups) {
      expect(g.observations).toHaveLength(1);
      expect(g).toMatchObject({ linkage: "unknown" });
      expect(["rail:zai:5h", "rail:ollama_cloud:session"]).toContain(g.key);
      expect(g.notes.join(" ")).toContain("not linked to other hosts");
      expect(g.notes.join(" ")).not.toMatch(/Codex|undefined/);
    }
    expect(groups.map((g) => g.provider).sort()).toEqual(["ollama_cloud", "ollama_cloud", "zai", "zai"]);
  });

  it("a kind with no key function here has an unresolved (null) key, never the Claude one", async () => {
    const c = collector(FIXTURE);
    await c.refreshAll();
    const odd = { ...windowRow(c.project(FRESH_NOW), "zai", "5h"), provider: "weird", source: { kind: "claude_statusline_samples" as const, host: "local" as const } };
    expect(allowanceKey(odd)).toBeNull();
    const groups = groupUsageAcrossHosts([{ hostId: "a", readAt: FRESH_NOW, row: odd }]);
    expect(groups).toEqual([expect.objectContaining({ key: null, linkage: "unknown" })]);
  });
});

describe("through the service and routes", () => {

  it("a status read serves the rails' rows and the summary without a manual refresh, and only while provider.usage_windows is on", async () => {
    const on = await service(true).getReadModel();
    expect(on.usage!.filter((r) => r.provider === "zai")).toHaveLength(3);
    expect(on.quotaCollector).toMatchObject({ state: "ok", unrecognizedRails: { count: 2 } });
    // The host rollup is untouched by rails it has no rollup for.
    expect((on.hostUsage ?? []).every((r) => r.provider === "codex" || r.provider === "claude")).toBe(true);
    const off = await service(false).getReadModel();
    expect(off).not.toHaveProperty("usage");
    expect(off).not.toHaveProperty("quotaCollector");
    expect(off.usage?.some((r) => r.provider === "zai") ?? false).toBe(false);
  });

  it("refreshUsage reads a registered rail's file, answers unavailable for a kind with no reader, and leaves codex to its own reader", async () => {
    const svc = service(true);
    expect(await svc.refreshUsage("zai")).toMatchObject({ refresh: { outcome: "ok" } });
    expect(await svc.refreshUsage("not-a-rail")).toEqual({ unavailable: true });
    expect(await svc.refreshUsage("codex")).toMatchObject({ refresh: { outcome: "failed", reason: "no_codex" } });
    expect(await service(false).refreshUsage("zai")).toEqual({ disabled: true });
    expect(await service(true, null).refreshUsage("zai")).toEqual({ unavailable: true });
  });

  function app(svc: ProviderServiceImpl): Hono {
    const a = new Hono();
    a.use("*", async (c, next) => { c.set("providerService" as never, svc); await next(); });
    a.route("/api/provider", providerRoutes());
    return a;
  }

  it("the routes accept a registered rail and refuse an unregistered one naming the live list, including across hosts", async () => {
    registerProviderKinds(["zai"]);
    const svc = service(true);
    const ok = await app(svc).request("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider: "zai" }) });
    expect(ok.status).toBe(200);
    const filtered = await app(svc).request("/api/provider/accounts?provider=zai");
    expect(filtered.status).toBe(200);
    const bad = await app(svc).request("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider: "nope" }) });
    expect(bad.status).toBe(400);
    expect(String((await bad.json()).error)).toContain("codex, claude, zai");
    // Across hosts the same live list applies, so what `status` calls known is not refused there with a different list.
    const hostsBad = await app(svc).request("/api/provider/usage/hosts/refresh", { method: "POST", body: JSON.stringify({ provider: "nope" }) });
    expect(hostsBad.status).toBe(400);
    expect(String((await hostsBad.json()).error)).toContain("codex, claude, zai");
    const hostsNonString = await app(svc).request("/api/provider/usage/hosts/refresh", { method: "POST", body: JSON.stringify({ providers: ["zai", 42] }) });
    expect(hostsNonString.status).toBe(400);
    expect(String((await hostsNonString.json()).error)).toContain("(got 42)");
  });

  it("the 409 for a switched-off refresh names the real provider, not Claude", async () => {
    registerProviderKinds(["zai"]);
    const off = await app(service(false)).request("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider: "zai" }) });
    expect(off.status).toBe(409);
    expect((await off.json()).message).toBe("zai usage windows are off. Turn them on with: rig config set provider.usage_windows true");
    for (const [provider, label] of [["codex", "Codex"], ["claude", "Claude"]] as const) {
      const res = await app(service(false)).request("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider }) });
      expect(res.status).toBe(409);
      expect((await res.json()).message).toBe(`${label} usage windows are off. Turn them on with: rig config set provider.usage_windows true`);
    }
  });

  it("a cross-host refresh of a collector rail refreshes this host's feed, and each remote host's leg is a NAMED failure before any request", async () => {
    registerProviderKinds(["zai"]);
    const fetchImpl = vi.fn(async () => { throw new Error("no network in this test"); });
    const a = new Hono();
    a.use("*", async (c, next) => {
      c.set("providerService" as never, service(true));
      c.set("hostRegistryLoader" as never, () => ({ ok: true, registry: { hosts: [{ id: "remote-a", transport: "http", url: "http://remote-a.invalid:7433" }] } }));
      c.set("remoteFetchImpl" as never, fetchImpl);
      await next();
    });
    a.route("/api/provider", providerRoutes());
    const res = await a.request("/api/provider/usage/hosts/refresh", { method: "POST", body: JSON.stringify({ provider: "zai" }) });
    expect(res.status).toBe(200);
    const { refresh } = await res.json() as { refresh: Array<Record<string, unknown>> };
    const local = refresh.find((l) => l.hostId === "local")!;
    const remote = refresh.find((l) => l.hostId === "remote-a")!;
    expect(local).toMatchObject({ provider: "zai", outcome: "ok" });
    expect(remote).toMatchObject({ provider: "zai", outcome: "failed", reason: "provider_has_no_reader" });
    expect(String(remote.detail)).toContain('provider kind "zai"');
    // The refresh leg itself sent nothing to the remote host (the view's own read of it may).
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/usage/refresh"))).toBe(true);
  });
});
