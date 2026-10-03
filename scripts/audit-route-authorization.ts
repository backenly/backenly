/**
 * WHICH ROUTES TAKE A RESOURCE ID AND NEVER CHECK WHO IS ASKING
 * ============================================================
 *
 *   npx tsx scripts/audit-route-authorization.ts            # summary + risks
 *   npx tsx scripts/audit-route-authorization.ts --json     # machine-readable
 *   npx tsx scripts/audit-route-authorization.ts --all      # every route
 *
 * WHY THIS EXISTS
 * ---------------
 * `/api/projects/[id]/schema-versions` called `verifyToken` and stopped. That
 * proves the caller is SOME signed-in user and says nothing about whether the
 * project in the URL is theirs, so any account could read another tenant's
 * schema snapshots and roll back another tenant's schema. It had no UI, which
 * is why nothing noticed.
 *
 * `/api/database/query` was the same shape from a different angle: reachable,
 * apparently guarded, and running raw SQL on the application connection with a
 * regex as its only tenant boundary.
 *
 * Two defects, both in surfaces normal product use never exercises. So "which
 * other routes look like that" is a question worth answering mechanically
 * rather than one UI at a time.
 *
 * WHAT IT CAN AND CANNOT SEE
 * --------------------------
 * This is static analysis of route files. It can see which guard a route calls
 * and whether it accepts a resource identifier. It CANNOT see whether the SQL
 * underneath is tenant-scoped — that depends on service functions it does not
 * follow, and a route can call the right helper and still hand an unscoped id
 * to a library, which is exactly what `getSchemaVersion` did.
 *
 * So its output is a RISK REGISTER, not a verdict. A route it flags needs a
 * human to look; a route it does not flag is not thereby proven safe. Saying
 * that plainly matters more than the count, because a green audit that is
 * actually a blind one is the failure mode this whole program keeps finding.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, relative, sep } from 'path'

const ROOT = process.cwd()
const API_DIR = join(ROOT, 'app', 'api')

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
type Verb = (typeof HTTP_VERBS)[number]

/** Verbs that can change state. Used to rank a missing check by consequence. */
const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface RouteRecord {
  route: string
  file: string
  verbs: Verb[]
  /** How the caller is identified. */
  authn:
    | 'withProjectAccess' | 'withTenantIsolation' | 'withProjectValidation'
    | 'withAuth' | 'requireAuth' | 'authenticateRequest' | 'requireAdmin' | 'verifySession'
    | 'requireUser'
    | 'v1ApiMiddleware' | 'getProjectContext'
    | 'mcpGuard' | 'verifyToken' | 'sharedSecret' | 'none'
  /** Explicit authorization helpers called in the file. */
  authz: string[]
  /** A dynamic segment, e.g. [id] or [webhookId]. */
  pathParams: string[]
  /** Reads a project id from the query string or the body. */
  readsProjectIdFromInput: boolean
  mutating: boolean
  /** The query filters on the authenticated caller's id, which IS authorization. */
  scopedByCallerIdentity: boolean
  /** `findUnique({ where: { id ... } })` — a lookup by bare resource id. */
  bareFindUnique: boolean
  risk: 'high' | 'medium' | 'none'
  why: string[]
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry === 'route.ts') out.push(full)
  }
  return out
}

