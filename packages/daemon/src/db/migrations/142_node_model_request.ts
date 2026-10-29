import type { Migration } from "../migrate.js";

/**
 * nodes.model_request and nodes.model_resolution_json — a seat that asks for a model by rail (P25).
 *
 * `model_request` holds what the spec asked for in canonical form (`rail:minimax`); NULL for every seat that names a literal
 * model, which is every existing row. `nodes.model` keeps meaning "the literal this seat launches with", so every reader of it
 * is unchanged. `model_resolution_json` holds the latest resolution (requested, resolved id, effort or UNKNOWN, resolver argv,
 * time, gate verdict) so `rig ps` can show where the launch value came from, separately from the value.
 *
 * Additive by contract: both columns are NULLABLE, nothing is backfilled, and a writer that never names them (an older daemon
 * after a rollback) leaves NULL, which means "a literal model, as before".
 *
 * Base table: 003 core nodes. Numbering: the next free number after 141.
 */
export const nodeModelRequestSchema: Migration = {
  name: "142_node_model_request.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN model_request TEXT;
    ALTER TABLE nodes ADD COLUMN model_resolution_json TEXT;
  `,
};
