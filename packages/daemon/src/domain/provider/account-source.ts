// The AccountSource seam: where the accounts[] rows and seat bindings of the provider read model come from. Each source owns one
// rail (today only Codex's saved profiles and seat registry) and contributes accounts and bindings without touching another's.
// `collectFourBlockReadModel` asks every registered source, in registration order. Everything here is secret-safe: labels and
// opaque refs only, never a token, a header or a credential file's contents (BR-6).

import type { CodexAuthMetadata } from "./codex-auth-reader.js";
import type { ProviderSeat } from "./provider-collect.js";
import type { RawSeatBinding } from "./provider-read-model.js";
import type { ProviderAccount, ProviderKind } from "./provider-types.js";

/**
 * One source of accounts and bindings.
 *
 * Contract:
 * - `accountId` is the key everywhere downstream (the assembler's same-account grouping, precheck's target lookup, signal joins), so it
 *   must be unique across ALL sources, whatever their provider. Codex's ids are the bare saved-profile names and stay exactly as they
 *   were; every other source MUST prefix its ids with its own id: `<source id>:<label>`.
 * - `bindingFor` MUST gate on `seat.runtime`: a source returns a binding only for a seat whose live runtime it serves. A stale row
 *   keyed by a reused session name must never bind a seat of another runtime. It returns null for every other seat.
 * - Both methods are pure over data the source already holds. A collection reads each backing store once, before it builds its
 *   sources, and a source never reads one itself while the model is assembled.
 * - Account and binding data are refs and labels only (BR-6); an account's `authState` is "unknown" unless something native proved
 *   it (BR-3).
 * - `id` is unique among registered sources; register with `validateAccountSources`, which throws then rather than during a collection.
 */
export interface AccountSource {
  /** A stable name for this source, used in warnings and as the prefix of a non-Codex source's account ids. */
  readonly id: string;
  readonly provider: ProviderKind;
  listAccounts(asOf: string): ProviderAccount[];
  bindingFor(seat: ProviderSeat): RawSeatBinding | null;
}

/** The id of the Codex source: its account ids are bare profile names, not prefixed with it. */
export const CODEX_SOURCE_ID = "codex";

/** Registration check: source ids are unique, and none repeats a `reserved` id (the sources the collection builds itself). Throws with
 *  the repeated id. This is the one place a static mistake in the source list throws; a collection never does. */
export function validateAccountSources(sources: ReadonlyArray<Pick<AccountSource, "id">>, reserved: readonly string[] = []): void {
  const seen = new Set<string>(reserved);
  for (const { id } of sources) {
    if (!id) throw new Error("an account source needs a non-empty id");
    if (seen.has(id)) throw new Error(`account source id "${id}" is registered twice${reserved.includes(id) ? " (it is reserved)" : ""}`);
    seen.add(id);
  }
}

/**
 * The Codex source: saved profiles are accounts with authState "unknown" (BR-3: static disk presence proves the profile exists, NOT that
 * its auth is currently valid), and a seat binds through the seat registry. Takes the metadata already read, so one collection reads
 * `~/.codex` once.
 */
export function codexAccountSource(auth: CodexAuthMetadata): AccountSource {
  // seat session → codex-auth registry row (the only Codex binding source).
  const registryBySeat = new Map(auth.seats.map((s) => [s.seat, s]));
  return {
    id: CODEX_SOURCE_ID,
    provider: "codex",
    listAccounts: (asOf) => auth.profiles.map((name) => ({
      accountId: name,
      label: name,
      provider: "codex",
      authState: "unknown",
      profileRef: name,
      asOf,
    })),
    bindingFor: (seat) => {
      const reg = registryBySeat.get(seat.seatSession);
      // Runtime-identity gate: bind ONLY when the LIVE inventory seat is actually a Codex seat. The
      // codex auth-seat-registry is keyed by session name, so a STALE row whose session name was
      // reused by a Claude seat must NOT bind that Claude seat to a Codex account — a Claude seat
      // stays unbound (seat_with_no_account) regardless of any same-session registry row. The registry lives in
      // the daemon's CODEX_HOME, so it binds nothing for a seat that launches with its own.
      if (reg && seat.runtime === "codex" && !seat.runtimeHome?.home) {
        return {
          accountId: reg.authProfile,
          seatSession: seat.seatSession,
          rigName: seat.rigName,
          boundAt: reg.updatedTs,
          bindingSource: "codex_auth_seat_registry",
        };
      }
      return null;
    },
  };
}
