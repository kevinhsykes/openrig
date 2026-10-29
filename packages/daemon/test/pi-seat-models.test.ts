import { describe, expect, it } from "vitest";
import { piSeatModelsCheck } from "../src/domain/pi-seat-models.js";

/** P25: the check a rail-resolved model must pass before a Pi seat launches with it. Anything but a clear yes is "could not tell". */
const DOC = { providers: { minimax: { models: [{ id: "MiniMax-M3" }] } } };
const repo = (runtime = "pi", logicalId = "dev.impl") => ({
  getNodeById: (id: string) => id === "n1" ? ({ id, rigId: "r1", logicalId, runtime } as never) : null,
  getRig: (id: string) => id === "r1" ? ({ rig: { name: "fleet" } } as never) : null,
});
const check = (read: (p: string) => string, r = repo()) => piSeatModelsCheck({ openrigHome: "/h", rigRepo: r, readFile: read });

describe("piSeatModelsCheck (P25)", () => {
  it("reads the seat's own models.json under the canonical session name", () => {
    const seen: string[] = [];
    const out = check((p) => { seen.push(p); return JSON.stringify(DOC); })("n1", "pi", "minimax/MiniMax-M3");
    expect(out).toBe(true);
    expect(seen).toEqual(["/h/state/pi/dev-impl@fleet/agent/models.json"]);
  });
  it("false when the list does not contain the model", () => {
    expect(check(() => JSON.stringify(DOC))("n1", "pi", "minimax/Other")).toBe(false);
    expect(check(() => JSON.stringify(DOC))("n1", "pi", "zai/GLM")).toBe(false);
  });
  it("null (refuse) when the file is missing, unreadable, not JSON or not the known shape", () => {
    expect(check(() => { throw new Error("ENOENT"); })("n1", "pi", "minimax/MiniMax-M3")).toBeNull();
    expect(check(() => "not json")("n1", "pi", "minimax/MiniMax-M3")).toBeNull();
    expect(check(() => JSON.stringify({ other: 1 }))("n1", "pi", "minimax/MiniMax-M3")).toBeNull();
  });
  it("null when the node or its rig is unknown, or its logical id has no pod.member shape", () => {
    expect(check(() => JSON.stringify(DOC))("missing", "pi", "minimax/MiniMax-M3")).toBeNull();
    expect(check(() => JSON.stringify(DOC), repo("pi", "nodot"))("n1", "pi", "minimax/MiniMax-M3")).toBeNull();
  });
  it("true without reading anything for a runtime that keeps no per-seat model list", () => {
    let read = 0;
    expect(check(() => { read++; return ""; })("n1", "claude-code", "opus")).toBe(true);
    expect(read).toBe(0);
  });
});
