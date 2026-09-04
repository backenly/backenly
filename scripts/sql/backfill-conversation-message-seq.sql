-- Reorder conversation_messages.messageSeq for a deployment that already had
-- messages before the column existed.
--
-- WHO NEEDS THIS
-- Only an existing deployment. A fresh install never does: the column defaults
-- to nextval, so every row is numbered in insertion order from the start.
--
-- `prisma db push` adds the column as BIGSERIAL, which fills existing rows from
-- the sequence in whatever order Postgres happens to scan the heap. That order
-- is arbitrary and would scramble history that is not ambiguous at all, so this
-- reassigns every row using the best ordering the old data can support.
--
-- WHAT IT CAN AND CANNOT RECOVER
-- The ordering key below is, in order:
--
--   1. createdAt
--   2. snapshotSeq, for the build-snapshot messages that carry one
--   3. messages without a snapshotSeq LAST within a millisecond, matching the
--      Infinity default the application already used: recordBuildSnapshot
--      writes its user and ai rows together, so anything appended afterwards
--      genuinely came later
--   4. id, purely to make the result deterministic
--
-- Step 4 is not causality and is not claimed to be. Two plain messages written
-- in the same millisecond have no recoverable order: createdAt ties, neither
-- has a snapshotSeq, and the ids are random v4 UUIDs. This puts them in a
-- stable order, not their true one. That information was never recorded and
-- cannot be reconstructed here. It is why the column exists going forward.
--
-- Safe to run more than once. The ordering key is deterministic, so a second
-- run produces the same sequence of rows; only the absolute numbers shift.
--
--   psql -d <database> -f scripts/sql/backfill-conversation-message-seq.sql

DO $backfill$
DECLARE
  offset_from bigint;
  reordered   bigint;
BEGIN
  -- New values are assigned ABOVE every existing one. The unique index on
  -- messageSeq is checked per row as the UPDATE walks, not at commit, so
  -- renumbering in place would collide partway through even though the final
  -- state is unique.
  SELECT coalesce(max("messageSeq"), 0) INTO offset_from FROM conversation_messages;

  WITH ordered AS (
    SELECT
      id,
      row_number() OVER (
        ORDER BY
          "createdAt" ASC,
          -- The application's Infinity default, spelled as the largest bigint.
          -- A metadata value that is not a plain integer is treated as absent
          -- rather than cast, because a cast failure here would abort the whole
          -- backfill over one malformed row.
          CASE
            WHEN metadata ->> 'snapshotSeq' ~ '^[0-9]+$'
              THEN (metadata ->> 'snapshotSeq')::bigint
            ELSE 9223372036854775807
          END ASC,
          id ASC
      ) AS rn
    FROM conversation_messages
  )
  UPDATE conversation_messages m
     SET "messageSeq" = o.rn + offset_from
    FROM ordered o
   WHERE m.id = o.id;

  GET DIAGNOSTICS reordered = ROW_COUNT;

  -- Leave the sequence above every assigned value, or the next insert reuses
  -- one and violates the unique index.
  PERFORM setval(
    pg_get_serial_sequence('conversation_messages', 'messageSeq'),
    (SELECT coalesce(max("messageSeq"), 0) + 1 FROM conversation_messages),
    false
  );

  RAISE NOTICE 'conversation_messages: reordered % row(s)', reordered;
END $backfill$;
