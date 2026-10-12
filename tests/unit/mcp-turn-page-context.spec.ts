/**
 * #228 — an MCP turn told the model the user's current page is "mcp".
 *
 * `/api/mcp/chat` used to pass `surface: 'mcp'` to mark the agent door, and
 * `runAgentLoop` rendered any surface into the system prompt as a page name,
 * so every MCP turn told the model there was a page called "mcp", and to read
 * "this table" as whatever that page shows.
 *
 * The door and the page are now separate: the MCP route passes `door: 'mcp'`
 * (which is what keys the protected-production agent gate), and the prompt's
 * page line comes from `userPageContext`, which only renders when a real page
 * name was supplied. There is no caller that does.
 *
 * Structural pins because the wiring between the route and the loop is the
 * property under test, and a behaviour test that scripted a real provider
 * would need a database the unit job deliberately runs without. The pure
 * `userPageContext` helper gets a behaviour test; the route and the loop get
 * the source pins (same pattern as brain-approval-gate.spec.ts).
 */

import fs from 'fs'
import path from 'path'
import { userPageContext } from '@/lib/ai/brain/agent'

const root = path.resolve(__dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

describe('the page line renders a page, never a door (#228)', () => {
  it('renders the line with the page name when a real page is known', () => {
    const line = userPageContext('Database')
    expect(line).toMatch(/^USER'S CURRENT PAGE: Database — /)
  })

  it('renders nothing when no page is known', () => {
    expect(userPageContext()).toBe('')
    expect(userPageContext(null)).toBe('')
    expect(userPageContext(undefined)).toBe('')
  })

  it('still renders any page a caller names, because hiding one name here would paper over the bug', () => {
    // The fix belongs at the caller, not in a name filter: the renderer must
    // stay honest and print what it is told.
    expect(userPageContext('mcp')).toMatch(/^USER'S CURRENT PAGE: mcp — /)
  })
})

describe('the MCP door is not a page (#228)', () => {
  it('the MCP chat route marks the door, and passes no surface', () => {
    const route = read('app/api/mcp/chat/route.ts')
    const call = route.slice(route.indexOf('runBrain('), route.indexOf('(e) => events.push(e))'))
    expect(call).toMatch(/door: 'mcp'/)
    expect(call).not.toMatch(/\bsurface:/)
  })

  it('the brain keeps the agent surface for MCP turns, keyed on the door', () => {
    const agent = read('lib/ai/brain/agent.ts')
    expect(agent).toMatch(/agentSurface:\s*input\.door === 'mcp'/)
    expect(agent).not.toMatch(/agentSurface:\s*input\.surface/)
  })

  it('the loop derives its page line only from the page field', () => {
    expect(read('lib/ai/brain/agent.ts')).toMatch(/userPageContext\(input\.surface\)/)
  })
})