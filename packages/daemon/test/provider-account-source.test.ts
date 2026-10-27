import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_SOURCE_ID, codexAccountSource, validateAccountSources, type AccountSource } from "../src/domain/provider/account-source.js";
import { collectFourBlockReadModel, type ProviderCollectDeps, type ProviderSeat } from "../src/domain/provider/provider-collect.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import type { CodexAuthMetadata } from "../src/domain/provider/codex-auth-reader.js";
import { goldenAuth, goldenSeats, goldenSignals, GOLDEN_ASOF } from "./fixtures/provider-collect-golden-input.js";

// The AccountSource registry is a pure refactor of the collection seam: the default path must reproduce, byte for byte, what
// `collectFourBlockReadModel` produced at upstream 6957751f5 on the golden fixture, and a second source adds accounts and bindings
// without disturbing the first. A collision between sources is reported, never thrown from a collection.

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_FILE = path.join(here, "fixtures", "provider-collect-golden.json");

function deps(over: Partial<ProviderCollectDeps> = {}): ProviderCollectDeps {
  return { readCodexAuth: () => goldenAuth, listSeats: () => goldenSeats, collectSignals: () => goldenSignals, now: () => GOLDEN_ASOF, ...over };
}

/** A source for another rail: its account ids are prefixed with its id, and it binds only seats of the runtime it serves. */
function fakeSource(id: string, runtime: string, accounts: string[], binds: Record<string, string> = {}): AccountSource {
  return {
    id,
    provider: "claude",
    listAccounts: (asOf) => accounts.map((name) => ({ accountId: name, label: name, provider: "claude" as const, authState: "unknown" as const, profileRef: name, asOf })),
    bindingFor: (seat: ProviderSeat) => binds[seat.seatSession] !== undefined && seat.runtime === runtime
      ? { accountId: binds[seat.seatSession]!, seatSession: seat.seatSession, rigName: seat.rigName, boundAt: "2026-10-27T11:00:00Z", bindingSource: `${id}_fake` }
      : null,
  };
}

describe("the refactored collection reproduces the base golden", () => {
  it("the default path (no accountSources) is byte-for-byte the model upstream 6957751f5 produced on the golden fixture", () => {
    const model = collectFourBlockReadModel(deps());
    expect(JSON.stringify(model, null, 2) + "\n").toBe(fs.readFileSync(GOLDEN_FILE, "utf8"));
  });

  it("the explicit [codexAccountSource] path deep-equals the default path", () => {
    const explicit = collectFourBlockReadModel(deps({ accountSources: [codexAccountSource(goldenAuth)] }));
    expect(explicit).toEqual(collectFourBlockReadModel(deps()));
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(collectFourBlockReadModel(deps())));
  });

  it("the golden exercises the branches that matter: a shared profile, a stale-row gate, an own-home seat, an unsaved profile", () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8")) as ReturnType<typeof collectFourBlockReadModel>;
    const by = (seat: string) => golden.bindings.find((b) => b.seatSession === seat)!;
    expect(by("driver-a@rig-a").anomalies.map((a) => a.kind)).toEqual(["same_account_on_n_seats"]);
    expect(by("reused@rig-b").accountId).toBeNull();
    expect(by("homed@rig-c").accountId).toBeNull();
    expect(by("orphan@rig-d").accountId).toBe("never-saved");
    expect(golden.hostUsage?.length).toBeGreaterThan(0);
  });
});

