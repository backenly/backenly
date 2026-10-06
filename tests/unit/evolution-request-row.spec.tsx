/**
 * @jest-environment jsdom
 */

/**
 * An architecture change waiting on a person, as a row in the existing
 * "Waiting on you" queue (components/autonomy/EvolutionRequestRow.tsx, rendered
 * by components/ReviewQueuePanel.tsx).
 *
 * What it must do: say the change in plain words and keep SQL, evidence and
 * internal states behind an opt-in toggle; approve exactly the plan version on
 * screen, through the architecture route and never the generic approve paths;
 * re-read the queue when the server says the version moved; ask once more
 * before an undo. What it must never do: offer to remove the old columns.
 *
 * Only fetch is mocked. Nothing here touches a database.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { EvolutionRequestRow, type EvolutionQueueItem } from '@/components/autonomy/EvolutionRequestRow'
import { ReviewQueuePanel } from '@/components/ReviewQueuePanel'
import { LIFECYCLE_STATES } from '@/lib/evolution-engine/lifecycle'
import type { EvolutionRequestDetails } from '@/lib/evolution-engine/request'

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }), useParams: () => ({ id: 'p1' }) }))

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/**
 * Lifecycle states that are internal vocabulary. The others (approved, stable,
 * blocked, failed, proposed, rehearsed) are also ordinary English and may
 * appear in a sentence written for a person.
 */
const PLAIN_ENGLISH = new Set(['proposed', 'rehearsed', 'approved', 'stable', 'blocked', 'failed'])
const INTERNAL_STATES = LIFECYCLE_STATES.filter(s => !PLAIN_ENGLISH.has(s))

const SQL_CREATE = 'CREATE TABLE "workspace_p1"."order_refunds" (order_id uuid PRIMARY KEY)'
const SQL_CONTRACT = 'ALTER TABLE "workspace_p1"."orders" DROP COLUMN "refund_amount"'

function evolution(over: Partial<EvolutionRequestDetails> = {}): EvolutionRequestDetails {
  return {
    v: 1,
    primitive: 'structural_extraction',
    decisionId: 'dec-1',
    concernKey: 'orders:refund',
    proposalKey: 'orders:refund_amount,refund_reason',
    planId: 'plan-1',
    planVersion: 'pv-1',
    subject: 'orders',
    spec: { host: 'orders' },
    level: 'executable_proposal',
    ask: 'approve',
    summary: {
      headline: 'Give refunds on orders their own table',
      change: 'Refund details move from orders into a new table, order_refunds.',
      reason: 'Changing refund columns has been locking the whole orders table.',
      compatibility: 'Apps that read refund columns on orders keep working; both shapes stay in step.',
      rollback: 'Undo puts orders back exactly as it was.',
      subjectTitle: 'Orders',
      did: 'moved refund data out of orders into its own table, order_refunds',
    },
    risk: 'medium',
    rehearsal: { planVersion: 'pv-1', passed: true, authorization: 'passed', detail: 'every exercise reconciled', at: '2026-10-06T10:00:00Z' },
    technical: {
      steps: [
        { title: 'Create order_refunds', why: 'A new table, closed to clients until it is filled.', tier: 1, humanOnly: false, sql: [SQL_CREATE] },
        { title: 'Retire the old refund columns on orders', why: 'Only after every client has moved.', tier: 3, humanOnly: true, sql: [SQL_CONTRACT] },
      ],
      evidence: [
        { family: 'co_presence', verdict: 'supports', detail: 'refund columns are set on the same rows' },
        { family: 'lifecycle', verdict: 'unavailable', detail: 'rows could not be read' },
      ],
      pressure: [{ kind: 'hot_host_change', class: 'measured_cost', detail: 'a refund column change took an exclusive lock on orders' }],
      semanticBoundary: 'This keeps one refund per order. Whether an order can have several refunds is a decision for you.',
      contractBlockers: ['PostgREST clients choose their own columns and cannot be enumerated'],
      caveats: [],
      clientMigration: [
        { purpose: 'read refunds with their order', before: 'GET /db/orders?select=id,refund_amount', after: 'GET /db/orders?select=id,order_refunds(refund_amount)' },
      ],
    },
    ...over,
  }
}

function item(ev: EvolutionRequestDetails, id = 'f-1'): EvolutionQueueItem {
  return { id, detectedAt: new Date(Date.now() - 120_000).toISOString(), reason: 'Architecture change', details: { evolution: ev } }
}

