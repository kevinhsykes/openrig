export {
  readLoadoutOwners,
  readProjectSkillSelection,
  readSystemSkillSelection,
  reconcileSkillLoadout,
  resolveSkillLoadout,
} from "./domain/skill-catalog.js";

export type {
  CatalogSkill,
  OrphanedOwnerReport,
  ReleasedOwnerRecord,
  ReconcileSkillLoadoutResult,
  ResolveSkillLoadoutResult,
  SkillCatalogFailure,
  SkillOwnerLiveness,
  SkillLoadout,
  SkillProjectionReceipt,
  SkillProjectionStatus,
  SkillRuntime,
  SkillSelectionSource,
} from "./domain/skill-catalog.js";

// OPR.0.7.0.13 (router): the seat's one generated router skill.
export { resolveSeatSkillRouter, writeSeatSkillRouter, SEAT_SKILL_ROUTER_ID } from "./domain/seat-skill-storage.js";
export type { SeatSkillRouter } from "./domain/seat-skill-storage.js";
