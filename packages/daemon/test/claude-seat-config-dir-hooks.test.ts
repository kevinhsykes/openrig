import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RigRepository } from "../src/domain/rig-repository.js";
import { claudeSeatConfigDirHooks } from "../src/domain/provider/claude-seat-switch.js";
import { createFullTestDb } from "./helpers/test-app.js";

// P28 (port of T3 652bdcf7f): the two hooks the config-dir move uses that the fork's claudeSeatConfigDirHooks gained.
// T3 tested them through the route; here they are tested where the fork builds them, against real directories.

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); vi.unstubAllEnvs(); });

function fixture() {
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const repo = new RigRepository(db);
  const rig = repo.createRig("hooks-rig");
  const node = repo.addNode(rig.id, "owner", { runtime: "claude-code" });
  return { repo, rig, node, hooks: claudeSeatConfigDirHooks(repo) };
}

describe("claudeSeatConfigDirHooks.inheritedConfigDir", () => {
  it("is the rig's selection, ignoring the member's own, and says it is selected", () => {
    const { repo, rig, node, hooks } = fixture();
    repo.setRigEnv(rig.id, { CLAUDE_CONFIG_DIR: "/rig/dir" });
    repo.setNodeEnvVar(node.id, "CLAUDE_CONFIG_DIR", "/member/dir");
    expect(hooks.inheritedConfigDir!(node.id)).toEqual({ effective: "/rig/dir", selected: "/rig/dir" });   // RED if the member's wins
    expect(hooks.configDir!(node.id)).toMatchObject({ declared: "/member/dir", effective: "/member/dir" });   // the member's still shown as the seat's own
  });

  it("falls back to the process's CLAUDE_CONFIG_DIR, then to Claude's native default with NOTHING selected", () => {
    const { node, hooks } = fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/process/dir");
    expect(hooks.inheritedConfigDir!(node.id)).toEqual({ effective: "/process/dir", selected: "/process/dir" });
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    expect(hooks.inheritedConfigDir!(node.id)).toEqual({ effective: path.join(os.homedir(), ".claude"), selected: null });   // native unset
  });
});

describe("claudeSeatConfigDirHooks.canResumeInConfigDir", () => {
  const TOKEN = "11111111-2222-4333-8444-555555555555";
  function roots() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "p28-share-")); cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const source = path.join(base, "src"), target = path.join(base, "dst");
    fs.mkdirSync(path.join(source, "projects", "-work"), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(source, "projects", "-work", `${TOKEN}.jsonl`), "{}\n");
    return { source, target };
  }
  function seatOn(source: string) {
    const f = fixture();
    f.repo.setNodeEnvVar(f.node.id, "CLAUDE_CONFIG_DIR", source);
    return f;
  }

  it("is true only when the target's projects/ reaches the SAME transcript file (a shared projects dir)", () => {
    const { source, target } = roots();
    const { node, hooks } = seatOn(source);
    fs.symlinkSync(path.join(source, "projects"), path.join(target, "projects"));
    expect(hooks.canResumeInConfigDir!(node.id, target, TOKEN)).toBe(true);
  });

  it("is false for a separate copy of the same transcript: it would diverge while the seat runs", () => {
    const { source, target } = roots();
    const { node, hooks } = seatOn(source);
    fs.mkdirSync(path.join(target, "projects", "-work"), { recursive: true });
    fs.copyFileSync(path.join(source, "projects", "-work", `${TOKEN}.jsonl`), path.join(target, "projects", "-work", `${TOKEN}.jsonl`));
    expect(hooks.canResumeInConfigDir!(node.id, target, TOKEN)).toBe(false);   // RED if file equality were enough
  });

  it("is false when the target has no projects/, and for a missing, blank or malformed conversation id", () => {
    const { source, target } = roots();
    const { node, hooks } = seatOn(source);
    expect(hooks.canResumeInConfigDir!(node.id, target, TOKEN)).toBe(false);
    fs.symlinkSync(path.join(source, "projects"), path.join(target, "projects"));
    for (const bad of [null, "", "   ", "not-a-uuid", `${TOKEN}/../x`]) expect(hooks.canResumeInConfigDir!(node.id, target, bad)).toBe(false);
    // a token that walks out of the project folder and lands on the real transcript must not pass as the conversation id
    expect(hooks.canResumeInConfigDir!(node.id, target, `../-work/${TOKEN}`)).toBe(false);
  });

  it("measures from the seat's CURRENT config root, not from the target", () => {
    const { source, target } = roots();
    const { node, hooks } = seatOn(source);
    fs.symlinkSync(path.join(source, "projects"), path.join(target, "projects"));
    expect(hooks.canResumeInConfigDir!(node.id, target, TOKEN)).toBe(true);
    const { repo, node: other, hooks: otherHooks } = fixture();
    repo.setNodeEnvVar(other.id, "CLAUDE_CONFIG_DIR", target);   // a seat already on the target, moving to the source
    expect(otherHooks.canResumeInConfigDir!(other.id, source, TOKEN)).toBe(true);
    const lonely = fs.mkdtempSync(path.join(os.tmpdir(), "p28-lonely-")); cleanup.push(() => fs.rmSync(lonely, { recursive: true, force: true }));
    expect(otherHooks.canResumeInConfigDir!(other.id, lonely, TOKEN)).toBe(false);
  });
});
