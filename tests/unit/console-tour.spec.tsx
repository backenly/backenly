/**
 * @jest-environment jsdom
 */

/**
 * The one-time console tour (components/tour/ConsoleTour.tsx): it runs only for
 * a user the server says has not seen it, never when the server cannot say,
 * and every way out of it records it as seen so it does not come back.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { ConsoleTour, CONSOLE_TOUR } from '@/components/tour/ConsoleTour'

const push = jest.fn()
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }), useParams: () => ({ id: 'p1' }) }))

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function mountTargets(names = CONSOLE_TOUR.map((s) => s.target)) {
  for (const name of names) {
    const el = document.createElement('button')
    el.dataset.tour = name
    el.textContent = name
    document.body.appendChild(el)
  }
}

async function start(seen: { available: boolean; seen: string[] } | null, status = 200) {
  global.fetch = jest.fn().mockResolvedValue(json(status, seen))
  render(<ConsoleTour />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  await act(async () => {
    jest.advanceTimersByTime(1000)
  })
  await act(async () => {
    jest.runOnlyPendingTimers()
  })
}

/** One interaction, then the card's exit/enter animation run to completion. */
function act_(fn: () => void) {
  act(() => fn())
  act(() => {
    jest.advanceTimersByTime(600)
  })
}

const posts = () => (global.fetch as jest.Mock).mock.calls.filter(([, init]) => init?.method === 'POST')

beforeAll(() => {
  // jsdom lays nothing out, so it has no scrollIntoView to call.
  Element.prototype.scrollIntoView = jest.fn()
})

beforeEach(() => {
  jest.useFakeTimers()
  push.mockReset()
  localStorage.clear()
  document.body.innerHTML = ''
})

afterEach(() => {
  jest.useRealTimers()
})

describe('ConsoleTour', () => {
  it('starts at Connect agent for a user who has not seen it', async () => {
    mountTargets()
    await start({ available: true, seen: [] })
    expect(screen.getByRole('dialog', { name: 'Connect your coding agent' })).toBeInTheDocument()
    expect(screen.getByText('1 of 5')).toBeInTheDocument()
  })

  it('never shows to a user who has seen it', async () => {
    mountTargets()
    await start({ available: true, seen: ['console'] })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(localStorage.getItem('backenly_tour_console')).toBe('seen')
  })

  it('does not show when the server cannot say (migration not run, or request failed)', async () => {
    mountTargets()
    await start({ available: false, seen: [] })
    expect(screen.queryByRole('dialog')).toBeNull()
    await start(null, 500)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not even ask once this browser has recorded it', async () => {
    mountTargets()
    localStorage.setItem('backenly_tour_console', 'seen')
    await start({ available: true, seen: [] })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('walks forward and back, then finishes on Connect and records it', async () => {
    mountTargets()
    await start({ available: true, seen: [] })
    act_(() => fireEvent.click(screen.getByRole('button', { name: /Next/ })))
    expect(screen.getByRole('dialog', { name: 'Everything your agent builds lands here' })).toBeInTheDocument()
    act_(() => fireEvent.click(screen.getByRole('button', { name: 'Back' })))
    expect(screen.getByRole('dialog', { name: 'Connect your coding agent' })).toBeInTheDocument()
    for (let i = 0; i < 4; i++) act_(() => fireEvent.click(screen.getByRole('button', { name: /Next/ })))
    expect(screen.getByRole('dialog', { name: 'Changes waiting on you' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Connect your agent/ }))
    expect(push).toHaveBeenCalledWith('/app/projects/p1/connect')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(posts()).toHaveLength(1)
    expect(JSON.parse(posts()[0][1].body)).toEqual({ tourId: 'console' })
    expect(localStorage.getItem('backenly_tour_console')).toBe('seen')
  })

  it('records it as seen when skipped', async () => {
    mountTargets()
    await start({ available: true, seen: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(posts()).toHaveLength(1)
  })

  it('records it as seen when closed with Escape', async () => {
    mountTargets()
    await start({ available: true, seen: [] })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(posts()).toHaveLength(1)
  })

  it('moves with the arrow keys', async () => {
    mountTargets()
    await start({ available: true, seen: [] })
    act_(() => fireEvent.keyDown(document, { key: 'ArrowRight' }))
    expect(screen.getByText('2 of 5')).toBeInTheDocument()
    act_(() => fireEvent.keyDown(document, { key: 'ArrowLeft' }))
    expect(screen.getByText('1 of 5')).toBeInTheDocument()
  })

  it('drops a step whose target is not on the page instead of pointing at nothing', async () => {
    mountTargets(['connect-agent', 'nav-database', 'nav-autonomy', 'review-inbox'])
    await start({ available: true, seen: [] })
    expect(screen.getByText('1 of 4')).toBeInTheDocument()
  })

  it('does not run on a narrow screen, where the console sidebar is not there to point at', async () => {
    mountTargets()
    const width = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    try {
      await start({ available: true, seen: [] })
      expect(global.fetch).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    }
  })
})
