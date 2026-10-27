// P1 (fork/p1-provider-kind-open) — the ProviderKind opening. ProviderKind is an OPEN union
// (precedent: SignalWindow); KNOWN_PROVIDER_KINDS is the registry the edges validate against.
// These pins: the registry's contents, the three route validators (400 naming the known list),
// refreshUsage's BR-1 refusal for a kind with no reader (never Codex's windows), and the
// readings store's construction-time refusal. Codex/claude behavior is pinned by the existing
// provider-*.test.ts suites, unchanged.
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { KNOWN_PROVIDER_KINDS, isKnownProviderKind } from "../src/domain/provider/provider-types.js";
import type { FourBlockReadModel } from "../src/domain/provider/provider-types.js";
import { providerRoutes } from "../src/routes/provider.js";
import type { ProviderService } from "../src/domain/provider/provider-service.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { ProviderAccountReadingsStore } from "../src/domain/provider/provider-account-readings.js";
import { UsageRefreshLegs } from "../src/domain/provider/usage-across-hosts.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("KNOWN_PROVIDER_KINDS registry", () => {
  it("starts as exactly codex and claude", () => {
    expect([...KNOWN_PROVIDER_KINDS]).toEqual(["codex", "claude"]);
  });

  it("isKnownProviderKind is true only for registry members (the open union accepts any string)", () => {
    expect(isKnownProviderKind("codex")).toBe(true);
    expect(isKnownProviderKind("claude")).toBe(true);
    expect(isKnownProviderKind("zai")).toBe(false);
    expect(isKnownProviderKind("Claude")).toBe(false); // case-sensitive: a kind is its exact spelling
    expect(isKnownProviderKind("")).toBe(false);
    expect(isKnownProviderKind(42)).toBe(false);
    expect(isKnownProviderKind(null)).toBe(false);
    expect(isKnownProviderKind(undefined)).toBe(false);
    expect(isKnownProviderKind({})).toBe(false);
  });
});

const MODEL: FourBlockReadModel = { accounts: [], bindings: [], signals: [], asOf: "2026-08-03T12:00:00.000Z" };

function appWith(svc: ProviderService | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (svc) c.set("providerService" as never, svc);
    await next();
  });
  app.route("/api/provider", providerRoutes());
  return app;
}

describe("provider routes validate against the registry (not a hard-coded pair)", () => {
  it("GET filter with an unknown kind is a 400 whose text names the known list", async () => {
    const res = await appWith({ getReadModel: async () => MODEL }).request("/api/provider/accounts?provider=zai");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain("codex, claude");
  });

  it("POST /usage/refresh with an unknown kind is a 400 naming the known list, and the service is never called", async () => {
    const refreshUsage = vi.fn(async () => ({ disabled: true }) as never);
    const res = await appWith({ getReadModel: async () => MODEL, refreshUsage })
      .request("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider: "zai" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain("codex, claude");
    expect(refreshUsage).not.toHaveBeenCalled();
  });

  it("POST /usage/refresh with a known kind still reaches the service (behavior unchanged)", async () => {
    const refreshUsage = vi.fn(async () => ({ disabled: true }) as never);
    const res = await appWith({ getReadModel: async () => MODEL, refreshUsage })
      .request("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider: "codex" }) });
    // The stub answers disabled, so the route's 409 (not a 400) proves validation passed.
    expect(res.status).toBe(409);
    expect(refreshUsage).toHaveBeenCalledWith("codex", undefined);
  });

  it("POST /usage/hosts/refresh refuses an unknown kind in either shape (400 naming the known list)", async () => {
    const refreshUsage = vi.fn(async () => ({ disabled: true }) as never);
    const app = appWith({ getReadModel: async () => MODEL, refreshUsage });
    const asList = await app.request("/api/provider/usage/hosts/refresh",
      { method: "POST", body: JSON.stringify({ providers: ["codex", "zai"] }) });
    expect(asList.status).toBe(400);
    expect(String((await asList.json()).error)).toContain("codex, claude");
    const asSingle = await app.request("/api/provider/usage/hosts/refresh",
      { method: "POST", body: JSON.stringify({ provider: "zai" }) });
    expect(asSingle.status).toBe(400);
    expect(String((await asSingle.json()).error)).toContain("codex, claude");
    expect(refreshUsage).not.toHaveBeenCalled();
  });

  it("POST /usage/hosts/refresh with only known kinds passes validation (409 = the usage-off gate, not the registry)", async () => {
    const res = await appWith({ getReadModel: async () => MODEL, refreshUsage: async () => ({ disabled: true }) as never })
      .request("/api/provider/usage/hosts/refresh", { method: "POST", body: JSON.stringify({ providers: ["codex", "claude"] }) });
    expect(res.status).toBe(409);
  });
});

function refreshSvc(windows: { enabled: () => boolean; refresh: (token?: unknown) => Promise<unknown> }): ProviderServiceImpl {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "p1-kind-"));
  return new ProviderServiceImpl({
    db: createFullTestDb(),
    listRigs: () => [],
    env: { CODEX_HOME: home } as NodeJS.ProcessEnv,
    now: () => "2026-08-04T00:00:00.000Z",
    usageWindows: { enabled: windows.enabled, windows: { refresh: windows.refresh } as never },
  });
}

