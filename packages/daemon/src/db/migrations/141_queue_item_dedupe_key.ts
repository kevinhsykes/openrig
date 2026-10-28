import type { Migration } from "../migrate.js";

/**
 * queue_items.dedupe_key — conditional create (D4222).
 *
 * Adds `dedupe_key TEXT` (NULLABLE): an optional caller-chosen key. Over (destination_session, dedupe_key), at
 * most one OPEN row (pending, in-progress, blocked) may hold a key; a closed row frees it. A create that finds
 * an open holder returns it instead of writing a second row. Rows without a key are not in the index.
 *
 * Additive by contract: every existing row stays NULL, nothing is backfilled, and a writer that never names the
 * column (an older daemon after a rollback) inserts NULL, which the partial index ignores. The statement list
 * matters: the index is created WITH its predicate, never as a plain unique index.
 *
 * The open-state list is the one the stuck sweep uses (queue-stuck-sweep.ts) and the repository's isBlockerLive.
 *
 * Base table: 024_queue_items.ts. Numbering: the next free number after 140.
 */
export const queueItemDedupeKeySchema: Migration = {
  name: "141_queue_item_dedupe_key.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN dedupe_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_items_open_dedupe
      ON queue_items(destination_session, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'in-progress', 'blocked');
  `,
};
