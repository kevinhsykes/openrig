import type Database from "better-sqlite3";

/**
 * The commands a `terminal` seat's own startup types to bring its agent up.
 *
 * A terminal-runtime seat is a shell. Its agent (a Pi chat screen, for the fleet's seats) is started by the seat's
 * persisted `send_text` startup action, as one `after_ready` command. A successor made by a handover starts as a blank
 * shell, so that command has to be run again before anything is typed at the agent.
 *
 * This reads the persisted record and fails closed: a missing or malformed record is a named refusal, never "nothing to
 * launch". Only an `after_ready` `send_text` that applies to a fresh start counts. A session-identity action, a startup
 * proof, an `after_files` action, a restore-only action and a slash command are not commands for a shell.
 */

export interface TerminalLaunchAction {
  value: string;
}

export type TerminalLaunchActions =
  | { ok: true; actions: TerminalLaunchAction[] }
  | { ok: false; reason: "startup_context_missing" | "startup_context_malformed"; detail: string };

const TYPES = ["slash_command", "send_text", "startup_proof"];
const PHASES = ["after_files", "after_ready"];
const CONTEXTS = ["fresh_start", "restore"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTerminalLaunchActions(db: Database.Database, nodeId: string): TerminalLaunchActions {
  let row: { startup_actions_json: string | null } | undefined;
  try {
    row = db.prepare("SELECT startup_actions_json FROM node_startup_context WHERE node_id = ?").get(nodeId) as typeof row;
  } catch (err) {
    return { ok: false, reason: "startup_context_missing", detail: `the startup context could not be read (${(err as Error).message})` };
  }
  if (!row) return { ok: false, reason: "startup_context_missing", detail: `no startup context is persisted for node ${nodeId}` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.startup_actions_json ?? "");
  } catch (err) {
    return { ok: false, reason: "startup_context_malformed", detail: `startup_actions_json is not JSON (${(err as Error).message})` };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: "startup_context_malformed", detail: "startup_actions_json is not an array" };

  const actions: TerminalLaunchAction[] = [];
  for (const [index, raw] of parsed.entries()) {
    if (!isRecord(raw)
      || !TYPES.includes(raw["type"] as string)
      || typeof raw["value"] !== "string"
      || !PHASES.includes(raw["phase"] as string)
      || !Array.isArray(raw["appliesOn"]) || !raw["appliesOn"].every((c) => CONTEXTS.includes(c as string))
      || typeof raw["idempotent"] !== "boolean") {
      return { ok: false, reason: "startup_context_malformed", detail: `startup action ${index} is not a valid action` };
    }
    if (raw["type"] !== "send_text" || raw["phase"] !== "after_ready") continue;
    if (!(raw["appliesOn"] as string[]).includes("fresh_start")) continue;
    if (raw["builtin"] === "session_identity") continue;
    if (raw["value"].trim().length === 0) continue; // typing nothing cannot start an agent
    actions.push({ value: raw["value"] });
  }
  return { ok: true, actions };
}
