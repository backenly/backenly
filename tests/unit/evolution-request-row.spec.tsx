/**
 * @jest-environment jsdom
 */

/**
 * An architecture change waiting on a person, as a row in the existing
 * "Waiting on you" queue (components/autonomy/EvolutionRequestRow.tsx, rendered
 * by components/ReviewQueuePanel.tsx).
 *
 * What it must do: say the change in plain words, every caveat on the page
 * (never only in a tooltip), and keep SQL, evidence, counts and internal states
 * behind an opt-in toggle; approve exactly the plan version on screen, and
 * decline, through the architecture route and never the generic paths; re-read
 * the queue when the server says the version moved; ask once more before an
 * undo, saying what undo removes; tell the other surface on the page; say a
 * role refusal in words that name the role; announce what happened to a screen
 * reader and keep keyboard focus. What it must never do: offer to remove the
 * old columns.
 *
 * The summary is the engine's own (lib/structural-evolution/words.ts), built
 * from evidence and costs worded exactly as the analysis words them, numbers
 * and all, so "nothing technical by default" is checked against what a person
 * would really be shown. Only fetch is mocked. Nothing here touches a database.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { EvolutionRequestRow, type EvolutionQueueItem } from '@/components/autonomy/EvolutionRequestRow'
import { ReviewQueuePanel } from '@/components/ReviewQueuePanel'
import { LIFECYCLE_STATES } from '@/lib/evolution-engine/lifecycle'
import type { EvolutionRequestDetails } from '@/lib/evolution-engine/request'
import { describeExtraction, whyOf } from '@/lib/structural-evolution/words'
import { ADMIN_ONLY, ARCHITECTURE_CHANGED, announceArchitectureChange } from '@/components/autonomy/architecture-decisions'

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

const SPEC = { host: 'orders', members: ['refund_amount', 'refund_reason', 'refunded_at'], satellite: 'order_refunds', label: 'refund' }

/** Evidence and costs as lib/structural-evolution/concerns.ts words them, numbers and all. */
const FAMILIES = [
  { family: 'lexical' as const, verdict: 'supports' as const, detail: 'all named for "refund"' },
  { family: 'co_presence' as const, verdict: 'supports' as const, detail: 'set on the same rows (lowest pairwise overlap 97% over 500 sampled rows)' },
  { family: 'lifecycle' as const, verdict: 'supports' as const, detail: 'set a median of 3 days after the row is created — a later event in its life' },
]
const PRESSURE = [
  {
    kind: 'hot_host_change' as const,
    detail: 'changing this concern took an exclusive lock on orders (48,210 request(s) in the window, about 1,204,331 row(s)) — 3 time(s) in the last 30 days',
  },
  { kind: 'attributed_repairs' as const, detail: 'Backenly found problems on these columns 2 time(s) in the last 30 days (missing_index)' },
]
/** What the engine writes for this change. */
const SUMMARY = describeExtraction(SPEC, whyOf({ host: 'orders', label: 'refund', families: FAMILIES, pressure: PRESSURE, emerging: [], levelReason: '' }))

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
    summary: SUMMARY,
    risk: 'medium',
    rehearsal: { planVersion: 'pv-1', passed: true, authorization: 'passed', detail: 'every exercise reconciled', at: '2026-10-06T10:00:00Z' },
    technical: {
      steps: [
        { title: 'Create order_refunds', why: 'A new table, closed to clients until it is filled.', tier: 1, humanOnly: false, sql: [SQL_CREATE] },
        { title: 'Retire the old refund columns on orders', why: 'Only after every client has moved.', tier: 3, humanOnly: true, sql: [SQL_CONTRACT] },
      ],
      evidence: [...FAMILIES, { family: 'reference', verdict: 'unavailable', detail: 'rows could not be read' }],
      pressure: PRESSURE.map(p => ({ ...p, class: 'measured_cost' })),
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
  it('says the change, why, and every caveat in plain words on the page, with nothing technical', () => {
    const { container } = mountRow(evolution())
    expect(screen.getByText('Move refund data out of orders into its own table')).toBeTruthy()
    expect(screen.getByText(/Backenly would create order_refunds/)).toBeTruthy()
    // Why, as the engine says it: what the columns do and what keeping them costs.
    expect(
      screen.getByText(
        "The refund columns are filled in on the same rows and are set later in a row's life, not when it is created. " +
          'Changing them has been locking all of orders while it is in use. Backenly keeps finding problems on them.',
      ),
    ).toBeTruthy()
    expect(screen.getByText('Medium risk')).toBeTruthy()
    // On the page, not one hover away: a keyboard or a phone reaches them too.
    expect(screen.getByText(/Apps that use orders today keep working unchanged/).textContent).toMatch(
      /Who can read or change refund data stays exactly the same\./,
    )
    expect(screen.getByText(/^Undo removes order_refunds/).textContent).toMatch(/anything already using order_refunds stops working/)
    expect(container.querySelector('[title]')).toBeNull()
    expect(screen.getByText(/Rehearsed on a copy of your data, including who can read and change it/)).toBeTruthy()
    expect(button(/^Approve$/)).toBeTruthy()
    expect(button(/^Decline$/)).toBeTruthy()

    // Hidden by default: SQL, the evidence and its numbers, the boundary, the
    // finding types, a name match presented as behaviour, internal state names.
    const text = container.textContent ?? ''
    expect(text).not.toContain('CREATE TABLE')
    // No number at all, the row's own "2m ago" aside.
    expect(text.replace(/\b\d+[smhd] ago/, '')).not.toMatch(/\d/)
    for (const technical of ['overlap', 'sampled', 'exclusive lock', 'request(s)', 'time(s)', 'missing_index', 'named for', 'one refund per order']) {
      expect(text).not.toContain(technical)
    }
    for (const s of INTERNAL_STATES) expect(text).not.toMatch(new RegExp(`\\b${s}\\b`, 'i'))
  })

  it('makes no promise about who can read the data when the rehearsal could not check it', () => {
    mountRow(evolution({ rehearsal: { planVersion: 'pv-1', passed: true, authorization: 'unavailable', detail: '', at: '' } }))
    expect(screen.getByText('Rehearsed on a copy of your data.')).toBeTruthy()
    expect(screen.queryByText(/who can read and change it/)).toBeNull()
    expect(screen.queryByText(/stays exactly the same/)).toBeNull()
    expect(screen.getByText(/was not checked on the copy, so Backenly does not promise it stays the same/)).toBeTruthy()
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
    // Said to a screen reader too.
    expect(screen.getByText('Approved. The change is in progress.').closest('[aria-live]')).toBeTruthy()
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
    expect(screen.getAllByText(/updated after you opened it/).length).toBeGreaterThan(0)
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

  it('declines through the architecture route, says it will not ask again, and tells the card', async () => {
    jest.useFakeTimers()
    const told = jest.fn()
    window.addEventListener(ARCHITECTURE_CHANGED, told)
    const fetchMock = mockFetch(() => json(200, { ok: true, message: "Declined. Backenly won't ask again unless something new is measured." }))
    const { onRefresh } = mountRow(evolution())
    await act(async () => {
      fireEvent.click(button(/^Decline$/))
    })
    expect(posts(fetchMock)).toEqual([{ url: '/api/projects/p1/architecture', body: { action: 'dismiss', findingId: 'f-1' } }])
    expect(screen.getByText("Declined. Backenly won't ask again unless something new is measured.")).toBeTruthy()
    expect(told).toHaveBeenCalledTimes(1)
    expect((told.mock.calls[0][0] as CustomEvent).detail).toEqual({ from: 'queue' })
    window.removeEventListener(ARCHITECTURE_CHANGED, told)
    await act(async () => {
      jest.advanceTimersByTime(3000)
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('a decline of a request someone already decided says so and re-reads, instead of failing', async () => {
    mockFetch(() => json(409, { error: 'This change was already decided. Refresh to see where it is now.' }))
    const { onRefresh } = mountRow(evolution())
    await act(async () => {
      fireEvent.click(button(/^Decline$/))
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText('This change was already decided. Refresh to see where it is now.').length).toBeGreaterThan(0)
  })

  it('says who may decide when the person is not allowed to', async () => {
    mockFetch(() => json(403, { error: 'Project not found or access denied' }))
    const { onRefresh } = mountRow(evolution())
    await act(async () => {
      fireEvent.click(button(/^Approve$/))
    })
    expect(screen.getByRole('alert').textContent).toBe(ADMIN_ONLY)
    expect(screen.queryByText(/Project not found/)).toBeNull()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('does not offer Approve, or claim a rehearsal, for a version that has not passed its own', () => {
    // An older version passed; this one has not been rehearsed yet.
    mountRow(evolution({ rehearsal: { planVersion: 'pv-0', passed: true, authorization: 'passed', detail: '', at: '' } }))
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull()
    expect(screen.queryByText(/^Rehearsed on a copy/)).toBeNull()
    expect(screen.getByText(/Not rehearsed yet/)).toBeTruthy()
    expect(button(/^Decline$/)).toBeTruthy()
  })
})

describe('technical details', () => {
  it('are hidden until asked for, and the SQL sits behind its own toggle', () => {
    const { container } = mountRow(evolution())
    expect(screen.queryByText('Steps')).toBeNull()

    fireEvent.click(button(/Technical details/))
    expect(screen.getByText('1. Create order_refunds')).toBeTruthy()
    expect(screen.getByText(/closed to clients until it is filled/)).toBeTruthy()
    // The evidence and its numbers, here and only here.
    expect(screen.getByText(/lowest pairwise overlap 97% over 500 sampled rows/)).toBeTruthy()
    expect(screen.getByText(/rows could not be read/)).toBeTruthy()
    expect(screen.getByText(/took an exclusive lock on orders \(48,210 request\(s\)/)).toBeTruthy()
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

  it("for a project kept in another region, reads the exact SQL from it when asked, and stores none", async () => {
    const withheld = evolution({
      technical: {
        ...evolution().technical,
        sqlWithheld: true,
        steps: evolution().technical.steps.map(st => ({ ...st, sql: [] })),
      },
    })
    const fetchFn = mockFetch(url =>
      url.includes('?statements=f-1') ? json(200, { planVersion: 'pv-1', current: true, steps: [{ title: 'Create order_refunds', sql: [SQL_CREATE] }, { title: 'Retire', sql: [SQL_CONTRACT] }] }) : json(404, {}),
    )
    const { container } = mountRow(withheld)
    fireEvent.click(button(/Technical details/))
    expect(screen.getByText(/exact SQL stays in its region and is not stored outside it/)).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: /^SQL/ })).toHaveLength(0)

    await act(async () => {
      fireEvent.click(button('Show it'))
    })
    expect(fetchFn).toHaveBeenCalledWith('/api/projects/p1/architecture?statements=f-1', expect.anything())
    fireEvent.click(screen.getAllByRole('button', { name: /^SQL/ })[0])
    expect(container.querySelector('pre')?.textContent).toBe(SQL_CREATE)
  })

  it('does not show statements of another version than the one being approved', async () => {
    const withheld = evolution({ technical: { ...evolution().technical, sqlWithheld: true, steps: evolution().technical.steps.map(st => ({ ...st, sql: [] })) } })
    mockFetch(() => json(200, { planVersion: 'pv-2', current: false, steps: [] }))
    mountRow(withheld)
    fireEvent.click(button(/Technical details/))
    await act(async () => {
      fireEvent.click(button('Show it'))
    })
    expect(screen.getByText(/The table changed since this was prepared/)).toBeTruthy()
    expect(screen.queryAllByRole('button', { name: /^SQL/ })).toHaveLength(0)
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
    expect(screen.getByText('Move refund data out of orders into its own table')).toBeTruthy()
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

  it('asks once more before an undo, saying what undo removes, and keeps keyboard focus', async () => {
    const fetchMock = mockFetch(() => json(200, { ok: true, message: 'Undone. Everything is exactly as it was, and no data was lost.' }))
    mountRow(stopped())

    fireEvent.click(button(/^Undo$/))
    const asked = screen.getAllByText(/^Undo removes order_refunds/)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked[0].textContent).toMatch(/anything already using order_refunds stops working/)
    expect(posts(fetchMock)).toEqual([])
    // Focus lands on the safe choice, and the question is announced.
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(document.querySelector('[aria-live]')?.textContent).toMatch(/^Undo\? Undo removes order_refunds/)

    fireEvent.click(button(/^Cancel$/))
    expect(screen.queryByText(/^Undo removes order_refunds/)).toBeNull()
    expect(document.activeElement?.textContent).toMatch(/Undo/)

    fireEvent.click(button(/^Undo$/))
    await act(async () => {
      fireEvent.click(button(/^Undo$/))
    })
    expect(posts(fetchMock)).toEqual([{ url: '/api/projects/p1/architecture', body: { action: 'undo', decisionId: 'dec-1' } }])
    expect(screen.getByText(/no data was lost/)).toBeTruthy()
  })

  it('a change that stopped after it was in place asks keep or undo, and keeping it is the resume action', async () => {
    const fetchMock = mockFetch(() => json(200, { ok: true, message: 'Kept. Backenly watches it again from now.', state: 'observing' }))
    mountRow(evolution({ ask: 'keep_or_undo', stoppedBecause: 'requests got slower' }))
    expect(screen.getByText(/It stopped because requests got slower\. It is still in place\. Keep it, or undo it\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Resume$/ })).toBeNull()
    await act(async () => {
      fireEvent.click(button(/^Keep it$/))
    })
    expect(posts(fetchMock)).toEqual([{ url: '/api/projects/p1/architecture', body: { action: 'resume', decisionId: 'dec-1' } }])
    expect(screen.getByText('Kept. Backenly watches it again from now.')).toBeTruthy()
  })

  it('"Not now" on a stopped change sets the row aside through the architecture route', async () => {
    const fetchMock = mockFetch(() => json(200, { ok: true, message: 'Set aside. The change stays exactly as it is; you can still decide on it under Architecture changes.' }))
    mountRow(stopped())
    await act(async () => {
      fireEvent.click(button(/Not now/))
    })
    expect(posts(fetchMock)).toEqual([{ url: '/api/projects/p1/architecture', body: { action: 'dismiss', findingId: 'f-1' } }])
    expect(screen.getByText(/The change stays exactly as it is/)).toBeTruthy()
  })

  it('re-reads the queue when an undo is refused', async () => {
    mockFetch(() => json(409, { error: 'Not undone: a write landed only on the new table' }))
    const { onRefresh } = mountRow(stopped())
    fireEvent.click(button(/^Undo$/))
    await act(async () => {
      fireEvent.click(button(/^Undo$/))
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText(/Not undone: a write landed only on the new table/).length).toBeGreaterThan(0)
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
    expect(await screen.findByText('Move refund data out of orders into its own table')).toBeTruthy()
    expect(screen.getByText('Give addresses on users their own table')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Approve$/ })).toHaveLength(2)
    // Three findings, three rows: nothing was folded.
    const header = screen.getByText('Waiting on you').parentElement!
    expect(header.textContent).toContain('3')
    expect(header.textContent).not.toMatch(/in \d+ issue/)
    // The ordinary finding still renders as it always did, with its own fix.
    const ordinary = screen.getByText('missing_index').parentElement!
    expect(within(ordinary).getByText('Warning')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Approve & fix/ })).toBeTruthy()
  })

  it('re-reads when a change is decided on the Architecture changes card, and not for its own decisions', async () => {
    const { fetchMock } = await mountPanel()
    const reads = () => fetchMock.mock.calls.filter(([url, init]) => !init?.method && !String(url).endsWith('/agent-approvals')).length
    const before = reads()
    await act(async () => {
      announceArchitectureChange('queue')
      await Promise.resolve()
    })
    expect(reads()).toBe(before)
    await act(async () => {
      announceArchitectureChange('card')
      await Promise.resolve()
    })
    expect(reads()).toBe(before + 1)
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