/** `app/api/projects/[id]/webhooks/route.ts` → `/api/projects/[id]/webhooks` */
function routePath(file: string): string {
  const rel = relative(ROOT, file).split(sep).join('/')
  return '/' + rel.replace(/^app\//, '').replace(/\/route\.ts$/, '')
}

function classify(file: string): RouteRecord {
  const src = readFileSync(file, 'utf8')
  const route = routePath(file)

  const verbs = HTTP_VERBS.filter(v =>
    new RegExp(`export\\s+(?:const|async\\s+function)\\s+${v}\\b`).test(src)
  )

  // Ordered most-specific first: withProjectAccess already resolves and
  // authorizes a project, so a file using it is not merely "withAuth".
  //
  // The full set was enumerated from the tree rather than assumed. A first
  // pass knew only five of them and flagged 218 of 322 routes, most of them
  // simply using `requireAuth` or `authenticateRequest` — a 68% flag rate that
  // would train everybody to ignore the report, which is worse than not having
  // one.
  const authn: RouteRecord['authn'] =
    /withProjectAccess\s*[(<]/.test(src) ? 'withProjectAccess'
    : /withProjectValidation\s*[(<]/.test(src) ? 'withProjectValidation'
    // The public end-user runtime. It authenticates with the PROJECT's API key
    // rather than a dashboard session, and lib/api/v1/middleware.ts refuses a
    // key whose projectId does not match the one in the path, recording a
    // security event when that happens. That is a tenant boundary, and a
    // stricter one than most: not knowing about it flagged all 32 /api/v1
    // routes as unauthenticated, which was the largest single block of false
    // positives in the first report.
    : /v1ApiMiddleware\s*\(/.test(src) ? 'v1ApiMiddleware'
    // Calls requireUser AND canAccessProject before returning the project, so
    // it is both the authentication and the authorization for its callers.
    : /getProjectContext\s*\(/.test(src) ? 'getProjectContext'
    : /withTenantIsolation\s*[(<]/.test(src) ? 'withTenantIsolation'
    : /requireAdmin\s*\(/.test(src) ? 'requireAdmin'
    : /withAuth\s*\(/.test(src) ? 'withAuth'
    : /requireAuth\s*\(/.test(src) ? 'requireAuth'
    : /authenticateRequest\s*\(/.test(src) ? 'authenticateRequest'
    : /verifySession\s*\(/.test(src) ? 'verifySession'
    // What requireAdmin and getProjectContext are both built on: it verifies
    // the cookie token AND that a matching session row exists and has not
    // expired. Listed after those two so a route using a stronger guard is
    // still classified by the stronger one.
    : /requireUser\s*\(/.test(src) ? 'requireUser'
    : /mcpGuard\s*\(/.test(src) ? 'mcpGuard'
    : /verifyToken\s*\(/.test(src) ? 'verifyToken'
    // A scheduled or machine caller proves itself with a shared secret rather
    // than a session. Checked last, so a route that also has a real guard is
    // classified by the stronger one.
    : /(CRON_SECRET|INTERNAL_API_TOKEN|AI_EXECUTION_TOKEN|x-internal-token|verifySignature|constructEvent)/.test(src)
      ? 'sharedSecret'
    : 'none'

  // Helpers that answer "may this caller touch this project".
  //
  // createOrchestrationContext is included because it calls
  // validateProjectAccess(projectId, userId) before anything else, so a route
  // handing it both is authorized. Not knowing that flagged the two
  // /api/testing routes as unguarded when the check was simply one call
  // deeper — the limit this file's header warns about, erring toward false
  // positives rather than false negatives.
  const authz = [
    'canAccessProject', 'canAdministerProject', 'canWriteProject',
    'requireProjectAccess', 'validateProjectAccess', 'createOrchestrationContext',
    // getProjectContext calls canAccessProject before returning the project,
    // so /api/projects/[id]/go-live was authorized all along.
    'getProjectContext',
    // Cross-checks a child resource's projectId against the authorized one.
    // /api/storage/buckets/[bucketId] uses it on every verb, which is the
    // correct pattern for a globally unique child id.
    'validateProjectOwnership',
    // Resolves the project FOR THE CALLER via resolveForUser and throws on a
    // cross-tenant request, recording a security event. It is authentication
    // and authorization in one call.
    'getCurrentProjectId',
    // Delegates straight to canAccessProject / canWriteProject /
    // canAdministerProject by access level, then applies the plan entitlement
    // SECOND and separately. Listed here rather than baselining the five
    // webhook routes: a baseline entry per route would turn the file this
    // detector guards into a suppression list, which is the one thing it must
    // never become. Teaching the detector about a helper that really does
    // authorize keeps the ratchet meaningful for the next route that uses it.
    'guardWebhookRoute',
  ].filter(h => new RegExp(`\\b${h}\\s*\\(`).test(src))

  const pathParams = Array.from(route.matchAll(/\[([^\]]+)\]/g)).map(m => m[1])

  const readsProjectIdFromInput =
    /searchParams\.get\(\s*['"]projectId['"]\s*\)/.test(src) ||
    /\bbody\s*\.\s*projectId\b/.test(src) ||
    /\{[^}]*\bprojectId\b[^}]*\}\s*=\s*(?:body|await\s+request\.json)/.test(src)

  const mutating = verbs.some(v => MUTATING.has(v))
  const bareFindUnique = /findUnique\s*\(\s*\{\s*where:\s*\{\s*id\b/.test(src)

  // ── Risk ────────────────────────────────────────────────────────────────
  //
  // The shape that produced the IDOR: authenticated, accepts a resource
  // identifier, and never calls an authorization helper. `withProjectAccess`
  // and `withTenantIsolation` resolve AND authorize, so they clear it;
  // `withAuth`, `verifyToken` and `mcpGuard` identify only.
  const why: string[] = []
  // Guards that answer "who is this" but not "may they touch this resource".
  // withProjectAccess and withTenantIsolation resolve AND authorize a project,
  // so they are excluded; requireAdmin answers a platform-level question that
  // is not per-project either, but an admin route is deliberately privileged.
  const identifiesOnly =
    authn === 'withAuth' || authn === 'requireAuth' || authn === 'verifySession' ||
    authn === 'authenticateRequest' || authn === 'verifyToken' || authn === 'mcpGuard'
  const takesResourceId = pathParams.length > 0 || readsProjectIdFromInput

  // Scoping the QUERY by the authenticated user is authorization, and a
  // stronger form of it than a separate helper call: there is no window
  // between the check and the use. /api/api-keys/[id] does exactly this with
  // `where: { id, userId: auth.userId }`, and counting it as unguarded was a
  // false positive that would have buried the real findings.
  //
  // The word boundary is built with String.fromCharCode(92) rather than
  // written as an escape, because this file has been rewritten through a
  // heredoc more than once and a backslash-b written that way decays into a
  // literal BACKSPACE (U+0008). The regex still compiles, matches nothing,
  // and every route is reported as unscoped - a clean check that is actually
  // a blind one. That happened here, and it is the same decay this repository
  // has recorded before.
  // It must be in a WHERE clause, not merely somewhere in the file.
  //
  // The first version matched the caller's id anywhere, and
  // /api/ai-workspace/apply-changes writes `userId: auth.userId` into an audit
  // log while passing an UNCHECKED `projectId` from the request body straight
  // to applyChangesFromPlan. So a confirmed cross-tenant write was cleared by
  // its own logging — a false negative, which is far worse than the false
  // positives this heuristic exists to remove. Narrowing to `where:` is what
  // distinguishes "the query is scoped by the caller" from "the caller is
  // mentioned".
  const WORD_BOUNDARY = String.fromCharCode(92) + 'b'
  const callerScoped = new RegExp(
    'where:\\s*\\{[^}]{0,400}' +
    WORD_BOUNDARY + '(?:userId|ownerId):\\s*(?:auth|user|session|ctx)\\.[A-Za-z]+',
    's'
  )
  const scopedByCallerIdentity = callerScoped.test(src)

  // A route may also authorize by COMPARING the caller to the resource, which
  // is what a self-or-admin rule looks like: `caller.userId !== params.userId`
  // guarded by a requireAdmin escape. That is authorization, and recognising
  // it is what lets a fixed route leave the baseline instead of sitting there
  // permanently UNREVIEWED and teaching everyone to ignore the list.
  // A route may authorize by loading the resource and COMPARING its owning
  // project to the authorized one - `issue.projectId !== projectId`. That is
  // weaker than a scoped predicate, because the row is fetched before the
  // check, but it is a real check and apply-fix does it before executing
  // anything. Recognising it is what lets a reviewed route leave the baseline.
  // The strongest form: projectId in the query PREDICATE, so a wrong tenant
  // simply matches nothing. `findFirst({ where: { id, projectId } })`.
  // Recognised because it is what the audit is trying to push routes toward,
  // and a route that already does it should not stay on the list.
  const scopedPredicate = new RegExp(
    `where:\\s*\\{[^}]{0,200}${WORD_BOUNDARY}projectId${WORD_BOUNDARY}`,
    's',
  ).test(src)

  const comparesOwningProject =
    /\.projectId\s*[!=]==\s*projectId/.test(src) ||
    new RegExp(`${WORD_BOUNDARY}projectId\\s*[!=]==\\s*\\w+\\.projectId`).test(src)

  const selfOrAdmin =
    /requireAdmin\s*\(/.test(src) &&
    /(?:caller|user|auth|session)\.userId\s*[!=]==\s*params\./.test(src)

  if (authn === 'none' && verbs.length > 0) {
    why.push('no authentication guard found')
  }
  if (
    identifiesOnly && takesResourceId && authz.length === 0 &&
    !scopedByCallerIdentity && !selfOrAdmin && !comparesOwningProject && !scopedPredicate
  ) {
    why.push(
      `${authn} identifies the caller but no authorization helper is called, ` +
      `while the route accepts ${pathParams.length ? `path param(s) ${pathParams.join(', ')}` : 'a projectId from input'}`
    )
  }
  // Only when nothing authorized the caller first. /api/project/deploy calls
  // canWriteProject and THEN looks the project up by id, which is the correct
  // order — the lookup is not the boundary, the check before it is. Flagging
  // that was a false positive.
  const authorizingGuard =
    authn === 'withProjectAccess' || authn === 'withTenantIsolation' ||
    authn === 'withProjectValidation' || authn === 'v1ApiMiddleware' ||
    authn === 'getProjectContext'

  if (
    bareFindUnique && takesResourceId && !scopedByCallerIdentity &&
    authz.length === 0 && !selfOrAdmin && !authorizingGuard && !comparesOwningProject &&
    // An admin-gated route looking a resource up by id is not a finding: the
    // caller has already been established as a platform administrator, and
    // these resources are not project-scoped.
    authn !== 'requireAdmin' && !/requireAdmin\s*\(/.test(src)
  ) {
    why.push('findUnique by bare id: a resource id is not proof of ownership')
  }

  let risk: RouteRecord['risk'] = 'none'
  if (why.length > 0) risk = mutating ? 'high' : 'medium'
  // An unauthenticated mutating route is the worst case regardless.
  if (authn === 'none' && mutating && verbs.length > 0) risk = 'high'

  return {
    route, file: relative(ROOT, file).split(sep).join('/'),
    verbs, authn, authz, pathParams, readsProjectIdFromInput,
    mutating, scopedByCallerIdentity, bareFindUnique, risk, why,
  }
}

const BASELINE = join(ROOT, '.github', 'route-authorization-baseline.json')

/**
 * One reviewed route.
 *
 * `status` exists because "the detector stopped flagging it" and "a human
 * looked and it is safe" are different facts, and only the second is evidence.
 * Without the distinction, a route silently left the list whenever the
 * heuristics improved, and a later reviewer could not tell which had happened.
 *
 *   UNREVIEWED  still flagged, nobody has looked yet
 *   ACCEPTED    still flagged, reviewed, and the shape is correct here anyway
 *   SAFE        reviewed and confirmed safe; the reason records HOW that was
 *               established, so it survives the detector changing its mind
 */
interface BaselineEntry {
  route: string
  status?: 'UNREVIEWED' | 'ACCEPTED' | 'SAFE'
  /** Why. For SAFE and ACCEPTED this is the evidence a later reviewer reads. */
  reason: string
}

/**
 * Fail when a route is flagged and not in the baseline.
 *
 * The baseline is a ratchet, not an exemption list. Every route in it is either
 * explained or marked UNREVIEWED, and the point is that a NEW route with the
 * shape that produced the schema-versions IDOR cannot be added without somebody
 * either fixing it or writing down why it is fine. Grandfathering what is
 * already there keeps the check honest rather than permanently red.
 *
 * Routes that have been FIXED are removed from the baseline automatically by
 * this check failing in the other direction, so the list can only shrink
 * without someone noticing.
 */
function check(records: RouteRecord[]): void {
  let baseline: BaselineEntry[] = []
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  } catch {
    console.error('')
    console.error(`  No baseline at ${relative(ROOT, BASELINE)}.`)
    console.error('  Generate one with --write-baseline, then review its entries.')
    console.error('')
    process.exit(1)
  }

  const known = new Map(baseline.map(b => [b.route, b]))
  const flagged = records.filter(r => r.risk !== 'none')
  const flaggedRoutes = new Set(flagged.map(r => r.route))

  const added = flagged.filter(r => !known.has(r.route))

  // A SAFE entry is KEPT after it stops being flagged. That is the whole point:
  // it records that somebody looked and what they established, so a later
  // reviewer can tell "reviewed and safe" from "the detector changed its mind".
  // Only UNREVIEWED and ACCEPTED entries are expected to track the detector.
  const stale = baseline.filter(
    b => (b.status ?? 'UNREVIEWED') !== 'SAFE' && !flaggedRoutes.has(b.route),
  )

  // A SAFE route that starts being flagged again is a regression in something
  // that was reviewed, which deserves a louder failure than a new route.
  const regressed = baseline.filter(
    b => b.status === 'SAFE' && flaggedRoutes.has(b.route),
  )

  const counts = baseline.reduce<Record<string, number>>((acc, b) => {
    const k = b.status ?? 'UNREVIEWED'
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})

  if (added.length === 0 && stale.length === 0 && regressed.length === 0) {
    const summary = Object.entries(counts).sort().map(([k, v]) => `${v} ${k}`).join(' · ')
    console.log(`  Route authorization: ${flagged.length} flagged. Baseline: ${summary}.`)
    if ((counts.UNREVIEWED ?? 0) > 0) {
      console.log(`  ${counts.UNREVIEWED} entr(y/ies) still UNREVIEWED.`)
    }
    return
  }

  if (regressed.length > 0) {
    console.error('')
    console.error('  These were reviewed and marked SAFE, and are flagged again:')
    for (const b of regressed) {
      console.error(`    ${b.route}`)
      console.error(`      was: ${b.reason}`)
    }
    console.error('')
  }

  if (added.length > 0) {
    console.error('')
    console.error('  These routes accept a resource identifier and never authorize the caller:')
    console.error('')
    for (const r of added) {
      console.error(`    ${r.risk.toUpperCase().padEnd(6)} ${r.verbs.join(',').padEnd(16)} ${r.route}`)
      for (const w of r.why) console.error(`           ${w}`)
    }
    console.error('')
    console.error('  Fix the route, or add it to the baseline with a reason explaining why')
    console.error('  this shape is correct here. A resource id is not proof of ownership.')
    console.error('')
  }

  if (stale.length > 0) {
    // Not a failure to celebrate quietly: a stale baseline is how a ratchet
    // loosens without anybody deciding to loosen it. Mark the entry SAFE with
    // the evidence instead of deleting it, so the review is not lost.
    console.error('')
    console.error('  These baseline entries are no longer flagged. Either remove them,')
    console.error('  or set status SAFE with a reason recording what you established:')
    for (const b of stale) console.error(`    ${b.route}`)
    console.error('')
  }

  process.exit(1)
}

function writeBaseline(records: RouteRecord[]): void {
  const flagged = records.filter(r => r.risk !== 'none')
  const existing = new Map<string, BaselineEntry>()
  try {
    for (const b of JSON.parse(readFileSync(BASELINE, 'utf8')) as BaselineEntry[]) {
      existing.set(b.route, b)
    }
  } catch { /* first run */ }

  // Reasons already written are preserved; only the route list is refreshed.
  // SAFE entries are carried forward even when no longer flagged, so a review
  // is never lost by regenerating the file.
  const safeKept = [...existing.values()].filter(
    b => b.status === 'SAFE' && !flagged.some(r => r.route === b.route),
  )
  const out: BaselineEntry[] = [
    ...flagged.map(r => {
      const prior = existing.get(r.route)
      return {
        route: r.route,
        status: prior?.status ?? ('UNREVIEWED' as const),
        reason: prior?.reason ?? 'UNREVIEWED',
      }
    }),
    ...safeKept,
  ].sort((a, b) => a.route.localeCompare(b.route))
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + String.fromCharCode(10), 'utf8')
  console.log(`  Wrote ${out.length} entries to ${relative(ROOT, BASELINE)}`)
  console.log(`  ${out.filter(e => (e.status ?? 'UNREVIEWED') === 'UNREVIEWED').length} are UNREVIEWED.`)
}

function main(): void {
  const files = walk(API_DIR)
  const records = files.map(classify).sort((a, b) => a.route.localeCompare(b.route))

  if (process.argv.includes('--write-baseline')) {
    writeBaseline(records)
    return
  }
  if (process.argv.includes('--check')) {
    check(records)
    return
  }
  if (process.argv.includes('--json')) {
    const out = join(ROOT, 'route-authorization.json')
    writeFileSync(out, JSON.stringify(records, null, 2), 'utf8')
    console.log(out)
    return
  }

  const flagged = records.filter(r => r.risk !== 'none')
  const showAll = process.argv.includes('--all')

  console.log('')
  console.log('  Route authorization audit')
  console.log('')
  console.log(`  routes              ${records.length}`)
  console.log(`  with a guard        ${records.filter(r => r.authn !== 'none').length}`)
  const AUTHORIZING = new Set(['withProjectAccess', 'withTenantIsolation', 'withProjectValidation', 'v1ApiMiddleware', 'getProjectContext'])
  console.log(`  authorizing guard   ${records.filter(r => AUTHORIZING.has(r.authn)).length}`)
  console.log(`  scoped by caller    ${records.filter(r => r.scopedByCallerIdentity).length}`)
  console.log(`  explicit authz call ${records.filter(r => r.authz.length > 0).length}`)
  console.log(`  flagged             ${flagged.length}  (high ${flagged.filter(r => r.risk === 'high').length})`)
  console.log('')

  for (const r of (showAll ? records : flagged)) {
    if (r.risk === 'none' && !showAll) continue
    const tag = r.risk === 'high' ? 'HIGH' : r.risk === 'medium' ? 'MED ' : '    '
    console.log(`  ${tag}  ${r.verbs.join(',').padEnd(18)} ${r.route}`)
    for (const w of r.why) console.log(`          ${w}`)
  }

  console.log('')
  console.log('  Static analysis of route files only. It cannot see whether the SQL')
  console.log('  underneath is tenant-scoped, so a route it does not flag is NOT')
  console.log('  thereby proven safe.')
  console.log('')
}

main()
