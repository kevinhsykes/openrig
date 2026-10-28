import { describe, it, expect } from "vitest";
import { buildPiChildArgs, buildPiRunnerCommand } from "../src/adapters/pi-runner-protocol.js";
import { parseRunnerArgs } from "../src/adapters/pi-runner.js";

const launch = { sessionName: "native@fixture", stateRoot: "/managed/pi", cwd: "/work", launchId: "attempt-1", trust: "no-approve" as const };
describe("explicit native Pi TUI launch contract", () => {
  it("uses native terminal input and the typed extension instead of RPC streams", () => {
    const args = buildPiChildArgs({ ...launch, sessionsDir: "/managed/pi/native@fixture/sessions", interaction: "tui", extensionPath: "/dist/pi-tui-extension.js", sessionFile: "/managed/pi/native@fixture/sessions/exact.jsonl" });
    expect(args).not.toContain("rpc");
    expect(args).toContain("--extension");
    expect(args[args.indexOf("--session") + 1]).toBe("/managed/pi/native@fixture/sessions/exact.jsonl");
    expect(args).not.toContain("--resume");
  });
  it("preserves an explicit interface through the existing runner command/parser", () => {
    const command = buildPiRunnerCommand({ ...launch, runnerEntryPath: "/dist/pi-runner.js", interaction: "tui" });
    expect(command).toContain("--interface tui");
    const parsed = parseRunnerArgs(["--session-name", launch.sessionName, "--state-root", launch.stateRoot, "--cwd", launch.cwd, "--launch-id", launch.launchId, "--no-approve", "--interface", "tui"]);
    expect(parsed.interaction).toBe("tui");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachNativePiLifecycle, type NativePiContext } from "../src/adapters/pi-tui-extension.js";
import { buildPendingRunnerState, nativeTuiStatePath, readCurrentPiRunnerState, piInteraction, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

function lifecycle() {
  const handlers = new Map<string, (event: any, ctx: NativePiContext) => unknown>();
  const binding = { ...launch, nodeId: "node-1", generation: "generation-1", sessionsDir: "/managed/pi/native@fixture/sessions", statePath: "/managed/pi/native@fixture/runner-state.json", expectedSessionFile: "/managed/pi/native@fixture/sessions/exact.jsonl" };
  let selected = buildPendingRunnerState(launch.launchId, "2026-10-28T22:00:00Z", null, "tui");
  let heartbeat: (() => void) | undefined;
  let idle = true;
  const writes: PiRunnerState[] = [], posts: Record<string, unknown>[] = [];
  attachNativePiLifecycle({ on: (event, handler) => { handlers.set(event, handler); } }, binding, {
    current: () => selected, write: state => { writes.push(state); },
    heartbeat: callback => { heartbeat = callback; return () => { heartbeat = undefined; }; },
    post: async payload => { posts.push(payload); }, now: () => "2026-10-28T22:00:01Z",
  });
  const ctx: NativePiContext = { hasUI: true, mode: "tui", isIdle: () => idle, sessionManager: { getSessionId: () => "native-session", getSessionFile: () => binding.expectedSessionFile } };
  return { binding, ctx, writes, posts, beat: () => heartbeat?.(), busy: () => { idle = false; }, emit: (name: string, event: any = {}, context = ctx) => handlers.get(name)!(event, context), supersede: () => { selected = { ...selected, launchId: "attempt-2" }; } };
}

describe("native extension lifecycle", () => {
  it("establishes identity from the actual typed session context, then records ordered activity", async () => {
    const f = lifecycle();
    await f.emit("agent_start"); expect(f.posts).toEqual([]);
    await f.emit("session_start");
    expect(f.writes[0]).toMatchObject({ ready: true, interaction: "tui", launchId: launch.launchId, sessionId: "native-session", sessionFile: f.binding.expectedSessionFile });
    expect(f.posts[0]).toMatchObject({ eventFamily: "session_identity", runtime: "pi", nodeId: "node-1", generation: "generation-1" });
    expect(f.posts[0]).not.toHaveProperty("servedModel");
    await f.emit("agent_start"); await f.emit("tool_execution_start", { toolName: "read" });
    await f.emit("tool_execution_end", { toolName: "read" }); await f.emit("agent_end");
    expect(f.posts.slice(1).map(x => x.sequence)).toEqual([1, 2, 3, 4, 5]);
    await f.emit("session_shutdown"); expect(f.writes.at(-1)).toMatchObject({ ready: false, exited: { code: 0 } });
  });
  it.each([{ mode: "rpc", hasUI: false }, { mode: "tui", hasUI: false }])("refuses non-native UI context %j", async patch => {
    const f = lifecycle(); await expect(f.emit("session_start", {}, { ...f.ctx, ...patch })).rejects.toThrow(/terminal UI/);
    expect(f.writes).toEqual([]); expect(f.posts).toEqual([]);
  });
  it.each(["/other/exact.jsonl", "/managed/pi/native@fixture/sessions/copied.jsonl", "/managed/pi/native@fixture/sessions/../outside.jsonl"])("refuses a different resume or session boundary %s", async file => {
    const f = lifecycle();
    await expect(f.emit("session_start", {}, { ...f.ctx, sessionManager: { getSessionId: () => "different", getSessionFile: () => file } })).rejects.toThrow(/managed session/);
    expect(f.writes.some(x => x.ready)).toBe(false); expect(f.posts).toEqual([]);
  });
  it("renews idle only from Pi's typed idle state, and stops after shutdown", async () => {
    const f = lifecycle(); await f.emit("session_start");
    f.beat(); await Promise.resolve(); expect(f.posts.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "idle_heartbeat", livenessSeconds: 30 });
    f.busy(); const count = f.posts.length; f.beat(); await Promise.resolve(); expect(f.posts).toHaveLength(count);
    await f.emit("session_shutdown"); const end = f.posts.length; f.beat(); await Promise.resolve(); expect(f.posts).toHaveLength(end);
  });
  it("cannot publish readiness, identity, shutdown or activity after its attempt was replaced", async () => {
    const f = lifecycle(); await f.emit("session_start"); f.supersede();
    const n = [f.writes.length, f.posts.length];
    await f.emit("session_switch"); await f.emit("agent_start"); await f.emit("session_shutdown");
    expect([f.writes.length, f.posts.length]).toEqual(n);
  });
});

describe("native attempt selection", () => {
  it("a retiring native writer cannot overwrite the selected launch or its cursor", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tui-attempt-test-"));
    try {
      const statePath = path.join(dir, "runner-state.json");
      const first = { ...buildPendingRunnerState("attempt-1", "now", null, "tui"), ready: true, sessionFile: "/first.jsonl", lastEntryId: "cursor-1" };
      fs.writeFileSync(statePath, JSON.stringify(first));
      expect(readCurrentPiRunnerState(p => fs.readFileSync(p, "utf8"), statePath)?.ready).toBe(false);
      fs.writeFileSync(nativeTuiStatePath(statePath, "attempt-1"), JSON.stringify(first));
      expect(readCurrentPiRunnerState(p => fs.readFileSync(p, "utf8"), statePath)?.ready).toBe(true);
      const second = buildPendingRunnerState("attempt-2", "later", first, "tui");
      fs.writeFileSync(statePath, JSON.stringify(second));
      fs.writeFileSync(nativeTuiStatePath(statePath, "attempt-1"), JSON.stringify({ ...first, ready: false }));
      expect(readCurrentPiRunnerState(p => fs.readFileSync(p, "utf8"), statePath)).toEqual(second);
      expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual(second);
      fs.writeFileSync(nativeTuiStatePath(statePath, "attempt-2"), JSON.stringify({ ...first, launchId: "wrong" }));
      expect(readCurrentPiRunnerState(p => fs.readFileSync(p, "utf8"), statePath)).toEqual(second);
    } finally { fs.rmSync(dir, { recursive: true }); }
  });
  it("defaults to RPC and refuses unknown interface selections", () => {
    expect(piInteraction("")).toBe("rpc"); expect(piInteraction("rpc")).toBe("rpc"); expect(piInteraction("tui")).toBe("tui");
    expect(() => piInteraction("typo")).toThrow(/rpc or tui/);
    expect(() => nativeTuiStatePath("/state", "../foreign")).toThrow();
  });
  it("refuses unsupported native cost capture rather than silently dropping it", () => {
    const args = ["--session-name", "native", "--state-root", "/state", "--cwd", "/work", "--launch-id", "attempt-1", "--no-approve", "--interface", "tui"];
    expect(() => parseRunnerArgs([...args, "--usage-facts"])).toThrow(/usage-fact/);
  });
});
