/**
 * The domain table in public/llms.txt says what each section tool can do, and
 * agents act on it. It must name every action the tool really has, no action
 * it does not, and exactly the actions that wait for a human.
 *
 * The catalog conformance suite checks tool names; this checks the actions
 * inside them, which is where the table drifted: after the webhooks tool gained
 * the Webhooks page's endpoints, the table still listed the four trigger
 * actions, and every other check stayed green.
 */

import fs from 'fs'
import path from 'path'
import { DOMAIN_TOOLS, domainInputSchema, needsApproval } from '@/lib/mcp/domains'

const LLMS = fs.readFileSync(path.join(process.cwd(), 'public', 'llms.txt'), 'utf8')

function rowFor(domain: string): string {
  const row = LLMS.split('\n').find((l) => l.startsWith(`| \`${domain}\` |`))
  if (!row) throw new Error(`public/llms.txt has no domain table row for ${domain}`)
  return row
}

/** Backticked words that could be an action or an argument name. */
function words(text: string): string[] {
  return [...text.matchAll(/`([A-Za-z_]+)`/g)].map((m) => m[1])
}

describe.each(DOMAIN_TOOLS.map((d) => [d.name, d] as const))('the llms.txt row for %s', (_name, domain) => {
  const row = rowFor(domain.name)
  const actions = Object.keys(domain.actions)
  const args = new Set(Object.keys(domainInputSchema(domain).properties))

  it('names every action the tool has', () => {
    const named = new Set(words(row))
    expect(actions.filter((a) => !named.has(a))).toEqual([])
  })

  it('names no action the tool does not have', () => {
    const unknown = words(row).filter((w) => w !== domain.name && !actions.includes(w) && !args.has(w))
    expect(unknown).toEqual([])
  })

  it('says exactly which actions wait for a human', () => {
    const gated = actions.filter((a) => needsApproval(domain.actions[a].tool)).sort()
    const clause = row.match(/;([^;]*)\bwaits? for approval/)
    const said = clause ? words(clause[1]).filter((w) => actions.includes(w)).sort() : []
    expect(said).toEqual(gated)
  })
})
