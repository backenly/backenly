/**
 * @jest-environment jsdom
 */
/**
 * Fix now says "Rollback snapshot captured" only when the approve route kept
 * one. Production QA (2026-11-09): approving an index fix returned
 * snapshotId: null, and the panel said a snapshot was captured anyway.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { DetectedFindingsPanel } from '@/components/DetectedFindingsPanel'

const FINDING = {
  id: 'f1',
  type: 'slow_query_missing_index',
  severity: 'warning',
  status: 'open',
  detectedAt: new Date().toISOString(),
  details: { tableName: 'orders', columnName: 'status' },
}

function stub(snapshotId: string | null) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    const body = path.endsWith('/health/approve')
      ? { success: true, snapshotId }
      : { data: { findings: [FINDING], actionableTotal: 1, needsAttention: 0 } }
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
}

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })

async function fixNow() {
  render(<DetectedFindingsPanel projectId="p1" level="BALANCED" />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: /Fix now/ }))
  await settle()
  expect(screen.getByText('Fixed')).toBeInTheDocument()
}

it('does not claim a snapshot the fix did not keep', async () => {
  stub(null)
  await fixNow()
  expect(screen.queryByText(/snapshot/i)).toBeNull()
})

it('says a snapshot was captured when one was', async () => {
  stub('snap_1')
  await fixNow()
  expect(screen.getByText('Rollback snapshot captured')).toBeInTheDocument()
})
