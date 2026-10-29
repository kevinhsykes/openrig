// P37b — does the seat that owns a kept skill selection still exist?
//
// The skill loadout manifest of a working folder keeps, per owner (a seat's canonical session name, `pod-member@rig`), the skills
// that owner selected. When the seat is gone (renamed, replaced, its rig archived) nobody refreshes those selections any more.
// This answers, for each owner string, "live", "orphaned" (with the reason) or "unknown". Anything it cannot establish is
// "unknown", which every caller treats as live: a read problem never releases anyone's selection.
import type Database from "better-sqlite3";
import { deriveCanonicalSessionName } from "./session-name.js";
import type { SkillOwnerLiveness } from "./skill-catalog.js";

interface NodeRow { logical_id: string; rig_name: string; rig_archived: string | null; live_sessions: number; total_sessions: number }

/** A seat identity is `pod-member@rig`. Anything else ("workspace", a folder-mode owner) is not a seat and cannot be judged. */
const SEAT_IDENTITY = /^[^@\s]+@[^@\s]+$/;

export function ownerLiveness(db: Database.Database, owners: readonly string[]): Record<string, SkillOwnerLiveness> {
  const out: Record<string, SkillOwnerLiveness> = {};
  let rows: NodeRow[];
  try {
    rows = db.prepare(`
      SELECT n.logical_id AS logical_id, r.name AS rig_name, r.archived_at AS rig_archived,
             (SELECT COUNT(*) FROM sessions s WHERE s.node_id = n.id AND s.status != 'superseded') AS live_sessions,
             (SELECT COUNT(*) FROM sessions s WHERE s.node_id = n.id) AS total_sessions
      FROM nodes n JOIN rigs r ON r.id = n.rig_id`).all() as NodeRow[];
  } catch (error) {
    for (const owner of owners) out[owner] = { state: "unknown", reason: `seat state could not be read (${(error as Error).message})` };
    return out;
  }
  const byName = new Map<string, NodeRow[]>();
  for (const row of rows) {
    const dot = row.logical_id.indexOf(".");
    if (dot <= 0 || dot === row.logical_id.length - 1) continue;
    const name = deriveCanonicalSessionName(row.logical_id.slice(0, dot), row.logical_id.slice(dot + 1), row.rig_name);
    byName.set(name, [...(byName.get(name) ?? []), row]);
  }
  for (const owner of owners) {
    if (!SEAT_IDENTITY.test(owner)) { out[owner] = { state: "unknown", reason: "not a seat identity" }; continue; }
    const nodes = byName.get(owner) ?? [];
    if (nodes.length === 0) { out[owner] = { state: "orphaned", reason: `no node named ${owner} in any rig` }; continue; }
    // A seat that exists in a live rig, even stopped or never launched, comes back and re-selects: live. A seat whose rig is
    // archived, or whose every session was superseded, has been retired.
    const active = nodes.filter((node) => node.rig_archived === null);
    if (active.length === 0) { out[owner] = { state: "orphaned", reason: `${owner} exists only in an archived rig` }; continue; }
    if (active.every((node) => node.total_sessions > 0 && node.live_sessions === 0)) {
      out[owner] = { state: "orphaned", reason: `${owner} has only superseded sessions` };
      continue;
    }
    out[owner] = { state: "live" };
  }
  return out;
}
