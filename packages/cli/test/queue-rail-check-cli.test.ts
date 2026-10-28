import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";

/**
 * P29, CLI half: the daemon's destination rail check answers with an advisory (the row was still written). The CLI puts it on
 * stderr, never in the result, and `--allow-exhausted-destination` is the per-request override that rides the request only when
 * asked for. Covers create, handoff, handoff-and-complete and fallback, the four paths that pick a destination.
 */

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

type Answer = { status: number; data: unknown };
const ID = "qitem-20261028120000-bbbbbbbbbbbbbbbb";
const row = (over: Record<string, unknown> = {}) => ({ qitemId: ID, state: "pending", sourceSession: "worker@r", destinationSession: "owner@r", body: "b", summary: "s", tags: null, ...over });
const advisory = (over: Record<string, unknown> = {}) => ({ code: "destination_rail_unavailable", destinationSession: "owner@r", exitCode: 3, overridden: false, message: "owner@r: rail EXHAUSTED, resets 2026-11-03", ...over });

let logs: string[];
let errors: string[];
let posted: Array<{ path: string; body: Record<string, unknown> }>;

async function run(argv: string[], answer: Answer): Promise<void> {
  const deps: QueueDeps = {
    lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
    clientFactory: () => ({
      get: vi.fn(async () => ({ status: 200, data: row() })),
      post: vi.fn(async (path: string, body: Record<string, unknown>) => { posted.push({ path, body }); return answer; }),
    }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
  };
  const program = createProgram({ queueDeps: deps });
  program.exitOverride();
  await program.parseAsync(["node", "rig", "queue", ...argv]);
}
const create = (extra: string[], answer: Answer) => run(["create", "--destination", "owner@r", "--body", "b", "--summary", "s", "--id", ID, "--json", ...extra], answer);
const handoff = (extra: string[], answer: Answer) => run(["handoff", ID, "--to", "owner@r", "--body", "b", "--summary", "s", "--json", ...extra], answer);
const handoffAndComplete = (extra: string[], answer: Answer) => run(["handoff-and-complete", ID, "--to", "owner@r", "--body", "b", "--summary", "s", "--json", ...extra], answer);
const fallback = (extra: string[], answer: Answer) => run(["fallback", ID, "--destination", "owner@r", "--json", ...extra], answer);
const warnings = () => errors.filter((e) => e.startsWith("Warning: the destination's rail"));

describe("rig queue: the destination rail check (P29)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENRIG_SESSION_NAME", "worker@r");
    logs = []; errors = []; posted = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

  describe.each([
    ["create", create, 201, (a: object) => row({ advisories: [a] })],
    ["handoff", handoff, 201, (a: object) => ({ closed: row({ state: "handed-off" }), created: row(), advisories: [a] })],
    ["handoff-and-complete", handoffAndComplete, 201, (a: object) => ({ closed: row({ state: "done" }), created: row(), advisories: [a] })],
    ["fallback", fallback, 200, (a: object) => row({ advisories: [a] })],
  ] as const)("%s", (_name, send, status, body) => {
    it("prints the warning on stderr and leaves the result and the exit code alone", async () => {
      await send([], { status, data: body(advisory()) });
      expect(warnings()).toEqual([expect.stringContaining("owner@r: rail EXHAUSTED, resets 2026-11-03")]);
      expect(logs.join("\n")).not.toContain("Warning");
      expect(process.exitCode).toBeUndefined();
    });

    it("prints nothing when the daemon sent no advisory", async () => {
      await send([], { status, data: _name === "create" || _name === "fallback" ? row() : { closed: row(), created: row() } });
      expect(warnings()).toEqual([]);
    });

    it("says an overridden send went anyway", async () => {
      await send(["--allow-exhausted-destination"], { status, data: body(advisory({ overridden: true })) });
      expect(warnings()[0]).toContain("sent anyway: --allow-exhausted-destination");
    });

    it("sends allowExhaustedDestination only when asked for", async () => {
      await send(["--allow-exhausted-destination"], { status, data: body(advisory()) });
      expect(posted[0]!.body["allowExhaustedDestination"]).toBe(true);
      posted = [];
      await send([], { status, data: body(advisory()) });
      expect("allowExhaustedDestination" in posted[0]!.body).toBe(false);
    });

    it("strips control bytes from the daemon's message before it reaches the terminal", async () => {
      await send([], { status, data: body(advisory({ message: "owner@r: \x1b[31mEXHAUSTED\x07\x9b" })) });
      expect(warnings()[0]).not.toMatch(/\x1b|\x07|\x9b/);
      expect(warnings()[0]).toContain("EXHAUSTED");
    });

    it("a daemon refusal (409) prints no 'warning' and is a failure", async () => {
      await send([], { status: 409, data: { error: "destination_rail_exhausted", destinationSession: "owner@r", message: "owner@r: rail EXHAUSTED", hint: "repeat with allowExhaustedDestination: true" } });
      expect(warnings()).toEqual([]);
      expect(process.exitCode).toBeTruthy();
      expect(`${logs.join("\n")}\n${errors.join("\n")}`).toContain("destination_rail_exhausted");
    });
  });
});
