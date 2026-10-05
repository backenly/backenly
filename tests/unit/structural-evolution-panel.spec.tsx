/**
 * @jest-environment jsdom
 */

/**
 * The Evolution view in the Database section (components/database/
 * StructuralEvolutionPanel.tsx). What it must never do is let a person approve
 * SQL that has not been rehearsed — or approve a different plan from the one
 * they rehearsed, which is what renaming the new table after rehearsing would
 * otherwise do.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { StructuralEvolutionPanel } from '@/components/database/StructuralEvolutionPanel'

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

const PROPOSAL = {
  key: 'orders:refund_amount,refund_reason',
  planId: 'plan1',
  host: 'orders',
  label: 'refund',
  members: ['refund_amount', 'refund_reason'],
  state: 'proposed',
  verdict: 'Proposed: refund_amount, refund_reason behave as one refund concern and keeping them on orders has a measured cost.',
  families: [
    { family: 'lexical', verdict: 'supports', detail: 'all named for "refund"' },
    { family: 'co_presence', verdict: 'supports', detail: 'set on the same rows' },
    { family: 'lifecycle', verdict: 'unavailable', detail: 'rows could not be read' },
  ],
  pressure: [{ kind: 'hot_host_change', detail: 'changing this concern took an exclusive lock on orders' }],
  presenceRate: 0.2,
  priority: { score: 72, label: 'high' },
  spec: { host: 'orders', members: ['refund_amount', 'refund_reason'], satellite: 'order_refunds', label: 'refund' },
  plan: {
    planVersion: 'v-default',
    validity: 'executable',
    blockedReasons: [],
    contractBlockers: ['PostgREST clients and direct connection strings choose their own columns and cannot be enumerated'],
    caveats: [],
    access: { readers: ['authenticated'], writers: ['authenticated'] },
    steps: [
      { ordinal: 0, kind: 'rehearse', tier: 0, capability: 'implemented', title: 'Rehearse on a copy of real rows', why: '…', sql: [], rollback: { strategy: 'none_required', description: '' } },
      { ordinal: 8, kind: 'contract', tier: 3, capability: 'human_only', title: 'Retire orders.refund_amount, refund_reason', why: '…', sql: ['ALTER TABLE …'], rollback: null },
    ],
    requiredTier: 2,
  },
  consent: null,
  lastRun: null,
  clientMigration: [{ purpose: 'read the concern with its parent', before: 'GET /db/orders?select=id,refund_amount', after: 'GET /db/orders?select=id,order_refunds(refund_amount)' }],
}

const REHEARSAL = {
  planVersion: 'v-default',
  rehearsal: {
    passed: true,
    sampledRows: 260,
    exercises: [{ name: 'backfill', outcome: 'passed', detail: '60 rows copied' }],
    notRehearsed: [],
    error: null,
  },
}

async function mount() {
  const fetchMock = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (!init || !init.method) return Promise.resolve(json(200, { proposals: [PROPOSAL], watching: [], limits: [], windowDays: 90 }))
    const body = JSON.parse(String(init.body ?? '{}'))
    if (body.action === 'rehearse') return Promise.resolve(json(200, REHEARSAL))
    if (body.action === 'approve') return Promise.resolve(json(200, { ok: true }))
    return Promise.resolve(json(400, { error: 'unexpected' }))
  })
  global.fetch = fetchMock as unknown as typeof fetch
  render(<StructuralEvolutionPanel projectId="p1" />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return fetchMock
}

const approveButton = () => screen.getByRole('button', { name: /Approve this version/ }) as HTMLButtonElement
/** Action buttons only: the ladder's rows are disclosure toggles, not actions. */
const actions = () => screen.getAllByRole('button').filter(b => !b.hasAttribute('aria-expanded'))

describe('the Evolution view', () => {
  it('shows the proposal with every evidence family, including the one that could not look', async () => {
    await mount()
    expect(await screen.findByText(/behave as one refund concern/)).toBeTruthy()
    expect(screen.getByText('rows could not be read')).toBeTruthy()
    expect(screen.getByText(/changing this concern took an exclusive lock/)).toBeTruthy()
    expect(screen.getByText('GET /db/orders?select=id,order_refunds(refund_amount)')).toBeTruthy()
  })

  it('will not approve before a rehearsal of this exact spec passed', async () => {
    const fetchMock = await mount()
    await screen.findByText(/behave as one refund concern/)
    expect(approveButton().disabled).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Rehearse$/ }))
    })
    expect(await screen.findByText(/Every exercise reconciled/)).toBeTruthy()
    expect(approveButton().disabled).toBe(false)

    // Renaming the new table after rehearsing makes it a different plan.
    fireEvent.change(screen.getByDisplayValue('order_refunds'), { target: { value: 'refunds' } })
    expect(approveButton().disabled).toBe(true)
    fireEvent.change(screen.getByDisplayValue('refunds'), { target: { value: 'order_refunds' } })

    await act(async () => {
      fireEvent.click(approveButton())
    })
    const approve = fetchMock.mock.calls.find(([, init]) => init?.body && JSON.parse(String(init.body)).action === 'approve')!
    expect(JSON.parse(String(approve[1].body))).toMatchObject({
      action: 'approve',
      planVersion: 'v-default',
      spec: { host: 'orders', satellite: 'order_refunds', members: ['refund_amount', 'refund_reason'] },
    })
  })

  it('never offers to retire the old columns', async () => {
    await mount()
    await screen.findByText(/behave as one refund concern/)
    expect(actions().map(b => b.textContent)).not.toContainEqual(expect.stringMatching(/retire|contract|drop/i))
    // The rung is still shown, as a person's to do.
    expect(screen.getByText(/yours to do, never the robot/)).toBeTruthy()
  })
})
