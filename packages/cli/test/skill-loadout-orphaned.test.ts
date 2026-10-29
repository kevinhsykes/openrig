// P37b: `rig skill loadout` reports kept selections whose owner seat is not live, and `--release-orphaned` drops them (explicit,
// needs the daemon's answer, never touches a live owner). Folder mode only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillCommand } from "../src/commands/skill.js";
import { reconcileSkillLoadout, resolvePluginSkills } from "../../daemon/src/domain/skill-catalog.js";

function makeDeps(answer: { status: number; data: unknown } | "down") {
  const client = { get: vi.fn(async () => { if (answer === "down") throw new Error("connection refused"); return answer; }), post: vi.fn() };
  return {
    client,
    deps: {
      lifecycleDeps: {
        spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: answer !== "down" })), kill: vi.fn(() => true),
        readFile: vi.fn(() => JSON.stringify({ pid: 1, port: 3000, db: "t.sqlite", startedAt: new Date().toISOString() })),
        writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => true), mkdirp: vi.fn(), openForAppend: vi.fn(() => 1), isProcessAlive: vi.fn(() => answer !== "down"),
      },
      clientFactory: () => client,
    },
  };
}

describe("rig skill loadout: orphaned owners (P37b)", () => {
  let root: string; let project: string; let plugin: string; let logs: string[]; let errors: string[];
  const manifestPath = () => join(project, ".openrig", "skill-loadouts", "claude-code.json");
  const manifest = () => JSON.parse(readFileSync(manifestPath(), "utf8")) as { topologySelections: Record<string, string[]>; releases?: Array<Record<string, unknown>> };
  const copy = () => readFileSync(join(project, ".claude", "skills", "queue-handoff", "SKILL.md"), "utf8");
  const run = async (answer: { status: number; data: unknown } | "down", ...flags: string[]) => {
    const { deps, client } = makeDeps(answer);
    await skillCommand(deps as never).parseAsync(["node", "rig", "loadout", "--runtime", "claude-code", "--cwd", project, ...flags]);
    return client;
  };
  const owners = (state: "orphaned" | "live", reason = "no node named seat-a@fleet in any rig") =>
    ({ status: 200, data: { owners: { "seat-a@fleet": state === "live" ? { state } : { state, reason } } } });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-orphan-cli-")); project = join(root, "project"); plugin = join(root, "plugins", "core");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "core", version: "1.0.0", skills: "./skills" }));
    mkdirSync(join(plugin, "skills", "queue-handoff"), { recursive: true });
    writeFileSync(join(plugin, "skills", "queue-handoff", "SKILL.md"), "---\nname: queue-handoff\ndescription: Use when testing.\n---\n\n# old\n");
    const entries = resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code" }).entries;
    const loadout = { catalogRoot: join(root, "none"), catalogRevision: null, catalogDigest: null, projectSelectionDeclared: false, projectSelection: [], entries };
    expect(reconcileSkillLoadout({ loadout, runtime: "claude-code", cwd: project, topologyOwner: "seat-a@fleet", apply: true }).ok).toBe(true);
    // the plugin is refreshed after the owner projected it
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "core", version: "2.0.0", skills: "./skills" }));
    writeFileSync(join(plugin, "skills", "queue-handoff", "SKILL.md"), "---\nname: queue-handoff\ndescription: Use when testing.\n---\n\n# newer plugin bytes\n");
    logs = []; errors = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    process.exitCode = undefined;
  });
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; rmSync(root, { recursive: true, force: true }); });

  it("asks the daemon about the owners in the manifest and reports an orphan, writing nothing", async () => {
    const client = await run(owners("orphaned"));
    expect(client.get).toHaveBeenCalledWith("/api/skills/owners?owner=seat-a%40fleet");
    expect(logs.some((l) => l.startsWith("orphaned    seat-a@fleet: no node named seat-a@fleet in any rig; 1 kept skill") && l.includes("--release-orphaned"))).toBe(true);
    expect(copy()).toContain("# old");
    expect(manifest().topologySelections["seat-a@fleet"]).toEqual(["queue-handoff"]);
  });

  it("--json carries orphanedOwners in the projection", async () => {
    await run(owners("orphaned"), "--json");
    const out = JSON.parse(logs.join("\n"));
    expect(out.projection.orphanedOwners).toEqual([{ owner: "seat-a@fleet", reason: "no node named seat-a@fleet in any rig", skills: ["queue-handoff"] }]);
  });

  it("--release-orphaned without --apply is a plan: it says what would be released and changes nothing", async () => {
    await run(owners("orphaned"), "--release-orphaned");
    expect(logs.some((l) => l.startsWith("would release seat-a@fleet: 1 skill"))).toBe(true);
    expect(copy()).toContain("# old");
    expect(manifest().releases).toBeUndefined();
  });

  it("--release-orphaned --apply drops the owner, refreshes the copy and records who released it", async () => {
    process.env["OPENRIG_SESSION_NAME"] = "lead-lead@openrig-fork";
    try { await run(owners("orphaned"), "--release-orphaned", "--apply"); } finally { delete process.env["OPENRIG_SESSION_NAME"]; }
    expect(copy()).toContain("# newer plugin bytes");
    expect(manifest().topologySelections["seat-a@fleet"]).toBeUndefined();
    expect(manifest().releases).toEqual([expect.objectContaining({ owner: "seat-a@fleet", skills: ["queue-handoff"], by: "lead-lead@openrig-fork" })]);
    expect(logs.some((l) => l.startsWith("released    seat-a@fleet"))).toBe(true);
  });

  it("a live owner is never released, flag or not", async () => {
    await run(owners("live"), "--release-orphaned", "--apply");
    expect(manifest().topologySelections["seat-a@fleet"]).toEqual(["queue-handoff"]);
    expect(copy()).toContain("# old");
    expect(logs.some((l) => l.startsWith("orphaned") || l.includes("released"))).toBe(false);
  });

  it("--release-orphaned with the daemon unreachable refuses by name and changes nothing; without the flag the loadout still reports", async () => {
    await run("down", "--release-orphaned", "--apply");
    expect(errors.join("\n")).toMatch(/release_unavailable/);
    expect(process.exitCode).toBe(1);
    expect(manifest().topologySelections["seat-a@fleet"]).toEqual(["queue-handoff"]);
    process.exitCode = undefined; errors.length = 0;
    await run("down");
    expect(errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("a folder with no kept owners never asks the daemon", async () => {
    rmSync(manifestPath());
    const client = await run(owners("orphaned"));
    expect(client.get).not.toHaveBeenCalled();
  });
});
