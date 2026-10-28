import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { psCommand, type PsDeps } from "../src/commands/ps.js";
import type { DaemonClient, DaemonResponse } from "../src/client.js";

/**
 * P31: `rig ps --all-hosts` meets both an ssh entry (a terminal tile) and an http entry (the fan-out target) for one machine.
 * The ssh entry is a note, not a FAILED line, and does not turn the exit code to 3. An http entry that does not answer still
 * fails loudly, and naming the ssh entry with --hosts is still a failure (the person asked for a fan-out it cannot do).
 */

const okClient = (status = 200): DaemonClient => ({
  baseUrl: "http://remote:7433",
  get: async <T>() => ({ status, data: (status === 200 ? [{ rigId: "r1", name: "remote-rig" }] : { error: "down" }) as T }) as DaemonResponse<T>,
  post: async () => ({ status: 200, data: {} }) as DaemonResponse<unknown>,
}) as unknown as DaemonClient;

const HOSTS = [
  { id: "corsair-2500x", transport: "ssh", target: "corsair.local" },
  { id: "corsair-http", transport: "http", url: "http://c", bearer_env: "TOK_C" },
];
const deps = (hosts: Array<Record<string, unknown>>, status = 200): PsDeps => ({
  lifecycleDeps: {} as PsDeps["lifecycleDeps"],
  clientFactory: () => okClient(status),
  hostRegistryLoader: () => ({ ok: true as const, registry: { hosts } }),
});

async function run(d: PsDeps, args: string[]): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try {
    const prog = new Command(); prog.exitOverride(); prog.addCommand(psCommand(d));
    await prog.parseAsync(["node", "rig", "ps", ...args]);
  } catch { /* exit override */ } finally { console.log = log; }
  return out.join("\n");
}

afterEach(() => { vi.unstubAllEnvs(); process.exitCode = undefined; });

describe("rig ps --all-hosts and ssh entries (P31)", () => {
  it("an ssh entry is a one-line skip note naming the http entry, not FAILED, and the exit code stays 0", async () => {
    vi.stubEnv("TOK_C", "t");
    const text = await run(deps(HOSTS), ["--all-hosts"]);
    expect(text).toContain("[host=corsair-2500x] skipped: ssh entry for terminal tiles; fan-out uses corsair-http");
    expect(text).not.toContain("FAILED");
    expect(process.exitCode).toBeUndefined();
  });

  it("--json keeps the ssh host in hosts[] (nothing silently absent) and still exits 0", async () => {
    vi.stubEnv("TOK_C", "t");
    const parsed = JSON.parse(await run(deps(HOSTS), ["--all-hosts", "--json"]));
    const byId = Object.fromEntries(parsed.hosts.map((h: { hostId: string; status: string }) => [h.hostId, h.status]));
    expect(byId).toEqual({ "corsair-2500x": "unsupported-transport", "corsair-http": "ok" });
    expect(parsed.hosts.find((h: { hostId: string }) => h.hostId === "corsair-2500x").error).toContain("skipped: ssh entry");
    expect(process.exitCode).toBeUndefined();
  });

  it("an http entry that does not answer still FAILS loudly (exit 3) next to a skipped ssh entry", async () => {
    vi.stubEnv("TOK_C", "t");
    const text = await run(deps(HOSTS, 503), ["--all-hosts"]);
    expect(text).toContain("[host=corsair-http] FAILED");
    expect(text).toContain("[host=corsair-2500x] skipped");
    expect(process.exitCode).toBe(3);
  });

  it("an http entry with no bearer still fails (exit 3)", async () => {
    delete process.env.TOK_C;
    await run(deps(HOSTS), ["--all-hosts"]);
    expect(process.exitCode).toBe(3);
  });

  it("naming the ssh entry with --hosts is still a failure: the person asked for a fan-out it cannot do", async () => {
    vi.stubEnv("TOK_C", "t");
    const text = await run(deps(HOSTS), ["--hosts", "corsair-2500x"]);
    expect(text).toContain("FAILED (unsupported-transport)");
    expect(process.exitCode).toBe(3);
  });

  it("with no http entry declared the note says so", async () => {
    const text = await run(deps([HOSTS[0]!]), ["--all-hosts"]);
    expect(text).toContain("fan-out uses an http entry (none declared)");
    expect(process.exitCode).toBeUndefined();
  });
});
