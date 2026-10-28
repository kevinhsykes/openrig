// Slice-04 (OPR.0.5.0.4) seam C1 (resume) — the getReadModel COLLECTION seam. A pure function
// over injected inputs (the codex-auth metadata reader + a cross-rig seat lister + a clock), so the
// production read-model path is directly testable without a live daemon/db. Accounts and bindings
// come from the registered AccountSources (account-source.ts; by default only the Codex source: saved
// profiles → accounts[] with authState="unknown" per BR-3 validate-at-use — NEVER assert active/
// needs_reauth from static disk — and the codex seat-registry joined to the seat universe into
// rawBindings[]; unregistered/claude seats → unbound, so the assembler emits seat_with_no_account),
// carries signals through (empty until the live signal-collection lane), and delegates all anomaly
// computation to assembleFourBlock.

import { codexAccountSource, type AccountSource } from "./account-source.js";
import type { CodexAuthMetadata } from "./codex-auth-reader.js";
import { rollupHostUsage } from "./host-usage-rollup.js";
import { assembleFourBlock, type RawSeatBinding } from "./provider-read-model.js";
import { claudeStatuslineSignals } from "./provider-signals.js";
import type { FourBlockReadModel, ProviderAccount, ProviderSignal } from "./provider-types.js";
import type { NodeLifecycleState } from "../types.js";
import type { SeatRuntimeHome } from "../seat-runtime-home.js";

/** One seat in the fleet (the universe to bind), sourced from node-inventory across rigs. */
export interface ProviderSeat {
  seatSession: string;
  rigName: string;
  runtime: string;
  lifecycleState: NodeLifecycleState;
  /** The seat's own runtime home from its stored `env:`, when it declares one (seat-runtime-home.ts). */
  runtimeHome?: SeatRuntimeHome;
}

export interface ProviderCollectDeps {
  /** Reads codex-auth on-disk METADATA (profile names + seat registry) — never token content. */
  readCodexAuth: () => CodexAuthMetadata;
  /** The current seat universe (node-inventory across all rigs). */
  listSeats: () => ProviderSeat[];
  /** signals[] — empty until the live Codex/Claude/reactive collection lane is wired. */
  collectSignals?: () => ProviderSignal[];
  /** A real caller-provided clock; the read model's asOf (anomalies borrow it, never invented). */
  now: () => string;
  /** The sources of accounts and bindings, in order. Absent: just the Codex source, built from the one `readCodexAuth()` read. A caller that
   *  passes its own list includes the Codex source itself and registers the list with `validateAccountSources`. */
  accountSources?: readonly AccountSource[];
  /** Where a collision between sources is reported (the daemon's warning log). A collection never throws for one. */
  warn?: (message: string) => void;
}

export function collectFourBlockReadModel(deps: ProviderCollectDeps): FourBlockReadModel {
  const asOf = deps.now();
  // The one read of the Codex home in this collection: it builds the default source and says whether the host has Codex profiles.
  const auth = deps.readCodexAuth();
  const { profiles } = auth;
  const seatUniverse = deps.listSeats();
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const sources = deps.accountSources ?? [codexAccountSource(auth)];

  // accounts[] — every source's rows, in source order. accountId is the key downstream, so a second row with an id already taken is
  // dropped (the first stays) and reported; the collection goes on.
  const accounts: ProviderAccount[] = [];
  const accountOwner = new Map<string, string>();
  for (const source of sources) {
    for (const account of source.listAccounts(asOf)) {
      const owner = accountOwner.get(account.accountId);
      if (owner !== undefined) {
        warn(`[provider-account-source] account id "${account.accountId}" from source "${source.id}" repeats one from source "${owner}"; kept the first, dropped this one`);
        continue;
      }
      accountOwner.set(account.accountId, source.id);
      accounts.push(account);
    }
  }

  // Binding per seat: every source is asked; the first non-null answer wins, and a second one is reported. A seat no source binds is
  // unbound: the assembler attaches the required seat_with_no_account anomaly; we never fabricate a sentinel account.
  const rawBindings: RawSeatBinding[] = seatUniverse.map((seat) => {
    let bound: RawSeatBinding | null = null;
    let boundBy = "";
    for (const source of sources) {
      const binding = source.bindingFor(seat);
      if (binding === null) continue;
      if (bound === null) { bound = binding; boundBy = source.id; continue; }
      warn(`[provider-account-source] seat "${seat.seatSession}" is bound by both source "${boundBy}" and source "${source.id}"; kept source "${boundBy}"`);
    }
    return bound ?? {
      accountId: null,
      seatSession: seat.seatSession,
      rigName: seat.rigName,
      boundAt: null,
      bindingSource: null,
    };
  });

  const liveClaudeSeats = new Set(
    seatUniverse
      .filter((seat) => seat.runtime === "claude-code" && seat.lifecycleState === "running")
      .map((seat) => seat.seatSession),
  );
  const signals = (deps.collectSignals ? [...deps.collectSignals()] : []).filter((signal) =>
    signal.provider !== "claude" || !signal.seatSession || liveClaudeSeats.has(signal.seatSession),
  );
  const signaledClaudeSeats = new Set(
    signals.filter((signal) => signal.provider === "claude" && signal.seatSession).map((signal) => signal.seatSession!),
  );
  // Cache discovery is never the seat-discovery authority. Every live Claude seat must have a
  // row even before its first statusline payload (or when its cache is malformed/absent).
  for (const seatSession of liveClaudeSeats) {
    if (signaledClaudeSeats.has(seatSession)) continue;
    signals.push(...claudeStatuslineSignals({ seatSession, cachePresent: false, asOf }));
  }
  const model = assembleFourBlock({ accounts, rawBindings, signals, asOf });
  // Slice-04 S-A: the host-level rollup aggregates the SAME signals this collection produced.
  // Codex deployment presence = auth profiles on disk (a host with codex accounts but no meter
  // must surface an explicit unknown, never an omitted row).
  return {
    ...model,
    hostUsage: rollupHostUsage({ signals, codexProfilesPresent: profiles.length > 0, now: asOf }),
  };
}
