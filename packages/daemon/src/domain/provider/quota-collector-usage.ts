// P4 — usage readings for the subscription rails the fleet's quota collector meters (zai, minimax, kimi, ...), read from the collector's
// availability file. Read-only and ADVISORY: a derived file proves rail-level usage, never which account spent it. That is enforced by
// structure, not by a field: these are usage rows only and this module emits no ProviderSignal, so nothing here ever reaches the
// automation policy (provider-policy.ts), which reads signals.
//
// One `UsageWindows` engine per allowed rail (usage-windows.ts, unchanged), so each row's `provider` is its rail and a missing file reads
// as unavailable on every rail. All engines share one coalesced read of the file per refresh. A window is one reading, keyed
// `rail:<rail>:<window>`, aged from the window's own `observed_at` (so an old file goes stale) with its `reset_at` carried through.
// Unknown stays unknown: a window the file marks unknown, or whose remaining fraction isn't a number in 0..1, has a null used percent.
//
// The file's shape is the fleet's `provider-availability.v1` (providers → { quota_windows[], quota_observation, record }). Account
// fingerprints in it are never read into a row.

import fs from "node:fs";
import { PROVIDER_QUOTA_FILE_ENV, PROVIDER_RAILS_FILE_ENV, registerAllowedRailsFromEnv, type AllowedRail } from "./provider-rails.js";
import { COLLECTOR_SOURCE_NOT_STATED, registerProviderKinds } from "./provider-types.js";
import type { CollectorQuotaIdentity, ProviderUsageAllowance, QuotaCollectorSummary } from "./provider-types.js";
import { UsageWindows, type UsageReading, type UsageRefreshResult } from "./usage-windows.js";

/** The only file schema this reads. Another version is refused, not guessed at. */
export const QUOTA_FILE_SCHEMA = "provider-availability.v1";
/** A file larger than this is refused rather than read into memory. */
export const QUOTA_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** `rig provider status` re-reads the file at most this often (a local file read, not a probe). */
export const QUOTA_READ_MIN_INTERVAL_MS = 30_000;
const SKIPPED_NAMED = 20;
/** The sign-in fact of every collector row: this feed has no login to read. */
export const COLLECTOR_SIGN_IN_EVIDENCE = "read from the fleet quota collector file; no sign-in through OpenRig";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v !== "" ? v.slice(0, max) : null);
const parses = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/** The key of one collector reading: its rail and window. It names no account, and across hosts it never links (usage-across-hosts.ts). */
export function collectorUsageIdentityKey(identity: Pick<CollectorQuotaIdentity, "rail" | "window">): string {
  return `rail:${identity.rail}:${identity.window}`;
}

type Reading = UsageReading<CollectorQuotaIdentity>;
type Skipped = { rail: string; window: string | null; reason: string };
interface Slice { hasRow: boolean; readings: Reading[]; skipped: Skipped[] }

