import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueDestinationChecker, destinationCheckConfigFromEnv, MAX_TIMEOUT_MS, type RunHook } from "../src/domain/queue-rail-check.js";

const ENV = { OPENRIG_QUEUE_DESTINATION_CHECK: '["checker","check","{session}"]' };
const hook = (code: number, stdout = "", extra: Partial<Awaited<ReturnType<RunHook>>> = {}): RunHook => async () => ({ code, stdout, timedOut: false, ...extra });

function checker(env: Record<string, string>, run: RunHook, clock = { t: 1_000_000 }) {
  const lines: string[] = [];
  const c = new QueueDestinationChecker({ env: () => env, run, now: () => clock.t, debug: (l) => lines.push(l) });
  return { c, lines, clock };
}

describe("destinationCheckConfigFromEnv", () => {
  it("no variable means no check, silently", () => {
    expect(destinationCheckConfigFromEnv({})).toEqual({ config: null });
    expect(destinationCheckConfigFromEnv({ OPENRIG_QUEUE_DESTINATION_CHECK: "  " })).toEqual({ config: null });
  });
  it.each([["not json"], ["[]"], ['["a",""]'], ['{"a":1}'], ['["checker","check"]']])("an unusable argv %j disables the check and says why", (raw) => {
    const r = destinationCheckConfigFromEnv({ OPENRIG_QUEUE_DESTINATION_CHECK: raw });
    expect(r.config).toBeNull();
    expect(r.problem).toBeTruthy();
  });
  it("defaults: warn mode, warn on 3 and 4, refuse on nothing, the hard timeout cap, a 60 s cache", () => {
    expect(destinationCheckConfigFromEnv(ENV).config).toMatchObject({ mode: "warn", warnCodes: [3, 4], refuseCodes: [], timeoutMs: MAX_TIMEOUT_MS, cacheMs: 60_000 });
  });
  it("a timeout above the cap is clamped to it; a bad mode or code list disables the check", () => {
    expect(destinationCheckConfigFromEnv({ ...ENV, OPENRIG_QUEUE_DESTINATION_CHECK_TIMEOUT_MS: "60000" }).config?.timeoutMs).toBe(MAX_TIMEOUT_MS);
    expect(destinationCheckConfigFromEnv({ ...ENV, OPENRIG_QUEUE_DESTINATION_CHECK_MODE: "block" }).config).toBeNull();
    expect(destinationCheckConfigFromEnv({ ...ENV, OPENRIG_QUEUE_DESTINATION_CHECK_REFUSE_CODES: "[0]" }).config).toBeNull();
    expect(destinationCheckConfigFromEnv({ ...ENV, OPENRIG_QUEUE_DESTINATION_CHECK_WARN_CODES: '["3"]' }).config).toBeNull();
  });
});

