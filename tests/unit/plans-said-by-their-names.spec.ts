/**
 * Every sentence that names a plan names it as people know it ("Free"), never
 * by its internal code ("SANDBOX"). Production QA (2026-11-09): Usage, the
 * agent's usage answer and the quota refusals said "SANDBOX".
 *
 * A plan's code (UserEntitlements.planName and the like) still keys every
 * decision; where one goes into words, it goes through planDisplayName
 * (lib/entitlements/plan-names.ts).
 */
import fs from 'fs'
import path from 'path'
import { planDisplayName } from '@/lib/entitlements/plan-names'

const ROOT = process.cwd()

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(rel, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) out.push(rel)
  }
  return out
}

it('names the plans as people know them', () => {
  expect(planDisplayName('SANDBOX')).toBe('Free')
  expect(planDisplayName('BUILDER')).toBe('Pro')
  expect(planDisplayName('SCALE')).toBe('Enterprise')
})

it('never puts a plan code into a sentence about the plan', () => {
  // `${x.planName} plan` (or `{x.planName} plan` in JSX), not wrapped in planDisplayName.
  const RAW = /\{\s*(?!planDisplayName\()[\w.!?]*planName\s*\}\s+[Pp]lan\b/
  const offenders: string[] = []
  for (const file of ['lib', 'app', 'components', 'server'].flatMap((d) => sources(d))) {
    fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
      if (RAW.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  expect(offenders).toEqual([])
})