/** One rail's readings from its row of the file. A row that isn't a mapping is an error for that rail alone. */
export function sliceRail(rail: AllowedRail, row: unknown): Slice | { error: string } {
  if (row === undefined) return { hasRow: false, readings: [], skipped: [] };
  if (!isRecord(row)) return { error: `the file's row for "${rail.storeKey}" isn't a mapping` };
  if (row.quota_windows !== undefined && row.quota_windows !== null && !Array.isArray(row.quota_windows)) {
    return { error: `the file's quota_windows for "${rail.storeKey}" isn't a list` };
  }
  // The full window set when there is one; else the single provider-wide observation, as one window.
  const raw: unknown[] = Array.isArray(row.quota_windows) && row.quota_windows.length > 0 ? row.quota_windows
    : isRecord(row.quota_observation) ? [row.quota_observation] : [];
  const record = isRecord(row.record) ? row.record : null;
  const recordState = text(record?.state, 64);
  // A latched EXHAUSTED rail is exhausted whatever one window's fraction says; the engine reads limit evidence that way.
  const limitEvidence = recordState === "EXHAUSTED"
    ? `file record state EXHAUSTED${text(record?.set_by, 64) ? `, set by ${text(record?.set_by, 64)}` : ""}${text(record?.expected_reset_at, 64) ? `, expected to clear ${text(record?.expected_reset_at, 64)}` : ""}`
    : null;
  const readings: Reading[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    if (!isRecord(w)) { skipped.push({ rail: rail.rail, window: null, reason: "not_a_mapping" }); continue; }
    const id = text(w.window_id, 128);
    if (id === null) { skipped.push({ rail: rail.rail, window: null, reason: "no_window_id" }); continue; }
    if (!parses(w.observed_at)) { skipped.push({ rail: rail.rail, window: id, reason: "no_observation_time" }); continue; }
    if (seen.has(id)) { skipped.push({ rail: rail.rail, window: id, reason: "duplicate_window_id" }); continue; }
    seen.add(id);
    const fraction = w.remaining_fraction;
    let usedPercent: number | null = null;
    let unknown: CollectorQuotaIdentity["unknown"] = null;
    if (w.unknown === true) {
      unknown = { kind: text(w.kind, 64) ?? "unknown", reason: text(w.reason, 200) };
    } else if (typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1) {
      usedPercent = Math.round((1 - fraction) * 10000) / 100;
    } else {
      // Never a zero: an unreadable fraction is an unknown window.
      unknown = { kind: "remaining_fraction_unreadable", reason: `remaining_fraction was ${fraction === undefined ? "absent" : typeof fraction === "number" ? "outside 0..1" : `a ${typeof fraction}`}` };
    }
    readings.push({
      // The file's own source string, verbatim: no label of ours stands in for who wrote the window.
      identity: { provider: rail.storeKey, rail: rail.rail, window: id, source: text(w.source) ?? COLLECTOR_SOURCE_NOT_STATED, recordState, unknown },
      windows: [{ window: id, durationMins: null, usedPercent, resetsAt: parses(w.reset_at) ? w.reset_at : null }],
      limitEvidence,
      observedAt: w.observed_at,
    });
  }
  return { hasRow: true, readings, skipped };
}

type FileState =
  | { ok: true; at: string; updatedAt: string | null; slices: Map<string, Slice | { error: string }>; summary: QuotaCollectorSummary }
  | { ok: false; at: string; reason: string; detail: string };

export interface QuotaCollectorOptions {
  /** The availability file (path from daemon config; never hard-coded). */
  file: string;
  rails: readonly AllowedRail[];
  now?: () => string;
  /** How often a status read may re-read the file. */
  minReadIntervalMs?: number;
}

export class QuotaCollectorUsage {
  private readonly now: () => string;
  private readonly engines = new Map<string, UsageWindows<CollectorQuotaIdentity, { rail: AllowedRail; state: Extract<FileState, { ok: true }> }>>();
  private inflight: Promise<FileState> | null = null;
  private last: FileState | null = null;
  private lastReadMs: number | null = null;
  private readonly minReadIntervalMs: number;

