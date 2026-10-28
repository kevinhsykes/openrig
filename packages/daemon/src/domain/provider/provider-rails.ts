// The allowed-rails export: which subscription rails this host may serve usage readings for, exported by the fleet that owns the rail
// universe (kevinsykes-ai's billing_rails._known_quota_rails()). The fork ships no rail list and no mapping: the export carries both.
//
// Shape (a list under `rails`, or the list itself):
//   { "rails": [ { "rail": "ollama_cloud", "storeKey": "ollama-cloud", "aliases": ["ollama"], "nativeReader": false }, ... ] }
// `storeKey` is the availability file's provider key for the rail; it differs from the rail id for many rails (rail `codex` is store key
// `openai`; `ollama_cloud` is `ollama-cloud`), so the file's keys are mapped to rails through this and nowhere else. `nativeReader: true`
// marks a rail some native reader serves (the codex and claude families): it is excluded here, so no duplicate reading sits beside the
// native one. `aliases` are the rail's other spellings; they are validated and kept, and never used to match a file key.
//
// Loading registers each collector-served rail id into the live known-kinds list (provider-types.ts), so the daemon's validators accept
// `--provider <rail>`. Only the daemon loads it: the CLI keeps no list and lets the daemon refuse an unknown kind.

import fs from "node:fs";
import { isKnownProviderKind, isProviderRailId, registerProviderKinds } from "./provider-types.js";

/** Names the allowed-rails file. */
export const PROVIDER_RAILS_FILE_ENV = "OPENRIG_PROVIDER_RAILS_FILE";
/** Names the quota collector's availability file (read-only input; the fork never writes it). */
export const PROVIDER_QUOTA_FILE_ENV = "OPENRIG_PROVIDER_QUOTA_FILE";

const MAX_RAILS_FILE_BYTES = 256 * 1024;

export interface AllowedRail {
  rail: string;
  /** The availability file's provider key for this rail. */
  storeKey: string;
  aliases: string[];
  /** True when a native reader serves this rail (or its id is a built-in kind): this feed excludes it. */
  nativeReader: boolean;
}

export type AllowedRailsRead = { ok: true; rails: AllowedRail[] } | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function keyProblem(key: unknown, what: string): string | null {
  if (typeof key !== "string" || key === "") return `${what} must be a non-empty string`;
  if (key.length > 128 || /[\x00-\x1f\x7f]/.test(key)) return `${what} is too long or holds a control character`;
  return null;
}

/** Parses the export. A malformed entry fails the whole file: a half-read allow-list would serve some rails and hide the rest. */
export function parseAllowedRails(json: unknown): AllowedRailsRead {
  const list = isRecord(json) && "rails" in json ? json.rails : json;
  if (!Array.isArray(list)) return { ok: false, reason: "the allowed-rails export isn't a list of {rail, storeKey, ...} entries" };
  const rails: AllowedRail[] = [];
  const seenRails = new Set<string>();
  const seenKeys = new Map<string, string>();
  for (const [i, entry] of list.entries()) {
    if (!isRecord(entry)) return { ok: false, reason: `entry ${i} isn't a mapping` };
    const rail = entry.rail;
    if (!isProviderRailId(rail)) return { ok: false, reason: `entry ${i}: rail ${JSON.stringify(rail)} isn't a rail id (lower-case letters, digits, _ and -, starting with a letter)` };
    if (seenRails.has(rail)) return { ok: false, reason: `rail "${rail}" is listed twice` };
    seenRails.add(rail);
    const keyIssue = keyProblem(entry.storeKey, "storeKey");
    if (keyIssue) return { ok: false, reason: `rail "${rail}": ${keyIssue}` };
    const storeKey = entry.storeKey as string;
    let aliases: string[] = [];
    if (entry.aliases !== undefined) {
      if (!Array.isArray(entry.aliases) || entry.aliases.some((a) => keyProblem(a, "an alias") !== null)) return { ok: false, reason: `rail "${rail}": aliases must be a list of strings` };
      aliases = entry.aliases as string[];
    }
    if (entry.nativeReader !== undefined && typeof entry.nativeReader !== "boolean") return { ok: false, reason: `rail "${rail}": nativeReader must be true or false` };
    // A file key can name only one rail, or a row would be served twice under two rails.
    const owner = seenKeys.get(storeKey);
    if (owner !== undefined) return { ok: false, reason: `file key "${storeKey}" is claimed by both rail "${owner}" and rail "${rail}"` };
    seenKeys.set(storeKey, rail);
    rails.push({ rail, storeKey, aliases, nativeReader: entry.nativeReader === true || isKnownProviderKind(rail) });
  }
  return rails.length > 0 ? { ok: true, rails } : { ok: false, reason: "the allowed-rails export lists no rails" };
}

/** Reads and parses the file, bounded. */
export function readAllowedRailsFile(file: string): AllowedRailsRead {
  let text: string;
  try {
    if (fs.statSync(file).size > MAX_RAILS_FILE_BYTES) return { ok: false, reason: `the allowed-rails file ${file} is larger than ${MAX_RAILS_FILE_BYTES} bytes` };
    text = fs.readFileSync(file, "utf8");
  } catch (err) { return { ok: false, reason: `the allowed-rails file ${file} can't be read (${(err as NodeJS.ErrnoException).code ?? "error"})` }; }
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, reason: `the allowed-rails file ${file} isn't JSON` }; }
  return parseAllowedRails(json);
}

export type RailsLoad =
  | { state: "absent" }
  | { state: "registered"; file: string; rails: AllowedRail[] }
  | { state: "unusable"; file: string; reason: string };

/** Registers the rails the environment's allowed-rails file names. Absent variable: nothing registered, no error. An unusable file
 *  registers nothing and says why: the caller shows that, never a partial list. */
export function registerAllowedRailsFromEnv(env: NodeJS.ProcessEnv): RailsLoad {
  const file = env[PROVIDER_RAILS_FILE_ENV];
  if (!file) return { state: "absent" };
  const read = readAllowedRailsFile(file);
  if (!read.ok) return { state: "unusable", file, reason: read.reason };
  // Only the rails this feed serves become known kinds; a native-reader rail has its own reader and its own validation.
  registerProviderKinds(read.rails.filter((r) => !r.nativeReader).map((r) => r.rail));
  return { state: "registered", file, rails: read.rails };
}
