// P25 — can this Pi seat start the model a rail resolved to? The answer is the seat's own `models.json`
// (<OPENRIG_HOME>/state/pi/<seat>/agent/models.json): Pi launches only models its provider block lists. Anything that is not
// a clear yes — a missing file, unreadable JSON, a shape we do not know — is "could not tell", which the caller refuses.
import fs from "node:fs";
import nodePath from "node:path";
import type { RigRepository } from "./rig-repository.js";
import { piSeatPaths } from "../adapters/pi-runner-protocol.js";
import { deriveCanonicalSessionName } from "./session-name.js";
import { piModelsJsonHas } from "./model-resolver.js";

export function piSeatModelsCheck(deps: {
  openrigHome: string;
  rigRepo: Pick<RigRepository, "getNodeById" | "getRig">;
  readFile?: (path: string) => string;
}): (nodeId: string, runtime: string | null, model: string) => boolean | null {
  const read = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  return (nodeId, runtime, model) => {
    if (runtime !== "pi") return true;   // only Pi keeps a per-seat model list
    const node = deps.rigRepo.getNodeById(nodeId);
    const rig = node ? deps.rigRepo.getRig(node.rigId)?.rig ?? null : null;
    if (!node || !rig) return null;
    const dot = node.logicalId.indexOf(".");
    if (dot <= 0 || dot === node.logicalId.length - 1) return null;
    const seat = deriveCanonicalSessionName(node.logicalId.slice(0, dot), node.logicalId.slice(dot + 1), rig.name);
    try {
      const file = nodePath.join(piSeatPaths(nodePath.join(deps.openrigHome, "state", "pi"), seat).agentDir, "models.json");
      return piModelsJsonHas(JSON.parse(read(file)), model);
    } catch { return null; }
  };
}
