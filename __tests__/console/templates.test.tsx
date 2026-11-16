/**
 * @jest-environment jsdom
 */
/**
 * THE CONSOLE'S FIXED TEMPLATES (components/console/states.tsx, Time.tsx,
 * KitConfirmDialog in components/inspector/kit.tsx)
 * =====================================================================
 * Project decisions 8, 12 and 13 fixed the words of the empty panel, the
 * error row, the destructive confirm and a time on screen. Every section
 * renders these components rather than its own copy, so the words are
 * pinned once, here:
 *
 *   - an empty panel's second sentence follows the agent's connection and
 *     the person's role, and says nothing while the connection is unknown;
 *   - a failed first load is an alert with Try again; a failed refresh keeps
 *     the data and says how old it is;
 *   - a confirm says whether History can bring it back, and a typed
 *     confirmation holds the button until the exact text is typed;
 *   - a time carries its exact moment for hover and screen readers.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { AskYourAgent, EmptyPanel, ErrorRow, agentSentence } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { KitConfirmDialog } from '@/components/inspector/kit'

describe('the empty panel (decision 12)', () => {
  it('picks its second sentence from the agent connection and the role', () => {
    expect(agentSentence({ status: 'disconnected' }, 1)).toBe('Connect your agent, then send it this.')
    expect(agentSentence({ status: 'disconnected' }, 3)).toBe('Connect your agent, then send it one of these.')
    expect(agentSentence({ status: 'connected', client: 'Claude Code' }, 1)).toBe('Send Claude Code this to start.')
    expect(agentSentence({ status: 'connected', client: null }, 2)).toBe('Send your agent one of these to start.')
    expect(agentSentence({ status: 'disconnected' }, 1, false)).toBe('Ask an owner or admin to connect an agent.')
  })

  it('says nothing about the agent while the connection is unknown, or when nothing is to be sent', () => {
    expect(agentSentence({ status: 'loading' }, 1)).toBeNull()
    expect(agentSentence(undefined, 1)).toBeNull()
    expect(agentSentence({ status: 'disconnected' }, 0)).toBeNull()
  })

  it('renders the title, one sentence, the requests and the docs link, and no button', () => {
    render(
      <EmptyPanel
        title="No tables yet"
        sentence="Your coding agent creates tables as it builds."
        requests={['Create a movies table.']}
        agent={{ status: 'disconnected' }}
        docs={{ label: 'Database docs', slug: 'database' }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'No tables yet' })).toBeInTheDocument()
    expect(screen.getByText('Your coding agent creates tables as it builds. Connect your agent, then send it this.')).toBeInTheDocument()
    expect(screen.getByText('Create a movies table.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Database docs/ }).getAttribute('href')).toMatch(/\/docs\/database$/)
    // The one button is Copy, inside the request block: the panel carries no action of its own.
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Copy'])
  })

  it('gives each of several requests its own copy button', () => {
    render(<AskYourAgent requests={['One.', 'Two.', 'Three.', 'Four.']} />)
    expect(screen.getAllByRole('button', { name: 'Copy request' })).toHaveLength(3)
    expect(screen.queryByText('Four.')).not.toBeInTheDocument()
  })
})

describe('the error row (decision 12)', () => {
  it('replaces the rows with an alert, what still works, and Try again', () => {
    const retry = jest.fn()
    render(<ErrorRow things="tables" stillWorks="The SQL editor still works." onRetry={retry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tables. The SQL editor still works.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('keeps the data after a failed refresh and says how old it is', () => {
    const at = new Date()
    at.setHours(14, 14, 0, 0)
    render(<ErrorRow things="tables" staleAt={at} onRetry={() => {}} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Could not refresh. Showing tables from 2:14 PM.')
  })
})

describe('the destructive confirm (decision 8)', () => {
  const base = { open: true, onCancel: () => {}, title: 'Drop table movies?', danger: true, confirmLabel: 'Drop table' }

  it('says whether History can bring it back', () => {
    const { rerender } = render(
      <KitConfirmDialog {...base} onConfirm={() => {}} description="Its rows go with it." undoable={{ days: 7, detail: 'rows included' }} />,
    )
    expect(screen.getByText('Its rows go with it. You can undo it from History for 7 days, rows included.')).toBeInTheDocument()
    rerender(<KitConfirmDialog {...base} onConfirm={() => {}} undoable={{ detail: 'code and all' }} />)
    expect(screen.getByText('You can undo this in History, code and all.')).toBeInTheDocument()
    rerender(<KitConfirmDialog {...base} onConfirm={() => {}} undoable={false} lost="Its 240 files are deleted for good." />)
    expect(screen.getByText("You can't undo this. Its 240 files are deleted for good.")).toBeInTheDocument()
  })

  it('holds the button until the exact text is typed, then confirms on Enter', () => {
    const confirm = jest.fn()
    render(<KitConfirmDialog {...base} onConfirm={confirm} requireText="movies" />)
    const button = screen.getByRole('button', { name: 'Drop table' })
    const field = screen.getByLabelText('Type movies to confirm')
    expect(button).toBeDisabled()
    fireEvent.change(field, { target: { value: 'Movies' } })
    expect(button).toBeDisabled()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: 'movies' } })
    expect(button).toBeEnabled()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('starts each opening with an empty field', () => {
    const { rerender } = render(<KitConfirmDialog {...base} onConfirm={() => {}} requireText="movies" />)
    fireEvent.change(screen.getByLabelText('Type movies to confirm'), { target: { value: 'movies' } })
    rerender(<KitConfirmDialog {...base} open={false} onConfirm={() => {}} requireText="movies" />)
    rerender(<KitConfirmDialog {...base} onConfirm={() => {}} requireText="movies" />)
    expect(screen.getByLabelText('Type movies to confirm')).toHaveValue('')
  })

  it('works as before when none of the new props are passed', () => {
    const confirm = jest.fn()
    render(<KitConfirmDialog {...base} onConfirm={confirm} description="Plain." />)
    expect(screen.getByText('Plain.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Drop table' }))
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})

describe('<Time> (decision 13)', () => {
  it('writes the moment the console way, with the exact moment in its title and datetime', () => {
    const d = new Date(2026, 10, 14, 2, 9, 41)
    render(<Time iso={d.toISOString()} mode="clock" />)
    const el = screen.getByText('2:09 AM')
    expect(el.tagName).toBe('TIME')
    expect(el).toHaveAttribute('datetime', d.toISOString())
    expect(el.getAttribute('title')).toMatch(/^Sat, Nov 14, 2026, 2:09:41 AM/)
  })

  it('gives screen readers the moment behind a relative time', () => {
    const d = new Date(Date.now() - 12 * 60_000)
    render(<Time iso={d} prefix="Updated" />)
    const el = screen.getByText(/Updated 12 min ago/)
    expect(el.querySelector('.sr-only')?.textContent).toMatch(/^, [A-Z][a-z]{2} \d{1,2}(, \d{4})?, \d{1,2}:\d{2} [AP]M$/)
  })

  it('renders its fallback for a missing moment', () => {
    render(<Time iso={null} fallback="Never" />)
    expect(screen.getByText('Never')).toBeInTheDocument()
  })
})

describe('the component gallery (/app/_kit)', () => {
  // The page reads NODE_ENV when it renders, so flipping it here is what a production build sees.
  const setEnv = (v: string | undefined) => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = v
  }

  it('answers 404 in a production build, and renders in development', async () => {
    const { default: KitPage } = await import('@/app/app/%5Fkit/page')
    const was = process.env.NODE_ENV
    try {
      setEnv('production')
      let thrown: unknown = null
      try {
        KitPage()
      } catch (e) {
        thrown = e
      }
      expect(String((thrown as { digest?: string } | null)?.digest ?? thrown)).toMatch(/404/)
      setEnv('development')
      expect(() => KitPage()).not.toThrow()
    } finally {
      setEnv(was)
    }
  })
})