describe("a second source adds accounts and bindings, and the first is undisturbed", () => {
  it("appends its accounts after Codex's, and its binding is used only for a seat Codex doesn't bind", () => {
    const warnings: string[] = [];
    const second = fakeSource("claudedir", "claude-code", ["claudedir:golisano", "claudedir:max"], { "pm@rig-a": "claudedir:golisano", "idle@rig-b": "claudedir:max" });
    const model = collectFourBlockReadModel(deps({ accountSources: [codexAccountSource(goldenAuth), second], warn: (m) => warnings.push(m) }));
    const base = collectFourBlockReadModel(deps());
    expect(model.accounts).toEqual([...base.accounts, ...second.listAccounts(GOLDEN_ASOF)]);
    const by = (seat: string) => model.bindings.find((b) => b.seatSession === seat)!;
    expect(by("pm@rig-a")).toMatchObject({ accountId: "claudedir:golisano", bindingSource: "claudedir_fake", anomalies: [] });
    expect(by("idle@rig-b")).toMatchObject({ accountId: "claudedir:max" });
    // Every seat the second source doesn't bind is exactly what Codex alone gave.
    for (const row of base.bindings.filter((b) => b.seatSession !== "pm@rig-a" && b.seatSession !== "idle@rig-b")) {
      expect(by(row.seatSession)).toEqual(row);
    }
    expect(warnings).toEqual([]);
    // Signals and the host rollup are carried as before.
    expect(model.signals).toEqual(base.signals);
    expect(model.hostUsage).toEqual(base.hostUsage);
  });

  it("source order is binding priority: the same seat answered by two sources goes to the first, and the conflict is reported", () => {
    const warnings: string[] = [];
    // A second source claiming a seat Codex also binds (it ignores the runtime gate, which the contract forbids).
    const rogue: AccountSource = { ...fakeSource("rogue", "codex", ["rogue:x"], { "driver-a@rig-a": "rogue:x" }) };
    const model = collectFourBlockReadModel(deps({ accountSources: [codexAccountSource(goldenAuth), rogue], warn: (m) => warnings.push(m) }));
    const row = model.bindings.find((b) => b.seatSession === "driver-a@rig-a")!;
    expect(row).toMatchObject({ accountId: "work", bindingSource: "codex_auth_seat_registry" });
    expect(warnings).toEqual(['[provider-account-source] seat "driver-a@rig-a" is bound by both source "codex" and source "rogue"; kept source "codex"']);
    // The loser's account still lists, and nothing threw.
    expect(model.accounts.map((a) => a.accountId)).toContain("rogue:x");
  });

  it("reverse order flips the winner (priority is registration order, not the provider)", () => {
    const warnings: string[] = [];
    const rogue = fakeSource("rogue", "codex", ["rogue:x"], { "driver-a@rig-a": "rogue:x" });
    const model = collectFourBlockReadModel(deps({ accountSources: [rogue, codexAccountSource(goldenAuth)], warn: (m) => warnings.push(m) }));
    expect(model.bindings.find((b) => b.seatSession === "driver-a@rig-a")).toMatchObject({ accountId: "rogue:x" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('kept source "rogue"');
  });
});

describe("an account id two sources claim is reported, and the first is kept", () => {
  it("drops the repeat whatever its provider, names both sources, and the collection goes on", () => {
    const warnings: string[] = [];
    // "work" is a Codex profile; this source (a different provider) reuses the bare id, which its contract says it must prefix.
    const clash = fakeSource("clash", "claude-code", ["work", "clash:ok"]);
    const model = collectFourBlockReadModel(deps({ accountSources: [codexAccountSource(goldenAuth), clash], warn: (m) => warnings.push(m) }));
    expect(warnings).toEqual(['[provider-account-source] account id "work" from source "clash" repeats one from source "codex"; kept the first, dropped this one']);
    expect(model.accounts.filter((a) => a.accountId === "work")).toHaveLength(1);
    expect(model.accounts.find((a) => a.accountId === "work")!.provider).toBe("codex");
    expect(model.accounts.map((a) => a.accountId)).toEqual(["work", "personal", "spare", "clash:ok"]);
  });

  it("reports through console.warn when no warn is given, and never throws", () => {
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => void seen.push(String(m));
    try {
      expect(() => collectFourBlockReadModel(deps({ accountSources: [codexAccountSource(goldenAuth), fakeSource("clash", "claude-code", ["work"])] }))).not.toThrow();
    } finally { console.warn = orig; }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("[provider-account-source]");
  });
});

describe("one read of the Codex home per collection", () => {
  const three: ProviderSeat[] = goldenSeats.slice(0, 3);
  it("the default path reads it once for three seats, and the explicit path once too", () => {
    let reads = 0;
    const counting = (): CodexAuthMetadata => { reads++; return goldenAuth; };
    collectFourBlockReadModel(deps({ readCodexAuth: counting, listSeats: () => three }));
    expect(reads).toBe(1);
    reads = 0;
    collectFourBlockReadModel(deps({ readCodexAuth: counting, listSeats: () => three, accountSources: [codexAccountSource(goldenAuth)] }));
    expect(reads).toBe(1);
  });

  it("a source's methods never read the backing store: codexAccountSource works from the metadata it was given", () => {
    const source = codexAccountSource({ profiles: ["only"], seats: [] });
    expect(source.listAccounts(GOLDEN_ASOF).map((a) => a.accountId)).toEqual(["only"]);
    expect(source.bindingFor({ seatSession: "s@r", rigName: "r", runtime: "codex", lifecycleState: "running" })).toBeNull();
  });
});

describe("registration", () => {
  it("validateAccountSources throws on a repeated id, an empty id, and a reserved id, naming it", () => {
    expect(() => validateAccountSources([{ id: "a" }, { id: "b" }])).not.toThrow();
    expect(() => validateAccountSources([{ id: "a" }, { id: "a" }])).toThrow('account source id "a" is registered twice');
    expect(() => validateAccountSources([{ id: "" }])).toThrow("non-empty id");
    expect(() => validateAccountSources([{ id: CODEX_SOURCE_ID }], [CODEX_SOURCE_ID])).toThrow('"codex" is registered twice (it is reserved)');
  });

  it("ProviderServiceImpl validates extra sources at construction, not during a read", async () => {
    const mk = (extra: AccountSource[]) => new ProviderServiceImpl({ db: {} as never, listRigs: () => [], extraAccountSources: extra });
    expect(() => mk([fakeSource("x", "claude-code", []), fakeSource("x", "claude-code", [])])).toThrow('"x" is registered twice');
    expect(() => mk([fakeSource("codex", "claude-code", [])])).toThrow("reserved");
  });

  it("ProviderServiceImpl.getReadModel carries an extra source's accounts after Codex's, and routes collisions to its warn", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "provider-account-source-"));
    try {
      const warnings: string[] = [];
      const svc = new ProviderServiceImpl({ db: {} as never, listRigs: () => [], env: { CODEX_HOME: home } as NodeJS.ProcessEnv, now: () => GOLDEN_ASOF,
        warn: (m) => warnings.push(m), extraAccountSources: [fakeSource("claudedir", "claude-code", ["claudedir:max"])] });
      const model = await svc.getReadModel();
      expect(model.accounts.map((a) => a.accountId)).toEqual(["claudedir:max"]);
      expect(warnings).toEqual([]);
      const none = new ProviderServiceImpl({ db: {} as never, listRigs: () => [], env: { CODEX_HOME: home } as NodeJS.ProcessEnv, now: () => GOLDEN_ASOF });
      expect((await none.getReadModel()).accounts).toEqual([]);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