describe("ProviderServiceImpl.refreshUsage (BR-1 after the widening)", () => {
  it("an unknown kind answers { unavailable: true } and never reads the Codex windows", async () => {
    const refresh = vi.fn(async () => ({}) as never);
    const r = await refreshSvc({ enabled: () => true, refresh }).refreshUsage("zai");
    expect(r).toEqual({ unavailable: true });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("codex still reads the Codex windows verbatim (behavior unchanged)", async () => {
    const answer = { at: "2026-08-04T00:00:00.000Z", outcome: "ok" };
    const refresh = vi.fn(async () => answer as never);
    const r = await refreshSvc({ enabled: () => true, refresh }).refreshUsage("codex");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(r).toBe(answer);
  });
});

describe("ProviderAccountReadingsStore refuses an unknown kind at construction (BR-1)", () => {
  it("throws for a kind outside the registry, accepts registry members and the codex default", () => {
    const db = createFullTestDb();
    expect(() => new ProviderAccountReadingsStore(db, "zai")).toThrow(/unknown provider kind: zai/);
    expect(() => new ProviderAccountReadingsStore(db, "claude")).not.toThrow();
    expect(() => new ProviderAccountReadingsStore(db)).not.toThrow();
  });
});

describe("UsageRefreshLegs deadline refusal (R1)", () => {
  it("codex and claude keep their remote refresh deadlines (behavior unchanged)", () => {
    const legs = new UsageRefreshLegs();
    expect(legs.deadlineFor("codex")).toBe(50_000);
    expect(legs.deadlineFor("claude")).toBe(20_000);
  });

  it("deadlineFor refuses a kind with no deadline entry — loud, never undefined", () => {
    let threw: unknown;
    try {
      new UsageRefreshLegs().deadlineFor("zai");
    } catch (e) {
      threw = e;
    }
    expect(String(threw)).toContain('no usage-refresh deadline for provider kind "zai"');
    expect(String(threw)).toContain("codex, claude");
  });

  it("an explicit opts.deadlineMs entry wins even for a non-registry kind (override pinned)", () => {
    const legs = new UsageRefreshLegs({ deadlineMs: { zai: 1234 } });
    expect(legs.deadlineFor("zai")).toBe(1234);
  });

  it("remote() to a host with an unknown kind is its OWN failed leg (provider_has_no_reader), before any fetch", async () => {
    const fetchImpl = vi.fn();
    const legs = new UsageRefreshLegs();
    const leg = await legs.remote({ id: "h-1", transport: "http", url: "http://h-1" } as const,
      "zai", { fetchImpl });
    expect(leg.outcome).toBe("failed");
    expect(leg.reason).toBe("provider_has_no_reader");
    expect(leg.detail).toContain("codex, claude");
    expect(leg.hostId).toBe("h-1");
    expect(leg.provider).toBe("zai");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
