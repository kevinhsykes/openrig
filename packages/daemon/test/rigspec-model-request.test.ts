import { describe, it, expect } from "vitest";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";

/**
 * P25 slice 2b: a member (or legacy node) may ask for its model by rail. The spec keeps the request; nothing is resolved at
 * validation or normalization. A spec that names a literal model validates and normalizes exactly as before.
 */
const rig = (model: unknown) => ({
  version: "0.2", name: "r", summary: "s", culture_file: "c.md",
  pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "p", runtime: "pi", cwd: ".", ...(model === undefined ? {} : { model }) }], edges: [] }],
  edges: [],
});
const memberOf = (model: unknown) => RigSpecSchema.normalize(rig(model) as never).pods[0]!.members[0]!;

describe("RigSpec member model: rail requests (P25)", () => {
  it.each([["rail:minimax"], [{ rail: "minimax" }], ["rail: minimax "]])("accepts %j and keeps the request, with no literal model", (model) => {
    expect(RigSpecSchema.validate(rig(model)).errors).toEqual([]);
    const m = memberOf(model);
    expect(m.modelRequest).toBe("rail:minimax");
    expect(m.model).toBeUndefined();
  });

  it.each([
    [{ rail: "minimax", extra: 1 }, /unknown key/],
    [{}, /needs a `rail` key/],
    [{ rail: 5 }, /must be a string/],
    ["rail:", /not a rail name/],
    ["rail:-x", /not a rail name/],
    ["rail:a b", /not a rail name/],
    [{ rail: "Zai/Glm" }, /not a rail name/],
  ])("refuses %j by name", (model, why) => {
    const r = RigSpecSchema.validate(rig(model));
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/pods\[0\]\.members\[0\]\.model: /);
    expect(r.errors.join("\n")).toMatch(why);
  });

  it("a literal model validates and normalizes exactly as before: no request, the string unchanged", () => {
    for (const model of ["zai/glm-5.1", "opus", "sonnet"]) {
      expect(RigSpecSchema.validate(rig(model)).errors).toEqual([]);
      const m = memberOf(model);
      expect(m.model).toBe(model);
      expect("modelRequest" in m).toBe(false);
    }
    expect(memberOf(undefined).model).toBeUndefined();
  });

  it("a rail request raises no alias-pin advisory", () => {
    expect(RigSpecSchema.validate(rig("rail:minimax")).advisories?.join("\n") ?? "").not.toMatch(/alias form/);
  });
});

describe("legacy node model: rail requests (P25)", () => {
  const legacy = (model: unknown) => ({ version: "0.1", name: "r", nodes: [{ id: "a", runtime: "pi", model }], edges: [] });
  it("accepts a rail request and keeps it instead of a literal", () => {
    expect(LegacyRigSpecSchema.validate(legacy({ rail: "zai" })).errors).toEqual([]);
    const n = LegacyRigSpecSchema.normalize(legacy({ rail: "zai" })).nodes[0]!;
    expect(n.modelRequest).toBe("rail:zai");
    expect(n.model).toBeUndefined();
  });
  it("refuses a malformed one and leaves a literal alone", () => {
    expect(LegacyRigSpecSchema.validate(legacy({ rail: "zai", x: 1 })).errors.join("\n")).toMatch(/unknown key/);
    expect(LegacyRigSpecSchema.normalize(legacy("opus")).nodes[0]!.model).toBe("opus");
  });
});
