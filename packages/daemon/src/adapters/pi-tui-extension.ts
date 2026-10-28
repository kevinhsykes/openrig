// Native Pi extension: lifecycle comes from the public extension API, never terminal scraping.
// This is not a served-model receipt or an input-delivery transport.
import fs from "node:fs";
import path from "node:path";
import { nativeTuiStatePath, parsePiRunnerState, type PiRunnerState } from "./pi-runner-protocol.js";
import { resolveActivityEndpoint } from "./pi-runner.js";

export interface NativePiContext {
  mode: string;
  hasUI: boolean;
  isIdle?(): boolean;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
}
export interface NativePiApi {
  on(event: string, handler: (event: any, context: NativePiContext) => void | Promise<void>): unknown;
}
export interface NativePiBinding {
  sessionName: string;
  nodeId: string;
  generation: string;
  launchId: string;
  sessionsDir: string;
  statePath: string;
  expectedSessionFile?: string;
}
export interface NativePiIo {
  current(): PiRunnerState | null;
  write(state: PiRunnerState): void;
  post(payload: Record<string, unknown>): Promise<unknown>;
  now(): string;
  heartbeat?(callback: () => void): () => void;
}

/** A prior occupant cannot announce readiness, identity or activity for the new attempt. */
export function attachNativePiLifecycle(api: NativePiApi, binding: NativePiBinding, io: NativePiIo): void {
  let sequence = 0;
  let started = false;
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  let context: NativePiContext | undefined;
  let stopHeartbeat: (() => void) | undefined;
  const current = () => io.current()?.launchId === binding.launchId;
  const state = (ready: boolean, exited = false) => {
    if (!current()) return false;
    const old = io.current();
    io.write({ ready, interaction: "tui", launchId: binding.launchId, sessionId, sessionFile,
      lastEntryId: old?.lastEntryId, updatedAt: io.now(),
      ...(exited ? { exited: { code: 0, at: io.now() } } : {}) });
    return true;
  };
  const post = async (extra: Record<string, unknown>) => {
    if (!current()) return;
    await io.post({ sessionName: binding.sessionName, nodeId: binding.nodeId, generation: binding.generation,
      runtime: "pi", occurredAt: io.now(), ...extra });
  };
  const activity = async (hookEvent: string, subtype: string) => {
    if (!started || !current()) return;
    await post({ hookEvent, subtype, sequence: ++sequence, ...(hookEvent === "Stop" && subtype !== "pi_exited" ? { livenessSeconds: 30 } : {}) });
  };
  const identity = async (_event: unknown, ctx: NativePiContext) => {
    if (!current()) return;
    if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Native Pi lifecycle requires the terminal UI");
    const id = ctx.sessionManager.getSessionId();
    const file = ctx.sessionManager.getSessionFile();
    const relative = file && path.relative(binding.sessionsDir, file);
    if (!id || (file && (!path.isAbsolute(file) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`))) ||
        (!started && binding.expectedSessionFile && file !== binding.expectedSessionFile)) {
      state(false); started = false;
      throw new Error("Native Pi session does not match the managed session boundary");
    }
    sessionId = id; sessionFile = file; started = true;
    context = ctx;
    if (!state(true)) return;
    await post({ eventFamily: "session_identity", hookEvent: "SessionStart", sessionId, sessionFile: file ?? null });
    await activity("Stop", "native_tui_session_start");
    stopHeartbeat ??= io.heartbeat?.(() => {
      if (!current()) { stopHeartbeat?.(); stopHeartbeat = undefined; return; }
      if (started && context?.isIdle?.() === true) void activity("Stop", "idle_heartbeat");
    });
  };
  api.on("session_start", identity);
  api.on("session_switch", identity);
  api.on("agent_start", () => activity("active", "agent_start"));
  api.on("agent_end", () => activity("Stop", "agent_end"));
  api.on("tool_execution_start", event => activity("PreToolUse", String(event.toolName ?? "unknown")));
  api.on("tool_execution_end", event => activity("PostToolUse", String(event.toolName ?? "unknown")));
  api.on("session_shutdown", async () => {
    if (!started) return;
    await activity("Stop", "pi_exited");
    state(false, true); started = false;
    stopHeartbeat?.(); stopHeartbeat = undefined;
  });
}

/** Loaded only by the explicit native-TUI launcher. No provider, model or auth defaults change. */
export default function nativePiExtension(api: NativePiApi): void {
  const raw = process.env.OPENRIG_PI_TUI_LAUNCH;
  if (!raw) throw new Error("Native Pi launch binding is missing");
  const binding = JSON.parse(raw) as NativePiBinding;
  for (const key of ["sessionName", "nodeId", "generation", "launchId", "sessionsDir", "statePath"] as const) {
    if (typeof binding[key] !== "string" || !binding[key]) throw new Error(`Native Pi launch binding lacks ${key}`);
  }
  if (!path.isAbsolute(binding.statePath) || !path.isAbsolute(binding.sessionsDir)) throw new Error("Native Pi state paths must be absolute");
  const endpoint = resolveActivityEndpoint(process.env);
  if (!endpoint) throw new Error("Native Pi activity endpoint is unavailable");
  attachNativePiLifecycle(api, binding, {
    current: () => { try { return parsePiRunnerState(fs.readFileSync(binding.statePath, "utf8")); } catch { return null; } },
    write: state => {
      const target = nativeTuiStatePath(binding.statePath, binding.launchId);
      const temp = `${target}.${process.pid}.partial`;
      try { fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temp, target); }
      finally { try { fs.unlinkSync(temp); } catch { /* renamed or never created */ } }
    },
    post: async payload => {
      const response = await fetch(new URL("/api/activity/hooks", endpoint.baseUrl), {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(2000),
      }).catch(() => null);
      return response?.ok ?? false;
    },
    now: () => new Date().toISOString(),
    heartbeat: callback => {
      const timer = setInterval(callback, 15_000); timer.unref();
      return () => clearInterval(timer);
    },
  });
}
