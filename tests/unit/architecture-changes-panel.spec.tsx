/**
 * @jest-environment jsdom
 */

/**
 * The "Architecture changes" card on the Autonomy page
 * (components/autonomy/ArchitectureChangesPanel.tsx).
 *
 * It is one card, not a dashboard: nothing at all until there is a change, at
 * most five rows, each a short headline, the sentence under it, one plain
 * status and whether it helped in one clause. The numbers behind an outcome
 * and the change's history are one "View details" away. Only the buttons the
 * engine says are possible now; a change with a row waiting in the queue above
 * is decided there, so it gets none here. Undo asks once more, saying what it
 * removes. A decision here tells the queue. No SQL, no evidence, no internal
 * state, and never a control to remove the old columns.
 *
 * Only fetch is mocked. Nothing here touches a database.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { ArchitectureChangesPanel } from '@/components/autonomy/ArchitectureChangesPanel'
import { ADMIN_ONLY, ARCHITECTURE_CHANGED } from '@/components/autonomy/architecture-decisions'
import type { ArchitectureChangeView } from '@/lib/evolution-engine/views'

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

const UNDO_EFFECT =
  'Undo removes order_refunds and leaves orders exactly as it was, with no data lost; anything already using order_refunds stops working. ' +
  'Backenly refuses to undo if that would lose a write.'

function change(over: Partial<ArchitectureChangeView> = {}): ArchitectureChangeView {
  return {
    decisionId: 'dec-1',
    primitive: 'structural_extraction',
    subject: 'orders',
    headline: 'Backenly is changing your Orders architecture.',
    detail: 'Existing apps keep working while it runs.',
    change: 'Backenly would create order_refunds for refund_amount and refund_reason.',
    status: { label: 'In progress', tone: 'progress' },
    undoEffect: UNDO_EFFECT,
    at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    actions: { undo: true, pause: true, resume: false, keep: false },
    ...over,
  }
}

function mockFetch(status = 200, body: unknown = { ok: true, message: 'Done.', state: 'blocked' }) {
  const fn = jest.fn().mockResolvedValue(json(status, body))
  global.fetch = fn as unknown as typeof fetch
  return fn
}

const posted = (fn: jest.Mock) =>
  fn.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init.body)) }))

const rowOf = (headline: string) => screen.getByText(headline).closest('li')!
/** The decision buttons of a row; "View details" is a disclosure, not a decision. */
const buttonLabels = (el: HTMLElement) =>
  within(el)
    .queryAllByRole('button')
    .map(b => (b.textContent ?? '').trim())
    .filter(l => l !== 'View details')

const DONE = change({
  decisionId: 'dec-2',
  headline: 'Backenly improved your Orders architecture.',
  detail: 'It moved refund data out of orders into its own table, order_refunds. Verification passed. Undo is available.',
  status: { label: 'Done', tone: 'good' },
  outcome: {
    verdict: 'beneficial',
    plain: 'It helped: fewer problems found on refund columns.',
    summary: 'It works correctly. It helped: problems found on refund columns went from 4 to 0.',
  },
  actions: { undo: true, pause: false, resume: false, keep: false },
})

