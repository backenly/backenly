-- Did a FAILED attempt at 20260924120000_project_pause leave anything behind?
--
-- `rollback 20260924120000_project_pause` runs this before it marks the failed
-- history row as rolled back. Marking it tells Prisma the migration never ran,
-- and the next deploy applies it from the top. If any of its effects were
-- present, that retry would fail again, or worse, succeed on top of a schema
-- that is half one thing and half the other. So resolving is allowed only when
-- EVERY declared effect is absent, and any one of them refuses.
--
-- The list is the migration's full declaration: one enum value, two `plans`
-- columns, five `projects` columns, one index.
-- tests/unit/migration-runner-checks.spec.ts holds this file to the migration
-- text, so an edit to one without the other fails there.
--
-- The tables it changes must EXIST. "The column is absent" says nothing on a
-- database that has no `projects` table, so that case refuses too rather than
-- passing.

DO $$
DECLARE
  present text := '';
  c record;
BEGIN
  IF to_regclass('public.projects') IS NULL OR to_regclass('public.plans') IS NULL
     OR to_regtype('public."WebhookDeliveryStatus"') IS NULL THEN
    RAISE EXCEPTION 'absence proof refused: this is not a Backenly platform schema (projects, plans or WebhookDeliveryStatus is missing)';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_enum e
              WHERE e.enumtypid = 'public."WebhookDeliveryStatus"'::regtype
                AND e.enumlabel = 'CANCELLED') THEN
    present := present || E'\n  enum value WebhookDeliveryStatus.CANCELLED';
  END IF;

  FOR c IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'plans' AND column_name IN ('inactivityPauseDays', 'pausedFreeResumeDays'))
         OR (table_name = 'projects' AND column_name IN
               ('pausedAt', 'pauseReason', 'pauseWarnedAt', 'lastActivityAt', 'pausePolicySince')))
     ORDER BY 1, 2
  LOOP
    present := present || E'\n  column ' || c.table_name || '.' || c.column_name;
  END LOOP;

  IF to_regclass('public."projects_pausedAt_idx"') IS NOT NULL THEN
    present := present || E'\n  index projects_pausedAt_idx';
  END IF;

  IF present <> '' THEN
    RAISE EXCEPTION 'absence proof failed: 20260924120000_project_pause left declared effects behind:%', present;
  END IF;
END $$;
