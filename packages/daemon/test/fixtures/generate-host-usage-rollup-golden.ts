// P5 no-op proof generator — run THIS against the PRE-REFACTOR base (branch base 14fb93bcb) to
// produce host-usage-rollup-golden.json, e.g.:
//   npx tsx test/fixtures/generate-host-usage-rollup-golden.ts
// The committed fixture then pins the base output; provider-host-usage-rollup-golden.test.ts
// asserts the registry-refactored rollupHostUsage reproduces every case byte-for-byte.
// Cases cover the packet's list (claude only, codex only, both, conflicting resets, nearing,
// explicit unknown) plus the limited/expiry branches.
import { writeFileSync } from "node:fs";
import { rollupHostUsage, type HostUsageRollupInput } from "../../src/domain/provider/host-usage-rollup.js";
import type { ProviderSignal } from "../../src/domain/provider/provider-types.js";

const NOW = "2026-10-27T22:00:00.000Z";
const STALE_FUTURE = "2026-10-27T23:00:00.000Z"; // reactive evidence still fresh at NOW
const STALE_PAST = "2026-10-27T21:00:00.000Z"; // reactive evidence expired before NOW

type SignalSpec = Partial<ProviderSignal> &
  Pick<ProviderSignal, "provider" | "sourceClass" | "authority" | "asOf" | "automationUse">;
const sig = (spec: SignalSpec): ProviderSignal => ({ ...spec });

const claudeMeter = (over: Partial<SignalSpec> & { usedPercent: number }): SignalSpec => ({
  provider: "claude",
  sourceClass: "provider_statusline",
  authority: "account_cross_device",
  window: "five_hour",
  asOf: NOW,
  seatSession: "seat-c",
  automationUse: "advisory_only",
  ...over,
});

const reactiveAtLimit = (over: Partial<SignalSpec>): SignalSpec => ({
  sourceClass: "provider_event",
  authority: "reactive_error",
  automationUse: "allow_switch_decision",
  staleAfter: STALE_FUTURE,
  asOf: NOW,
  ...over,
});

const cases: Array<{ name: string; input: HostUsageRollupInput }> = [
  { name: "no signals and no codex presence emits no rows",
    input: { signals: [], codexProfilesPresent: false, now: NOW } },
  { name: "codex presence without signals is an explicit unknown row",
    input: { signals: [], codexProfilesPresent: true, now: NOW } },
  { name: "claude only, one fresh meter, low usage: ok",
    input: { signals: [sig(claudeMeter({ usedPercent: 10 }))], codexProfilesPresent: false, now: NOW } },
  { name: "claude only, meter at the nearing threshold: nearing",
    input: { signals: [sig(claudeMeter({ usedPercent: 85 }))], codexProfilesPresent: false, now: NOW } },
  { name: "claude only, meter exhausted with resets: limited until the latest reset",
    input: { signals: [
      sig(claudeMeter({ usedPercent: 100, resetsAt: "2026-10-28T03:00:00.000Z", seatSession: "seat-a" })),
      sig(claudeMeter({ usedPercent: 100, resetsAt: "2026-10-28T02:00:00.000Z", seatSession: "seat-b", window: "primary" })),
    ], codexProfilesPresent: false, now: NOW } },
  { name: "claude only, meter exhausted without reset evidence: limited with resetsAt omitted",
    input: { signals: [sig(claudeMeter({ usedPercent: 100 }))], codexProfilesPresent: false, now: NOW } },
  { name: "claude only, sub-100 meter plus fresh at-limit reactive evidence: limited",
    input: { signals: [
      sig(claudeMeter({ usedPercent: 40 })),
      sig(reactiveAtLimit({ provider: "claude", resetsAt: "2026-10-28T04:00:00.000Z", seatSession: "seat-c" })),
    ], codexProfilesPresent: false, now: NOW } },
  { name: "claude only, expired at-limit evidence is not usage evidence: ok",
    input: { signals: [
      sig(claudeMeter({ usedPercent: 10 })),
      sig(reactiveAtLimit({ provider: "claude", staleAfter: STALE_PAST, seatSession: "seat-c" })),
    ], codexProfilesPresent: false, now: NOW } },
  { name: "claude only, divergent same-window resets: conflicting anomaly, explicit unknown",
    input: { signals: [
      sig(claudeMeter({ usedPercent: 20, resetsAt: "2026-10-28T03:00:00.000Z", seatSession: "seat-a" })),
      sig(claudeMeter({ usedPercent: 30, resetsAt: "2026-10-28T05:00:00.000Z", seatSession: "seat-b" })),
    ], codexProfilesPresent: false, now: NOW } },
  { name: "claude only, unknown rows without meters: explicit unknown carrying the lane reason",
    input: { signals: [sig({
      provider: "claude", sourceClass: "unknown", authority: "unknown", asOf: NOW,
      automationUse: "do_not_automate", unknownReason: "claude_no_statusline_cache_yet", seatSession: "seat-c",
    })], codexProfilesPresent: false, now: NOW } },
  { name: "codex only, fresh at-limit reactive evidence: limited until the earliest reset",
    input: { signals: [sig(reactiveAtLimit({ provider: "codex", resetsAt: "2026-10-28T06:00:00.000Z", seatSession: "seat-x" }))],
      codexProfilesPresent: true, now: NOW } },
  { name: "both providers: claude ok row then codex explicit unknown row, in output order",
    input: { signals: [
      sig(claudeMeter({ usedPercent: 10 })),
      sig(reactiveAtLimit({ provider: "codex", resetsAt: "2026-10-28T06:00:00.000Z" })),
    ], codexProfilesPresent: true, now: NOW } },
  { name: "signals for an unregistered provider are ignored by today's default registry",
    input: { signals: [
      sig(claudeMeter({ usedPercent: 10 })),
      sig(reactiveAtLimit({ provider: "zai", resetsAt: "2026-10-28T06:00:00.000Z" })),
    ], codexProfilesPresent: false, now: NOW } },
];

const fixture = {
  generatedFrom: "fork/p5-host-rollup-registry base 14fb93bcb (pre-refactor rollupHostUsage)",
  purpose: "P5 no-op proof: the registry refactor must reproduce each case's outputJson byte-for-byte",
  cases: cases.map(({ name, input }) => ({ name, input, outputJson: JSON.stringify(rollupHostUsage(input)) })),
};

const out = new URL("./host-usage-rollup-golden.json", import.meta.url);
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${fixture.cases.length} cases to ${out.pathname}`);
