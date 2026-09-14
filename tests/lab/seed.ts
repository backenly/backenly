/**
 * SELF-MAINTENANCE VALIDATION LAB — seeding
 * =========================================
 *
 * Materialises a `LabScenario` as a real project: a `User`, a `Project`, a
 * `workspace_<id>` schema containing genuine DDL, and optionally the ledger
 * state (findings, request logs) a phase under test needs to reason about.
 *
 * Everything here executes against a live PostgreSQL. The point of the lab is
 * that the catalog, constraints, views and statistics under test are the ones
 * Postgres actually reports, not a fixture's idea of them.
 *
 * Teardown drops the schema and the project rows. It never drops cluster-wide
 * objects (roles, extensions) — those are shared with whatever else is using
 * the database, and removing one because a test created it is how a test suite
 * breaks production.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import type { LabScenario } from './scenarios'

export interface SeededProject {
  projectId: string
  userId: string
  schema: string
  scenario: LabScenario
}

/** Ledger state to seed alongside the schema. */
export interface LedgerSpec {
  /**
   * Confirmed auto-fixes. Stamped exactly the way `auto-fix-engine` stamps one,
   * at `details.rollbackData.verification`, because that is the accessor the
   * trust scoreboard and the recurrence evaluator both read. A fixture that
   * invents its own shape would pass while production disagreed.
   */
  confirmedRepairs?: Array<{ type: string; table: string; column?: string; hoursAgo?: number }>
  /** Auto-fixes that ran but could not be proven to have closed the gap. */
  unverifiedRepairs?: Array<{ type: string; table: string; column?: string; hoursAgo?: number }>
  /** Findings the loop escalated instead of acting on. */
  escalations?: Array<{ type: string; table: string; hoursAgo?: number }>
  /** Server errors, attributed to a table through the generated data-plane path. */
  serverErrors?: Array<{ table: string; status?: number; hoursAgo?: number }>
  /** Governed changes, which the evaluator counts as churn. Amplifier only. */
  changes?: Array<{ table: string; hoursAgo?: number }>
}

const HOUR = 60 * 60 * 1000

function ago(hours = 1): Date {
  return new Date(Date.now() - hours * HOUR)
}

