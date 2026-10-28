// P1 (fork/p1-provider-kind-open), as changed by P4 — the CLI's --provider handling. The CLI keeps no list of known kinds: it passes the
// kind to the daemon, which owns the live list (built-ins plus rails registered at load).
import { describe, it, expect, vi } from "vitest";
import { providerCommand } from "../src/commands/provider.js";
import { DaemonClient } from "../src/client.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";
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
function runningDeps(port: number, client: DaemonClient): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: vi.fn(() => client),
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

describe("rig provider --provider is passed to the daemon, which owns the list of known kinds", () => {
  // P4 (amendment F3): the CLI runs in its own process and can't see the rails a daemon registered at load, so it keeps no list of its own.
  // It forwards --provider exactly as given and prints the daemon's refusal, which names the daemon's live known list.
  const FOUR_BLOCK = { accounts: [], bindings: [], signals: [], asOf: "2026-08-03T12:00:00.000Z" };

  it("status --refresh --provider <kind> forwards the kind exactly as given, and prints the daemon's refusal naming its live list", async () => {
    const refusal = { status: 400, data: { error: "usage windows can be refreshed for codex, claude, zai (got nope)" } };
    const client = { post: vi.fn(async () => refusal), get: vi.fn(async () => ({ status: 200, data: FOUR_BLOCK })) } as unknown as DaemonClient;
    const deps = runningDeps(59901, client);
    const { logs, exitCode } = await run(["status", "--refresh", "--provider", "nope"], deps);
    expect((client.post as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["/api/provider/usage/refresh", { provider: "nope" }, { timeoutMs: 60_000 }]);
    expect(logs.join(" ")).toContain("codex, claude, zai");
    expect(exitCode).toBe(1);
    expect(deps.clientFactory).toHaveBeenCalledTimes(1);
  });

  it("a rail the daemon registered is accepted with no list on this side, and the kind is case-sensitive only at the daemon", async () => {
    const ok = { status: 200, data: { refresh: { at: "2026-08-03T12:00:00.000Z", outcome: "ok", coalesced: false } } };
    const client = { post: vi.fn(async () => ok), get: vi.fn(async () => ({ status: 200, data: FOUR_BLOCK })) } as unknown as DaemonClient;
    const { exitCode } = await run(["status", "--refresh", "--provider", "zai", "--json"], runningDeps(59902, client));
    expect(exitCode).toBeUndefined();
    expect((client.post as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual({ provider: "zai" });
    await run(["status", "--refresh", "--provider", "Claude", "--json"], runningDeps(59904, client));
    expect((client.post as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toEqual({ provider: "Claude" });
  });

  it("the block filters pass --provider to the daemon too", async () => {
    const client = { get: vi.fn(async () => ({ status: 200, data: { accounts: [] } })) } as unknown as DaemonClient;
    await run(["accounts", "--provider", "zai", "--json"], runningDeps(59905, client));
    expect((client.get as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("/api/provider/accounts?provider=zai");
  });

  it("the default refresh fan-out stays codex and claude", async () => {
    const ok = { status: 200, data: { refresh: { at: "2026-08-03T12:00:00.000Z", outcome: "ok", coalesced: false } } };
    const client = { post: vi.fn(async () => ok), get: vi.fn(async () => ({ status: 200, data: FOUR_BLOCK })) } as unknown as DaemonClient;
    await run(["status", "--refresh", "--json"], runningDeps(59906, client));
    expect((client.post as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { provider: string }).provider)).toEqual(["codex", "claude"]);
  });

  it("a built-in kind and the status read proceed as before", async () => {
    const client = { get: vi.fn(async () => ({ status: 200, data: FOUR_BLOCK })) } as unknown as DaemonClient;
    const deps = runningDeps(59903, client);
    const { logs, exitCode } = await run(["status", "--provider", "claude", "--json"], deps);
    expect(exitCode).toBeUndefined();
    expect(deps.clientFactory).toHaveBeenCalledTimes(1);
    expect((client.get as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("/api/provider/status");
    expect(logs.join(" ")).toContain(JSON.stringify(FOUR_BLOCK));
  });
});
