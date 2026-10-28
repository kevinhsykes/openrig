// P4 — how `rig provider status` shows the subscription rails the quota collector meters: one line per rail window naming the rail, the
// file's own source string, and that it is advisory; then what the file feed set aside (unrecognized rails, windowless rails) by name.
import { describe, it, expect, vi } from "vitest";
import { providerCommand } from "../src/commands/provider.js";
import { DaemonClient } from "../src/client.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function lifecycle(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  };
}
async function run(args: string[], model: Record<string, unknown>): Promise<{ out: string; exitCode: number | undefined }> {
  const client = { get: vi.fn(async () => ({ status: 200, data: model })) } as unknown as DaemonClient;
  const deps: StatusDeps = { lifecycleDeps: lifecycle(), clientFactory: vi.fn(() => client) };
  const logs: string[] = [];
  const origLog = console.log, origErr = console.error, origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try { await providerCommand(deps).parseAsync(["node", "rig", ...args]); }
  finally { console.log = origLog; console.error = origErr; }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { out: logs.join("\n"), exitCode };
}

const row = (over: Record<string, unknown>) => ({
  provider: "zai", source: { kind: "quota_collector_file", host: "local" }, observedAt: "2026-10-27T21:42:10Z", seats: "unknown", limitEvidence: null, latestFromSource: true,
  lastRefresh: { at: "2026-10-27T21:43:00Z", outcome: "ok" }, currentAvailability: "known", accountHistory: "unknown",
  signIn: { state: "unknown", at: null, evidence: "read from the fleet quota collector file; no sign-in through OpenRig" },
  identity: { provider: "zai", rail: "zai", window: "5h", source: "z.ai-live", recordState: "AVAILABLE", unknown: null },
  windows: [{ window: "5h", durationMins: null, usedPercent: 21, remainingPercent: 79, resetsAt: "2026-10-28T00:49:11Z", observedAt: "2026-10-27T21:42:10Z", level: "ok", freshness: "fresh" }],
  ...over,
});

const MODEL = {
  accounts: [], bindings: [], signals: [], asOf: "2026-10-27T21:43:00Z",
  usage: [
    row({}),
    row({ provider: "ollama_cloud", identity: { provider: "ollama-cloud", rail: "ollama_cloud", window: "session", source: "last-known:ollama (probe failed)", recordState: "EXHAUSTED", unknown: null },
      windows: [{ window: "session", durationMins: null, usedPercent: null, remainingPercent: null, resetsAt: null, observedAt: "2026-10-26T12:00:00Z", level: "unknown", freshness: "stale", freshnessReason: "observed 1900 min ago (fresh for 15 min)" }],
      currentAvailability: "unknown" }),
    row({ provider: "qwen", identity: null, windows: [], currentAvailability: "unknown", observedAt: null, unavailableReason: "no windows in file", signIn: { state: "unknown", at: null, evidence: "read from the fleet quota collector file; no sign-in through OpenRig" } }),
  ],
  quotaCollector: { state: "ok", fileUpdatedAt: "2026-10-27T21:42:43Z", readAt: "2026-10-27T21:43:00Z", rails: ["zai", "ollama_cloud", "qwen"],
    unrecognizedRails: { count: 2, keys: ["from-account-store", "mystery-vendor"] }, railsWithoutWindows: ["qwen"], nativeRailsSkipped: ["codex"],
    skippedWindows: { count: 1, items: [{ rail: "zai", window: "daily", reason: "no_observation_time" }] } },
};

describe("rig provider status shows collector-fed rails", () => {
  it("names each rail window with its rail, the file's own source string and that it is advisory, and shows no Codex-shaped fields", async () => {
    const { out, exitCode } = await run(["status"], MODEL);
    expect(exitCode).toBeUndefined();
    expect(out).toContain("zai  rail zai · source z.ai-live (the file's own string), read from the fleet quota collector file · advisory only: proves rail-level use, not which account spent it");
    expect(out).toContain("ollama_cloud  rail ollama_cloud (file key ollama-cloud) · source last-known:ollama (probe failed)");
    expect(out).toContain("file state EXHAUSTED");
    expect(out).toContain("79% left");
    expect(out).toContain("sign-in: unknown (read from the fleet quota collector file; no sign-in through OpenRig)");
    expect(out).not.toMatch(/bucket |email not reported|undefined|account history unknown\b.*Codex/);
  });

  it("an unknown window reads ?% left, never 0, and a rail with no window is one unavailable row with its reason", async () => {
    const { out } = await run(["status"], MODEL);
    expect(out).toMatch(/\?% left\s+unknown/);
    expect(out).toContain("qwen  unavailable: no windows in file");
  });

  it("names what the file feed read and set aside: unrecognized rails by name and count, windowless rails, native rails, set-aside windows", async () => {
    const { out } = await run(["status"], MODEL);
    expect(out).toContain("QUOTA COLLECTOR FILE: ok · file updated_at 2026-10-27T21:42:43Z · read 2026-10-27T21:43:00Z · 3 rails served");
    expect(out).toContain("unrecognized_rails: 2 skipped, not in the allowed-rails file: from-account-store, mystery-vendor");
    expect(out).toContain("rails with no usable window in the file (shown unavailable): qwen");
    expect(out).toContain("rails with a native reader, not read from this file: codex");
    expect(out).toContain("windows set aside: 1: zai/daily (no_observation_time)");
  });

  it("an unavailable feed says why, and a model without the feed prints no such section", async () => {
    const down = { ...MODEL, quotaCollector: { state: "unavailable", reason: "file_missing: the collector file doesn't exist at the configured path", fileUpdatedAt: null, readAt: "2026-10-27T21:43:00Z", rails: [],
      unrecognizedRails: { count: 0, keys: [] }, railsWithoutWindows: [], nativeRailsSkipped: [], skippedWindows: { count: 0, items: [] } } };
    expect((await run(["status"], down)).out).toContain("QUOTA COLLECTOR FILE: unavailable (file_missing: the collector file doesn't exist at the configured path)");
    const { quotaCollector: _q, ...without } = MODEL;
    expect((await run(["status"], without)).out).not.toContain("QUOTA COLLECTOR FILE");
  });
});
