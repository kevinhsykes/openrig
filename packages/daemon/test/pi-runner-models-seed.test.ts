// P7 — the Pi model catalog seed. A fresh seat's agent dir historically got no models.json
// (the only place a Pi seat loads models from), so Pi started with an empty catalog and
// exited `Model "<pin>" not found`. The runner now seeds the empty catalog once during seat
// dir preparation — 0600 (merged provider entries reference key material by path), never
// touching an existing file — and always before the child env is built or the child spawned
// (main() calls prepareSeatDirs ahead of buildPiChildEnv/spawn).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  prepareSeatDirs,
  seedPiModelsJson,
  PI_MODELS_SEED_CONTENT,
  type SeatDirPrepOps,
} from "../src/adapters/pi-runner.js";

const tmpSeat = (): string => fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-seed-"));

const recordingOps = (calls: string[], existsResult: boolean): SeatDirPrepOps => ({
  mkdir: (p) => calls.push(`mkdir:${nodePath.basename(p)}`),
  exists: (p) => {
    calls.push(`exists:${nodePath.basename(p)}`);
    return existsResult;
  },
  writeFile: (p, data, mode) => calls.push(`write:${nodePath.basename(p)}:${mode.toString(8)}:${data === PI_MODELS_SEED_CONTENT ? "seed-content" : "UNEXPECTED"}`),
});

describe("seedPiModelsJson", () => {
  it("a fresh agent dir gets models.json with the empty catalog, mode 0600", () => {
    const agentDir = tmpSeat();
    seedPiModelsJson(agentDir);
    const file = nodePath.join(agentDir, "models.json");
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toBe(PI_MODELS_SEED_CONTENT);
    expect(JSON.parse(content)).toEqual({ providers: {} });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("an existing models.json is never touched: byte-identical content, mode kept", () => {
    const agentDir = tmpSeat();
    const file = nodePath.join(agentDir, "models.json");
    fs.writeFileSync(file, '{"providers":{"merged":{"type":"openai-completions","apiKey":"sk-test"}}}\n');
    fs.chmodSync(file, 0o640);
    const before = fs.readFileSync(file);
    seedPiModelsJson(agentDir);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it("skips the write entirely when the file already exists (ops-level)", () => {
    const calls: string[] = [];
    seedPiModelsJson("/seat/agent", recordingOps(calls, true));
    expect(calls).toEqual(["exists:models.json"]);
  });
});

describe("prepareSeatDirs", () => {
  it("creates both dirs, then seeds — the seed completes before preparation returns, so before main() builds the child env or spawns", () => {
    const calls: string[] = [];
    prepareSeatDirs("/seat/agent", "/seat/sessions", "pi", recordingOps(calls, false));
    expect(calls).toEqual([
      "mkdir:agent",
      "mkdir:sessions",
      "exists:models.json",
      "write:models.json:600:seed-content",
    ]);
  });

  it("a fresh seat end to end on the real fs: both dirs exist, models.json seeded 0600", () => {
    const root = tmpSeat();
    const agentDir = nodePath.join(root, "agent");
    const sessionsDir = nodePath.join(root, "sessions");
    prepareSeatDirs(agentDir, sessionsDir, "pi");
    expect(fs.statSync(sessionsDir).isDirectory()).toBe(true);
    const file = nodePath.join(agentDir, "models.json");
    expect(fs.readFileSync(file, "utf8")).toBe('{"providers": {}}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("OMP seats share the dir layout but get no Pi catalog seed", () => {
    const root = tmpSeat();
    const agentDir = nodePath.join(root, "agent");
    prepareSeatDirs(agentDir, nodePath.join(root, "sessions"), "omp");
    expect(fs.statSync(agentDir).isDirectory()).toBe(true);
    expect(fs.existsSync(nodePath.join(agentDir, "models.json"))).toBe(false);
  });
});
