import { afterEach, describe, expect, it } from "vitest";
import { RigRepository } from "../src/domain/rig-repository.js";
import { seatRuntimeHome, claudeConfigRootFor } from "../src/domain/seat-runtime-home.js";
import { createFullTestDb } from "./helpers/test-app.js";

// A seat's own CLAUDE_CONFIG_DIR lives in its member `env:` (nodes.env_json), the one place launch, restore and handover read
// through getEffectiveSeatEnv. `setNodeEnvVar` writes one variable there and leaves the rest, so moving a seat between accounts
// doesn't disturb its other declared env, and a rig-level value of the same name is only shadowed, never rewritten.

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

function fixture() {
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const repo = new RigRepository(db);
  const rig = repo.createRig("env-rig");
  const node = repo.addNode(rig.id, "owner", { runtime: "claude-code", env: { KEEP_ME: "1" } });
  return { db, repo, rig, node };
}

describe("RigRepository.setNodeEnvVar", () => {
  it("sets one variable in the member's env, keeping the others, and the seat's launch reads it", () => {
    const { db, repo, node } = fixture();
    expect(repo.setNodeEnvVar(node.id, "CLAUDE_CONFIG_DIR", "/home/test/.claude-max")).toBe(true);
    expect(repo.getEffectiveSeatEnv(node.id)).toEqual({ KEEP_ME: "1", CLAUDE_CONFIG_DIR: "/home/test/.claude-max" });
    expect(seatRuntimeHome(db, node.id, "claude-code")).toEqual({ home: "/home/test/.claude-max", source: "member" });
    expect(claudeConfigRootFor(db, node.id, {}, "/home/test")).toBe("/home/test/.claude-max");
  });

  it("replaces a value and removes it with null; the other variables stay, and an empty env is stored as none", () => {
    const { repo, node } = fixture();
    repo.setNodeEnvVar(node.id, "CLAUDE_CONFIG_DIR", "/a");
    repo.setNodeEnvVar(node.id, "CLAUDE_CONFIG_DIR", "/b");
    expect(repo.getEffectiveSeatEnv(node.id)).toEqual({ KEEP_ME: "1", CLAUDE_CONFIG_DIR: "/b" });
    expect(repo.setNodeEnvVar(node.id, "CLAUDE_CONFIG_DIR", null)).toBe(true);
    expect(repo.getEffectiveSeatEnv(node.id)).toEqual({ KEEP_ME: "1" });
    expect(repo.setNodeEnvVar(node.id, "KEEP_ME", null)).toBe(true);
    expect(repo.getEffectiveSeatEnv(node.id)).toEqual({});
  });

  it("shadows a rig-level value without rewriting it, and removing the member's value brings the rig's back", () => {
    const { db, repo, rig, node } = fixture();
    repo.setRigEnv(rig.id, { CLAUDE_CONFIG_DIR: "/rig/level" });
    repo.setNodeEnvVar(node.id, "CLAUDE_CONFIG_DIR", "/member/level");
    expect(repo.getEffectiveSeatEnv(node.id).CLAUDE_CONFIG_DIR).toBe("/member/level");
    expect(repo.getRigEnv(rig.id)).toEqual({ CLAUDE_CONFIG_DIR: "/rig/level" });
    repo.setNodeEnvVar(node.id, "CLAUDE_CONFIG_DIR", null);
    expect(seatRuntimeHome(db, node.id, "claude-code")).toEqual({ home: "/rig/level", source: "rig" });
  });

  it("refuses an unknown seat, a reserved or malformed name, and an empty or NUL value, changing nothing", () => {
    const { repo, node } = fixture();
    expect(repo.setNodeEnvVar("no-such-node", "CLAUDE_CONFIG_DIR", "/a")).toBe(false);
    expect(repo.setNodeEnvVar(node.id, "OPENRIG_SOMETHING", "/a")).toBe(false);
    expect(repo.setNodeEnvVar(node.id, "lower-case", "/a")).toBe(false);
    expect(repo.setNodeEnvVar(node.id, "CLAUDE_CONFIG_DIR", "")).toBe(false);
    expect(repo.setNodeEnvVar(node.id, "CLAUDE_CONFIG_DIR", "/a\0b")).toBe(false);
    expect(repo.getEffectiveSeatEnv(node.id)).toEqual({ KEEP_ME: "1" });
  });
});
