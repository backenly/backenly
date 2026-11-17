/**
 * @jest-environment jsdom
 */
/**
 * THE FIRST PAGE OF A SECTION THE AGENT BUILDS INTO (components/console/FirstRun.tsx)
 * ================================================================================
 * Database, Auth & Users, Storage, Functions and Realtime open on this page
 * until the agent builds there (the founder's call, 2026-11-17). Pinned here:
 *
 *   - the outline of the page is decorative: hidden from assistive tech, and
 *     it carries no words, so nothing in it reads as the project's data;
 *   - Connect agent is offered only once the answer is in and it is "not
 *     connected", and only to someone who may connect one; anyone else is
 *     told who can;
 *   - a connected agent is named on the requests, and nothing asks to connect;
 *   - the docs open in a new tab and say so.
 */
import { render, screen } from '@testing-library/react'
import { FirstRun, type FirstRunPicture, type FirstRunProps } from '@/components/console/FirstRun'

const BASE: FirstRunProps = {
  picture: 'tables',
  title: 'No tables yet',
  sentence: 'Your agent creates the tables your app needs, each with REST endpoints and row-level security.',
  requests: ['Add a products table with a name, a price in cents and a stock count.'],
  projectId: 'p1',
  docs: { label: 'Database docs', slug: 'database' },
}

describe('the first-run page', () => {
  it('says what the section holds, hands over the request, and offers Connect agent and the docs', () => {
    const { container } = render(<FirstRun {...BASE} agent={{ status: 'disconnected' }} />)
    expect(screen.getByRole('heading', { level: 2, name: 'No tables yet' })).toBeInTheDocument()
    expect(screen.getByText(BASE.sentence)).toBeInTheDocument()
    expect(screen.getByText('Ask your agent')).toBeInTheDocument()
    expect(screen.getByText(BASE.requests[0])).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Connect agent/ }).getAttribute('href')).toBe('/app/projects/p1/connect')
    const docs = screen.getByRole('link', { name: /Database docs/ })
    expect(docs.getAttribute('href')).toMatch(/^(https:\/\/backenly\.com)?\/docs\/database$/)
    expect(docs.getAttribute('target')).toBe('_blank')
    expect(docs).toHaveTextContent('(opens in a new tab)')
    // The outline is a picture: hidden from assistive tech, with no words in it.
    const picture = container.querySelector('[aria-hidden="true"].overflow-hidden')
    expect(picture).not.toBeNull()
    expect(picture?.textContent).toBe('')
  })

  it('names a connected agent on the requests and asks nothing of the person', () => {
    render(<FirstRun {...BASE} agent={{ status: 'connected', client: 'Claude Code' }} />)
    expect(screen.getByText('Ask Claude Code')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Connect agent/ })).toBeNull()
    expect(screen.queryByText(/owner or admin/)).toBeNull()
  })

  it('falls back to "your agent" when the connected client has no name', () => {
    render(<FirstRun {...BASE} agent={{ status: 'connected', client: '  ' }} />)
    expect(screen.getByText('Ask your agent')).toBeInTheDocument()
  })

  it('tells someone who may not connect an agent who can, with nothing to press', () => {
    render(<FirstRun {...BASE} agent={{ status: 'disconnected' }} canConnect={false} />)
    expect(screen.getByText('Only an owner or admin can connect an agent to this project.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Connect agent/ })).toBeNull()
  })

  it('offers nothing about the agent while its connection is unknown', () => {
    for (const agent of [null, undefined, { status: 'loading' as const }]) {
      const { unmount } = render(<FirstRun {...BASE} agent={agent} />)
      expect(screen.queryByRole('link', { name: /Connect agent/ })).toBeNull()
      expect(screen.queryByText(/owner or admin/)).toBeNull()
      expect(screen.getByRole('link', { name: /Database docs/ })).toBeInTheDocument()
      unmount()
    }
  })

  it('draws an outline for every section, none of them with words', () => {
    const pictures: FirstRunPicture[] = ['tables', 'users', 'files', 'functions', 'events']
    for (const picture of pictures) {
      const { container, unmount } = render(<FirstRun {...BASE} picture={picture} agent={{ status: 'disconnected' }} />)
      const outline = container.querySelector('[aria-hidden="true"].overflow-hidden')
      expect(outline).not.toBeNull()
      expect(outline?.textContent).toBe('')
      unmount()
    }
  })
})
