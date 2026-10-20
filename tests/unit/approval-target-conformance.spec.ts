/**
 * Every destructive tool says what it destroys (describeDanger, lib/ai/brain/agent.ts).
 *
 * When the brain's gate stops a destructive call, describeDanger writes its
 * target, and over MCP that target is the Review Queue entry a person approves
 * or rejects. A tool without a case of its own fell to the default, whose
 * target is the bare tool name: a person was asked to approve `delete_webhook`
 * without being told which endpoint it deletes (#224).
 *
 * Read from the source: describeDanger is internal to the agent loop, and
 * several of its cases look their target up in a database this suite does not
 * have.
 */

import fs from 'fs'
import path from 'path'
import { BRAIN_TOOLS, isDestructiveTool } from '@/lib/ai/brain/tools'

const agent = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'ai', 'brain', 'agent.ts'), 'utf8')

/** The tools describeDanger has a `case` for. */
function describedTools(): Set<string> {
  const start = agent.indexOf('async function describeDanger(')
  expect(start).toBeGreaterThan(-1)
  const body = agent.slice(start, agent.indexOf('\n}\n', start))
  return new Set([...body.matchAll(/^\s*case '([a-z_]+)':/gm)].map((m) => m[1]))
}

describe('the Review Queue entry of a destructive call', () => {
  it('is written by a case of its own for every destructive tool', () => {
    // The gate's own test over the whole catalog: every destructive tool a call can name.
    const destructive = BRAIN_TOOLS.map((t) => t.function.name).filter(isDestructiveTool)
    expect(destructive.length).toBeGreaterThan(0)
    const described = describedTools()
    // Listed by name, so a tool that falls to the default is the one reported.
    expect(destructive.filter((tool) => !described.has(tool))).toEqual([])
  })
})
