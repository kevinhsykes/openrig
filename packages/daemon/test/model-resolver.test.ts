import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseModelRequest, describeModelRequest, resolveModelByRail, resolverArgvFromEnv, piModelsJsonHas, type RunCommand,
} from "../src/domain/model-resolver.js";

const ok = (doc: unknown, code = 0): RunCommand => async () => ({ code, stdout: JSON.stringify(doc), stderr: "", timedOut: false });
const GOOD = { refuse: false, requested_verdict: "OK", requested_reason: null, pick: { launch: "minimax/MiniMax-M3.1-Flash" } };
const NOW = () => new Date("2026-10-28T22:30:00.000Z");
const TEMPLATE = ["resolver", "--provider", "{rail}", "--json"];

describe("parseModelRequest", () => {
  it("keeps a literal string exactly as written", () => {
    expect(parseModelRequest("zai/glm-5.1")).toEqual({ ok: true, request: { kind: "literal", model: "zai/glm-5.1" } });
    expect(parseModelRequest(" zai/glm-5.1 ")).toEqual({ ok: true, request: { kind: "literal", model: " zai/glm-5.1 " } }); // byte-identical
  });
  it("reads both rail forms", () => {
    expect(parseModelRequest("rail:minimax")).toEqual({ ok: true, request: { kind: "rail", rail: "minimax" } });
    expect(parseModelRequest({ rail: "minimax" })).toEqual({ ok: true, request: { kind: "rail", rail: "minimax" } });
    expect(describeModelRequest({ kind: "rail", rail: "minimax" })).toBe("rail:minimax");
  });
  it.each([
    [{ rail: "minimax", model: "x" }, "unknown key"], [{}, "needs a `rail`"], [{ rail: 5 }, "must be a string"],
    ["rail:", "not a rail name"], ["rail:-x", "not a rail name"], [{ rail: "a b" }, "not a rail name"], [{ rail: "../x" }, "not a rail name"],
    ["", "empty"], [5, "string or a mapping"], [null, "string or a mapping"], [["rail:x"], "string or a mapping"],
  ])("rejects %j", (value, text) => {
    const r = parseModelRequest(value);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain(text);
  });
});

describe("resolveModelByRail (injected runner)", () => {
  it("returns the pick with its provenance, and passes the rail to the resolver", async () => {
    let seen: string[] = [];
    const r = await resolveModelByRail("minimax", { argv: TEMPLATE, now: NOW, run: async (argv) => { seen = argv; return { code: 0, stdout: JSON.stringify(GOOD), stderr: "", timedOut: false }; } });
    expect(seen).toEqual(["resolver", "--provider", "minimax", "--json"]);
    expect(r).toEqual({ ok: true, resolution: { requested: "rail:minimax", model: "minimax/MiniMax-M3.1-Flash", effort: null,
      resolverArgv: seen, resolvedAt: "2026-10-28T22:30:00.000Z", gateVerdict: "OK" } });
  });
  it("carries the resolver's effort when it gives one, and null (never a guess) when it does not", async () => {
    const withEffort = await resolveModelByRail("minimax", { argv: TEMPLATE, run: ok({ ...GOOD, pick: { launch: "a/b", effort: "high" } }) });
    expect(withEffort.ok && withEffort.resolution.effort).toBe("high");
    const without = await resolveModelByRail("minimax", { argv: TEMPLATE, run: ok(GOOD) });
    expect(without.ok && without.resolution.effort).toBeNull();
    const blank = await resolveModelByRail("minimax", { argv: TEMPLATE, run: ok({ ...GOOD, pick: { launch: "a/b", effort: "  " } }) });
    expect(blank.ok && blank.resolution.effort).toBeNull();
  });
  it("a refusal names the verdict and the reason, even when the process exited non-zero", async () => {
    const r = await resolveModelByRail("minimax", { argv: TEMPLATE, run: ok({ refuse: true, requested_verdict: "EXHAUSTED", requested_reason: "weekly window used", pick: null }, 3) });
    expect(r).toMatchObject({ ok: false, code: "gate_refused" });
    expect((r as { message: string }).message).toContain("EXHAUSTED");
    expect((r as { message: string }).message).toContain("weekly window used");
  });
  it("only an explicit refuse:false passes: absent, null, 0 and the string \"false\" all refuse", async () => {
    for (const refuse of [undefined, null, 0, "false", "no"]) {
      const doc: Record<string, unknown> = { ...GOOD }; if (refuse === undefined) delete doc["refuse"]; else doc["refuse"] = refuse;
      expect(await resolveModelByRail("minimax", { argv: TEMPLATE, run: ok(doc) })).toMatchObject({ ok: false, code: "gate_refused" });
    }
  });
  it.each([[{ ...GOOD, pick: null }], [{ ...GOOD, pick: {} }], [{ ...GOOD, pick: { launch: "" } }], [{ ...GOOD, pick: { launch: 5 } }]])("no usable pick.launch refuses: %j", async (doc) => {
    expect(await resolveModelByRail("minimax", { argv: TEMPLATE, run: ok(doc) })).toMatchObject({ ok: false, code: "no_pick" });
  });
  it("a non-zero exit with refuse:false is a failure, not a pass", async () => {
    expect(await resolveModelByRail("minimax", { argv: TEMPLATE, run: ok(GOOD, 2) })).toMatchObject({ ok: false, code: "resolver_failed" });
  });
  it("non-JSON output, a JSON array, and an exit without JSON are named", async () => {
    const text: RunCommand = async () => ({ code: 0, stdout: "USE minimax/x", stderr: "", timedOut: false });
    expect(await resolveModelByRail("minimax", { argv: TEMPLATE, run: text })).toMatchObject({ ok: false, code: "resolver_bad_output" });
    expect(await resolveModelByRail("minimax", { argv: TEMPLATE, run: ok([1, 2]) })).toMatchObject({ ok: false, code: "resolver_bad_output" });
    const crash: RunCommand = async () => ({ code: 1, stdout: "", stderr: "Traceback boom", timedOut: false });
    const r = await resolveModelByRail("minimax", { argv: TEMPLATE, run: crash });
    expect(r).toMatchObject({ ok: false, code: "resolver_failed" });
    expect((r as { message: string }).message).toContain("boom");
  });
  it("a timeout and a start failure are named", async () => {
    expect(await resolveModelByRail("minimax", { argv: TEMPLATE, timeoutMs: 5000, run: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) }))
      .toMatchObject({ ok: false, code: "resolver_timeout" });
    expect(await resolveModelByRail("minimax", { argv: TEMPLATE, run: async () => ({ code: null, stdout: "", stderr: "", timedOut: false, startError: "ENOENT: no such file" }) }))
      .toMatchObject({ ok: false, code: "resolver_start_failed" });
  });
  it("an invalid rail never reaches the runner", async () => {
    let called = false;
    const r = await resolveModelByRail("--evil", { argv: TEMPLATE, run: async () => { called = true; return { code: 0, stdout: "{}", stderr: "", timedOut: false }; } });
    expect(r).toMatchObject({ ok: false, code: "invalid_rail" });
    expect(called).toBe(false);
  });
  it("no configured resolver refuses by name and does not run anything", async () => {
    let called = false;
    const r = await resolveModelByRail("minimax", { env: {}, run: async () => { called = true; return { code: 0, stdout: "{}", stderr: "", timedOut: false }; } });
    expect(r).toMatchObject({ ok: false, code: "no_resolver" });
    expect(called).toBe(false);
  });
});