export async function seedScenario(
  prisma: PrismaClient,
  sc: LabScenario,
  ledger: LedgerSpec = {},
): Promise<SeededProject> {
  const userId = randomUUID()
  const projectId = randomUUID()
  const schema = `workspace_${projectId}`
  const q = (sql: string) => prisma.$executeRawUnsafe(sql)

  await prisma.user.create({
    data: {
      id: userId,
      email: `lab-${sc.id}+${userId.slice(0, 8)}@backenly.test`,
      name: `lab ${sc.id}`,
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({ data: { id: projectId, name: `lab-${sc.id}`, userId } })

  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)

  // Tables first, constraints after: a scenario may declare a foreign key to a
  // table defined later in the list, and ordering the bank by dependency would
  // make the scenarios harder to read than the seeding is to fix.
  for (const t of sc.tables) {
    await q(`CREATE TABLE "${schema}"."${t.name}" (${t.columns.join(', ')})`)
  }
  for (const t of sc.tables) {
    for (const [col, ref] of t.foreignKeys ?? []) {
      await q(
        `ALTER TABLE "${schema}"."${t.name}"
           ADD CONSTRAINT "fk_${t.name}_${col}"
           FOREIGN KEY ("${col}") REFERENCES "${schema}"."${ref}"(id)`,
      )
    }
  }

  for (const t of sc.tables) {
    if (t.seedRows) await insertRows(prisma, schema, t.name, t.columns, t.seedRows)
    if (t.rls) await q(`ALTER TABLE "${schema}"."${t.name}" ENABLE ROW LEVEL SECURITY`)
    for (const [i, body] of (t.policies ?? []).entries()) {
      await q(`CREATE POLICY "p_${t.name}_${i}" ON "${schema}"."${t.name}" ${body}`)
    }
  }

  for (const v of sc.views ?? []) {
    const select = v.select.replace(/\{schema\}/g, `"${schema}"`)
    await q(
      `CREATE ${v.materialized ? 'MATERIALIZED ' : ''}VIEW "${schema}"."${v.name}" AS ${select}`,
    )
  }

  // Statistics must exist before any probe with a row-count threshold can see
  // the rows. `reltuples` is -1 until the table is analysed, and several probes
  // treat that as "no evidence" — correctly, which means an un-analysed lab
  // project would report clean for the wrong reason.
  await q(`ANALYZE`)

  await seedLedger(prisma, projectId, userId, ledger)

  return { projectId, userId, schema, scenario: sc }
}

/**
 * Insert `n` rows, filling only the columns whose types this helper understands.
 *
 * Deliberately dumb: the lab needs tables that are non-empty so statistics
 * thresholds engage, not realistic data. Foreign key columns are left NULL,
 * which is valid and avoids ordering dependencies between tables.
 */
async function insertRows(
  prisma: PrismaClient,
  schema: string,
  table: string,
  columns: string[],
  n: number,
): Promise<void> {
  const idCol = columns.find(c => /^id\s/i.test(c))
  if (!idCol) return
  const textCols = columns
    .filter(c => /\b(text)\b/i.test(c))
    .map(c => c.split(/\s+/)[0])

  const cols = ['id', ...textCols]
  const values = Array.from({ length: n }, (_, i) => {
    const vals = [`gen_random_uuid()`, ...textCols.map(c => `'${c}_${i}'`)]
    return `(${vals.join(', ')})`
  }).join(', ')

  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES ${values}`,
  )
}

async function seedLedger(
  prisma: PrismaClient,
  projectId: string,
  userId: string,
  spec: LedgerSpec,
): Promise<void> {
  for (const r of spec.confirmedRepairs ?? []) {
    await prisma.healthFinding.create({
      data: {
        projectId,
        type: r.type,
        severity: 'warning',
        status: 'auto_fixed',
        autoFixed: true,
        fixAppliedAt: ago(r.hoursAgo ?? 24),
        details: {
          tableName: r.table,
          ...(r.column ? { columnName: r.column } : {}),
          rollbackData: { verification: 'confirmed' },
        },
      },
    })
  }

  for (const r of spec.unverifiedRepairs ?? []) {
    await prisma.healthFinding.create({
      data: {
        projectId,
        type: r.type,
        severity: 'warning',
        status: 'auto_fixed',
        autoFixed: true,
        fixAppliedAt: ago(r.hoursAgo ?? 24),
        details: {
          tableName: r.table,
          ...(r.column ? { columnName: r.column } : {}),
          rollbackData: { verification: 'unverified' },
        },
      },
    })
  }

  for (const e of spec.escalations ?? []) {
    await prisma.healthFinding.create({
      data: {
        projectId,
        type: e.type,
        severity: 'warning',
        status: 'pending_approval',
        autoFixed: false,
        detectedAt: ago(e.hoursAgo ?? 12),
        details: { tableName: e.table },
      },
    })
  }

  for (const s of spec.serverErrors ?? []) {
    await prisma.apiRequestLog.create({
      data: {
        projectId,
        userId,
        method: 'GET',
        path: `/api/v1/${projectId}/db/${s.table}`,
        statusCode: s.status ?? 500,
        duration: 25,
        timestamp: ago(s.hoursAgo ?? 6),
      },
    })
  }

  for (const c of spec.changes ?? []) {
    await prisma.backendEvent.create({
      data: {
        projectId,
        eventType: 'schema_changed',
        actorType: 'backenly_agent',
        summary: `Altered ${c.table}`,
        // Resource identity lives inside beforeState on the executor path. The
        // evaluator reads it from there, so the lab writes it there too rather
        // than inventing a shape production does not produce.
        beforeState: { resourceType: 'table', resource: c.table },
        riskLevel: 'low',
        status: 'applied',
        createdAt: ago(c.hoursAgo ?? 48),
      },
    })
  }
}

export async function teardownScenario(
  prisma: PrismaClient,
  seeded: SeededProject,
): Promise<void> {
  await prisma
    .$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${seeded.schema}" CASCADE`)
    .catch(() => {})
  // Project delete cascades findings, request logs and backend events.
  await prisma.project.deleteMany({ where: { id: seeded.projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: seeded.userId } }).catch(() => {})
}
