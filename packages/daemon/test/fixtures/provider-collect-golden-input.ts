// The inputs of the golden read model (provider-collect-golden.json): one fleet that exercises every branch of today's collection —
// Codex profiles and registry rows, a shared profile, a stale registry row on a reused session name, a seat on its own Codex home, Claude
// seats (live, detached, with a statusline signal, with none, with a stale cache row), other runtimes, and signals of three kinds.
// The golden file was produced by running `collectFourBlockReadModel` from upstream 6957751f5 on exactly these inputs, before the
// AccountSource refactor. Changing this file means regenerating the golden from base, so don't.
import type { CodexAuthMetadata } from "../../src/domain/provider/codex-auth-reader.js";
import type { ProviderSeat } from "../../src/domain/provider/provider-collect.js";
import type { ProviderSignal } from "../../src/domain/provider/provider-types.js";

export const GOLDEN_ASOF = "2026-10-27T12:00:00.000Z";

export const goldenAuth: CodexAuthMetadata = {
  profiles: ["work", "personal", "spare"],
  seats: [
    { seat: "driver-a@rig-a", rig: "rig-a", runtime: "codex", cwd: "/p/a", authProfile: "work", updatedTs: "2026-10-26T10:00:00Z" },
    { seat: "driver-b@rig-a", rig: "rig-a", runtime: "codex", cwd: "/p/a", authProfile: "work", updatedTs: "2026-10-26T11:00:00Z" },
    { seat: "qa@rig-b", rig: "rig-b", runtime: "codex", cwd: "/p/b", authProfile: "personal", updatedTs: "2026-10-25T09:30:00Z" },
    // A stale row whose session name is now a Claude seat: it must bind nothing.
    { seat: "reused@rig-b", rig: "rig-b", runtime: "codex", cwd: "/p/b", authProfile: "work", updatedTs: "2026-10-20T08:00:00Z" },
    // A Codex seat on its own home: the daemon's registry binds nothing for it.
    { seat: "homed@rig-c", rig: "rig-c", runtime: "codex", cwd: "/p/c", authProfile: "spare", updatedTs: "2026-10-24T07:00:00Z" },
    // A registry row for a seat that isn't in the inventory.
    { seat: "gone@rig-c", rig: "rig-c", runtime: "codex", cwd: "/p/c", authProfile: "personal", updatedTs: "2026-10-01T00:00:00Z" },
    // A registry row naming a profile that has no saved profile.
    { seat: "orphan@rig-d", rig: "rig-d", runtime: "codex", cwd: "/p/d", authProfile: "never-saved", updatedTs: "2026-10-22T06:00:00Z" },
  ],
};

export const goldenSeats: ProviderSeat[] = [
  { seatSession: "driver-a@rig-a", rigName: "rig-a", runtime: "codex", lifecycleState: "running" },
  { seatSession: "driver-b@rig-a", rigName: "rig-a", runtime: "codex", lifecycleState: "running" },
  { seatSession: "pm@rig-a", rigName: "rig-a", runtime: "claude-code", lifecycleState: "running" },
  { seatSession: "qa@rig-b", rigName: "rig-b", runtime: "codex", lifecycleState: "recoverable" },
  { seatSession: "reused@rig-b", rigName: "rig-b", runtime: "claude-code", lifecycleState: "running" },
  { seatSession: "idle@rig-b", rigName: "rig-b", runtime: "claude-code", lifecycleState: "detached" },
  { seatSession: "homed@rig-c", rigName: "rig-c", runtime: "codex", lifecycleState: "running", runtimeHome: { home: "/home/u/.codex-alt", source: "member" } },
  { seatSession: "bare@rig-c", rigName: "rig-c", runtime: "codex", lifecycleState: "attention_required" },
  { seatSession: "orphan@rig-d", rigName: "rig-d", runtime: "codex", lifecycleState: "running" },
  { seatSession: "pi@rig-d", rigName: "rig-d", runtime: "pi", lifecycleState: "running" },
  { seatSession: "term@rig-d", rigName: "rig-d", runtime: "terminal", lifecycleState: "detached" },
];

export const goldenSignals: ProviderSignal[] = [
  { provider: "codex", accountRef: "work", sourceClass: "provider_structured_read", authority: "account_cross_device", window: "five_hour", usedPercent: 41,
    resetsAt: "2026-10-27T15:00:00Z", windowDurationMins: 300, asOf: GOLDEN_ASOF, staleAfter: "2026-10-27T12:15:00Z", automationUse: "allow_switch_decision" },
  { provider: "codex", accountRef: "personal", sourceClass: "unknown", authority: "unknown", asOf: GOLDEN_ASOF,
    unknownReason: "no reading for this profile", automationUse: "do_not_automate" },
  // A live Claude seat's statusline reading.
  { provider: "claude", seatSession: "pm@rig-a", sourceClass: "provider_statusline", authority: "account_cross_device", window: "weekly", usedPercent: 63,
    asOf: GOLDEN_ASOF, automationUse: "advisory_only" },
  // A stale cache row for a Claude seat that is no longer live: dropped.
  { provider: "claude", seatSession: "dead@rig-a", sourceClass: "provider_statusline", authority: "account_cross_device", window: "five_hour", usedPercent: 12,
    asOf: GOLDEN_ASOF, automationUse: "allow_switch_decision" },
  // A cache row whose session name is live only as a non-Claude runtime: dropped.
  { provider: "claude", seatSession: "driver-a@rig-a", sourceClass: "provider_statusline", authority: "account_cross_device", window: "five_hour", usedPercent: 7,
    asOf: GOLDEN_ASOF, automationUse: "allow_switch_decision" },
  // A reactive error tap row with no account identity.
  { provider: "codex", seatSession: "driver-b@rig-a", sourceClass: "capture_fallback", authority: "reactive_error", asOf: GOLDEN_ASOF,
    unknownReason: "usage limit text seen in the pane", supportsNotification: true, automationUse: "do_not_automate" },
];