  constructor(private readonly opts: QuotaCollectorOptions & { configError?: string }) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.minReadIntervalMs = opts.minReadIntervalMs ?? QUOTA_READ_MIN_INTERVAL_MS;
    for (const rail of opts.rails) {
      // A rail some native reader serves (the export's nativeReader flag; the codex and claude families) is read by it, not by this file.
      if (rail.nativeReader) continue;
      // The feed registers the rails it serves into the live known-kinds list as it is built (idempotent), so the daemon's validators
      // accept them and refreshUsage reaches this feed.
      registerProviderKinds([rail.rail]);
      this.engines.set(rail.rail, new UsageWindows<CollectorQuotaIdentity, { rail: AllowedRail; state: Extract<FileState, { ok: true }> }>({
        provider: rail.rail,
        sourceKind: "quota_collector_file",
        now: this.now,
        read: async () => {
          const state = await this.readFile();
          return state.ok ? { ok: true, observedAt: state.at, rail, state } : { ok: false, at: state.at, reason: state.reason, detail: state.detail };
        },
        normalize: ({ rail: r, state }) => {
          const slice = state.slices.get(r.rail);
          if (!slice) return { ok: true, readings: [] };
          return "error" in slice ? { ok: false, detail: slice.error } : { ok: true, readings: slice.readings };
        },
        key: collectorUsageIdentityKey,
      }));
    }
  }

  /** A feed that couldn't be set up: no rails, and a summary that says why. */
  static unconfigured(reason: string): QuotaCollectorUsage {
    return new QuotaCollectorUsage({ file: "", rails: [], configError: reason });
  }

  /** Whether this feed serves `provider` (an allowed rail with no native reader). */
  handles(provider: string): boolean {
    return this.engines.has(provider);
  }

  /** One coalesced read of the file, shared by every rail's engine in the same refresh. */
  private readFile(): Promise<FileState> {
    if (this.inflight) return this.inflight;
    const run = this.loadFile().then((state) => { this.last = state; this.lastReadMs = Date.parse(state.at); return state; });
    this.inflight = run;
    const clear = () => { if (this.inflight === run) this.inflight = null; };
    run.then(clear, clear);
    return run;
  }

  private async loadFile(): Promise<FileState> {
    const at = this.now();
    const fail = (reason: string, detail: string): FileState => ({ ok: false, at, reason, detail });
    let body: string;
    try {
      const stat = await fs.promises.stat(this.opts.file);
      if (stat.size > QUOTA_FILE_MAX_BYTES) return fail("file_too_large", `the collector file is larger than ${QUOTA_FILE_MAX_BYTES} bytes`);
      body = await fs.promises.readFile(this.opts.file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? fail("file_missing", "the collector file doesn't exist at the configured path") : fail("file_unreadable", `the collector file can't be read (${code ?? "error"})`);
    }
    let json: unknown;
    try { json = JSON.parse(body); } catch { return fail("file_malformed", "the collector file isn't JSON"); }
    if (!isRecord(json) || !isRecord(json.providers)) return fail("file_malformed", 'the collector file has no "providers" mapping');
    if (json.schema_version !== QUOTA_FILE_SCHEMA) {
      return fail("unsupported_schema", `the collector file's schema_version is ${typeof json.schema_version === "string" ? `"${json.schema_version}"` : "absent"}, not "${QUOTA_FILE_SCHEMA}"`);
    }
    return this.parse(json.providers, at, text(json.updated_at, 64));
  }

  private parse(providers: Record<string, unknown>, at: string, updatedAt: string | null): FileState {
    const slices = new Map<string, Slice | { error: string }>();
    const keyOwner = new Map(this.opts.rails.map((r) => [r.storeKey, r]));
    const unrecognized = Object.keys(providers).filter((k) => !keyOwner.has(k));
    const railsWithoutWindows: string[] = [];
    const nativeRailsSkipped: string[] = [];
    const skipped: Skipped[] = [];
    for (const rail of this.opts.rails) {
      if (rail.nativeReader) { nativeRailsSkipped.push(rail.rail); continue; }
      const slice = sliceRail(rail, providers[rail.storeKey]);
      slices.set(rail.rail, slice);
      if ("error" in slice) { skipped.push({ rail: rail.rail, window: null, reason: "row_not_readable" }); railsWithoutWindows.push(rail.rail); continue; }
      if (slice.readings.length === 0) railsWithoutWindows.push(rail.rail);
      skipped.push(...slice.skipped);
    }
    return { ok: true, at, updatedAt, slices, summary: {
      state: "ok", fileUpdatedAt: updatedAt, readAt: at,
      rails: [...slices.keys()],
      unrecognizedRails: { count: unrecognized.length, keys: unrecognized.sort().slice(0, 50) },
      railsWithoutWindows, nativeRailsSkipped,
      skippedWindows: { count: skipped.length, items: skipped.slice(0, SKIPPED_NAMED) },
    } };
  }

  /** One refresh of this rail's engine; the file read is shared with any engine refreshing at the same time. */
  async refresh(provider: string): Promise<UsageRefreshResult | { unavailable: true }> {
    const engine = this.engines.get(provider);
    return engine ? engine.refresh() : { unavailable: true };
  }

  /** Every rail, one file read. A failure is recorded on each engine, never thrown. */
  async refreshAll(): Promise<void> {
    await Promise.all([...this.engines.values()].map((e) => e.refresh().catch(() => undefined)));
  }

  /** What a status read does: re-read the file when it hasn't been read within the interval. A local file read, not a probe. */
  async refreshIfStale(): Promise<void> {
    if (this.engines.size === 0) return;
    if (this.lastReadMs !== null && Date.parse(this.now()) - this.lastReadMs < this.minReadIntervalMs) return;
    await this.refreshAll();
  }

  /** What the last read saw, for the read model. */
  summary(): QuotaCollectorSummary {
    const none: QuotaCollectorSummary = {
      state: "not_read", fileUpdatedAt: null, readAt: null, rails: [...this.engines.keys()],
      unrecognizedRails: { count: 0, keys: [] }, railsWithoutWindows: [], nativeRailsSkipped: [], skippedWindows: { count: 0, items: [] },
    };
    if (this.opts.configError) return { ...none, state: "unavailable", reason: this.opts.configError, rails: [] };
    if (!this.last) return none;
    if (!this.last.ok) return { ...none, state: "unavailable", reason: `${this.last.reason}: ${this.last.detail}`, readAt: this.last.at };
    return this.last.summary;
  }

  /** The served rows: each engine's, made honest (this feed has no sign-in, account link or saved profile to speak of). */
  project(now: string): ProviderUsageAllowance[] {
    const rows: ProviderUsageAllowance[] = [];
    for (const [rail, engine] of this.engines) {
      for (const row of engine.project(now)) rows.push(this.honest(row, rail));
    }
    return rows;
  }

  private honest(row: ProviderUsageAllowance, rail: string): ProviderUsageAllowance {
    // The engine's sign-in, account-history and saved-profile facts are Codex's (its login in CODEX_HOME). A file feed has none, and
    // must not claim one (BR-4): this feed's own text says it reads none.
    const { savedProfile: _savedProfile, ...rest } = row;
    const out: ProviderUsageAllowance = {
      ...rest,
      accountHistory: "unknown",
      signIn: { state: "unknown", at: null, evidence: COLLECTOR_SIGN_IN_EVIDENCE },
    };
    // A rail the file read fine but gave nothing for is one explicit unknown row, with the reason, never omitted (the row's lastRefresh
    // carries the read time).
    if (row.identity === null && row.lastRefresh?.outcome === "ok") {
      const slice = this.last?.ok ? this.last.slices.get(rail) : undefined;
      out.unavailableReason = !slice ? "no row in file"
        : "error" in slice ? slice.error
          : !slice.hasRow ? "no row in file"
            : slice.skipped.length > 0 ? `no usable windows in file (${slice.skipped.length} set aside)` : "no windows in file";
    }
    return out;
  }
}

/** The feed the daemon's environment asks for, registering its rails as it loads. Neither variable set: the feature is off (undefined).
 *  Anything half-set or unusable is a feed with no rails whose summary says why, so it is visible rather than silently absent. */
export function quotaCollectorFromEnv(env: NodeJS.ProcessEnv, now?: () => string): QuotaCollectorUsage | undefined {
  const rails = registerAllowedRailsFromEnv(env);
  const file = env[PROVIDER_QUOTA_FILE_ENV];
  if (rails.state === "absent" && !file) return undefined;
  if (rails.state === "unusable") return QuotaCollectorUsage.unconfigured(rails.reason);
  if (rails.state === "absent") return QuotaCollectorUsage.unconfigured(`${PROVIDER_RAILS_FILE_ENV} is not set, so no rail is allowed`);
  if (!file) return QuotaCollectorUsage.unconfigured(`${PROVIDER_QUOTA_FILE_ENV} is not set, so there is no collector file to read`);
  return new QuotaCollectorUsage({ file, rails: rails.rails, ...(now ? { now } : {}) });
}
