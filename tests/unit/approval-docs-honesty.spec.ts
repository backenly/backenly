/**
 * THE DOCS DO NOT PROMISE MORE THAN check_approval DOES
 * =====================================================
 * llms.txt and skill.md told the agent an approval status of `failed` means
 * "nothing was applied". The engine says the opposite, in two places: the
 * check_approval guidance ("a call that stops part-way can leave some of its
 * work applied") and lib/mcp/approvals.ts ('Not "nothing was applied": a
 * deploy, a merge or a data migration can stop part-way'). An agent that
 * believed the docs replayed failed deploys on top of half-applied work
 * (T5 / CON-11).
 */

import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
const llms = fs.readFileSync(path.join(ROOT, 'public', 'llms.txt'), 'utf8')
const skill = fs.readFileSync(path.join(ROOT, 'public', 'skill.md'), 'utf8')
const approvals = fs.readFileSync(path.join(ROOT, 'lib', 'mcp', 'approvals.ts'), 'utf8')

it('the engine really does warn that failed can be partial — the docs defer to it', () => {
  expect(approvals).toMatch(/Not "nothing was applied"/)
})

it.each([
  ['llms.txt', llms],
  ['skill.md', skill],
])('%s never says failed means nothing was applied', (_name, text) => {
  expect(text).not.toMatch(/`failed` \(nothing (was )?applied\)/)
})

it.each([
  ['llms.txt', llms],
  ['skill.md', skill],
])('%s tells the agent to read state before retrying a failed approval', (_name, text) => {
  const failedClause = text.split('`failed`')[1]?.slice(0, 200) ?? ''
  expect(failedClause.toLowerCase()).toMatch(/read state|verify|what landed/)
})
