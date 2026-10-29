// P29 (a different module from queue-destination-check.ts, which validates WHICH addresses a row may name) — before a queue row is routed to an agent seat, ask a configurable hook whether that seat's model rail can take work.
// A Pi seat on an exhausted rail reads idle (a typed 429 looks transient), so rows keep landing on it and loop on retries.
//
// The hook is an argv the operator configures; nothing here names another repository. It is a SAFETY-NET WARNING, not a gate:
//   - warn-only by default; the row is always created and the warning travels with the response;
//   - a refuse mode exists, off by default, and refuses only on exit codes the operator lists as refusing (never on a
//     warn-only code such as UNKNOWN);
//   - bounded: a hard timeout and a per-seat result cache, so a create stays fast on a starved host;
//   - fail open: a missing, slow, crashing or unreadable hook yields no warning and no block, only a debug line.
import { execFile } from "node:child_process";
import { hookChildEnv } from "./hook-child-env.js";

export interface DestinationCheckConfig {
  /** argv template; `{session}` is replaced by the destination session name. */
  argv: string[];
  /** exit codes that mean "this rail cannot (reliably) take work": shown as a warning. Default [3, 4]. */
  warnCodes: number[];
  mode: "warn" | "refuse";
  /** exit codes that refuse in refuse mode. Default []: a refuse mode with no codes never refuses. */
  refuseCodes: number[];
  timeoutMs: number;
  cacheMs: number;
}

export type DestinationCheckResult =
  | { kind: "skipped"; reason: string }
  | { kind: "ok" }
  | { kind: "error"; reason: string }                       // hook missing / slow / crashed / unlisted code: no warning, no block
  | { kind: "warn"; code: number; message: string }
  | { kind: "refuse"; code: number; message: string };

export interface HookRun { code: number | null; stdout: string; timedOut: boolean; startError?: string }
export type RunHook = (argv: string[], timeoutMs: number) => Promise<HookRun>;

export const MAX_TIMEOUT_MS = 3000;
const MAX_MESSAGE_CHARS = 800;

function intList(raw: string | undefined, fallback: number[]): number[] | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((n) => Number.isInteger(n) && (n as number) > 0 && (n as number) < 256) ? (parsed as number[]) : null;
  } catch { return null; }
}

/** Read the configuration from the environment. Returns null when no hook is configured or the configuration is unusable
 *  (an unusable configuration disables the check rather than guessing; `problem` says why, for the debug log). */
export function destinationCheckConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { config: DestinationCheckConfig | null; problem?: string } {
  const raw = env["OPENRIG_QUEUE_DESTINATION_CHECK"];
  if (raw === undefined || raw.trim() === "") return { config: null };
  let argv: unknown;
  try { argv = JSON.parse(raw); } catch { return { config: null, problem: "OPENRIG_QUEUE_DESTINATION_CHECK is not valid JSON" }; }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((p) => typeof p === "string" && p !== "") || !argv.some((p) => (p as string).includes("{session}"))) {
    return { config: null, problem: "OPENRIG_QUEUE_DESTINATION_CHECK must be a JSON array of non-empty strings including {session}" };
  }
  const warnCodes = intList(env["OPENRIG_QUEUE_DESTINATION_CHECK_WARN_CODES"], [3, 4]);
  const refuseCodes = intList(env["OPENRIG_QUEUE_DESTINATION_CHECK_REFUSE_CODES"], []);
  if (!warnCodes || !refuseCodes) return { config: null, problem: "the destination-check code lists must be JSON arrays of exit codes 1-255" };
  const modeRaw = (env["OPENRIG_QUEUE_DESTINATION_CHECK_MODE"] ?? "warn").trim().toLowerCase();
  if (modeRaw !== "warn" && modeRaw !== "refuse") return { config: null, problem: "OPENRIG_QUEUE_DESTINATION_CHECK_MODE must be warn or refuse" };
  const timeout = Number(env["OPENRIG_QUEUE_DESTINATION_CHECK_TIMEOUT_MS"] ?? MAX_TIMEOUT_MS);
  const cache = Number(env["OPENRIG_QUEUE_DESTINATION_CHECK_CACHE_MS"] ?? 60_000);
  return {
    config: {
      argv: argv as string[], warnCodes, refuseCodes, mode: modeRaw,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS,   // never above the hard cap
      cacheMs: Number.isFinite(cache) && cache >= 0 ? cache : 60_000,
    },
  };
}

