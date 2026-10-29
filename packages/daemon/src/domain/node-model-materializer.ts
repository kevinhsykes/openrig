// P25 — turn a seat's model REQUEST (`rail:minimax`) into the literal model it launches with, at the moment it launches.
//
// `nodes.model` stays the literal every launch path already reads; this writes it, and the record of where it came from, in one
// statement (RigRepository.setNodeModelResolution) together with a `node.model_changed` event. A seat with no request is
// untouched and costs no resolver call. Any failure writes nothing and refuses the launch with the resolver's own reason: there is
// no fallback to the previous value, a default, or a profile model.
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { RigRepository } from "./rig-repository.js";
import { parseModelRequest, resolveModelByRail, type ModelResolution, type ResolveOptions } from "./model-resolver.js";

export type MaterializeFailureCode = "model_request_invalid" | "model_rail_unresolved" | "model_rail_gate_refused" | "model_not_installed" | "model_write_failed";

export type MaterializeResult =
  | { ok: true; changed: false; model: string | null }
  | { ok: true; changed: true; model: string; resolution: ModelResolution }
  | { ok: false; code: MaterializeFailureCode; message: string };

export interface NodeModelMaterializerDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  eventBus: EventBus;
  /** Resolver options (argv, env, run, timeout, clock); production reads OPENRIG_MODEL_RESOLVER. */
  resolver?: ResolveOptions;
  /** Is the resolved model one this seat can actually start? true = yes, false = no, null = could not tell. Both false and null
   *  refuse. Absent = no extra check (a runtime with no per-seat model list). */
  installed?: (nodeId: string, runtime: string | null, model: string) => boolean | null;
}

export class NodeModelMaterializer {
  constructor(private readonly deps: NodeModelMaterializerDeps) {}

  /** Does this seat ask for its model by rail? Cheap; no resolver call. */
  hasRequest(nodeId: string): boolean {
    return this.deps.rigRepo.getNodeModelRequest(nodeId).request !== null;
  }

  async materialize(nodeId: string, reason = "rail model resolved at launch"): Promise<MaterializeResult> {
    const { request } = this.deps.rigRepo.getNodeModelRequest(nodeId);
    const node = this.deps.rigRepo.getNodeById(nodeId);
    if (request === null) return { ok: true, changed: false, model: node?.model ?? null };
    if (!node) return { ok: false, code: "model_write_failed", message: `node ${nodeId} not found; nothing was written` };
    const parsed = parseModelRequest(request);
    if (!parsed.ok || parsed.request.kind !== "rail") {
      return { ok: false, code: "model_request_invalid", message: `${node.logicalId}: the stored model request ${JSON.stringify(request)} is not a rail request; nothing was launched` };
    }
    const resolved = await resolveModelByRail(parsed.request.rail, this.deps.resolver);
    if (!resolved.ok) {
      const code: MaterializeFailureCode = resolved.code === "gate_refused" || resolved.code === "no_pick" ? "model_rail_gate_refused" : "model_rail_unresolved";
      return { ok: false, code, message: `${node.logicalId}: could not resolve ${request} (${resolved.code}): ${resolved.message}. The seat was not launched and its model was not changed.` };
    }
    const { resolution } = resolved;
    if (this.deps.installed) {
      const has = this.deps.installed(nodeId, node.runtime, resolution.model);
      if (has !== true) {
        return { ok: false, code: "model_not_installed", message: `${node.logicalId}: ${request} resolved to ${resolution.model}, but ${has === false ? "this seat's model list does not contain it" : "this seat's model list could not be read"}. The seat was not launched and its model was not changed.` };
      }
    }
    const from = node.model ?? null;
    let persisted: ReturnType<EventBus["persistWithinTransaction"]> | null = null;
    try {
      this.deps.db.transaction(() => {
        if (!this.deps.rigRepo.setNodeModelResolution(nodeId, resolution.model, JSON.stringify(resolution))) throw new Error("the seat has no model request to resolve");
        if (from !== resolution.model) {
          persisted = this.deps.eventBus.persistWithinTransaction({
            type: "node.model_changed", actorClass: "daemon", rigId: node.rigId, nodeId, logicalId: node.logicalId,
            from, to: resolution.model, reason: `${reason}: ${request}`, operator: null,
          });
        }
      })();
    } catch (error) {
      return { ok: false, code: "model_write_failed", message: `${node.logicalId}: ${(error as Error).message}; the seat was not launched` };
    }
    if (persisted) this.deps.eventBus.notifySubscribers(persisted);
    return { ok: true, changed: true, model: resolution.model, resolution };
  }
}
