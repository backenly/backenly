/**
 * Every destructive tool says what it destroys (describeApproval,
 * lib/mcp/approval-describe.ts, which the brain's gate and the MCP door share).
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

const describer = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'mcp', 'approval-describe.ts'), 'utf8')

/** The tools describeApproval has a `case` for. */
function describedTools(): Set<string> {
  const start = describer.indexOf('export async function describeApproval(')
  expect(start).toBeGreaterThan(-1)
  const body = describer.slice(start, describer.indexOf('\n}\n', start))
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
