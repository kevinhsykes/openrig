import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { seatCommand, type SeatDeps } from "../src/commands/seat.js";
import { Command } from "commander";

/**
 * P20/R6h §5.3c — `rig seat stop --expect-generation <uuid>`. The CLI trusts a generation-scoped
 * stop only when the daemon advertises generation keying (preflight: the stop-precondition tuple
 * carries the occupantGeneration KEY, contract seat-stop.v2) and only when the ok answer ECHOES
 * the generation it enforced. A daemon that predates the field gets nothing sent; an ok answer
 * without the echo is treated as NOT generation-enforced and surfaced (the stop itself is real).
 */

vi.mock("../src/daemon-lifecycle.js", () => ({
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  daemonStatusGuard: vi.fn((status: unknown) => Boolean(status)),
}));

const SEAT = "dev-a@rig";
const TUPLE = {
  contract: "seat-stop.v2",
  expected: { nodeId: "node-1", sessionId: "session-1", occupantGeneration: "11111111-2222-4333-8444-555555555555" },
};

let logs: string[];
let errors: string[];
let gets: string[];
let posts: Array<{ path: string; body: Record<string, unknown> }>;

function cli(preconditionAnswer: { status: number; data: unknown }, stopAnswer: { status: number; data: unknown }) {
  const deps = {
    lifecycleDeps: {} as SeatDeps["lifecycleDeps"],
    clientFactory: () => ({
      get: vi.fn(async (path: string) => { gets.push(path); return preconditionAnswer; }),
      post: vi.fn(async (path: string, body: Record<string, unknown>) => { posts.push({ path, body }); return stopAnswer; }),
    }),
  } as unknown as SeatDeps;
  const program = new Command().exitOverride().addCommand(seatCommand(deps));
  return program.parseAsync(["node", "rig", "seat", "stop", SEAT, "--reason", "p20", "--expect-generation", "99999999-8888-4777-8666-555555555555", "--json"]);
}

describe("rig seat stop --expect-generation (§5.3c capability echo)", () => {
  beforeEach(() => {
    logs = []; errors = []; gets = []; posts = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    process.exitCode = undefined;
  });
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

  it("sends the pair and treats an echoed generation as enforced", async () => {
    await cli({ status: 200, data: TUPLE }, { status: 200, data: { ok: true, sessionName: SEAT, sessionId: "session-1", enforcedOccupantGeneration: "11111111-2222-4333-8444-555555555555", seat: { logicalId: "dev-a", rigName: "rig" } } });
    expect(gets).toEqual([`/api/seat/stop-precondition/${encodeURIComponent(SEAT)}`]);
    expect(posts[0]!.body.expected).toEqual({ nodeId: "node-1", sessionId: "session-1", occupantGeneration: "99999999-8888-4777-8666-555555555555" });
    expect(process.exitCode).toBeUndefined();
    expect(errors.join("\n")).toBe("");
  });

  it("an older daemon (no occupantGeneration key in the tuple) gets nothing sent", async () => {
    await cli({ status: 200, data: { contract: "seat-stop.v1", expected: { nodeId: "node-1", sessionId: "session-1" } } }, { status: 200, data: { ok: true } });
    expect(posts).toEqual([]);
    expect(errors.join("\n")).toContain("expect_generation_unsupported");
    expect(errors.join("\n")).toContain("Nothing was sent");
    expect(process.exitCode).toBe(1);
  });

  it("an ok answer without the echo is surfaced as NOT generation-enforced", async () => {
    await cli({ status: 200, data: TUPLE }, { status: 200, data: { ok: true, sessionName: SEAT, sessionId: "session-1", seat: { logicalId: "dev-a", rigName: "rig" } } });
    expect(posts).toHaveLength(1); // the stop happened and is reported
    expect(errors.join("\n")).toContain("expect_generation_unsupported");
    expect(errors.join("\n")).toContain("NOT enforced");
    expect(process.exitCode).toBe(1);
  });

  it("a malformed uuid is refused locally before anything is sent", async () => {
    const deps = {
      lifecycleDeps: {} as SeatDeps["lifecycleDeps"],
      clientFactory: () => ({ get: vi.fn(), post: vi.fn() }),
    } as unknown as SeatDeps;
    const program = new Command().exitOverride().addCommand(seatCommand(deps));
    await program.parseAsync(["node", "rig", "seat", "stop", SEAT, "--reason", "p20", "--expect-generation", "not-a-uuid", "--json"]);
    expect(gets).toEqual([]);
    expect(errors.join("\n")).toContain("Nothing was sent");
    expect(process.exitCode).toBe(1);
  });

  it("a daemon refusal passes through with its code and a non-zero exit", async () => {
    await cli({ status: 200, data: TUPLE }, { status: 409, data: { ok: false, code: "generation_not_settled", message: "still draining" } });
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ ok: false, code: "generation_not_settled" });
    expect(process.exitCode).toBe(1);
  });
});
