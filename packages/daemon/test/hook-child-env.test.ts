import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileHook } from "../src/domain/queue-rail-check.js";
import { HOOK_CHILD_ENV_ALLOWLIST, hookChildEnv } from "../src/domain/hook-child-env.js";

/**
 * P29c (GLM review of 0881b4ea9): an operator-configured helper is started with an allowlisted environment, never the daemon's.
 * The canaries are set on the daemon side; a REAL child process reports what it can see.
 */
const CANARIES = {
  OPENRIG_TEST_CANARY_SECRET: "must-not-leak-1",
  ANTHROPIC_API_KEY: "must-not-leak-2",
  OPENRIG_ACTIVITY_HOOK_TOKEN: "must-not-leak-3",
  OPENRIG_URL: "http://127.0.0.1:1",
  OPENRIG_PORT: "1",
  OPENRIG_NODE_ID: "node-canary",
};

afterEach(() => { vi.unstubAllEnvs(); });

describe("hook child environment (P29c)", () => {
  it("hookChildEnv keeps only the allowlist, drops everything else and any non-string value", () => {
    const env = hookChildEnv({ ...CANARIES, PATH: "/bin", HOME: "/h", LANG: "C", OPENRIG_HOME: "/state", NOT_A_STRING: undefined, TZ: undefined });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C", OPENRIG_HOME: "/state" });
    expect(Object.keys(env).every((k) => HOOK_CHILD_ENV_ALLOWLIST.includes(k))).toBe(true);
  });

  it("a real hook child sees the allowlisted variables and none of the daemon's secrets or identity", async () => {
    for (const [k, v] of Object.entries(CANARIES)) vi.stubEnv(k, v);
    vi.stubEnv("OPENRIG_HOME", "/state-home");
    const out = await execFileHook([process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"], 5000);
    expect(out.code).toBe(0);
    const seen = JSON.parse(out.stdout) as Record<string, string>;
    for (const name of Object.keys(CANARIES)) expect(seen, name).not.toHaveProperty(name);
    expect(JSON.stringify(seen)).not.toContain("must-not-leak");
    expect(seen["OPENRIG_HOME"]).toBe("/state-home");
    expect(seen["PATH"]).toBe(process.env["PATH"]);   // the healthy arm: the child still gets what it needs to run
    expect(Object.keys(seen).every((k) => HOOK_CHILD_ENV_ALLOWLIST.includes(k))).toBe(true);
  });
});
