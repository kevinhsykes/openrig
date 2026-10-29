import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileRunner } from "../src/domain/model-resolver.js";
import { HOOK_CHILD_ENV_ALLOWLIST } from "../src/domain/hook-child-env.js";

/** P29c, same class (P25): the operator-configured model resolver is started with the allowlisted environment, not the daemon's. */
afterEach(() => { vi.unstubAllEnvs(); });

describe("model resolver child environment (P29c)", () => {
  it("a real resolver child sees the allowlisted variables and none of the daemon's secrets or identity", async () => {
    for (const [k, v] of Object.entries({ OPENRIG_TEST_CANARY_SECRET: "must-not-leak-1", ZAI_API_KEY: "must-not-leak-2", OPENRIG_ACTIVITY_HOOK_TOKEN: "must-not-leak-3", OPENRIG_URL: "http://127.0.0.1:1", OPENRIG_NODE_ID: "n" })) vi.stubEnv(k, v);
    vi.stubEnv("OPENRIG_HOME", "/state-home");
    const out = await execFileRunner([process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"], 5000);
    expect(out.code).toBe(0);
    const seen = JSON.parse(out.stdout) as Record<string, string>;
    expect(JSON.stringify(seen)).not.toContain("must-not-leak");
    expect(seen).not.toHaveProperty("OPENRIG_URL");
    expect(seen["OPENRIG_HOME"]).toBe("/state-home");
    expect(seen["PATH"]).toBe(process.env["PATH"]);
    expect(Object.keys(seen).every((k) => HOOK_CHILD_ENV_ALLOWLIST.includes(k))).toBe(true);
  });
});
