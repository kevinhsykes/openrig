// P25 — a spec names WHAT it wants (a quota rail) instead of a model id; the model is chosen when the seat launches, by
// a resolver command the operator configures. This module is the whole mechanism and nothing here knows a model id, a
// provider, or any other repository's path: the resolver is an argv, the answer is JSON.
//
// FAIL CLOSED. Every way the answer can be missing, late, malformed or negative is a refusal with a named code and the
// resolver's own reason. There is no fallback to a literal, a default, or a previous answer.
import { execFile } from "node:child_process";
import { hookChildEnv } from "./hook-child-env.js";

/** What a spec's `model` asks for: a literal id (unchanged behaviour) or a rail the resolver picks a model for. */
export type ModelRequest =
  | { kind: "literal"; model: string }
  | { kind: "rail"; rail: string };

/** A rail name is a name, never an option: no leading dash, no path or shell characters. */
const RAIL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Parse a spec/member `model` value. Accepted forms: a string (`"zai/glm-5.1"`, or `"rail:minimax"` for a rail) or a
 * mapping with exactly the key `rail` (`{ rail: minimax }`). Anything else is an error that names what was wrong; unknown
 * keys are rejected rather than ignored.
 */
export function parseModelRequest(value: unknown): { ok: true; request: ModelRequest } | { ok: false; error: string } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return { ok: false, error: "model must not be empty" };
    if (trimmed.startsWith("rail:")) return railRequest(trimmed.slice("rail:".length));
    return { ok: true, request: { kind: "literal", model: value } };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    const unknown = keys.filter((k) => k !== "rail");
    if (unknown.length > 0) return { ok: false, error: `model has unknown key(s): ${unknown.join(", ")} (only \`rail\` is allowed)` };
    if (!keys.includes("rail")) return { ok: false, error: "model mapping needs a `rail` key" };
    const rail = (value as Record<string, unknown>)["rail"];
    if (typeof rail !== "string") return { ok: false, error: "model.rail must be a string" };
    return railRequest(rail);
  }
  return { ok: false, error: "model must be a string or a mapping with a `rail` key" };
}

function railRequest(raw: string): { ok: true; request: ModelRequest } | { ok: false; error: string } {
  const rail = raw.trim();
  if (!RAIL_NAME.test(rail)) return { ok: false, error: `model rail ${JSON.stringify(raw)} is not a rail name (lowercase letters, digits, - and _; no leading dash)` };
  return { ok: true, request: { kind: "rail", rail } };
}

/** The form that was requested, as one string, for the seat record. */
export function describeModelRequest(request: ModelRequest): string {
  return request.kind === "rail" ? `rail:${request.rail}` : request.model;
}

export type ResolveFailureCode =
  | "invalid_rail"
  | "no_resolver"
  | "resolver_start_failed"
  | "resolver_timeout"
  | "resolver_failed"
  | "resolver_bad_output"
  | "gate_refused"
  | "no_pick";

export interface ResolveFailure { ok: false; code: ResolveFailureCode; message: string }

/** What the seat record keeps about a resolution. Not a launch value: `nodes.model` stays what it was. */
export interface ModelResolution {
  requested: string;
  model: string;
  /** The resolver's chosen effort, or null when it gave none (the harness default is then in force, not a choice). */
  effort: string | null;
  resolverArgv: string[];
  resolvedAt: string;
  /** The gate's own verdict text, when the resolver reported one. */
  gateVerdict: string | null;
}

export interface ResolveSuccess { ok: true; resolution: ModelResolution }

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; startError?: string }
export type RunCommand = (argv: string[], timeoutMs: number) => Promise<RunResult>;

export const DEFAULT_RESOLVER_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1 << 20;

/** The resolver argv from the environment: a JSON array of strings, with `{rail}` where the rail name goes. */
export function resolverArgvFromEnv(env: NodeJS.ProcessEnv = process.env): { ok: true; argv: string[] } | { ok: false; message: string } {
  const raw = env["OPENRIG_MODEL_RESOLVER"];
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, message: "no model resolver is configured (set OPENRIG_MODEL_RESOLVER to a JSON array of strings, with {rail} where the rail name goes); a spec that asks for a rail cannot start without one" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, message: "OPENRIG_MODEL_RESOLVER is not valid JSON; it must be a JSON array of strings" }; }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === "string" && p !== "")) {
    return { ok: false, message: "OPENRIG_MODEL_RESOLVER must be a non-empty JSON array of non-empty strings" };
  }
  if (!parsed.some((p) => (p as string).includes("{rail}"))) {
    return { ok: false, message: "OPENRIG_MODEL_RESOLVER has no {rail} placeholder, so it could not be asked about a rail" };
  }
  return { ok: true, argv: parsed as string[] };
}

