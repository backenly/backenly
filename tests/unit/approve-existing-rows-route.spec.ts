/**
 * An approved fix that rows already in the table refuse answers 409, not 500.
 *
 * Production QA (2026-11-16): Approve & fix on "reviews has a relation with no
 * foreign key constraint" answered HTTP 500 with Prisma's text on the card. A
 * key, a UNIQUE or a CHECK refused by the rows already there (23503, 23505,
 * 23514) is the data's answer and nothing changed: 409, the executor's plain
 * sentence, and a code that tells the page not to retry it.
 */

const mockOutcome: { result: Record<string, unknown> } = { result: {} }

jest.mock('@/lib/auth/route-protection', () => ({
  withProjectAccess: (handler: any) => (req: any) =>
    handler(req, { user: { userId: 'u-owner', email: 'owner@backenly.test' }, project: {}, projectId: req.projectId }),
}))
jest.mock('@/lib/edition/guard', () => ({
  canWriteProject: jest.fn(async () => true),
  canAdministerProject: jest.fn(async () => true),
}))
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    healthFinding: {
      findFirst: jest.fn(async () => ({
        id: 'f1', projectId: 'p1', type: 'missing_fk', status: 'pending_approval',
        details: { tableName: 'reviews', columnName: 'user_id' },
      })),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  },
}))
jest.mock('@/lib/core/auto-fix-engine', () => ({
  executeApprovedFix: jest.fn(async () => mockOutcome.result),
  revertAutoFix: jest.fn(),
}))
jest.mock('@/lib/data-plane/residency', () => ({
  quotesKeptHere: jest.fn(async () => true),
  quotedError: (message: string) => message,
  recordedResultMessage: (message: string) => message,
  recordedStatements: (statements: unknown) => statements,
}))
jest.mock('@/lib/operational-memory/held-action-targets', () => ({ heldActionRecord: jest.fn() }))
jest.mock('@/lib/operational-memory/ledger', () => ({ resolvePendingActionMemory: jest.fn() }))

import { POST as approve } from '@/app/api/projects/[id]/health/approve/route'

const REFUSAL =
  'Some rows in reviews have a user_id that matches no row in users, so the foreign key was not added and nothing ' +
  'changed. Correct or remove those rows first (PostgreSQL: insert or update on table "reviews" violates foreign key ' +
  'constraint "fk_reviews_user").'

async function approveF1() {
  const res: any = await approve({ projectId: 'p1', json: async () => ({ findingId: 'f1' }) } as any)
  return { status: res.status as number, body: await res.json() }
}

it('answers 409 with the plain sentence and EXISTING_ROWS when rows already in the table refuse the rule', async () => {
  mockOutcome.result = { success: false, message: REFUSAL, refusedByRows: true }
  expect(await approveF1()).toEqual({ status: 409, body: { success: false, error: REFUSAL, code: 'EXISTING_ROWS' } })
})

it('still answers 500 for a failure that is not about the rows', async () => {
  mockOutcome.result = { success: false, message: 'Execution failed: connection reset' }
  const out = await approveF1()
  expect(out.status).toBe(500)
  expect(out.body.code).toBeUndefined()
})
