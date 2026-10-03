-- Did 20260924120000_project_pause actually land, exactly as declared?
--
-- `verify 20260924120000_project_pause` runs this after a deploy. `migrate
-- status` reports that the history table says the migration ran. This reads
-- the objects themselves: every column with the type the migration gave it,
-- the index on the column it names, and the enum value.
--
-- The mirror of 20260924120000_project_pause.absent.sql, and held to the
-- migration text by the same test.

DO $$
DECLARE
  missing text := '';
  want record;
  got record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e
                  WHERE e.enumtypid = to_regtype('public."WebhookDeliveryStatus"')
                    AND e.enumlabel = 'CANCELLED') THEN
    missing := missing || E'\n  enum value WebhookDeliveryStatus.CANCELLED';
  END IF;

  FOR want IN
    SELECT * FROM (VALUES
      ('plans',    'inactivityPauseDays',  'integer'),
      ('plans',    'pausedFreeResumeDays', 'integer'),
      ('projects', 'pausedAt',             'timestamp(3) without time zone'),
      ('projects', 'pauseReason',          'text'),
      ('projects', 'pauseWarnedAt',        'timestamp(3) without time zone'),
      ('projects', 'lastActivityAt',       'timestamp(3) without time zone'),
      ('projects', 'pausePolicySince',     'timestamp(3) without time zone')
    ) AS w(tbl, col, typ)
  LOOP
    SELECT format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS notnull
      INTO got
      FROM pg_attribute a
     WHERE a.attrelid = to_regclass('public.' || quote_ident(want.tbl))
       AND a.attname = want.col
       AND NOT a.attisdropped;
    IF NOT FOUND THEN
      missing := missing || E'\n  column ' || want.tbl || '.' || want.col;
    ELSIF got.typ <> want.typ THEN
      missing := missing || E'\n  column ' || want.tbl || '.' || want.col || ' is ' || got.typ || ', expected ' || want.typ;
    ELSIF got.notnull THEN
      -- Every one of them is nullable on purpose: NULL is "nothing changes".
      missing := missing || E'\n  column ' || want.tbl || '.' || want.col || ' is NOT NULL, expected nullable';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE ic.relname = 'projects_pausedAt_idx'
       AND ic.relnamespace = 'public'::regnamespace
       AND i.indrelid = to_regclass('public.projects')
       AND i.indnatts = 1
       AND a.attname = 'pausedAt'
  ) THEN
    missing := missing || E'\n  index projects_pausedAt_idx on projects("pausedAt")';
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'verification failed: 20260924120000_project_pause declared objects that are absent or different:%', missing;
  END IF;
END $$;
