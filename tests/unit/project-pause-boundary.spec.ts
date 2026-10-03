/**
 * The inactivity pause stays Cloud-only, and stays split where it was drawn.
 *
 * The mechanics (columns, gates, transitions) are public so the public tree is
 * a truthful description of what Cloud runs. The DECISION to pause, and whether
 * resuming is free, is Backenly's commercial policy and lives in the private
 * overlay. These assertions keep both halves of that true:
 *
 *   - no public code pauses anything, so a self-hosted project never pauses;
 *   - the transitions never read a plan, so policy cannot leak into them;
 *   - self-hosted entitlements say "never paused" in so many words.
 *
 * "Public code" is what git tracks. Overlay files are never tracked in this
 * repository, so the same check holds on a composed Cloud checkout, where the
 * private sweep legitimately calls the transitions.
 */
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'

import { selfHostedEntitlements } from '@/lib/entitlements'
import { activeProjectsWhere } from '@/lib/autonomy/activity-gate'

const LIFECYCLE = 'lib/projects/pause-lifecycle.ts'

function trackedSource(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--', 'app', 'lib', 'server', 'components', 'scripts', 'packages', 'instrumentation.ts'],
    { encoding: 'utf8' },
  )
  return out
    .split('\n')
    .map(f => f.trim())
    .filter(f => /\.(ts|tsx|js|mjs)$/.test(f))
}

describe('who may pause a project', () => {
  it.each(['applyPauseTransition', 'applyResumeTransition'])(
    'no public file calls %s; only the private overlay does',
    fn => {
      const callers = trackedSource().filter(
        f => f !== LIFECYCLE && readFileSync(f, 'utf8').includes(fn),
      )
      expect(callers).toEqual([])
    },
  )

  it('found the files it is checking, so an empty result means something', () => {
    // Guards the assertion above against passing because git returned nothing.
    const files = trackedSource()
    expect(files.length).toBeGreaterThan(500)
    expect(files).toContain(LIFECYCLE)
  })
})

describe('the transitions carry no commercial policy', () => {
  it('pause-lifecycle.ts imports no billing, entitlements or overlay module', () => {
    const imports = readFileSync(LIFECYCLE, 'utf8')
      .split('\n')
      .filter(line => /^\s*import\b|from\s+['"]/.test(line))
      .join('\n')

    expect(imports).not.toMatch(/@\/lib\/entitlements/)
    expect(imports).not.toMatch(/@\/lib\/billing/)
    expect(imports).not.toMatch(/@cloud\//)
  })
})

describe('a self-hosted deployment never pauses', () => {
  it('says so in its entitlements', () => {
    const e = selfHostedEntitlements()
    expect(e.inactivityPauseDays).toBeNull()
    expect(e.pausedFreeResumeDays).toBeNull()
  })
})

describe('background passes skip a paused project', () => {
  it('the shared activity rule excludes it, for every scheduler that uses it', () => {
    expect(activeProjectsWhere()).toMatchObject({ pausedAt: null, deletedAt: null })
  })
})
