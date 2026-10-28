import type Database from "better-sqlite3";
import { resolveGuardTarget } from "./seat-delivery-guard.js";

/** Exact-text selection needs the same unique current target as input delivery,
 * plus a binding to the actual tmux address. Historical rows and unbound
 * canonical names alone do not establish what is receiving this input. */
export function isBoundTerminalSeat(db: Database.Database, sessionName: string): boolean {
  return boundTerminalNode(db, sessionName) !== null;
}

function boundTerminalNode(db: Database.Database, sessionName: string): { nodeId: string; pane: string | null } | null {
  try {
    const target = resolveGuardTarget(db, sessionName);
    if (!target) return null;
    const current = db.prepare(
      `SELECT n.runtime AS runtime, b.tmux_pane AS pane FROM nodes n JOIN bindings b ON b.node_id = n.id
        WHERE n.id = ? AND (b.tmux_session = ? OR b.tmux_pane = ?)`,
    ).get(target.nodeId, sessionName, sessionName) as { runtime: string | null; pane: string | null } | undefined;
    return current?.runtime === "terminal" ? { nodeId: target.nodeId, pane: current.pane } : null;
  } catch {
    return null;
  }
}

/**
 * P27: pane commands that mean an AGENT holds the pane of a `runtime: terminal` seat. On KPC the Pi agents (and the other
 * harness agents) are declared runtime terminal and started by a startup action, so the runtime says nothing about them.
 * An explicit allowlist, not "anything that is not a shell": the human's TUI (`rig tui`) runs as `node`, and typing a wake
 * into it is what #1100 prevents. A command that is not listed here is treated as bare, so a new harness has to be added.
 */
export const AGENT_PANE_COMMANDS: ReadonlySet<string> = new Set(["pi", "command-code", "vibe", "claude", "codex"]);

/**
 * P27: whether a bound terminal seat hosts an agent, by what the daemon last RECORDED as holding its current pane
 * (seat_identity_verdicts.observed_command). The seat's startup record is deliberately not used: the human's TUI has a
 * fresh-start action too. No record, a record for another pane, an unlisted command or an unreadable database all read as
 * "no agent". The record can be old, so a send still re-checks the live pane (see SessionTransport.terminalAgentNotRunning).
 */
export function terminalSeatHostsAgent(db: Database.Database, sessionName: string): boolean {
  try {
    const node = boundTerminalNode(db, sessionName);
    if (!node) return false;
    const row = db.prepare("SELECT observed_command AS command, registered_pane AS pane FROM seat_identity_verdicts WHERE node_id = ?")
      .get(node.nodeId) as { command: string | null; pane: string | null } | undefined;
    if (!row?.command) return false;
    if (row.pane && node.pane && row.pane !== node.pane) return false;
    return AGENT_PANE_COMMANDS.has(row.command.trim().replace(/^-/, "").toLowerCase());
  } catch {
    return false;
  }
}

/** A bound terminal seat with no agent in it: typed text there would run as a command line (or land in a TUI). */
export function isBareTerminalSeat(db: Database.Database, sessionName: string): boolean {
  return isBoundTerminalSeat(db, sessionName) && !terminalSeatHostsAgent(db, sessionName);
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
