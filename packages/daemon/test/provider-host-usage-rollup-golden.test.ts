// P5 no-op proof — the fixture's outputs were produced by the PRE-REFACTOR base (14fb93bcb) on
// pi (generator: fixtures/generate-host-usage-rollup-golden.ts). The registry-refactored
// rollupHostUsage must reproduce each case's output STRING exactly: key order included, not
// just deep-equality.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rollupHostUsage } from "../src/domain/provider/host-usage-rollup.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/host-usage-rollup-golden.json", import.meta.url)), "utf8"),
) as { cases: Array<{ name: string; input: Parameters<typeof rollupHostUsage>[0]; outputJson: string }> };

describe("P5 no-op proof — registry rollup reproduces the base output byte-for-byte", () => {
  it("the fixture carries the packet's coverage (13 base cases)", () => {
    expect(fixture.cases.length).toBe(13);
  });
  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(JSON.stringify(rollupHostUsage(c.input))).toBe(c.outputJson);
    });
  }
});
