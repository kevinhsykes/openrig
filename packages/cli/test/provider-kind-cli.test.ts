// P1 (fork/p1-provider-kind-open) — the CLI's --provider validation against the provider-kind
// registry (no hard-coded pair). NOTE for runners: cli src imports @openrig/daemon/provider-types
// (runtime), so this suite needs the daemon package built first (T2 gate step 1:
// `npm run build -w packages/daemon`), like every other CLI suite that crosses that seam.
import { describe, it, expect, vi } from "vitest";
import { providerCommand } from "../src/commands/provider.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}
function runningState(port: number): DaemonState {
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" };
}
// The daemon answers as RUNNING, so the only path to clientFactory is a PASSED validation: if an
// unknown kind ever got past it, the spy call fails the test before any HTTP leaves the process.
function runningDeps(port: number, client: DaemonClient): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: vi.fn(() => client),
  };
}
// Deps whose daemon status reads as running and whose clientFactory fails the test if reached:
// a rejected --provider must be refused BEFORE any daemon contact.
function strictDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(runningState(port)) : null)),
    },
    clientFactory: vi.fn(() => {
      throw new Error("clientFactory must not be reached for an unknown --provider");
    }),
  };
}

async function run(args: string[], deps: StatusDeps): Promise<{ logs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const origLog = console.log, origErr = console.error, origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    await providerCommand(deps).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { logs, exitCode };
}

describe("rig provider --provider validates against the provider-kind registry", () => {
  it("status --provider <unknown> is refused before any daemon contact, naming the known list", async () => {
    const deps = strictDeps(59901);
    const { logs, exitCode } = await run(["status", "--provider", "zai"], deps);
    expect(exitCode).toBe(1);
    expect(logs.join(" ")).toMatch(/--provider must be a known provider kind/);
    expect(logs.join(" ")).toContain("codex, claude");
    expect(logs.join(" ")).toContain("got zai");
    expect(deps.clientFactory).not.toHaveBeenCalled();
  });

  it("the registry is case-sensitive: --provider Claude is refused like any unknown kind", async () => {
    const { logs, exitCode } = await run(["status", "--provider", "Claude"], strictDeps(59902));
    expect(exitCode).toBe(1);
    expect(logs.join(" ")).toMatch(/--provider must be a known provider kind/);
  });

  it("a known kind passes validation and the status read proceeds", async () => {
    const FOUR_BLOCK = { accounts: [], bindings: [], signals: [], asOf: "2026-08-03T12:00:00.000Z" };
    const client = { get: vi.fn(async () => ({ status: 200, data: FOUR_BLOCK })) } as unknown as DaemonClient;
    const deps = runningDeps(59903, client);
    const { logs, exitCode } = await run(["status", "--provider", "claude", "--json"], deps);
    expect(exitCode).toBeUndefined();
    expect(deps.clientFactory).toHaveBeenCalledTimes(1);
    expect((client.get as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("/api/provider/status");
    expect(logs.join(" ")).toContain(JSON.stringify(FOUR_BLOCK));
  });
});
