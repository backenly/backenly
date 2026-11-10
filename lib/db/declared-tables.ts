/**
 * Tables declared in SQL, which Backenly creates exactly as written.
 *
 * A table from apply_migration has the columns, keys, uniques and checks its
 * statement declares, and nothing its column names suggest
 * (lib/ai/minimal-executor.ts executeCreateTable, `asWritten`). Inference that
 * runs over the whole schema later, the foreign-key repair after every new
 * table (lib/ai/fk-repair.ts), would otherwise add to it what the statement
 * left out: a key with ON DELETE CASCADE on every `*_id`. This is the mark it
 * honours: project_preferences type `table_declared_in_sql`, key the table's
 * name, as the autonomy ledgers keep theirs.
 */
import { prisma } from '@/lib/db/prisma'

const TYPE = 'table_declared_in_sql'

export async function markDeclaredInSql(projectId: string, tableName: string): Promise<void> {
  const value = JSON.stringify({ declaredAt: new Date().toISOString() })
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: TYPE, key: tableName } },
    create: { projectId, type: TYPE, key: tableName, value, confidence: 1 },
    update: { value, lastSeen: new Date() },
  })
}

/** A table of that name built some other way since: inference applies to it again. */
export async function unmarkDeclaredInSql(projectId: string, tableName: string): Promise<void> {
  await prisma.projectPreference.deleteMany({ where: { projectId, type: TYPE, key: tableName } })
}

export async function tablesDeclaredInSql(projectId: string): Promise<Set<string>> {
  const rows = await prisma.projectPreference.findMany({ where: { projectId, type: TYPE }, select: { key: true } })
  return new Set(rows.map((r) => r.key))
}
