// A quota-collector rail row (zai, ...) names a rail, a window and the file's own source string. It has no account, no
// bucket and no email, so the native-provider label ("identity unresolved · bucket undefined") must not be drawn for it.
import { describe, expect, it } from "vitest";
import { allowanceLines, type Row } from "../src/usage/usage-model.js";
import { usageHostsLines } from "../src/usage/usage-hosts-model.js";
import { emptySnapshot } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

const NOW = "2026-10-13T23:30:00.000Z";
const window = (name: string) => ({ window: name, durationMins: 300, usedPercent: 40, remainingPercent: 60, resetsAt: "2026-10-14T00:00:00.000Z", observedAt: NOW, level: "ok", freshness: "fresh" });

const collectorRow = (over: Row = {}): Row => ({
  provider: "zai",
  identity: { provider: "zai", rail: "zai", window: "5h", source: "z.ai-live", recordState: "AVAILABLE", unknown: null },
  source: { kind: "quota_collector_file", host: "local" },
  observedAt: NOW, seats: "unknown", windows: [window("5h")], limitEvidence: null, latestFromSource: true,
  lastRefresh: { at: NOW, outcome: "ok" }, currentAvailability: "known", ...over,
});
const codexRow = (): Row => ({
  provider: "codex",
  identity: { accountId: "acct-1", workspaceId: null, limitId: "codex", email: "dev@example.com", planType: "team", source: "account/rateLimits/read accountId" },
  source: { kind: "codex_app_server", host: "local" },
  observedAt: NOW, seats: "unknown", windows: [window("secondary")], limitEvidence: null, latestFromSource: true,
  lastRefresh: { at: NOW, outcome: "ok" }, currentAvailability: "known",
});

const BAD = ["identity unresolved", "bucket", "email not reported", "undefined", "seats unknown"];
const text = (lines: Array<{ text: string }>) => lines.map((l) => l.text).join("\n");

describe("TUI: a collector rail row is labelled by rail, window and source", () => {
  it("the row line says rail, window and the file's own source, and none of the native-provider words", () => {
    const first = allowanceLines(collectorRow())[0]!.text;
    expect(first).toContain("zai");
    expect(first).toContain("rail zai");
    expect(first).toContain("source z.ai-live");
    expect(first).toContain("advisory only");
    for (const bad of BAD) expect(first).not.toContain(bad);
  });

  it("a different file key, a non-AVAILABLE state and an unknown marker are said, as the CLI's row line says them", () => {
    const first = allowanceLines(collectorRow({ identity: { provider: "z_ai", rail: "zai", window: "5h", source: "s", recordState: "EXHAUSTED", unknown: { kind: "no_number", reason: "not a fraction" } } }))[0]!.text;
    expect(first).toContain("(file key z_ai)");
    expect(first).toContain("file state EXHAUSTED");
    expect(first).toContain("unknown (no_number: not a fraction)");
  });

  const hubWith = (rows: Row[]): FleetSnapshot => {
    const snap = emptySnapshot();
    const observations = rows.map((row, i) => ({ hostId: `h${i}`, readAt: NOW, row }));
    return { ...snap, usageHosts: { status: { view: { hosts: [], skipped: [], registry: { state: "read" }, seatAccounts: [],
      items: [{ provider: rows[0]!["provider"], key: "k", linkage: "unknown", observations, notes: [] }] } } } } as unknown as FleetSnapshot;
  };

  it("across hosts, the group header names rail, window and source", () => {
    const header = text(usageHostsLines(hubWith([collectorRow()]), 400)).split("\n").find((l) => l.startsWith("  zai  "))!;
    expect(header).toContain("rail zai");
    expect(header).toContain("window 5h");
    expect(header).toContain("source z.ai-live");
    expect(header).toContain("linkage unknown");
    for (const bad of BAD) expect(header).not.toContain(bad);
  });

  it("native rows are drawn exactly as before (account, bucket, email)", () => {
    expect(allowanceLines(codexRow())[0]!.text).toContain("account acct-1 · bucket codex · dev@example.com");
    const header = text(usageHostsLines(hubWith([codexRow()]), 400)).split("\n").find((l) => l.startsWith("  codex  "))!;
    expect(header).toContain("account acct-1 · bucket codex");
  });
});
