import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readTerminalLaunchActions } from "../src/domain/terminal-launch-actions.js";

// A terminal seat's agent is started by its persisted `after_ready` send_text. The reader fails closed: a record it cannot
// trust is a named refusal, never "nothing to launch".

const act = (over: Record<string, unknown> = {}) =>
  ({ type: "send_text", value: "env A=1 pi --no-approve", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true, ...over });

describe("readTerminalLaunchActions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE node_startup_context (node_id TEXT PRIMARY KEY, startup_actions_json TEXT NOT NULL)");
  });
  afterEach(() => db.close());
  const put = (json: string) => db.prepare("INSERT INTO node_startup_context VALUES ('n1', ?)").run(json);

  it("returns the after_ready send_text commands that apply to a fresh start, in order", () => {
    put(JSON.stringify([act({ value: "first" }), act({ value: "second", appliesOn: ["fresh_start"] })]));
    expect(readTerminalLaunchActions(db, "n1")).toEqual({ ok: true, actions: [{ value: "first" }, { value: "second" }] });
  });

  it("leaves out everything that is not a command for a shell", () => {
    put(JSON.stringify([
      act({ value: "files", phase: "after_files" }),
      act({ value: "restore-only", appliesOn: ["restore"] }),
      act({ value: "/status", type: "slash_command" }),
      act({ value: "proof", type: "startup_proof" }),
      act({ value: "who am I", builtin: "session_identity" }),
      act({ value: "   " }),
      act({ value: "keep" }),
    ]));
    expect(readTerminalLaunchActions(db, "n1")).toEqual({ ok: true, actions: [{ value: "keep" }] });
  });

  it("an empty list is an empty answer, not a failure: the caller decides what no command means", () => {
    put("[]");
    expect(readTerminalLaunchActions(db, "n1")).toEqual({ ok: true, actions: [] });
  });

  it("no record, and no table (an older database), are startup_context_missing", () => {
    expect(readTerminalLaunchActions(db, "n1")).toMatchObject({ ok: false, reason: "startup_context_missing" });
    expect(readTerminalLaunchActions(new Database(":memory:"), "n1")).toMatchObject({ ok: false, reason: "startup_context_missing" });
  });

  it.each([
    ["not json", "{not json"],
    ["an object", "{}"],
    ["null", "null"],
    ["an entry that is not an object", "[1]"],
    ["an unknown type", JSON.stringify([act({ type: "shell" })])],
    ["an unknown phase", JSON.stringify([act({ phase: "later" })])],
    ["a value that is not text", JSON.stringify([act({ value: 5 })])],
    ["an appliesOn that is not a list", JSON.stringify([act({ appliesOn: "fresh_start" })])],
    ["an unknown context", JSON.stringify([act({ appliesOn: ["boot"] })])],
    ["an idempotent flag that is not a boolean", JSON.stringify([act({ idempotent: "yes" })])],
    ["one bad entry among good ones", JSON.stringify([act(), act({ type: 3 }), act()])],
  ])("%s is startup_context_malformed, never skipped", (_label, json) => {
    put(json);
    expect(readTerminalLaunchActions(db, "n1")).toMatchObject({ ok: false, reason: "startup_context_malformed" });
  });
});
