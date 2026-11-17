/**
 * @jest-environment jsdom
 */
/**
 * The Detected panel says "Fixed on the next pass" only for a repair the loop
 * applies on its own. A hot table's index waits for a person (#679), and no
 * loop applies an open hot-table finding, yet an old row of one was listed as
 * queued for Backenly's next pass, with Fix now, six days after it was raised
 * (production QA, 2026-11-16).
 */
import { act, render, screen } from '@testing-library/react'
import { DetectedFindingsPanel } from '@/components/DetectedFindingsPanel'

const now = new Date().toISOString()

function stub(findings: unknown[]) {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ data: { findings, actionableTotal: findings.length, needsAttention: 0 } }),
    } as Response),
  ) as unknown as typeof fetch
}

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })

async function rowFor(text: RegExp): Promise<HTMLElement> {
  return (await screen.findAllByText(text))[0].closest('li') as HTMLElement
}

it('does not promise the next pass for a hot table, whose index waits for a person', async () => {
  stub([{
    id: 'h1',
    type: 'infra_hot_table_product_views',
    severity: 'warning',
    status: 'open',
    detectedAt: now,
    details: { title: 'Hot table: product_views', table: 'product_views', tableName: 'product_views', columnName: 'referrer', requiresApproval: false },
  }])
  render(<DetectedFindingsPanel projectId="p1" level="AGGRESSIVE" />)
  await settle()
  const row = await rowFor(/product_views/)
  expect(row.textContent).not.toMatch(/Fixed on the next pass/)
  expect(row.textContent).toMatch(/Fix now to apply it/)
})

it('still promises it for a repair the loop applies on its own', async () => {
  stub([{
    id: 'i1',
    type: 'missing_fk_index',
    severity: 'info',
    status: 'open',
    detectedAt: now,
    details: { tableName: 'reviews', columnName: 'product_id', reason: 'Column "product_id" has a foreign key but no index' },
  }])
  // Another project: the panel's read of /health is shared for a moment (lib/client/shared-read.ts).
  render(<DetectedFindingsPanel projectId="p2" level="AGGRESSIVE" />)
  await settle()
  const row = await rowFor(/reviews/)
  expect(row.textContent).toMatch(/Fixed on the next pass/)
})
