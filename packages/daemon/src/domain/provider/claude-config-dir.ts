// A Claude account is a config dir: the home `CLAUDE_CONFIG_DIR` names, which holds that account's stored login. This
// module is the secret-safe half of moving a seat between them: the declared list of homes (a small config file whose path
// the caller gives), the shape a home's path must have, and one bounded `claude auth status --json` for a home. It never
// opens a credentials file, and nothing it returns carries a token (BR-6).

import fs from "node:fs";
import path from "node:path";
import { claudeAuthStatusReader, type ClaudeAuthReader } from "./claude-auth-status-reader.js";

/** One declared account: the file's key, its display label, and the absolute path of its config dir. */
export interface ClaudeAccount {
  key: string;
  label: string;
  dir: string;
}

export type ClaudeAccountsRead = { ok: true; accounts: ClaudeAccount[] } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a config dir's path must be, to name a seat's home: absolute, one line, and short enough to put in an env value.
 *  Null when it's usable; otherwise the problem, as a clause. */
export function claudeConfigDirProblem(dir: unknown): string | null {
  if (typeof dir !== "string" || dir === "") return "the config dir must be a path";
  if (!path.isAbsolute(dir)) return `the config dir "${dir}" isn't an absolute path`;
  if (dir.length > 4096 || /[\x00-\x1f\x7f]/.test(dir)) return "the config dir's path is too long or holds a control character";
  return null;
}

/** The accounts a declared list names. Only each entry's `dir` and `label` are read: the list may carry other fields (notes,
 *  availability), and none of them is kept. A list that names no usable account is a refusal, not an empty answer. */
export function parseClaudeAccounts(json: unknown): ClaudeAccountsRead {
  if (!isRecord(json) || !isRecord(json.accounts)) return { ok: false, reason: 'the accounts file has no "accounts" mapping' };
  const accounts: ClaudeAccount[] = [];
  const seenDirs = new Set<string>();
  for (const [key, entry] of Object.entries(json.accounts)) {
    if (!isRecord(entry)) return { ok: false, reason: `account "${key}" isn't a mapping` };
    const problem = claudeConfigDirProblem(entry.dir);
    if (problem) return { ok: false, reason: `account "${key}": ${problem}` };
    const dir = path.resolve(entry.dir as string);
    // Two labels on one home would make "one account per home" unprovable.
    if (seenDirs.has(dir)) return { ok: false, reason: `account "${key}" repeats the config dir ${dir}` };
    seenDirs.add(dir);
    accounts.push({ key, label: typeof entry.label === "string" && entry.label !== "" ? entry.label : key, dir });
  }
  return accounts.length > 0 ? { ok: true, accounts } : { ok: false, reason: "the accounts file declares no accounts" };
}

/** Read and parse the declared list from its file. */
export function readClaudeAccountsFile(file: string): ClaudeAccountsRead {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (err) { return { ok: false, reason: `the accounts file ${file} can't be read (${(err as NodeJS.ErrnoException).code ?? "error"})` }; }
  let json: unknown;
  try { json = JSON.parse(text); }
  catch { return { ok: false, reason: `the accounts file ${file} isn't JSON` }; }
  return parseClaudeAccounts(json);
}

export function claudeConfigDirPresent(dir: string): boolean {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/** What one config dir's login reads as: the `claude auth status --json` answer with that dir selected, or why it gave none.
 *  `email` is the account's own address, kept for the view the person asked for; nothing else about the login leaves. */
export type ClaudeConfigDirLogin =
  | { state: "logged_in"; email: string | null; subscriptionType: string | null }
  | { state: "not_logged_in" }
  | { state: "unreadable"; reason: string; detail: string };

/** Probes one config dir's login state. The probe is injected: tests pass a fake, and the daemon and CLI pass `realClaudeConfigDirProbe`. */
export type ClaudeConfigDirProbe = (dir: string) => Promise<ClaudeConfigDirLogin>;

/** The probe over the real `claude` binary, bounded and process-group-stopped as `claudeAuthStatusReader` is. */
export function realClaudeConfigDirProbe(options: { launchPath?: string; home?: string; reader?: (dir: string) => ClaudeAuthReader } = {}): ClaudeConfigDirProbe {
  const readerFor = options.reader ?? ((dir: string) => claudeAuthStatusReader({
    ...(options.launchPath ? { launchPath: options.launchPath } : {}), ...(options.home ? { home: options.home } : {}), claudeConfigDir: dir }));
  return async (dir) => {
    let answer: Awaited<ReturnType<ClaudeAuthReader>>;
    try { answer = await readerFor(dir)(); }
    catch (err) { return { state: "unreadable", reason: "spawn_failed", detail: `the reader failed: ${err instanceof Error ? err.message : String(err)}` }; }
    if (answer.ok) return { state: "logged_in", email: answer.auth.email, subscriptionType: answer.auth.subscriptionType };
    if (answer.reason === "not_logged_in") return { state: "not_logged_in" };
    return { state: "unreadable", reason: answer.reason, detail: answer.detail };
  };
}
