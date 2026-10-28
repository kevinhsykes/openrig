import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { QueueDeps } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";

/**
 * `rig queue create --dedupe-key <key>` (D4222). The daemon keeps at most one OPEN row per destination and key. A daemon
 * that predates the field drops it and answers as if it had been kept, so the CLI trusts the key only when the answer
 * echoes it. The pins: the field rides the request only when asked for; a hit is announced and is not an error; a missing
 * or different echo is an error that names the row already written; a refusal prints as every other refusal does.
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
const REQUEST_ID = "qitem-20261028120000-aaaaaaaaaaaaaaaa";
const row = (over: Record<string, unknown> = {}) => ({
  qitemId: REQUEST_ID, state: "pending", sourceSession: "worker@r", destinationSession: "owner@r", body: "alarm",
  summary: "s", tags: null, ...over,
});

let logs: string[];
let errors: string[];
let posted: Array<{ path: string; body: Record<string, unknown> }>;

async function create(extra: string[], answer: Answer): Promise<string> {
  const deps: QueueDeps = {
    lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
    clientFactory: () => ({
      get: vi.fn(async () => ({ status: 200, data: {} })),
      post: vi.fn(async (path: string, body: Record<string, unknown>) => { posted.push({ path, body }); return answer; }),
    }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
  };
  const program = createProgram({ queueDeps: deps });
  program.exitOverride();
  await program.parseAsync(["node", "rig", "queue", "create", "--destination", "owner@r", "--body", "alarm", "--summary", "s",
    "--id", REQUEST_ID, "--json", ...extra]);
  return logs.join("\n");
}

describe("rig queue create --dedupe-key", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENRIG_SESSION_NAME", "worker@r");
    logs = []; errors = []; posted = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    process.exitCode = undefined;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

  it("sends the key when asked, and sends nothing extra when not", async () => {
    await create(["--dedupe-key", "alarm:disk"], { status: 201, data: row({ dedupeKey: "alarm:disk" }) });
    expect(posted[0]!.body).toMatchObject({ dedupeKey: "alarm:disk", qitemId: REQUEST_ID });
    posted = [];
    await create([], { status: 201, data: row() });
    expect("dedupeKey" in posted[0]!.body).toBe(false);
  });

  it("a created row that echoes the key is a plain success", async () => {
    const out = await create(["--dedupe-key", "alarm:disk"], { status: 201, data: row({ dedupeKey: "alarm:disk" }) });
    expect(JSON.parse(out)).toMatchObject({ qitemId: REQUEST_ID, dedupeKey: "alarm:disk" });
    expect(process.exitCode).toBeUndefined();
    expect(errors.join("\n")).not.toMatch(/Deduplicated|did not confirm/);
  });

  it("a hit names the row that already held the key, says no new row was written, and is not an error", async () => {
    const out = await create(["--dedupe-key", "alarm:disk"], {
      status: 200, data: row({ qitemId: "qitem-20261028110000-existing", dedupeKey: "alarm:disk", deduped: true }),
    });
    expect(JSON.parse(out)).toMatchObject({ qitemId: "qitem-20261028110000-existing", deduped: true });
    const said = errors.join("\n");
    expect(said).toContain("Deduplicated: open row qitem-20261028110000-existing already holds dedupe key 'alarm:disk'");
    expect(said).toContain("No new row was created");
    expect(said).toContain(`the request ID ${REQUEST_ID} was not used`);
    expect(process.exitCode).toBeUndefined();
  });

  it("an answer without the key is an error that names the row already written (a daemon that predates the field)", async () => {
    const out = await create(["--dedupe-key", "alarm:disk"], { status: 201, data: row() });
    expect(JSON.parse(out)).toMatchObject({ qitemId: REQUEST_ID });
    expect(errors.join("\n")).toContain(`did not confirm dedupe key 'alarm:disk'`);
    expect(errors.join("\n")).toContain(`Row ${REQUEST_ID} WAS created without dedupe`);
    expect(process.exitCode).toBe(1);
  });

  it("an answer that echoes a different key is the same error", async () => {
    await create(["--dedupe-key", "alarm:disk"], { status: 201, data: row({ dedupeKey: "alarm:cpu" }) });
    expect(errors.join("\n")).toContain("did not confirm dedupe key 'alarm:disk'");
    expect(process.exitCode).toBe(1);
  });

  it("the key is compared as the daemon stores it, trimmed", async () => {
    await create(["--dedupe-key", "  alarm:disk  "], { status: 201, data: row({ dedupeKey: "alarm:disk" }) });
    expect(process.exitCode).toBeUndefined();
  });

  it("a refusal prints the daemon's error as any other refusal does, and adds no echo complaint", async () => {
    const out = await create(["--dedupe-key", "alarm:disk"], {
      status: 409, data: { error: "dedupe_key_conflict", message: "dedupe key 'alarm:disk' is held at owner@r by open row x, raised by a different source." },
    });
    expect(JSON.parse(out)).toMatchObject({ error: "dedupe_key_conflict" });
    expect(errors.join("\n")).not.toContain("did not confirm");
    expect(process.exitCode).toBe(1);
  });
});
