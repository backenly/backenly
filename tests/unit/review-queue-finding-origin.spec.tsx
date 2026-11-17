/**
 * @jest-environment jsdom
 */

/**
 * Who raised a finding, as a Review Queue card says it. `details.source` holds
 * either who raised a finding (the backend build's reports, an agent's held
 * call, an import) or what a detector read (`pg_stat_statements`). A slow query
 * Backenly measured itself was labelled "From the backend build" (production
 * QA, 2026-11-16).
 */

import { act, render, screen } from '@testing-library/react'
import { ReviewQueuePanel } from '@/components/ReviewQueuePanel'
import { findingOrigin, findingOriginLabel } from '@/lib/core/finding-origin'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
}))

const now = new Date().toISOString()

/** A held finding as GET /api/projects/[id]/autonomy lists it (lib/autonomy/trust-report.ts). */
function held(id: string, type: string, reason: string, details: Record<string, unknown>) {
  return {
    id,
    type,
    severity: 'warning',
    detectedAt: now,
    heldBecause: { kind: 'held', text: 'Waiting for your review.' },
    reason,
    source: (details.source as string | undefined) ?? 'autonomy',
    resource: details.location ?? details.tableName,
    details,
  }
}

let pending: unknown[] = []

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path.endsWith('/autonomy')) return Promise.resolve(json(200, { pendingApprovals: pending }))
    if (path.endsWith('/agent-approvals')) return Promise.resolve(json(200, { success: true, approvals: [] }))
    return Promise.resolve(json(404, {}))
  }) as unknown as typeof fetch
})

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

async function cardFor(text: RegExp): Promise<HTMLElement> {
  return (await screen.findByText(text)).closest('li') as HTMLElement
}

it('does not credit the backend build with a slow query Backenly measured', async () => {
  pending = [
    held('f1', 'slow_query_missing_index', 'Queries filtering product_views.referrer are averaging 180ms with no index on that column', {
      tableName: 'product_views',
      columnName: 'referrer',
      location: 'product_views.referrer',
      avgMs: 180,
      calls: 40,
      source: 'pg_stat_statements',
    }),
  ]
  render(<ReviewQueuePanel projectId="p1" />)
  const card = await cardFor(/Queries filtering product_views\.referrer/)
  await settle()
  expect(card.textContent).not.toMatch(/From the backend build/)
})

it('still credits the backend build, an agent and an import with what they raised', () => {
  expect(findingOriginLabel('plan_validator')).toBe('From the backend build')
  expect(findingOriginLabel('behavior_verification')).toBe('From the backend build')
  expect(findingOriginLabel('orchestration-risk')).toBe('From the backend build')
  expect(findingOriginLabel('brain-risk')).toBe('Raised by an AI agent')
  expect(findingOriginLabel('import')).toBe('From the import')
})

it('labels nothing Backenly\'s own checks found', () => {
  for (const source of ['pg_stat_statements', 'infra_intelligence', 'autonomy', undefined, null]) {
    expect(findingOrigin(source)).toBe('backenly')
    expect(findingOriginLabel(source)).toBeNull()
  }
})
