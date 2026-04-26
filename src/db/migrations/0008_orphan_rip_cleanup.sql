-- Cleanup orphaned pack_rips: rows whose user no longer owns ANY of
-- the books that were pulled. Surfaces in the /feed You tab where
-- "every rip you've opened" was misleading because the underlying
-- collection state had been wiped (early dev data + any future
-- collection-reset operation).
--
-- Truthful definition: a rip stays only if the user still owns at
-- least one of the books listed in pulled_book_ids. Otherwise the
-- rip event has no ongoing artifact to point at and is removed.
--
-- Idempotent: subsequent runs match no rows. Cascades:
--   • shard_events.rip_id is set null on rip delete (FK already
--     declared with on delete set null), so dupe-refund audit rows
--     keep their value but lose the (already meaningless) rip
--     pointer.
-- This migration is irreversible by design.

DELETE FROM pack_rips pr
WHERE NOT EXISTS (
  SELECT 1
  FROM unnest(pr.pulled_book_ids) AS pulled_id
  INNER JOIN collection_cards cc
    ON cc.user_id = pr.user_id
   AND cc.book_id = pulled_id
);
