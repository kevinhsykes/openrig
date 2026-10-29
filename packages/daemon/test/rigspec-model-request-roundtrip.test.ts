import { describe, it, expect, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator, RigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RigSpec, LegacyRigSpec } from "../src/domain/types.js";

/**
 * P25 slice 2c: a rail request survives serialize/parse and export (the request, never the id it resolved to), and until a launch
 * resolves requests, every creation path refuses one by name and creates nothing, instead of launching a profile's default model.
 */
const ROOT = "/project/rigs/my-rig";
const tmux = () => ({
  createSession: vi.fn(async () => ({ ok: true as const })), killSession: vi.fn(async () => ({ ok: true as const })),
  sendText: vi.fn(async () => ({ ok: true as const })), hasSession: vi.fn(async () => true), listSessions: vi.fn(async () => []),
  listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []), sendKeys: vi.fn(async () => ({ ok: true as const })),
}) as unknown as TmuxAdapter;
const adapter = (runtime: string): RuntimeAdapter => ({
  runtime, listInstalled: vi.fn(async () => []), project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
  deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })), checkReady: vi.fn(async () => ({ ready: true })), launchHarness: vi.fn(async () => ({ ok: true })),
}) as unknown as RuntimeAdapter;
const files: Record<string, string> = { [`${ROOT}/agents/impl/agent.yaml`]: 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []' };
const fsOps: AgentResolverFsOps = { readFile: (p) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); }, exists: (p) => p in files };
const spec = (member: Record<string, unknown>): RigSpec => ({
  version: "0.2", name: "rail-rig",
  pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", ...member }], edges: [] }],
  edges: [],
} as unknown as RigSpec);

function world() {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const t = tmux();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: t });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: t, sleep: async () => {} });
  const pod = new PodRigInstantiator({ db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator, fsOps,
    adapters: { "claude-code": adapter("claude-code"), terminal: adapter("terminal") }, tmuxAdapter: t } as never);
  (t as unknown as { hasSession: unknown }).hasSession = vi.fn(async () => false);   // the legacy preflight wants a free session name
  const preflight = new RigSpecPreflight({ rigRepo, tmuxAdapter: t, exec: async () => "", cmuxExec: async () => "" });
  const legacy = new RigInstantiator({ db, rigRepo, sessionRegistry, eventBus, nodeLauncher, preflight });
  return { db, rigRepo, podRepo, sessionRegistry, pod, legacy };
}
const nodeCount = (db: ReturnType<typeof createFullTestDb>) => (db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;

describe("rail model request: round trip and fail-closed creation (P25)", () => {
  it("serialize then parse keeps the request and no literal model", () => {
    const text = RigSpecCodec.serialize(spec({ modelRequest: "rail:minimax" }));
    expect(text).toContain("rail:minimax");
    const back = RigSpecSchema.normalize(RigSpecCodec.parse(text) as Record<string, unknown>);
    expect(back.pods[0]!.members[0]!.modelRequest).toBe("rail:minimax");
    expect(back.pods[0]!.members[0]!.model).toBeUndefined();
  });

  it("a literal model serializes exactly as before", () => {
    const text = RigSpecCodec.serialize(spec({ model: "opus" }));
    expect(text).toContain("model: opus");
    expect(text).not.toContain("rail:");
  });

  it("the exporter writes the request a seat holds, not the model it last resolved to", () => {
    const w = world();
    const rig = w.rigRepo.createRig("exp");
    w.rigRepo.addNode(rig.id, "dev.impl", { runtime: "pi", modelRequest: "rail:minimax" });
    const node = w.rigRepo.getRig(rig.id)!.nodes[0]!;
    expect(w.rigRepo.setNodeModelResolution(node.id, "minimax/MiniMax-M3", "{}")).toBe(true);
    const out = new RigSpecExporter({ rigRepo: w.rigRepo, sessionRegistry: w.sessionRegistry, podRepo: w.podRepo }).exportRig(rig.id) as LegacyRigSpec;
    expect(out.nodes[0]!.modelRequest).toBe("rail:minimax");
    expect(out.nodes[0]!.model).toBeUndefined();
    w.db.close();
  });

  it("the pod-aware path refuses a member that asks for a rail, by name, and creates no node", async () => {
    const w = world();
    const result = await w.pod.instantiate(RigSpecCodec.serialize(spec({ modelRequest: "rail:minimax" })), ROOT);
    const text = JSON.stringify(result);
    expect(text).toContain("asks for its model by rail (rail:minimax)");
    expect(text).toContain("Nothing was created");
    expect(nodeCount(w.db)).toBe(0);
    w.db.close();
  });

  it("the pod-aware path still instantiates a literal model", async () => {
    const w = world();
    const result = await w.pod.instantiate(RigSpecCodec.serialize(spec({ model: "opus" })), ROOT);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(nodeCount(w.db)).toBe(1);
    w.db.close();
  });

  it("the legacy path refuses a node that asks for a rail and creates no node", async () => {
    const w = world();
    const legacySpec = { schemaVersion: 1, version: "1.0.0", name: "legacy-rail", nodes: [{ id: "a", runtime: "claude-code", cwd: "/", modelRequest: "rail:zai" }], edges: [] } as unknown as LegacyRigSpec;
    const result = await w.legacy.instantiate(legacySpec);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("asks for its model by rail (rail:zai)");
    expect(nodeCount(w.db)).toBe(0);
    w.db.close();
  });
});
