/**
 * @jest-environment jsdom
 */
/**
 * The Autonomy page says when Backenly last looked for architecture changes,
 * and lets a person ask for a look now. Production QA (2026-11-09): the look
 * ran once a day and the console had no way to ask for one.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ArchitectureLookNow } from '@/components/autonomy/ArchitectureLookNow'

const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString()

function stub(look: { status: number; body: unknown }, analyzedAt: string | null = threeHoursAgo) {
  global.fetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const reply = init?.method === 'POST' ? look : { status: 200, body: { analyzedAt, changes: [], waitingOnYou: 0 } }
    return Promise.resolve({ ok: reply.status < 300, status: reply.status, json: async () => reply.body } as Response)
  }) as unknown as typeof fetch
}

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

async function lookNow(onLooked = jest.fn()) {
  render(<ArchitectureLookNow projectId="p1" onLooked={onLooked} />)
  await flush()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Look now' }))
  })
  await flush()
  return onLooked
}

it('says when Backenly last looked', async () => {
  stub({ status: 200, body: { ok: true, requested: 0 } })
  render(<ArchitectureLookNow projectId="p1" onLooked={jest.fn()} />)
  await flush()
  expect(screen.getByText('Backenly last looked for changes worth making 3h ago. It looks every day.')).toBeInTheDocument()
})

it('says when it has not looked yet', async () => {
  stub({ status: 200, body: { ok: true, requested: 0 } }, null)
  render(<ArchitectureLookNow projectId="p1" onLooked={jest.fn()} />)
  await flush()
  expect(screen.getByText(/has not looked for changes worth making yet/)).toBeInTheDocument()
})

it('asks for a look, and says what it found and where it waits', async () => {
  stub({ status: 200, body: { ok: true, assessed: 2, requested: 1 } })
  const onLooked = await lookNow()
  const post = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'POST')
  expect(JSON.parse(post?.[1].body)).toEqual({ action: 'assess' })
  expect(screen.getByRole('status')).toHaveTextContent('Found 1 change worth making. It is waiting on you above.')
  expect(onLooked).toHaveBeenCalled()
})

it('says when nothing is worth changing', async () => {
  stub({ status: 200, body: { ok: true, assessed: 2, requested: 0 } })
  await lookNow()
  expect(screen.getByRole('status')).toHaveTextContent('Looked just now. No change is worth making right now.')
})

it("says when the next look may start, in the route's words", async () => {
  const words = 'Backenly looked for changes in the last 10 minutes. Ask again in 7 minutes.'
  stub({ status: 429, body: { error: words, code: 'ASSESSED_RECENTLY' } })
  await lookNow()
  expect(screen.getByRole('status')).toHaveTextContent(words)
})

it('tells a member who is not an admin who can ask', async () => {
  stub({ status: 403, body: { error: 'Project not found or access denied' } })
  await lookNow()
  expect(screen.getByRole('status')).toHaveTextContent('Only an organization admin can ask Backenly to look.')
})
