import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EXIT_QUEUE_ALREADY_TERMINAL, type QueueDeps } from "../src/commands/queue.js";
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
      status: 200, data: row({ qitemId: "qitem-20261028110000-existing", dedupeKey: "alarm:disk", deduped: true, coalescedCount: 2 }),
    });
    expect(JSON.parse(out)).toMatchObject({ qitemId: "qitem-20261028110000-existing", deduped: true });
    const said = errors.join("\n");
    expect(said).toContain("Deduplicated: open row qitem-20261028110000-existing already holds dedupe key 'alarm:disk'");
    expect(said).toContain("Raise 2 is recorded on it (rig queue transitions qitem-20261028110000-existing)");
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


describe("rig queue update — a close that closed nothing, and a stale one", () => {
  const ID = "qitem-20261028120000-bbbbbbbbbbbbbbbb";
  let calls: Array<{ method: "get" | "post"; path: string; body?: Record<string, unknown> }>;

  async function update(extra: string[], answers: { get?: { status: number; data: unknown }; post?: { status: number; data: unknown } }): Promise<string> {
    const deps: QueueDeps = {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => { calls.push({ method: "get", path }); return answers.get ?? { status: 200, data: { qitemId: ID, lastTransitionId: 7 } }; }),
        post: vi.fn(async (path: string, body: Record<string, unknown>) => { calls.push({ method: "post", path, body }); return answers.post ?? { status: 200, data: row({ qitemId: ID, state: "done" }) }; }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    };
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "queue", "update", ID, "--json", ...extra]);
    return logs.join("\n");
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENRIG_SESSION_NAME", "worker@r");
    logs = []; errors = []; calls = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    process.exitCode = undefined;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

  const reasserted = {
    status: 200,
    data: row({ qitemId: ID, state: "done", lastTransitionId: 12, alreadyTerminal: true,
      updateWarning: { code: "already_terminal", currentState: "done", lastTransitionId: 12,
        message: `qitem ${ID} was already 'done', so no state was written; your note was appended. Its newest transition is now 12.` } }),
  };

  it("a close that closed nothing exits with the distinct, documented code, names the machine code on stderr, and still prints the row", async () => {
    const out = await update(["--state", "done", "--note", "closing"], { post: reasserted });
    expect(JSON.parse(out)).toMatchObject({ qitemId: ID, alreadyTerminal: true, updateWarning: { code: "already_terminal", currentState: "done", lastTransitionId: 12 } });
    expect(errors.join("\n")).toContain("Warning: already_terminal:");
    expect(errors.join("\n")).toContain("was already 'done'");
    expect(process.exitCode).toBe(EXIT_QUEUE_ALREADY_TERMINAL);
    expect(EXIT_QUEUE_ALREADY_TERMINAL).toBe(4);
    expect([0, 1, 2, 3, 130]).not.toContain(process.exitCode);
  });

  it("an ordinary update, and a note with no state, exit 0 and print no warning", async () => {
    await update(["--state", "done", "--closure-reason", "no-follow-on"], {});
    expect(process.exitCode).toBeUndefined();
    await update(["--note", "just a note"], {});
    expect(process.exitCode).toBeUndefined();
    expect(errors.join("\n")).not.toContain("already_terminal");
  });

  it("a 409 stale_transition is a named refusal on stderr, the error is in the body, and the exit is non-zero", async () => {
    const out = await update(["--state", "done", "--closure-reason", "no-follow-on", "--expect-transition", "7"], {
      post: { status: 409, data: { error: "stale_transition", message: `qitem ${ID} has changed since you read it: its newest transition is 9, not 7. It is 'pending' now.`,
        qitemId: ID, expectedTransitionId: 7, currentTransitionId: 9, currentState: "pending" } },
    });
    expect(JSON.parse(out)).toMatchObject({ error: "stale_transition", currentTransitionId: 9, currentState: "pending" });
    expect(errors.join("\n")).toContain("Refused: stale_transition:");
    expect(process.exitCode).toBe(1);
    expect(process.exitCode).not.toBe(EXIT_QUEUE_ALREADY_TERMINAL);
  });

  it("--expect-transition sends the token after reading the row, and sends nothing extra without it", async () => {
    await update(["--state", "done", "--closure-reason", "no-follow-on", "--expect-transition", "7"], {});
    expect(calls.map((c) => c.method)).toEqual(["get", "post"]);
    expect(calls[1]!.body).toMatchObject({ expectedTransitionId: 7 });
    calls = [];
    await update(["--state", "done", "--closure-reason", "no-follow-on"], {});
    expect(calls.map((c) => c.method)).toEqual(["post"]);
    expect("expectedTransitionId" in calls[0]!.body!).toBe(false);
  });

  it("a daemon that does not report lastTransitionId cannot enforce the token: nothing is sent and the exit is non-zero", async () => {
    await update(["--state", "done", "--closure-reason", "no-follow-on", "--expect-transition", "7"], { get: { status: 200, data: { qitemId: ID } } });
    expect(calls.map((c) => c.method)).toEqual(["get"]);
    expect(errors.join("\n")).toContain("cannot enforce --expect-transition 7");
    expect(process.exitCode).toBe(1);
  });

  it.each(["0", "-3", "abc", "1.5", "", "7x"])("a token of %j is refused before anything is sent", async (bad) => {
    await update(["--state", "done", "--closure-reason", "no-follow-on", "--expect-transition", bad], {});
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("--expect-transition needs the lastTransitionId");
    expect(process.exitCode).toBe(1);
  });

  it("a row that cannot be read for the preflight is reported as the daemon answered, and nothing is sent", async () => {
    const out = await update(["--state", "done", "--closure-reason", "no-follow-on", "--expect-transition", "7"], {
      get: { status: 404, data: { error: "qitem_not_found" } },
    });
    expect(JSON.parse(out)).toMatchObject({ error: "qitem_not_found" });
    expect(calls.filter((c) => c.method === "post")).toEqual([]); // the second get is the existing host hint
    expect(calls[0]).toMatchObject({ method: "get", path: `/api/queue/${ID}` });
    expect(process.exitCode).toBe(1);
  });

  it("the exit codes are documented in --help", async () => {
    const program = createProgram({ queueDeps: { lifecycleDeps: {} as QueueDeps["lifecycleDeps"], clientFactory: () => ({}) as never } });
    program.exitOverride();
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((c: string) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write);
    await program.parseAsync(["node", "rig", "queue", "update", "--help"]).catch(() => undefined);
    const help = chunks.join("");
    expect(help).toContain("Exit codes:");
    expect(help).toMatch(/4 the row was ALREADY in the terminal state you named/);
    expect(help).toContain("--expect-transition <id>");
  });
});
