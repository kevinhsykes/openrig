import type Database from "better-sqlite3";
import { resolveGuardTarget } from "./seat-delivery-guard.js";

/** Exact-text selection needs the same unique current target as input delivery,
 * plus a binding to the actual tmux address. Historical rows and unbound
 * canonical names alone do not establish what is receiving this input. */
export function isBoundTerminalSeat(db: Database.Database, sessionName: string): boolean {
  try {
    const target = resolveGuardTarget(db, sessionName);
    if (!target) return false;
    const current = db.prepare(
      `SELECT n.runtime AS runtime FROM nodes n JOIN bindings b ON b.node_id = n.id
        WHERE n.id = ? AND (b.tmux_session = ? OR b.tmux_pane = ?)`,
    ).get(target.nodeId, sessionName, sessionName) as { runtime: string | null } | undefined;
    return current?.runtime === "terminal";
  } catch {
    return false;
  }
}

type StartupActionsLike = ReadonlyArray<{ appliesOn?: readonly string[] }> | undefined;

/** How many of these actions run on a fresh start. */
export function countFreshStartActions(actions: StartupActionsLike): number {
  return (actions ?? []).filter((action) => action.appliesOn?.includes("fresh_start")).length;
}

/**
 * P18: the fresh-start launch actions a seat's stored recipe declares directly, in its pod and member startup blocks
 * (rig-level layers are not compared). Null when the recipe has no such pod or member, so there is nothing to compare.
 */
export function declaredFreshStartActions(
  recipe: { rigSpec: { pods: ReadonlyArray<{ id: string; startup?: { actions?: StartupActionsLike }; members: ReadonlyArray<{ id: string; startup?: { actions?: StartupActionsLike } }> }> } } | null,
  logicalId: string,
): number | null {
  if (!recipe) return null;
  const [podId, memberId] = logicalId.split(".", 2);
  const pod = recipe.rigSpec.pods.find((entry) => entry.id === podId);
  const member = pod?.members.find((entry) => entry.id === memberId);
  if (!pod || !member) return null;
  return countFreshStartActions(pod.startup?.actions) + countFreshStartActions(member.startup?.actions);
}

/**
 * P18: whether a terminal seat is supposed to be running an agent: its persisted record holds a fresh-start launch action,
 * or its stored recipe declares one (the record may have lost them). A plain shell seat, where nothing launches an agent,
 * is neither. A database that can't answer reads as not expecting one.
 */
export function terminalSeatExpectsAgent(
  db: Database.Database,
  recipeOf: (nodeId: string) => Parameters<typeof declaredFreshStartActions>[0],
  node: { id: string; logicalId: string },
): boolean {
  try {
    const row = db.prepare("SELECT startup_actions_json FROM node_startup_context WHERE node_id = ?").get(node.id) as { startup_actions_json: string } | undefined;
    if (row) {
      const parsed: unknown = JSON.parse(row.startup_actions_json);
      if (Array.isArray(parsed) && countFreshStartActions(parsed) > 0) return true;
    }
  } catch { /* an unreadable record is not an expectation; the recipe still decides below */ }
  try {
    return (declaredFreshStartActions(recipeOf(node.id), node.logicalId) ?? 0) > 0;
  } catch {
    return false;
  }
}

/** A `runtime: terminal` node, by its newest session row or else its composed canonical name
 *  (`<logical id with dashes>@<rig>`). A database that can't answer reads as not terminal. */
export function isTerminalSeat(db: Database.Database, sessionName: string): boolean {
  try {
    const exact = db.prepare(
      `SELECT n.runtime AS runtime FROM sessions s JOIN nodes n ON n.id = s.node_id
        WHERE s.session_name = ? ORDER BY s.id DESC LIMIT 1`,
    ).get(sessionName) as { runtime: string | null } | undefined;
    if (exact) return exact.runtime === "terminal";
    const at = sessionName.lastIndexOf("@");
    if (at <= 0) return false;
    const composed = db.prepare(
      `SELECT n.runtime AS runtime FROM nodes n JOIN rigs r ON r.id = n.rig_id
        WHERE r.name = ? AND REPLACE(n.logical_id, '.', '-') = ? LIMIT 1`,
    ).get(sessionName.slice(at + 1), sessionName.slice(0, at)) as { runtime: string | null } | undefined;
    return composed?.runtime === "terminal";
  } catch {
    return false;
  }
}
