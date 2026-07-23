/**
 * BACKFILL: heal the shared set_updated_at() trigger function in every existing
 * workspace schema.
 *
 * WHY: the function used to be `NEW."updatedAt" = NOW()`, which raised
 *   record "new" has no field "updatedAt"   (SQLSTATE 42703)
 * on every UPDATE of any table whose updated-at column was not that exact
 * camelCase name (snake_case `updated_at`, adopted tables, junction tables,
 * or none). New builds already install the fixed, column-agnostic function —
 * but projects built BEFORE the fix keep the broken function until their next
 * create_table. This script replaces it everywhere, once.
 *
 * SAFE: it only runs CREATE OR REPLACE FUNCTION (no table/data/trigger changes)
 * and is fully idempotent. Triggers already point at the shared function name,
 * so replacing the body upgrades every table in the schema at once.
 *
 * Run:  npx tsx scripts/fix-updated-at-trigger.ts
 */

import { prisma } from '@/lib/db/prisma'

const FIXED_BODY = (schema: string) => `
  CREATE OR REPLACE FUNCTION "${schema}".set_updated_at()
  RETURNS TRIGGER AS $$
  BEGIN
    IF to_jsonb(NEW) ? 'updatedAt' THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('updatedAt', NOW()));
    ELSIF to_jsonb(NEW) ? 'updated_at' THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('updated_at', NOW()));
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`

async function main() {
  // Every workspace schema that actually has the shared function installed.
  const rows = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT n.nspname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'set_updated_at'
        AND n.nspname LIKE 'workspace_%'
      ORDER BY n.nspname`,
  )

  console.log(`[fix-updated-at] ${rows.length} workspace schema(s) have set_updated_at() — healing…`)

  let ok = 0
  let failed = 0
  for (const { nspname } of rows) {
    try {
      await prisma.$executeRawUnsafe(FIXED_BODY(nspname))
      ok++
    } catch (err: any) {
      failed++
      console.error(`[fix-updated-at] ✗ ${nspname}: ${err?.message ?? err}`)
    }
  }

  console.log(`[fix-updated-at] done — ${ok} healed, ${failed} failed.`)
  await prisma.$disconnect()
  if (failed > 0) process.exit(1)
}

main().catch(async (err) => {
  console.error('[fix-updated-at] fatal:', err)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
