import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

import { startupActionsLaunchPi, terminalAgentHint } from "../src/domain/terminal/terminal-agent-hint.js";

// A `terminal` seat has no agent runtime. What it runs is whatever its startup types into the
// shell, so the hint is read from the persisted startup actions, never from the pane's text.

const sendText = (value: string, phase = "after_ready") => ({ type: "send_text", value, phase, appliesOn: ["fresh_start", "restore"], idempotent: false });
const actions = (...a: unknown[]) => JSON.stringify(a);

describe("startupActionsLaunchPi", () => {
  it("recognises the fleet's pi chat-screen launch: env assignments, then pi", () => {
    const cmd = "env HOME='/h/native/home' PI_CODING_AGENT_DIR='/h/state/pi/s@r/agent' pi --no-approve --model zai/glm-5 --continue --append-system-prompt '/r/role.md'";
    expect(startupActionsLaunchPi(actions(sendText(cmd)))).toBe(true);
  });

  it("recognises a bare pi, a path to pi, and bare assignments without env", () => {
    expect(startupActionsLaunchPi(actions(sendText("pi")))).toBe(true);
    expect(startupActionsLaunchPi(actions(sendText("/opt/pi/bin/pi --continue")))).toBe(true);
    expect(startupActionsLaunchPi(actions(sendText("PI_CODING_AGENT_DIR=/x pi")))).toBe(true);
  });

  it("finds the launch on any line of a multi-line action, and among other actions", () => {
    expect(startupActionsLaunchPi(actions(sendText("cd /work\npi --no-approve"), sendText("hello")))).toBe(true);
    expect(startupActionsLaunchPi(actions(sendText("echo ready"), sendText("env A=1 pi")))).toBe(true);
  });

  it("is false for anything that is not pi as the command word", () => {
    for (const value of [
      "pip install pi", "echo pi", "pi-tool --x", "pinentry", "ls ~/pi", "env", "env A=1", "", "   ",
      "BEFORE you do anything else, load your skills",
      "claude --model opus", "codex", "bash -lc 'pi'",
    ]) expect(startupActionsLaunchPi(actions(sendText(value))), value).toBe(false);
  });

  it("ignores actions that are not typed text", () => {
    expect(startupActionsLaunchPi(actions({ type: "slash_command", value: "pi", phase: "after_ready" }))).toBe(false);
  });

  it("is false, never a throw, for a missing or malformed record", () => {
    for (const raw of [null, undefined, "", "not json", "{}", "null", "[1,2]", "[{\"type\":\"send_text\"}]", "[{\"type\":\"send_text\",\"value\":5}]"]) {
      expect(startupActionsLaunchPi(raw), String(raw)).toBe(false);
    }
  });
});

describe("terminalAgentHint", () => {
  function db(rows: Array<[string, string, string]>): Database.Database {
    const d = new Database(":memory:");
    d.exec(`CREATE TABLE node_startup_context (node_id TEXT PRIMARY KEY, projection_entries_json TEXT NOT NULL DEFAULT '[]',
      resolved_files_json TEXT NOT NULL DEFAULT '[]', startup_actions_json TEXT NOT NULL, runtime TEXT NOT NULL)`);
    const ins = d.prepare("INSERT INTO node_startup_context (node_id, startup_actions_json, runtime) VALUES (?, ?, ?)");
    for (const r of rows) ins.run(...r);
    return d;
  }
  const piLaunch = actions(sendText("env A=1 pi --no-approve"));

  it("says pi for a terminal node whose persisted startup launches pi", () => {
    expect(terminalAgentHint(db([["n1", piLaunch, "terminal"]]), "n1", "terminal")).toBe("pi");
  });

  it("says nothing for a terminal node that launches something else, or has no record", () => {
    const d = db([["n1", actions(sendText("htop")), "terminal"]]);
    expect(terminalAgentHint(d, "n1", "terminal")).toBeNull();
    expect(terminalAgentHint(d, "missing", "terminal")).toBeNull();
  });

  it("does not read the record for a runtime that is not terminal", () => {
    const d = db([["n1", piLaunch, "claude-code"]]);
    for (const runtime of ["claude-code", "codex", "pi", "unknown", null, undefined]) {
      expect(terminalAgentHint(d, "n1", runtime), String(runtime)).toBeNull();
    }
  });

  it("says nothing when the table does not exist (an older database) or there is no node id", () => {
    expect(terminalAgentHint(new Database(":memory:"), "n1", "terminal")).toBeNull();
    expect(terminalAgentHint(db([["n1", piLaunch, "terminal"]]), undefined, "terminal")).toBeNull();
  });
});