function mockFetch(handler: (url: string, body: any) => Response) {
  const fn = jest.fn().mockImplementation((url: string, init?: RequestInit) =>
    Promise.resolve(handler(url, init?.body ? JSON.parse(String(init.body)) : null)),
  )
  global.fetch = fn as unknown as typeof fetch
  return fn
}

function mountRow(ev: EvolutionRequestDetails, onRefresh = jest.fn()) {
  const utils = render(
    <ul>
      <EvolutionRequestRow projectId="p1" request={item(ev)} onRefresh={onRefresh} />
    </ul>,
  )
  return { ...utils, onRefresh }
}

const button = (name: RegExp | string) => screen.getByRole('button', { name })
const posts = (fn: jest.Mock) =>
  fn.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init.body)) }))

/** Every disclosure open, so "anywhere" really means anywhere. */
function expandEverything() {
  fireEvent.click(button(/Technical details/))
  for (const b of screen.getAllByRole('button')) {
    if (b.getAttribute('aria-expanded') === 'false') fireEvent.click(b)
  }
}

afterEach(() => {
  jest.useRealTimers()
})

describe('an architecture change waiting for approval', () => {
  it('says the change in plain words, with three small facts and the rehearsal', () => {
    const { container } = mountRow(evolution())
    expect(screen.getByText('Give refunds on orders their own table')).toBeTruthy()
    expect(screen.getByText(/Refund details move from orders/)).toBeTruthy()
    expect(screen.getByText(/has been locking the whole orders table/)).toBeTruthy()
    expect(screen.getByText('Medium risk')).toBeTruthy()
    // The compatibility sentence is one hover away, not on the page.
    const compat = screen.getByText('Existing apps keep working')
    expect(compat.closest('[title]')?.getAttribute('title')).toMatch(/both shapes stay in step/)
    expect(screen.getByText('Can be undone')).toBeTruthy()
    expect(screen.getByText(/Rehearsed on a copy of your data, including who can read and change it/)).toBeTruthy()
    expect(button(/^Approve$/)).toBeTruthy()
    expect(button(/Not now/)).toBeTruthy()

    // Hidden by default: SQL, evidence, the boundary, internal state names.
    const text = container.textContent ?? ''
    expect(text).not.toContain('CREATE TABLE')
    expect(text).not.toContain('refund columns are set on the same rows')
    expect(text).not.toContain('one refund per order')
    for (const s of INTERNAL_STATES) expect(text).not.toMatch(new RegExp(`\\b${s}\\b`, 'i'))
  })

  it('says only "rehearsed on a copy" when access could not be rehearsed', () => {
    mountRow(evolution({ rehearsal: { planVersion: 'pv-1', passed: true, authorization: 'unavailable', detail: '', at: '' } }))
    expect(screen.getByText('Rehearsed on a copy of your data.')).toBeTruthy()
    expect(screen.queryByText(/who can read and change it/)).toBeNull()
  })

  it('approves exactly the version on screen, through the architecture route only', async () => {
    jest.useFakeTimers()
    const fetchMock = mockFetch(() => json(200, { ok: true, message: 'Approved. The change is in progress.' }))
    const { onRefresh } = mountRow(evolution())
    await act(async () => {
      fireEvent.click(button(/^Approve$/))
    })
    expect(posts(fetchMock)).toEqual([
      { url: '/api/projects/p1/architecture', body: { action: 'approve', findingId: 'f-1', planVersion: 'pv-1' } },
    ])
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toMatch(/\/health\/approve|\/approvals/)
    }
    expect(screen.getByText('Approved. The change is in progress.')).toBeTruthy()
    // The queue re-reads once the settled row has been seen.
    expect(onRefresh).not.toHaveBeenCalled()
    await act(async () => {
      jest.advanceTimersByTime(3000)
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('re-reads the queue at once when the server says the version moved', async () => {
    mockFetch(() =>
      json(409, {
        error: 'This change was updated after you opened it. Review the current version before approving.',
        currentPlanVersion: 'pv-2',
      }),
    )
    const { onRefresh } = mountRow(evolution())
    await act(async () => {
      fireEvent.click(button(/^Approve$/))
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/updated after you opened it/)).toBeTruthy()
    // Still decidable: the next click consents to whatever the refresh brings.
    expect((button(/^Approve$/) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a plain error, not a refresh, when the request fails for another reason', async () => {
    mockFetch(() => json(500, { error: 'Something went wrong on our side.' }))
    const { onRefresh } = mountRow(evolution())
    await act(async () => {
      fireEvent.click(button(/^Approve$/))
    })
    expect(onRefresh).not.toHaveBeenCalled()
    expect(screen.getByText('Something went wrong on our side.')).toBeTruthy()
    fireEvent.click(button(/Try again/))
    expect(button(/^Approve$/)).toBeTruthy()
  })

  it('"Not now" is the queue\'s own dismiss', async () => {
    const fetchMock = mockFetch(() => json(200, { success: true }))
    const { onRefresh } = mountRow(evolution())
    await act(async () => {
      fireEvent.click(button(/Not now/))
    })
    expect(posts(fetchMock)).toEqual([{ url: '/api/projects/p1/health', body: { findingId: 'f-1' } }])
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('does not offer Approve, or claim a rehearsal, for a version that has not passed its own', () => {
    // An older version passed; this one has not been rehearsed yet.
    mountRow(evolution({ rehearsal: { planVersion: 'pv-0', passed: true, authorization: 'passed', detail: '', at: '' } }))
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull()
    expect(screen.queryByText(/^Rehearsed on a copy/)).toBeNull()
    expect(screen.getByText(/Not rehearsed yet/)).toBeTruthy()
    expect(button(/Not now/)).toBeTruthy()
  })
})

describe('technical details', () => {
  it('are hidden until asked for, and the SQL sits behind its own toggle', () => {
    const { container } = mountRow(evolution())
    expect(screen.queryByText('Steps')).toBeNull()

    fireEvent.click(button(/Technical details/))
    expect(screen.getByText('1. Create order_refunds')).toBeTruthy()
    expect(screen.getByText(/closed to clients until it is filled/)).toBeTruthy()
    expect(screen.getByText(/refund columns are set on the same rows/)).toBeTruthy()
    expect(screen.getByText(/rows could not be read/)).toBeTruthy()
    expect(screen.getByText(/took an exclusive lock on orders/)).toBeTruthy()
    expect(screen.getByText(/Whether an order can have several refunds is a decision for you/)).toBeTruthy()
    expect(screen.getByText(/cannot be enumerated/)).toBeTruthy()
    expect(screen.getByText(/order_refunds\(refund_amount\)/)).toBeTruthy()
    // The person's own step is described as theirs.
    expect(screen.getByText(/Backenly never runs this step/)).toBeTruthy()
    // Still no SQL.
    expect(container.querySelector('pre')).toBeNull()

    const sqlToggles = screen.getAllByRole('button', { name: /^SQL/ })
    fireEvent.click(sqlToggles[0])
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toBe(SQL_CREATE)
  })

  it('never offers a control to retire or drop the old columns, even fully expanded', () => {
    mountRow(evolution())
    expandEverything()
    expect(screen.getByText(SQL_CONTRACT)).toBeTruthy() // shown as text...
    const labels = screen.getAllByRole('button').map(b => b.textContent ?? '')
    for (const l of labels) expect(l).not.toMatch(/retire|drop|contract|remove|delete/i) // ...never as a button
  })
})

describe('a change that stopped part-way', () => {
  const stopped = () =>
    evolution({ ask: 'resume_or_undo', stoppedBecause: 'the old and new shapes did not match when checked, so nothing more was opened' })

  it('asks resume or undo, says why it stopped in one sentence, and offers no approval', () => {
    const { container } = mountRow(stopped())
    expect(screen.getByText('Give refunds on orders their own table')).toBeTruthy()
    expect(screen.getByText(/It stopped because the old and new shapes did not match when checked/)).toBeTruthy()
    expect(button(/^Resume$/)).toBeTruthy()
    expect(button(/^Undo$/)).toBeTruthy()
    expect(button(/Not now/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull()
    const text = container.textContent ?? ''
    for (const s of INTERNAL_STATES) expect(text).not.toMatch(new RegExp(`\\b${s}\\b`, 'i'))
  })

  it('resumes by decision id', async () => {
    const fetchMock = mockFetch(() => json(200, { ok: true, message: 'Resumed.', state: 'backfilling' }))
    mountRow(stopped())
    await act(async () => {
      fireEvent.click(button(/^Resume$/))
    })
    expect(posts(fetchMock)).toEqual([{ url: '/api/projects/p1/architecture', body: { action: 'resume', decisionId: 'dec-1' } }])
    // The internal state the server returned is not shown.
    expect(screen.queryByText(/backfilling/)).toBeNull()
  })

  it('asks once more before an undo, and can be kept', async () => {
    const fetchMock = mockFetch(() => json(200, { ok: true, message: 'Undone. Everything is exactly as it was, and no data was lost.' }))
    mountRow(stopped())

    fireEvent.click(button(/^Undo$/))
    expect(screen.getByText('Undo puts orders back exactly as it was. Nothing is lost.')).toBeTruthy()
    expect(posts(fetchMock)).toEqual([])

    fireEvent.click(button(/Keep it/))
    expect(screen.queryByText(/Undo puts orders back/)).toBeNull()

    fireEvent.click(button(/^Undo$/))
    await act(async () => {
      fireEvent.click(button(/^Undo$/))
    })
    expect(posts(fetchMock)).toEqual([{ url: '/api/projects/p1/architecture', body: { action: 'undo', decisionId: 'dec-1' } }])
    expect(screen.getByText(/no data was lost/)).toBeTruthy()
  })

  it('re-reads the queue when an undo is refused', async () => {
    mockFetch(() => json(409, { error: 'Not undone: a write landed only on the new table' }))
    const { onRefresh } = mountRow(stopped())
    fireEvent.click(button(/^Undo$/))
    await act(async () => {
      fireEvent.click(button(/^Undo$/))
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Not undone: a write landed only on the new table/)).toBeTruthy()
  })
})

describe('in the "Waiting on you" queue', () => {
  const finding = (id: string, ev: EvolutionRequestDetails) => ({
    id,
    type: 'architecture_evolution',
    severity: 'info',
    detectedAt: new Date().toISOString(),
    reason: 'An architecture change is ready for your approval',
    heldBecause: { kind: 'guardrail', text: 'Restructuring a table always waits for you.' },
    source: 'evolution_engine',
    details: { evolution: ev },
  })

  async function mountPanel() {
    const pendingApprovals = [
      finding('f-1', evolution()),
      finding(
        'f-2',
        evolution({
          decisionId: 'dec-2',
          planVersion: 'pv-9',
          subject: 'users',
          rehearsal: { planVersion: 'pv-9', passed: true, authorization: 'passed', detail: '', at: '' },
          summary: { ...evolution().summary, headline: 'Give addresses on users their own table' },
        }),
      ),
      {
        id: 'h-1',
        type: 'missing_index',
        severity: 'warning',
        detectedAt: new Date().toISOString(),
        reason: 'Queries on orders.customer_id scan the whole table',
        source: 'autonomy',
        details: { tableName: 'orders' },
      },
    ]
    const fetchMock = mockFetch((url, body) => {
      if (body) return json(200, { ok: true, message: 'Approved.' })
      if (url.endsWith('/agent-approvals')) return json(200, { approvals: [] })
      return json(200, { pendingApprovals })
    })
    const utils = render(<ReviewQueuePanel projectId="p1" />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    return { ...utils, fetchMock }
  }

  it('gives each architecture change its own row, and counts it', async () => {
    await mountPanel()
    expect(await screen.findByText('Give refunds on orders their own table')).toBeTruthy()
    expect(screen.getByText('Give addresses on users their own table')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Approve$/ })).toHaveLength(2)
    // Three findings, three rows: nothing was folded.
    const header = screen.getByText('Waiting on you').parentElement!
    expect(header.textContent).toContain('3')
    expect(header.textContent).not.toMatch(/in \d+ issue/)
    // The ordinary finding still renders as it always did, with its own fix.
    expect(screen.getByText(/missing_index · warning/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Approve & fix/ })).toBeTruthy()
  })

  it('approves the one that was clicked, with its own version', async () => {
    jest.useFakeTimers()
    const { fetchMock } = await mountPanel()
    const row = screen.getByText('Give addresses on users their own table').closest('li')!
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: /^Approve$/ }))
    })
    expect(posts(fetchMock)).toEqual([
      { url: '/api/projects/p1/architecture', body: { action: 'approve', findingId: 'f-2', planVersion: 'pv-9' } },
    ])
  })
})