export const execFileRunner: RunCommand = (argv, timeoutMs) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    execFile(file!, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", windowsHide: true, killSignal: "SIGKILL", env: hookChildEnv() },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr, timedOut: false });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (e.killed || e.code === "ETIMEDOUT") return resolve({ code: null, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: true });
        if (typeof e.code === "string") return resolve({ code: null, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: false, startError: `${e.code}: ${e.message}` });
        resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: false });
      });
  });

export interface ResolveOptions {
  /** The argv template; `{rail}` is replaced by the rail. Defaults to the one in OPENRIG_MODEL_RESOLVER. */
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  run?: RunCommand;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Ask the configured resolver which model a rail should launch on. The resolver contract (kevinsykes-ai
 * scripts/lanes/launch_usage.py --provider <rail> --json): top-level `refuse` (true = do not launch), `pick.launch` (the
 * model), optional `pick.effort`, and `requested_reason` / `requested_verdict` for the cause of a refusal. Text output is
 * never parsed.
 */
export async function resolveModelByRail(rail: string, options: ResolveOptions = {}): Promise<ResolveSuccess | ResolveFailure> {
  const fail = (code: ResolveFailureCode, message: string): ResolveFailure => ({ ok: false, code, message });
  if (!RAIL_NAME.test(rail)) return fail("invalid_rail", `model rail ${JSON.stringify(rail)} is not a rail name`);
  let template = options.argv;
  if (!template) {
    const fromEnv = resolverArgvFromEnv(options.env);
    if (!fromEnv.ok) return fail("no_resolver", fromEnv.message);
    template = fromEnv.argv;
  }
  const argv = template.map((part) => part.split("{rail}").join(rail));
  const run = options.run ?? execFileRunner;
  const result = await run(argv, options.timeoutMs ?? DEFAULT_RESOLVER_TIMEOUT_MS);
  const where = `rail ${rail} (resolver: ${argv.join(" ")})`;
  if (result.startError) return fail("resolver_start_failed", `could not start the model resolver for ${where}: ${result.startError}`);
  if (result.timedOut) return fail("resolver_timeout", `the model resolver for ${where} did not answer within ${(options.timeoutMs ?? DEFAULT_RESOLVER_TIMEOUT_MS) / 1000}s`);
  let doc: unknown;
  try { doc = JSON.parse(result.stdout); } catch { doc = undefined; }
  // A non-zero exit can still carry a typed refusal (launch_usage exits non-zero when it refuses), so read the JSON first.
  const body = doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  if (body === undefined) {
    if (result.code !== 0) return fail("resolver_failed", `the model resolver for ${where} exited ${result.code} without JSON: ${tail(result.stderr)}`);
    return fail("resolver_bad_output", `the model resolver for ${where} did not print a JSON object`);
  }
  const verdict = typeof body["requested_verdict"] === "string" ? (body["requested_verdict"] as string) : null;
  const reason = typeof body["requested_reason"] === "string" ? (body["requested_reason"] as string) : null;
  if (body["refuse"] !== false) {
    // refuse === true, or the key is absent / not a boolean: both are "do not launch"; only an explicit false passes.
    const why = [verdict ? `verdict ${verdict}` : null, reason ? `reason ${reason}` : null].filter(Boolean).join(", ") || "no reason given";
    return fail("gate_refused", `the model resolver refused ${where}: ${why}`);
  }
  if (result.code !== 0) return fail("resolver_failed", `the model resolver for ${where} exited ${result.code} although it printed refuse:false: ${tail(result.stderr)}`);
  const pick = body["pick"];
  const launch = pick !== null && typeof pick === "object" && !Array.isArray(pick) ? (pick as Record<string, unknown>)["launch"] : undefined;
  if (typeof launch !== "string" || launch.trim() === "") return fail("no_pick", `the model resolver for ${where} allowed the launch but named no pick.launch model`);
  const effortRaw = (pick as Record<string, unknown>)["effort"];
  const effort = typeof effortRaw === "string" && effortRaw.trim() !== "" ? effortRaw.trim() : null;
  return {
    ok: true,
    resolution: {
      requested: `rail:${rail}`,
      model: launch.trim(),
      effort,
      resolverArgv: argv,
      resolvedAt: (options.now ?? (() => new Date()))().toISOString(),
      gateVerdict: verdict,
    },
  };
}

function tail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat === "" ? "(no stderr)" : flat.slice(-300);
}

/**
 * Does a Pi `models.json` document list `provider/id`? `null` when the document has no readable `providers` shape (the
 * caller refuses on null as well as on false: an unknown schema must not read as "present").
 */
export function piModelsJsonHas(doc: unknown, model: string): boolean | null {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const providers = (doc as Record<string, unknown>)["providers"];
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return null;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return false;
  const block = (providers as Record<string, unknown>)[model.slice(0, slash)];
  if (block === null || typeof block !== "object" || Array.isArray(block)) return false;
  const models = (block as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return false;
  const id = model.slice(slash + 1);
  return models.some((m) => m !== null && typeof m === "object" && (m as Record<string, unknown>)["id"] === id);
}
