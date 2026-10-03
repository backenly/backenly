/**
 * A REQUEST MUST NEVER AUTHORIZE ONE PROJECT AND OPERATE ON ANOTHER
 * ================================================================
 * `extractProjectId` used to return the `?projectId=` query parameter whenever
 * one was present, falling back to the URL path. That made a confused deputy
 * possible by construction:
 *
 *     POST /api/projects/VICTIM/thing?projectId=MINE
 *
 * would authorize MINE - the caller's own project, so the check passes - and
 * then any handler reading its path parameter would act on VICTIM.
 *
 * No route in the tree mixed the two that way, so this was latent rather than
 * live. It was one reasonable-looking edit from being real, which is exactly
 * the kind of hazard worth removing structurally rather than documenting.
 *
 * Two rules, tested here: the path wins, and a disagreement is REFUSED rather
 * than resolved in favour of either side. Refusing matters - answering a
 * request that names two different projects invites somebody to build on the
 * behaviour.
 */

import { resolveProjectId, PROJECT_ID_CONFLICT } from '@/lib/middleware/projectValidation'

const PATH_ID = 'proj-from-path'
const QUERY_ID = 'proj-from-query'

/**
 * The rule takes a pathname and a query value, so the tests state exactly the
 * two inputs that matter. Building a NextRequest here is impossible anyway:
 * the test environment's Request polyfill defines `url` as a getter.
 */
function resolve(pathname: string, query: string | null = null) {
  return resolveProjectId(pathname, query)
}

describe('when only one source names a project', () => {
  it('reads the id from the path', () => {
    expect(resolve(`/api/projects/${PATH_ID}/database`)).toBe(PATH_ID)
  })

  it('reads the id from the query when there is no path id', () => {
    // Routes that genuinely have no path project still work this way.
    expect(resolve('/api/database/tables', QUERY_ID)).toBe(QUERY_ID)
  })

  it('returns null when neither names one', () => {
    expect(resolve('/api/health')).toBeNull()
  })
})

describe('when both name a project', () => {
  it('accepts them when they agree', () => {
    // A client sending both consistently is not an attack, and refusing it
    // would break callers for no benefit.
    expect(resolve(`/api/projects/${PATH_ID}/database`, PATH_ID)).toBe(PATH_ID)
  })

  it('REFUSES them when they differ', () => {
    // The whole point. Neither "prefer the path" nor "prefer the query" is
    // safe, because a handler downstream may read the other one.
    expect(resolve(`/api/projects/${PATH_ID}/database`, QUERY_ID)).toBe(PROJECT_ID_CONFLICT)
  })

  it('refuses regardless of which id the caller owns', () => {
    // Stated from the attacker's direction: putting your OWN project in the
    // query and somebody else's in the path is the exploit shape, and it is
    // refused before any authorization decision is made.
    expect(resolve('/api/projects/victim-project/database', 'my-project')).toBe(PROJECT_ID_CONFLICT)
    expect(resolve('/api/projects/my-project/database', 'victim-project')).toBe(PROJECT_ID_CONFLICT)
  })
})

describe('the conflict signal', () => {
  it('is distinguishable from a real project id and from absence', () => {
    // A caller must not be able to produce it as a string, and it must not be
    // confused with "no project named", which is a 400 of a different kind.
    expect(typeof PROJECT_ID_CONFLICT).toBe('symbol')
    expect(PROJECT_ID_CONFLICT).not.toBe(null)
  })
})
