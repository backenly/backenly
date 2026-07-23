// lib/ai/agents/repair-agent.ts
/** Repair specialist agent: finds API-less tables, missing realtime triggers, and orphaned FK references. */

import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import type { AgentInput, AgentResult, AgentFinding } from './types'

function makeId(): string {
  return `finding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export async function runRepairAgent(input: AgentInput): Promise<AgentResult> {
  const start = Date.now()
  const findings: AgentFinding[] = []
  const autoFixed: string[] = []

  const { projectId, tables } = input

  if (tables.length === 0) {
    return { agentType: 'repair', durationMs: Date.now() - start, findings, autoFixed, skipped: true }
  }

  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    // ── 1. Tables with no corresponding API definition ────────────────────
    try {
      const apiDefs = await prisma.apiDefinition.findMany({
        where: { projectId },
        select: { name: true },
      })
      const apiTableNames = new Set(apiDefs.map((a: { name: string }) => a.name.toLowerCase()))

      const noApiTables = tables.filter(
        t => t !== 'users' && !apiTableNames.has(t.toLowerCase()),
      )

      for (const tbl of noApiTables) {
        findings.push({
          id: makeId(),
          agentType: 'repair',
          category: 'missing_api',
          severity: 'high',
          title: `Table "${tbl}" has no REST API`,
          description: `Table "${tbl}" exists in the workspace schema but has no generated REST endpoints. It cannot be accessed from the SDK or any frontend.`,
          location: tbl,
          fix: {
            description: `Generate REST API endpoints (list, create, get, update, delete) for table "${tbl}".`,
            executorAction: 'GENERATE_API',
            executorParams: { tableName: tbl },
            reversible: true,
            requiresApproval: false,
          },
        })
      }
    } catch {
      // Non-fatal — Prisma may fail if DB not ready
    }

    // ── 2. Realtime triggers: tables present but no DB triggers defined ────
    try {
      const triggerRes = await pool.query<{ trigger_name: string }>(
        `SELECT trigger_name
         FROM information_schema.triggers
         WHERE trigger_schema = $1`,
        [postgresSchema],
      )
      const triggerCount = triggerRes.rows.length

      if (tables.length > 0 && triggerCount === 0) {
        findings.push({
          id: makeId(),
          agentType: 'repair',
          category: 'missing_realtime_triggers',
          severity: 'medium',
          title: 'No realtime triggers configured',
          description: `The workspace has ${tables.length} table(s) but no database triggers for realtime change events. SDK subscriptions (backend.table.subscribe()) will not fire.`,
          location: 'realtime',
          fix: {
            description: 'Enable realtime triggers for workspace tables so change events are broadcast to subscribers.',
            reversible: true,
            requiresApproval: true,
          },
        })
      }
    } catch {
      // Non-fatal — trigger query may fail on restricted schemas
    }

    // ── 3. Orphaned FK columns referencing non-existent tables ────────────
    try {
      const fkRes = await pool.query<{
        table_name: string
        column_name: string
        foreign_table_name: string
      }>(
        `SELECT
           kcu.table_name,
           kcu.column_name,
           ccu.table_name AS foreign_table_name
         FROM information_schema.key_column_usage kcu
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = kcu.constraint_name
          AND rc.constraint_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = rc.unique_constraint_name
          AND ccu.table_schema    = kcu.table_schema
         WHERE kcu.table_schema = $1`,
        [postgresSchema],
      )

      // Get the live table list for existence check
      const liveTablesRes = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [postgresSchema],
      )
      const liveTableSet = new Set(liveTablesRes.rows.map(r => r.table_name))

      for (const fk of fkRes.rows) {
        if (!liveTableSet.has(fk.foreign_table_name)) {
          findings.push({
            id: makeId(),
            agentType: 'repair',
            category: 'orphaned_fk',
            severity: 'critical',
            title: `Orphaned FK on "${fk.table_name}.${fk.column_name}"`,
            description: `Column "${fk.column_name}" in table "${fk.table_name}" references "${fk.foreign_table_name}", which no longer exists. Inserts into this column will fail with a constraint violation.`,
            location: fk.table_name,
            fix: {
              description: `Drop the broken foreign-key constraint from "${fk.table_name}.${fk.column_name}" or recreate the missing target table.`,
              reversible: false,
              requiresApproval: true,
            },
          })
        }
      }
    } catch {
      // Non-fatal — FK introspection may fail on restricted connections
    }
  } catch {
    // Top-level guard — never throw
  } finally {
    try { await pool.end() } catch { /* ignore */ }
  }

  return {
    agentType: 'repair',
    durationMs: Date.now() - start,
    findings,
    autoFixed,
    skipped: false,
  }
}
