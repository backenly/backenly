/**
 * @jest-environment jsdom
 */

/**
 * The "Architecture changes" card on the Autonomy page
 * (components/autonomy/ArchitectureChangesPanel.tsx).
 *
 * It is one card, not a dashboard: nothing at all until there is a change, at
 * most five rows, one plain status each, and only the buttons the engine says
 * are possible now. A change also waiting in the queue above is decided there,
 * so it gets no buttons here. Undo asks once more. No SQL, no evidence, no
 * internal state, and never a control to remove the old columns.
 *
 * Only fetch is mocked. Nothing here touches a database.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { ArchitectureChangesPanel } from '@/components/autonomy/ArchitectureChangesPanel'
import type { ArchitectureChangeView } from '@/lib/evolution-engine/views'

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function change(over: Partial<ArchitectureChangeView> = {}): ArchitectureChangeView {
  return {
    decisionId: 'dec-1',
    primitive: 'structural_extraction',
    subject: 'orders',
    headline: 'Refunds on orders now have their own table',
    change: 'Refund details moved from orders into order_refunds.',
    status: { label: 'In progress', tone: 'progress' },
    state: 'backfilling',
    at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    actions: { undo: true, pause: true, resume: false },
    ...over,
  }
}

function mockFetch(status = 200, body: unknown = { ok: true, message: 'Done.', state: 'blocked' }) {
  const fn = jest.fn().mockResolvedValue(json(status, body))
  global.fetch = fn as unknown as typeof fetch
  return fn
}

const posted = (fn: jest.Mock) =>
  fn.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init.body)) }))

const rowOf = (headline: string) => screen.getByText(headline).closest('li')!
const buttonLabels = (el: HTMLElement) => within(el).queryAllByRole('button').map(b => (b.textContent ?? '').trim())

describe('the Architecture changes card', () => {
  it('renders nothing when there are no changes', () => {
    const { container } = render(<ArchitectureChangesPanel projectId="p1" changes={[]} onChanged={jest.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('says each change in plain words: headline, status, outcome, when', () => {
    const { container } = render(
      <ArchitectureChangesPanel
        projectId="p1"
        changes={[
          change({
            decisionId: 'dec-2',
            headline: 'Backenly improved your Orders architecture',
            status: { label: 'Done', tone: 'good' },
            state: 'stable',
            outcome: { verdict: 'beneficial', summary: 'Changing refund columns no longer locks orders.' },
            actions: { undo: true, pause: false, resume: false },
          }),
        ]}
        onChanged={jest.fn()}
      />,
    )
    expect(screen.getByText('Architecture changes')).toBeTruthy()
    expect(screen.getByText('Backenly improved your Orders architecture')).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByText('Changing refund columns no longer locks orders.')).toBeTruthy()
    expect(screen.getByText('3h ago')).toBeTruthy()
    // Not shown: the internal state, the verdict code, SQL.
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/\bstable\b|\bbeneficial\b|ALTER TABLE|CREATE TABLE/)
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

  it('lists at most five', () => {
    const many = Array.from({ length: 7 }, (_, i) => change({ decisionId: `d${i}`, headline: `Change number ${i}` }))
    render(<ArchitectureChangesPanel projectId="p1" changes={many} onChanged={jest.fn()} />)
    expect(screen.getAllByText(/^Change number \d$/)).toHaveLength(5)
    expect(screen.queryByText('Change number 5')).toBeNull()
  })

  it('offers exactly the actions the engine allows, and none for a change waiting in the queue', () => {
    render(
      <ArchitectureChangesPanel
        projectId="p1"
        changes={[
          change({ decisionId: 'a', headline: 'Running change', actions: { undo: true, pause: true, resume: false } }),
          change({
            decisionId: 'b',
            headline: 'Stopped change',
            status: { label: 'Stopped', tone: 'bad' },
            state: 'failed',
            actions: { undo: false, pause: false, resume: true },
          }),
          change({
            decisionId: 'c',
            headline: 'Change waiting on you',
            status: { label: 'Paused — needs your attention', tone: 'attention' },
            state: 'blocked',
            actions: { undo: true, pause: false, resume: true },
            findingId: 'f-9',
          }),
          change({
            decisionId: 'd',
            headline: 'Finished change',
            status: { label: 'Undone', tone: 'neutral' },
            state: 'rolled_back',
            actions: { undo: false, pause: false, resume: false },
          }),
        ]}
        onChanged={jest.fn()}
      />,
    )
    expect(buttonLabels(rowOf('Running change')).sort()).toEqual(['Pause', 'Undo'])
    expect(buttonLabels(rowOf('Stopped change'))).toEqual(['Resume'])
    expect(buttonLabels(rowOf('Change waiting on you'))).toEqual([])
    expect(within(rowOf('Change waiting on you')).getByText(/Waiting on you in the queue above/)).toBeTruthy()
    expect(buttonLabels(rowOf('Finished change'))).toEqual([])
  })

  it('pauses and resumes by decision id, then re-reads the report', async () => {
    const fetchMock = mockFetch(200, { ok: true, message: 'Paused. Nothing further runs until you resume it.', state: 'blocked' })
    const onChanged = jest.fn()
    render(
      <ArchitectureChangesPanel
        projectId="p1"
        changes={[
          change({ decisionId: 'a', headline: 'Running change' }),
          change({ decisionId: 'b', headline: 'Stopped change', actions: { undo: false, pause: false, resume: true } }),
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
    expect(within(rowOf('Running change')).getByText(/Nothing further runs until you resume it/)).toBeTruthy()
  })

  it('asks once more before an undo', async () => {
    const fetchMock = mockFetch(200, { ok: true, message: 'Undone. Everything is exactly as it was, and no data was lost.', state: 'rolled_back' })
    const onChanged = jest.fn()
    render(<ArchitectureChangesPanel projectId="p1" changes={[change()]} onChanged={onChanged} />)

    fireEvent.click(screen.getByRole('button', { name: /^Undo$/ }))
    expect(screen.getByText('Undo puts orders back exactly as it was. Nothing is lost.')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Keep it/ }))
    expect(screen.queryByText(/Undo puts orders back/)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^Undo$/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Undo$/ }))
    })
    expect(posted(fetchMock)).toEqual([{ url: '/api/projects/p1/architecture', body: { action: 'undo', decisionId: 'dec-1' } }])
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/no data was lost/)).toBeTruthy()
  })

  it('says why a refused action was refused, and re-reads', async () => {
    mockFetch(409, { error: 'Another change is running on this project. Try again in a minute.' })
    const onChanged = jest.fn()
    render(<ArchitectureChangesPanel projectId="p1" changes={[change()]} onChanged={onChanged} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Pause/ }))
    })
    expect(screen.getByText(/Another change is running on this project/)).toBeTruthy()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('never offers to retire or drop anything', () => {
    render(
      <ArchitectureChangesPanel
        projectId="p1"
        changes={[change({ status: { label: 'Done', tone: 'good' }, state: 'stable', actions: { undo: true, pause: true, resume: true } })]}
        onChanged={jest.fn()}
      />,
    )
    for (const b of screen.getAllByRole('button')) {
      expect(b.textContent).not.toMatch(/retire|drop|contract|remove|delete/i)
    }
  })
})
