/**
 * MISSING FK — proposed, never applied, and the proposal names the delete rule
 * ----------------------------------------------------------------------------
 * `missing_fk` was classified `auto` on the reasoning that adding a foreign key
 * is "safe when data is consistent". Two things were wrong with that:
 *
 *   1. A foreign key is not additive. From the moment it exists the database
 *      rejects writes it previously accepted, so application code that inserted
 *      a child before its parent starts failing with nothing in the schema to
 *      explain why.
 *
 *   2. The repair also picks the cascade rule, and getCascadeRule's default
 *      branch is ON DELETE CASCADE. The loop was therefore inferring from a
 *      column name that deleting one row should silently delete every row
 *      referencing it — a destructive change to application semantics, applied
 *      without asking.
 *
 * These pin both halves of the fix: the type is approval-gated, and the finding
 * carries the exact ON DELETE rule so the approval is about the behaviour rather
 * than about the word "constraint".
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { detectFkColumnsMissingConstraints } from '@/lib/core/drift-detector'
import { classifyFix } from '@/lib/core/fix-classifier'
import { deriveTier } from '@/lib/autonomy/desired-state'
import { buildFixAction } from '@/lib/core/fix-actions'
import { plannedCascadeRule } from '@/lib/ai/fk-repair'

let userId: string
let projectId: string
let schema: string
let findings: Awaited<ReturnType<typeof detectFkColumnsMissingConstraints>>

const byLocation = (table: string, column: string) =>
  findings.find(f => {
    const d = f.details as any
    return d.tableName === table && d.columnName === column
  })

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `missing-fk-${Date.now()}@example.test`, password: 'x', name: 'fk' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'missing-fk-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  const raw = (sql: string) => prisma.$executeRawUnsafe(sql)
  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}"."users" (id uuid primary key default gen_random_uuid(), email text)`)
  await raw(`CREATE TABLE "${schema}"."posts" (id serial primary key, title text)`)
  await raw(`CREATE TABLE "${schema}"."orders" (id serial primary key, user_id uuid NOT NULL, total numeric)`)
  // An audit table, which the cascade heuristic deliberately treats differently.
  await raw(`CREATE TABLE "${schema}"."audit_logs" (id serial primary key, user_id uuid, what text)`)

  findings = await detectFkColumnsMissingConstraints(projectId)
}, 60_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('missing_fk is a proposal', () => {
  test('the detector finds the relationships', () => {
    expect(byLocation('orders', 'user_id')).toBeDefined()
    expect(byLocation('audit_logs', 'user_id')).toBeDefined()
  })

  test('no missing_fk finding is marked auto-fixable', () => {
    for (const f of findings) expect(f.autoFixable).toBe(false)
  })

  test('the classifier gates it on approval, with a risk note', () => {
    const c = classifyFix('missing_fk', byLocation('orders', 'user_id')!.details as any)
    expect(c.decision).toBe('approval')
    expect(c.riskNote).toMatch(/ON DELETE CASCADE/)
  })

  test('the reconciler tiers it as needing approval, at every autonomy level', () => {
    // Tier 2 is the floor the dial cannot lower — see the reconciler's gap loop.
    expect(deriveTier('missing_fk', byLocation('orders', 'user_id')!.details as any)).toBe(2)
  })

  test('the finding names the exact delete rule that would be installed', () => {
    const d = byLocation('orders', 'user_id')!.details as any
    expect(d.referencedTable).toBe('users')
    expect(d.onDelete).toBe('CASCADE')
    // The consequence has to be in the sentence a human reads, not only in a
    // field a developer could inspect.
    expect(d.reason).toMatch(/ON DELETE CASCADE/)
    expect(d.reason).toMatch(/also delete every "orders" row/i)
  })

  test('the preview is computed with the function the executor uses', () => {
    // If these ever diverge, the approval describes one behaviour and the DDL
    // installs another.
    const d = byLocation('audit_logs', 'user_id')!.details as any
    const planned = plannedCascadeRule('user_id', 'audit_logs', { selfRef: false, nullable: true })
    expect(d.onDelete).toBe(planned.onDelete)
    // Audit tables preserve history rather than cascading — proof the rule is
    // being computed rather than hardcoded to CASCADE in the detector.
    expect(d.onDelete).toBe('SET NULL')
    expect(d.reason).toMatch(/blank "user_id"/i)
  })

  test('approving it still has a real repair behind the button', () => {
    const d = byLocation('orders', 'user_id')!.details as any
    expect(buildFixAction('missing_fk', d)).toEqual({
      action: 'ADD_CONSTRAINT',
      params: {
        tableName: 'orders',
        columnName: 'user_id',
        referencedTable: 'users',
        referencedColumn: 'id',
      },
    })
  })
})