describe("QueueDestinationChecker", () => {
  it("exit 0 is ok and no warning; the hook gets the session in its argv", async () => {
    let seen: string[] = [];
    const { c } = checker(ENV, async (argv) => { seen = argv; return { code: 0, stdout: "", timedOut: false }; });
    expect(await c.check("workers-a@rig")).toEqual({ kind: "ok" });
    expect(seen).toEqual(["checker", "check", "workers-a@rig"]);
  });

  it("a listed warning code shows the hook's own stdout, control bytes stripped", async () => {
    const { c } = checker(ENV, hook(3, "workers-a@rig: rail EXHAUSTED \x1b[31mresets 2026-11-03\x07\n"));
    const r = await c.check("workers-a@rig");
    expect(r).toMatchObject({ kind: "warn", code: 3 });
    expect((r as { message: string }).message).toBe("workers-a@rig: rail EXHAUSTED [31mresets 2026-11-03");
    expect((r as { message: string }).message).not.toMatch(/\x1b|\x07/);
  });

  it("a warning with no stdout still says something", async () => {
    const { c } = checker(ENV, hook(4, "  \n"));
    expect((await c.check("x@r") as { message: string }).message).toContain("exited 4");
  });

  it("an unlisted nonzero code is a checker error: no warning, no block, one debug line", async () => {
    const { c, lines } = checker(ENV, hook(2, "usage: ..."));
    expect(await c.check("x@r")).toEqual({ kind: "error", reason: "unlisted exit code 2" });
    expect(lines.join("\n")).toContain("not a listed code");
  });

  it.each([
    ["the hook times out", { code: null, stdout: "", timedOut: true } as const, "timed out"],
    ["the hook cannot start", { code: null, stdout: "", timedOut: false, startError: "ENOENT" } as const, "could not start"],
  ])("%s: no warning, no block, a debug line", async (_l, out, text) => {
    const { c, lines } = checker(ENV, async () => out);
    expect(await c.check("x@r")).toMatchObject({ kind: "error", reason: expect.stringContaining(text) });
    expect(lines.length).toBe(1);
  });

  it("a runner that throws is contained", async () => {
    const { c } = checker(ENV, async () => { throw new Error("boom"); });
    expect(await c.check("x@r")).toMatchObject({ kind: "error" });
  });

  it("no hook configured: skipped, and the runner is never called", async () => {
    let called = false;
    const { c } = checker({}, async () => { called = true; return { code: 0, stdout: "", timedOut: false }; });
    expect(await c.check("x@r")).toMatchObject({ kind: "skipped" });
    expect(called).toBe(false);
  });

  describe("refuse mode", () => {
    const REFUSE = { ...ENV, OPENRIG_QUEUE_DESTINATION_CHECK_MODE: "refuse", OPENRIG_QUEUE_DESTINATION_CHECK_REFUSE_CODES: "[3]" };
    it("refuses only on a code listed as refusing; the other warn code still only warns", async () => {
      expect(await checker(REFUSE, hook(3, "EXHAUSTED")).c.check("x@r")).toMatchObject({ kind: "refuse", code: 3 });
      expect(await checker(REFUSE, hook(4, "UNKNOWN")).c.check("x@r")).toMatchObject({ kind: "warn", code: 4 });   // never refuses on UNKNOWN
    });
    it("with no refuse codes configured it never refuses, whatever the code", async () => {
      const env = { ...ENV, OPENRIG_QUEUE_DESTINATION_CHECK_MODE: "refuse" };
      expect(await checker(env, hook(3, "EXHAUSTED")).c.check("x@r")).toMatchObject({ kind: "warn" });
    });
    it("warn mode never refuses even for a code that is listed as refusing", async () => {
      const env = { ...ENV, OPENRIG_QUEUE_DESTINATION_CHECK_REFUSE_CODES: "[3]" };
      expect(await checker(env, hook(3, "EXHAUSTED")).c.check("x@r")).toMatchObject({ kind: "warn" });
    });
  });

  describe("cache", () => {
    it("a second check within the window does not run the hook again; after the window it does", async () => {
      let runs = 0;
      const { c, clock } = checker(ENV, async () => { runs++; return { code: 3, stdout: "EXHAUSTED", timedOut: false }; });
      await c.check("x@r"); await c.check("x@r");
      expect(runs).toBe(1);                                  // RED if the cache is removed
      clock.t += 59_000; await c.check("x@r");
      expect(runs).toBe(1);
      clock.t += 2_000; await c.check("x@r");
      expect(runs).toBe(2);
    });
    it("is per seat", async () => {
      let runs = 0;
      const { c } = checker(ENV, async () => { runs++; return { code: 0, stdout: "", timedOut: false }; });
      await c.check("a@r"); await c.check("b@r");
      expect(runs).toBe(2);
    });
    it("a burst of concurrent checks for one seat runs the hook once", async () => {
      let runs = 0;
      const { c } = checker({ ...ENV, OPENRIG_QUEUE_DESTINATION_CHECK_CACHE_MS: "0" }, async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return { code: 0, stdout: "", timedOut: false }; });
      await Promise.all([c.check("a@r"), c.check("a@r"), c.check("a@r")]);
      expect(runs).toBe(1);
    });
    it("an error result is cached too, so a hung hook costs one timeout per window, not one per create", async () => {
      let runs = 0;
      const { c } = checker(ENV, async () => { runs++; return { code: null, stdout: "", timedOut: true }; });
      await c.check("a@r"); await c.check("a@r");
      expect(runs).toBe(1);
    });
  });

  describe("a real process", () => {
    const dir = mkdtempSync(join(tmpdir(), "p29-hook-"));
    const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return JSON.stringify([process.execPath, p, "{session}"]); };
    it("exit 3 with stdout is a warning that carries the stdout", async () => {
      const env = { OPENRIG_QUEUE_DESTINATION_CHECK: script("warn.js", `console.log("rail of "+process.argv[2]+" is EXHAUSTED");process.exit(3)`) };
      const r = await new QueueDestinationChecker({ env: () => env }).check("workers-a@rig");
      expect(r).toEqual({ kind: "warn", code: 3, message: "rail of workers-a@rig is EXHAUSTED" });
    });
    it("a hook that outlives the timeout is killed within the cap and does not block", async () => {
      const env = { OPENRIG_QUEUE_DESTINATION_CHECK: script("hang.js", `setTimeout(()=>{},60000)`), OPENRIG_QUEUE_DESTINATION_CHECK_TIMEOUT_MS: "300" };
      const t0 = Date.now();
      expect(await new QueueDestinationChecker({ env: () => env }).check("a@r")).toMatchObject({ kind: "error", reason: expect.stringContaining("timed out") });
      expect(Date.now() - t0).toBeLessThan(MAX_TIMEOUT_MS + 2000);
    });
    it("a missing binary is an error result, not a throw", async () => {
      const env = { OPENRIG_QUEUE_DESTINATION_CHECK: JSON.stringify([join(dir, "no-such-hook"), "{session}"]) };
      expect(await new QueueDestinationChecker({ env: () => env }).check("a@r")).toMatchObject({ kind: "error" });
    });
  });
});