export const execFileHook: RunHook = (argv, timeoutMs) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    execFile(file!, args, { timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: "utf8", windowsHide: true, killSignal: "SIGKILL", env: hookChildEnv() }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout, timedOut: false });
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return resolve({ code: null, stdout: stdout ?? "", timedOut: true });
      if (typeof e.code === "string") return resolve({ code: null, stdout: stdout ?? "", timedOut: false, startError: `${e.code}` });
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: stdout ?? "", timedOut: false });
    });
  });

/** The first stdout line a checker prints to say a rail is EXHAUSTED (P29b); refuse mode refuses on nothing else. */
export const EXHAUSTED_VERDICT = "verdict=EXHAUSTED";
const firstLine = (stdout: string): string => (stdout.split(/\r?\n/, 1)[0] ?? "").trim();

export class QueueDestinationChecker {
  private readonly cache = new Map<string, { at: number; result: DestinationCheckResult }>();
  private readonly inFlight = new Map<string, Promise<DestinationCheckResult>>();

  constructor(private readonly opts: {
    env?: () => NodeJS.ProcessEnv;
    run?: RunHook;
    now?: () => number;
    debug?: (line: string) => void;
  } = {}) {}

  /** The hook's verdict for one destination session. Never throws. */
  async check(session: string): Promise<DestinationCheckResult> {
    const debug = this.opts.debug ?? (() => {});
    const { config, problem } = destinationCheckConfigFromEnv(this.opts.env?.() ?? process.env);
    if (!config) {
      if (problem) debug(`[queue-destination-check] disabled: ${problem}`);
      return { kind: "skipped", reason: problem ?? "no destination check is configured" };
    }
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(session);
    if (hit && now - hit.at < config.cacheMs) return hit.result;
    const pending = this.inFlight.get(session);
    if (pending) return pending;
    const run = (async (): Promise<DestinationCheckResult> => {
      let result: DestinationCheckResult;
      try {
        const argv = config.argv.map((part) => part.split("{session}").join(session));
        const out = await (this.opts.run ?? execFileHook)(argv, config.timeoutMs);
        result = this.interpret(config, out, debug, session);
      } catch (err) {
        debug(`[queue-destination-check] ${session}: ${err instanceof Error ? err.message : String(err)}`);
        result = { kind: "error", reason: "the destination check threw" };
      }
      this.cache.set(session, { at: now, result });
      return result;
    })().finally(() => { this.inFlight.delete(session); });
    this.inFlight.set(session, run);
    return run;
  }

  private interpret(config: DestinationCheckConfig, out: HookRun, debug: (line: string) => void, session: string): DestinationCheckResult {
    if (out.startError) { debug(`[queue-destination-check] ${session}: could not start the hook (${out.startError})`); return { kind: "error", reason: "the hook could not start" }; }
    if (out.timedOut) { debug(`[queue-destination-check] ${session}: the hook did not answer within ${config.timeoutMs} ms`); return { kind: "error", reason: "the hook timed out" }; }
    if (out.code === 0) return { kind: "ok" };
    const code = out.code ?? 1;
    const confirmed = firstLine(out.stdout) === EXHAUSTED_VERDICT;
    // The token line is for the daemon; the person reads the explanation after it.
    const body = confirmed ? out.stdout.replace(/^[^\r\n]*(\r?\n|$)/, "") : out.stdout;
    const text = body.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim().slice(0, MAX_MESSAGE_CHARS);
    const message = text !== "" ? text : confirmed ? `the destination check says the rail is EXHAUSTED for ${session}` : `the destination check exited ${code} for ${session}`;
    // P29b: refusing needs two things, not one. The exit code is listed AND the checker said so in words: its first stdout line is
    // exactly `verdict=EXHAUSTED`. A checker that uses one code for EXHAUSTED and UNKNOWN, with that code listed, therefore still
    // only warns on UNKNOWN. A listed code without the token warns and says the verdict was not confirmed.
    if (config.mode === "refuse" && config.refuseCodes.includes(code)) {
      if (confirmed) return { kind: "refuse", code, message };
      return { kind: "warn", code, message: `${message} (exit ${code} is a refusing code, but the checker did not print ${EXHAUSTED_VERDICT} as its first line, so the verdict is not confirmed EXHAUSTED and the row was sent)` };
    }
    if (config.warnCodes.includes(code) || config.refuseCodes.includes(code)) return { kind: "warn", code, message };
    debug(`[queue-destination-check] ${session}: the hook exited ${code}, which is not a listed code; no warning`);
    return { kind: "error", reason: `unlisted exit code ${code}` };
  }
}
