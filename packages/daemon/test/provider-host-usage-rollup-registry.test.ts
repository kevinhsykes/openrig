// P5 — the new registry semantics (distinct from the no-op golden proof): registration
// validation, non-mutable-global extension, and the mid-rollup failure contract (fail visible,
// never drop a host row, never take down the read model).
import { describe, it, expect } from "vitest";
import {
  DEFAULT_HOST_USAGE_ROLLUPS,
  hostUsageRollupsWith,
  rollupHostUsage,
  type HostUsageRollup,
  type HostUsageRollupInput,
} from "../src/domain/provider/host-usage-rollup.js";

const NOW = "2026-10-27T22:00:00.000Z";
const input: HostUsageRollupInput = { signals: [], codexProfilesPresent: true, now: NOW };

const zaiRow = (asOf: string) => ({
  host: "local" as const,
  provider: "zai" as const,
  state: "explicit_unknown" as const,
  windows: [],
  provenance: { basis: "one_account_per_host_deployment_invariant" as const, note: "collector reading expected" },
  anomalies: [],
  evidenceSeats: [],
  unknownReason: "no collector reading yet",
  asOf,
});

describe("host usage rollup registry", () => {
  it("default registry is claude then codex, in today's output order", () => {
    expect(DEFAULT_HOST_USAGE_ROLLUPS.map((r) => r.provider)).toEqual(["claude", "codex"]);
  });

  it("a duplicate provider throws AT REGISTRATION, not during rollup", () => {
    const dupe: HostUsageRollup = { provider: "codex", rollup: () => null };
    expect(() => hostUsageRollupsWith([dupe])).toThrow(/duplicate host usage rollup registered for provider "codex"/);
    // The default list itself is never re-validated into a throw: registering nothing is fine.
    expect(() => hostUsageRollupsWith()).not.toThrow();
  });

  it("extras keep their place after the defaults; the builder returns a fresh array (no mutable globals)", () => {
    const list = hostUsageRollupsWith([{ provider: "zai", rollup: () => zaiRow(NOW) }]);
    expect(list.map((r) => r.provider)).toEqual(["claude", "codex", "zai"]);
    expect(hostUsageRollupsWith([])).not.toBe(DEFAULT_HOST_USAGE_ROLLUPS);
    // The default registry is untouched by building lists with extras.
    expect(DEFAULT_HOST_USAGE_ROLLUPS.map((r) => r.provider)).toEqual(["claude", "codex"]);
  });

  it("an extra rollup contributes its row through rollupHostUsage", () => {
    const rows = rollupHostUsage(input, hostUsageRollupsWith([{ provider: "zai", rollup: () => zaiRow(NOW) }]));
    // claude: no presence → no row; codex: presence without signals → explicit unknown; then zai.
    expect(rows.map((r) => r.provider)).toEqual(["codex", "zai"]);
  });

  it("a rollup that throws during rollup becomes that provider's explicit_unknown row; the other rows are kept", () => {
    const bomb: HostUsageRollup = {
      provider: "claude",
      rollup: () => {
        throw new Error("boom");
      },
    };
    const codexEntry = DEFAULT_HOST_USAGE_ROLLUPS.find((r) => r.provider === "codex")!;
    const rows = rollupHostUsage(input, [bomb, codexEntry]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.provider).toBe("claude");
    expect(rows[0]!.state).toBe("explicit_unknown");
    expect(rows[0]!.unknownReason).toContain("host usage rollup for claude failed");
    expect(rows[0]!.unknownReason).toContain("boom");
    expect(rows[1]!.provider).toBe("codex");
    expect(rows[1]!.state).toBe("explicit_unknown"); // codex's own normal row, unharmed
  });

  it("DEFAULT_HOST_USAGE_ROLLUPS and its entries are frozen at runtime, not just readonly in types", () => {
    expect(Object.isFrozen(DEFAULT_HOST_USAGE_ROLLUPS)).toBe(true);
    for (const entry of DEFAULT_HOST_USAGE_ROLLUPS) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("a push onto the frozen defaults throws (modules are strict) and the defaults are unchanged", () => {
    const attemptPush = (list: HostUsageRollup[]) => list.push({ provider: "evil", rollup: () => null });
    expect(() => attemptPush(DEFAULT_HOST_USAGE_ROLLUPS as HostUsageRollup[])).toThrow(TypeError);
    expect(DEFAULT_HOST_USAGE_ROLLUPS.map((r) => r.provider)).toEqual(["claude", "codex"]);
  });

  it("hostUsageRollupsWith() still returns a fresh, unfrozen, caller-owned list over the frozen defaults", () => {
    const list = hostUsageRollupsWith();
    expect(list).not.toBe(DEFAULT_HOST_USAGE_ROLLUPS);
    expect(Object.isFrozen(list)).toBe(false);
    expect(list.map((r) => r.provider)).toEqual(["claude", "codex"]);
    // Mutating the caller-owned copy never reaches the global.
    list.push({ provider: "zai", rollup: () => zaiRow(NOW) });
    expect(DEFAULT_HOST_USAGE_ROLLUPS).toHaveLength(2);
  });

  it("rollupHostUsage refuses a raw list with duplicate providers — same text, before any rollup runs", () => {
    const codexEntry = DEFAULT_HOST_USAGE_ROLLUPS.find((r) => r.provider === "codex")!;
    let ran = false;
    const spy: HostUsageRollup = { provider: "codex", rollup: () => { ran = true; return null; } };
    expect(() => rollupHostUsage(input, [codexEntry, spy])).toThrow(
      /duplicate host usage rollup registered for provider "codex"/,
    );
    expect(ran).toBe(false);
  });

  it("a non-Error throw is stringified into the row's reason, never propagated", () => {
    const bomb: HostUsageRollup = {
      provider: "claude",
      rollup: () => {
        throw "string boom";
      },
    };
    const rows = rollupHostUsage(input, [bomb]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("explicit_unknown");
    expect(rows[0]!.unknownReason).toContain("string boom");
  });
});