describe('the Architecture changes card', () => {
  it('renders nothing when there are no changes', () => {
    const { container } = render(<ArchitectureChangesPanel projectId="p1" changes={[]} onChanged={jest.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('says each change as the owner reads it: headline, what was done, whether it helped, status, when', () => {
    const { container } = render(<ArchitectureChangesPanel projectId="p1" changes={[DONE]} onChanged={jest.fn()} />)
    expect(screen.getByText('Architecture changes')).toBeTruthy()
    expect(screen.getByText('Backenly improved your Orders architecture.')).toBeTruthy()
    expect(screen.getByText(/Verification passed\. Undo is available\./)).toBeTruthy()
    expect(screen.getByText('It helped: fewer problems found on refund columns.')).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByText('3h ago')).toBeTruthy()
    // Not shown by default: the numbers behind the outcome, the verdict code,
    // the internal state, SQL.
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/4 to 0|\bstable\b|\bbeneficial\b|ALTER TABLE|CREATE TABLE/)
  })

  it('shows the history and the numbers only when asked', async () => {
    const fetchMock = mockFetch(200, {
      trail: [
        { at: new Date().toISOString(), sentence: 'You approved: Move refund data out of orders into its own table.', milestone: true },
        { at: new Date().toISOString(), sentence: 'expanding: orders.', milestone: false },
        { at: new Date().toISOString(), sentence: 'Backenly improved your Orders architecture: it moved refund data out of orders.', milestone: true },
      ],
    })
    render(<ArchitectureChangesPanel projectId="p1" changes={[DONE]} onChanged={jest.fn()} />)
    expect(screen.queryByText(/4 to 0/)).toBeNull()
    const details = screen.getByRole('button', { name: /View details/ })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    await act(async () => {
      fireEvent.click(details)
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/architecture?decision=dec-2', expect.anything())
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/problems found on refund columns went from 4 to 0/)).toBeTruthy()
    expect(screen.getByText(/You approved: Move refund data/)).toBeTruthy()
    // The engine's notebook stays out, even here.
    expect(screen.queryByText(/expanding: orders/)).toBeNull()
  })

  it('never shows the internal state, whatever it is', () => {
    const { container } = render(
      <ArchitectureChangesPanel
        projectId="p1"
        changes={[change({ state: 'cutover' }), change({ decisionId: 'dec-3', headline: 'Another change', state: 'rolling_back', status: { label: 'Undoing', tone: 'progress' } })]}
        onChanged={jest.fn()}
      />,
    )
    expect(container.textContent).not.toMatch(/backfilling|cutover|rolling_back/i)
  })

  it('says why a change is waiting when nothing carries it on here', () => {
    render(
      <ArchitectureChangesPanel
        projectId="p1"
        changes={[
          change({
            status: { label: 'Waiting to continue', tone: 'attention' },
            waiting: 'Autonomy is off for this project, so Backenly does not carry changes on by itself.',
            actions: { undo: true, pause: false, resume: true, keep: false },
          }),
        ]}
        onChanged={jest.fn()}
      />,
    )
    expect(screen.getByText('Waiting to continue')).toBeTruthy()
    expect(screen.getByText(/Autonomy is off for this project/)).toBeTruthy()
    expect(buttonLabels(rowOf('Backenly is changing your Orders architecture.')).sort()).toEqual(['Resume', 'Undo'])
  })

  it('lists at most five', () => {
    const many = Array.from({ length: 7 }, (_, i) => change({ decisionId: `d${i}`, headline: `Change number ${i}` }))
    render(<ArchitectureChangesPanel projectId="p1" changes={many} onChanged={jest.fn()} />)
    expect(screen.getAllByText(/^Change number \d$/)).toHaveLength(5)
    expect(screen.queryByText('Change number 5')).toBeNull()
  })

  it('offers exactly the actions the engine allows, and none for a change with a row in the queue', () => {
    render(
      <ArchitectureChangesPanel
        projectId="p1"
        changes={[
          change({ decisionId: 'a', headline: 'Running change', actions: { undo: true, pause: true, resume: false, keep: false } }),
          change({
            decisionId: 'b',
            headline: 'Stopped change',
            status: { label: 'Paused by you', tone: 'neutral' },
            actions: { undo: false, pause: false, resume: true, keep: false },
          }),
          change({
            decisionId: 'c',
            headline: 'Change waiting on you',
            status: { label: 'Paused — needs your attention', tone: 'attention' },
            actions: { undo: true, pause: false, resume: true, keep: false },
            findingId: 'f-9',
          }),
          // Failed, so its tone is not "attention": it is still decided in the queue.
          change({
            decisionId: 'e',
            headline: 'Failed change waiting on you',
            status: { label: 'Stopped', tone: 'bad' },
            actions: { undo: true, pause: false, resume: true, keep: false },
            findingId: 'f-10',
          }),
          change({
            decisionId: 'd',
            headline: 'Finished change',
            status: { label: 'Undone', tone: 'neutral' },
            actions: { undo: false, pause: false, resume: false, keep: false },
          }),
        ]}
        onChanged={jest.fn()}
      />,
    )
    expect(buttonLabels(rowOf('Running change')).sort()).toEqual(['Pause', 'Undo'])
    expect(buttonLabels(rowOf('Stopped change'))).toEqual(['Resume'])
    for (const queued of ['Change waiting on you', 'Failed change waiting on you']) {
      expect(buttonLabels(rowOf(queued))).toEqual([])
      expect(within(rowOf(queued)).getByText(/Waiting on you in the queue above/)).toBeTruthy()
    }
    expect(buttonLabels(rowOf('Finished change'))).toEqual([])
  })

  it('keeps a change that stopped after it was in place, through the resume action', async () => {
    const fetchMock = mockFetch(200, { ok: true, message: 'Kept. Backenly watches it again from now.', state: 'observing' })
    render(
      <ArchitectureChangesPanel
        projectId="p1"
        changes={[
          change({
            headline: 'The change to your Orders architecture stopped.',
            status: { label: 'Paused — needs your attention', tone: 'attention' },
            actions: { undo: true, pause: false, resume: false, keep: true },
          }),
        ]}
        onChanged={jest.fn()}
      />,
    )
    expect(buttonLabels(rowOf('The change to your Orders architecture stopped.')).sort()).toEqual(['Keep it', 'Undo'])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Keep it/ }))
    })
    expect(posted(fetchMock)).toEqual([{ url: '/api/projects/p1/architecture', body: { action: 'resume', decisionId: 'dec-1' } }])
  })

  it('pauses and resumes by decision id, re-reads the report, and tells the queue', async () => {
    const told = jest.fn()
    window.addEventListener(ARCHITECTURE_CHANGED, told)
    const fetchMock = mockFetch(200, { ok: true, message: 'Paused. Nothing further runs until you resume it.', state: 'blocked' })
    const onChanged = jest.fn()
    render(
      <ArchitectureChangesPanel
        projectId="p1"
        changes={[
          change({ decisionId: 'a', headline: 'Running change' }),
          change({ decisionId: 'b', headline: 'Stopped change', actions: { undo: false, pause: false, resume: true, keep: false } }),
        ]}
        onChanged={onChanged}
      />,
    )
    await act(async () => {
      fireEvent.click(within(rowOf('Running change')).getByRole('button', { name: /Pause/ }))
    })
    await act(async () => {
      fireEvent.click(within(rowOf('Stopped change')).getByRole('button', { name: /Resume/ }))
    })
    expect(posted(fetchMock)).toEqual([
      { url: '/api/projects/p1/architecture', body: { action: 'pause', decisionId: 'a' } },
      { url: '/api/projects/p1/architecture', body: { action: 'resume', decisionId: 'b' } },
    ])
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(told).toHaveBeenCalledTimes(2)
    expect((told.mock.calls[0][0] as CustomEvent).detail).toEqual({ from: 'card' })
    window.removeEventListener(ARCHITECTURE_CHANGED, told)
    expect(within(rowOf('Running change')).getAllByText(/Nothing further runs until you resume it/).length).toBeGreaterThan(0)
  })

  it('asks once more before an undo, saying what undo removes, and keeps keyboard focus', async () => {
    const fetchMock = mockFetch(200, { ok: true, message: 'Undone. Everything is exactly as it was, and no data was lost.', state: 'rolled_back' })
    const onChanged = jest.fn()
    render(<ArchitectureChangesPanel projectId="p1" changes={[change()]} onChanged={onChanged} />)

    fireEvent.click(screen.getByRole('button', { name: /^Undo$/ }))
    expect(screen.getAllByText(UNDO_EFFECT).length).toBeGreaterThan(0)
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(posted(fetchMock)).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(screen.queryAllByText(UNDO_EFFECT)).toHaveLength(0)
    expect(document.activeElement?.textContent).toMatch(/Undo/)
    expect(posted(fetchMock)).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: /^Undo$/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Undo$/ }))
    })
    expect(posted(fetchMock)).toEqual([{ url: '/api/projects/p1/architecture', body: { action: 'undo', decisionId: 'dec-1' } }])
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText(/no data was lost/).length).toBeGreaterThan(0)
  })

  it('says why a refused action was refused, and re-reads', async () => {
    mockFetch(409, { error: 'Another change is running on this project. Try again in a minute.' })
    const onChanged = jest.fn()
    render(<ArchitectureChangesPanel projectId="p1" changes={[change()]} onChanged={onChanged} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Pause/ }))
    })
    expect(screen.getByRole('alert').textContent).toMatch(/Another change is running on this project/)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('says who may decide when the person is not allowed to', async () => {
    mockFetch(403, { error: 'Project not found or access denied' })
    const onChanged = jest.fn()
    render(<ArchitectureChangesPanel projectId="p1" changes={[change()]} onChanged={onChanged} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Pause/ }))
    })
    expect(screen.getByRole('alert').textContent).toBe(ADMIN_ONLY)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('never offers to retire or drop anything', () => {
    render(
      <ArchitectureChangesPanel
        projectId="p1"
        changes={[change({ status: { label: 'Done', tone: 'good' }, actions: { undo: true, pause: true, resume: true, keep: true } })]}
        onChanged={jest.fn()}
      />,
    )
    for (const b of screen.getAllByRole('button')) {
      expect(b.textContent).not.toMatch(/retire|drop|contract|remove|delete/i)
    }
  })
})