describe("resolverArgvFromEnv", () => {
  it.each([[undefined], [""], ["not json"], ["[]"], ['["a", ""]'], ['{"a":1}'], ['["a","b"]'], ['[1,"{rail}"]']])("refuses %j", (raw) => {
    expect(resolverArgvFromEnv(raw === undefined ? {} : { OPENRIG_MODEL_RESOLVER: raw }).ok).toBe(false);
  });
  it("accepts a JSON argv with the placeholder", () => {
    expect(resolverArgvFromEnv({ OPENRIG_MODEL_RESOLVER: '["python3","x.py","--provider","{rail}","--json"]' })).toEqual({ ok: true, argv: ["python3", "x.py", "--provider", "{rail}", "--json"] });
  });
});

describe("resolveModelByRail against a real process (execFile)", () => {
  const dir = mkdtempSync(join(tmpdir(), "p25-resolver-"));
  const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return [process.execPath, p, "{rail}"]; };
  it("runs a real command, templates the rail, and reads its JSON", async () => {
    const argv = script("good.js", `console.log(JSON.stringify({refuse:false,requested_verdict:"OK",pick:{launch:"x/"+process.argv[2]}}))`);
    const r = await resolveModelByRail("minimax", { argv });
    expect(r.ok && r.resolution.model).toBe("x/minimax");
  });
  it("reads a typed refusal from a process that exits non-zero", async () => {
    const argv = script("refuse.js", `console.log(JSON.stringify({refuse:true,requested_verdict:"NEAR-LIMIT",requested_reason:"low"}));process.exit(1)`);
    const r = await resolveModelByRail("minimax", { argv });
    expect(r).toMatchObject({ ok: false, code: "gate_refused" });
    expect((r as { message: string }).message).toContain("NEAR-LIMIT");
  });
  it("kills a resolver that outlives the timeout", async () => {
    const argv = script("hang.js", `setTimeout(()=>{}, 60000)`);
    const t0 = Date.now();
    expect(await resolveModelByRail("minimax", { argv, timeoutMs: 300 })).toMatchObject({ ok: false, code: "resolver_timeout" });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
  it("names a resolver binary that does not exist", async () => {
    expect(await resolveModelByRail("minimax", { argv: [join(dir, "no-such-binary"), "{rail}"] })).toMatchObject({ ok: false, code: "resolver_start_failed" });
  });
});

describe("piModelsJsonHas", () => {
  const doc = { providers: { minimax: { models: [{ id: "MiniMax-M3.1-Flash" }, { id: "MiniMax-M3" }] }, zai: { models: [] } } };
  it("finds a listed model and refuses an unlisted one", () => {
    expect(piModelsJsonHas(doc, "minimax/MiniMax-M3.1-Flash")).toBe(true);
    expect(piModelsJsonHas(doc, "minimax/MiniMax-M2")).toBe(false);
    expect(piModelsJsonHas(doc, "zai/glm-5.1")).toBe(false);
    expect(piModelsJsonHas(doc, "nowhere/x")).toBe(false);
    expect(piModelsJsonHas(doc, "no-slash")).toBe(false);
  });
  it("is null (unknown) for a document without a providers mapping, never true", () => {
    for (const bad of [null, [], "x", {}, { providers: [] }, { providers: null }]) expect(piModelsJsonHas(bad, "a/b")).toBeNull();
  });
});
