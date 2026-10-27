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
