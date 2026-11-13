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
 *
 * ROLE FLOORS
 * -----------
 * A second question, asked per handler: does a handler that can change a
 * project ask for the role the change needs, or does any member of the
 * project get through? See "Role floors" below.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative, sep } from 'path'

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
    | 'v1ApiMiddleware' | 'getProjectContext' | 'requireProjectCapability'
    | 'getCurrentProjectId'
    | 'mcpGuard' | 'verifyToken' | 'sharedSecret' | 'none'
  /** Explicit authorization helpers called in the file. */
  authz: string[]
  /** A dynamic segment, e.g. [id] or [webhookId]. */
  pathParams: string[]
  /** Reads a project id from the query string, the body or the x-project-id header. */
  readsProjectIdFromInput: boolean
  mutating: boolean
  /** The query filters on the authenticated caller's id, which IS authorization. */
  scopedByCallerIdentity: boolean
  /** `findUnique({ where: { id ... } })` — a lookup by bare resource id. */
  bareFindUnique: boolean
  risk: 'high' | 'medium' | 'none'
  why: string[]
  /** Each exported handler that reaches a project through a session, with the role it needs. */
  handlers: HandlerFloor[]
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
    // Authenticates, resolves the requested project for the caller (404 to a
    // stranger), then asks the guard for the role the route passes in. It is
    // authentication and authorization in one call, like getProjectContext.
    : /requireProjectCapability\s*\(/.test(src) ? 'requireProjectCapability'
    // Authenticates (throws 401 UNAUTHENTICATED) AND resolves the requested
    // project for the caller, refusing one they may not see — authn and authz
    // in a single call, which is why the sibling workspace/files routes are
    // authorized by it alone. Placed above withTenantIsolation, which is the
    // thin wrapper around it.
    : /getCurrentProjectId\s*\(/.test(src) ? 'getCurrentProjectId'
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
    // getCurrentProjectId plus the guard function the route names, so a write
    // or a delete on the header path is held to its role, not to membership.
    'requireProjectCapability',
    // Delegates straight to canAccessProject / canWriteProject /
    // canAdministerProject by access level, then applies the plan entitlement
    // SECOND and separately. Listed here rather than baselining the five
    // webhook routes: a baseline entry per route would turn the file this
    // detector guards into a suppression list, which is the one thing it must
    // never become. Teaching the detector about a helper that really does
    // authorize keeps the ratchet meaningful for the next route that uses it.
    'guardWebhookRoute',
    // lib/support/service.ts: every customer-side entry takes the caller's
    // userId and scopes its own query `where: { id: ticketId, userId }` — the
    // stronger, no-window form of authorization described at the api-keys note
    // below, living in the service instead of the route file so the Cloud
    // admin overlay can compose the same logic. Pinned two-sided against a
    // real database in tests/integration/support-center.spec.ts. The
    // staff-side functions are deliberately NOT listed: no public route may
    // call them. createTicket authorizes its optional projectId input by
    // calling canAccessProject before the row is written.
    'createTicket', 'getTicket', 'addCustomerReply', 'resolveTicket', 'reopenTicket', 'retryAiAnswer',
  ].filter(h => new RegExp(`\\b${h}\\s*\\(`).test(src))

  const pathParams = Array.from(route.matchAll(/\[([^\]]+)\]/g)).map(m => m[1])

  // A project id in a HEADER is input exactly like one in the query or the
  // body: the caller chose it. Not counting it is how /api/workspace-oauth
  // shipped reading `x-project-id` after requireAuth and nothing else, letting
  // any signed-in account replace or delete another project's OAuth client,
  // while this check reported nothing because the route had no path param.
  const readsProjectIdFromInput =
    /searchParams\.get\(\s*['"]projectId['"]\s*\)/.test(src) ||
    /headers\.get\(\s*['"]x-project-id['"]\s*\)/i.test(src) ||
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
    authn === 'getProjectContext' || authn === 'requireProjectCapability'

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
    handlers: handlerFloors(file, src),
  }
}

// ── Role floors ─────────────────────────────────────────────────────────────
//
// Everything above asks whether a route checks the caller at all. This asks
// the next question, one handler at a time: does a handler that can change a
// project ask for the role the change needs, or does any member of the
// project get through?
//
// Membership answers "may this caller see the project", and a Viewer is a
// member. The three wrappers that hand a route its project (withProjectAccess,
// withTenantIsolation, withProjectValidation) hold POST, PUT, PATCH and DELETE
// to the Developer role unless the route passes `{ floor }`
// (lib/auth/project-floor.ts). A handler that checks the project by hand asks
// canWriteProject or canAdministerProject. That leaves two shapes in which a
// mutating handler admits any member, and both are reported:
//
//   - a wrapper given `{ floor: 'view' }`
//   - a hand check that establishes membership and nothing more
//
// Both are right for a handler that changes nothing: a read-only query sent
// as a POST, a preview, a heartbeat. So each one is listed in the baseline
// with its reason, as { route, method, floor: 'view', reason }. A new one
// fails --check until it asks for a role or is explained, and an entry whose
// handler asks for a role again fails until it is removed.
//
// The limit in the header applies here too. This reads route files: a guard
// called on only one branch of a handler still counts, and a check made
// inside a service the route calls is not seen.

export type Floor = 'view' | 'write' | 'administer'

export interface HandlerFloor {
  route: string
  method: string
  /** The role the handler needs: 'view' is any member of the project. */
  floor: Floor
  /** What decided it: a wrapper's method default or option, or a hand check. */
  via: string
}

/** A mutating handler that admits any member, reviewed, with the reason. */
export interface FloorBaselineEntry {
  route: string
  method: string
  floor: 'view'
  reason: string
}

const FLOOR_RANK: Record<Floor, number> = { view: 0, write: 1, administer: 2 }
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])
const HANDLER_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']

// Built from character codes for the reason given at WORD_BOUNDARY in classify().
const NEWLINE = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)
const QUOTES = `'"` + String.fromCharCode(96)

/** Wrappers that resolve the project and apply the role floor. */
const FLOORED_WRAPPERS = ['withProjectAccess', 'withTenantIsolation', 'withProjectValidation']

/** Hand checks that ask for a role, and the floor each one gives. */
const ROLE_GUARDS: ReadonlyArray<readonly [string, Floor]> = [
  ['canAdministerProject', 'administer'],
  // Owner only (lib/context/execution-context.ts), which is above Admin.
  ['createOrchestrationContext', 'administer'],
  ['canWriteProject', 'write'],
]

/** guardWebhookRoute's access argument as a floor (lib/webhooks/route-guard.ts). */
const WEBHOOK_ACCESS: Record<string, Floor> = { read: 'view', write: 'write', admin: 'administer' }

/**
 * Hand checks that establish membership and nothing more. withRole and
 * requireRole are here because the role they compare is the caller's account
 * role, not their role in the project.
 */
const MEMBERSHIP_CHECKS = [
  'getCurrentProjectId', 'requireProjectId', 'canAccessProject', 'hasProjectAccess',
  'verifyProjectAccess', 'resolveForUser', 'requireProjectAccess', 'validateProjectAccess',
  'getProjectContext', 'withRole', 'requireRole',
]

/** Lines that start a top-level statement. Route files keep these at column 0. */
const STATEMENT_START = /^(?:export|import|async|function|const|let|var|class|type|interface|enum)(?=[\s{*(])/gm
const NAMED_DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/gm

/** `name` as a whole identifier outside quotes; `afterDot` also accepts `x.name`. */
function identifier(name: string, afterDot: boolean): RegExp {
  const edge = `A-Za-z0-9_$${QUOTES}`
  return new RegExp(`(?<![${edge}${afterDot ? '' : '.'}])${name.replace(/[$]/g, '[$]')}(?![${edge}])`)
}

/**
 * The source with its comments blanked, so a comment that names a guard is
 * not read as a call to it. Strings are kept; offsets and lines are unchanged.
 */
export function withoutComments(src: string): string {
  let out = ''
  let quote = ''
  let i = 0
  const blank = (text: string) => text.split('').map(ch => (ch === NEWLINE ? NEWLINE : ' ')).join('')
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1] ?? ''
    if (quote) {
      if (ch === BACKSLASH) {
        out += ch + next
        i += 2
        continue
      }
      // Only a template literal spans lines, so a misread quote costs one line at most.
      if (ch === quote || (ch === NEWLINE && quote !== QUOTES[2])) quote = ''
      out += ch
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      const end = src.indexOf(NEWLINE, i)
      const stop = end === -1 ? src.length : end
      out += blank(src.slice(i, stop))
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      out += blank(src.slice(i, stop))
      i = stop
      continue
    }
    // A regular expression literal is copied whole, so the quote in `/['"]/`
    // does not open a string and the `//` in `/a\//` does not open a comment.
    // A `/` starts one where an expression can start; elsewhere it divides.
    if (ch === '/' && /(?:^|[(,=:[!&|?{};])\s*$|(?:^|[^A-Za-z0-9_$])return\s*$/.test(out.slice(-40))) {
      let inClass = false
      out += ch
      i++
      while (i < src.length && src[i] !== NEWLINE) {
        const c = src[i]
        out += c
        i++
        if (c === BACKSLASH) {
          out += src[i] ?? ''
          i++
        } else if (c === '[') {
          inClass = true
        } else if (c === ']') {
          inClass = false
        } else if (c === '/' && !inClass) {
          break
        }
      }
      continue
    }
    if (QUOTES.includes(ch)) quote = ch
    out += ch
    i++
  }
  return out
}

/** A module specifier in a route file, as a file on disk, or null. */
function resolveModule(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? join(ROOT, specifier.slice(2))
    : specifier.startsWith('.') ? join(dirname(fromFile), specifier)
    : null
  if (!base) return null
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'route.ts'), join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** A handler's source with the file's own functions it uses, three levels deep. */
function withLocalHelpers(method: string, source: string, declarations: Map<string, string>): string {
  const parts = [source]
  const seen = new Set<string>([method])
  let frontier = [source]
  for (let level = 0; level < 3 && frontier.length > 0; level++) {
    const next: string[] = []
    for (const [name, body] of declarations) {
      if (seen.has(name)) continue
      const used = identifier(name, false)
      if (frontier.some(text => used.test(text))) {
        seen.add(name)
        next.push(body)
      }
    }
    parts.push(...next)
    frontier = next
  }
  return parts.join(NEWLINE)
}

/**
 * Each handler a route file exports, as the source that runs for it: the
 * handler plus the file's own functions it uses, so that
 * `export const POST = recordedV1(handlePOST)` is read through to handlePOST.
 * Every export form counts (`export function`, `export async function`,
 * `export const`, an export list), and a handler re-exported from another
 * file is read in that file. Comments are left out.
 */
export function exportedHandlers(
  file: string,
  src?: string,
  depth = 0,
): Array<{ method: string; source: string }> {
  const code = withoutComments(src ?? readFileSync(file, 'utf8'))
  const starts = Array.from(code.matchAll(STATEMENT_START), m => m.index ?? 0)
  const declarations = new Map<string, string>()
  for (const m of code.matchAll(NAMED_DECLARATION)) {
    const start = m.index ?? 0
    const end = starts.find(s => s > start) ?? code.length
    if (!declarations.has(m[1])) declarations.set(m[1], code.slice(start, end))
  }

  const handlers: Array<{ method: string; source: string }> = []
  for (const method of HANDLER_METHODS) {
    const exported = new RegExp(
      `^export\\s+(?:const|let|var|(?:async\\s+)?function\\s*\\*?)\\s+${method}(?![A-Za-z0-9_$])`,
      'm',
    )
    if (exported.test(code)) {
      handlers.push({ method, source: withLocalHelpers(method, declarations.get(method) ?? '', declarations) })
    }
  }
  for (const m of code.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const [local, exportedAs = local] = part.trim().split(/\s+as\s+/)
      if (!HANDLER_METHODS.includes(exportedAs)) continue
      if (!m[2]) {
        handlers.push({
          method: exportedAs,
          source: withLocalHelpers(exportedAs, declarations.get(local) ?? '', declarations),
        })
        continue
      }
      const target = depth < 3 ? resolveModule(file, m[2]) : null
      const there = target ? exportedHandlers(target, undefined, depth + 1).find(h => h.method === local) : undefined
      handlers.push({ method: exportedAs, source: there?.source ?? '' })
    }
  }
  return handlers
}

/**
 * The role a handler needs, from what its source calls, or null when it
 * reaches no project through a platform session (a public route, an API key,
 * a route about the caller's own account).
 *
 * A wrapper gives its option, or the method's default. A role guard in the
 * handler raises that. A handler with neither, that still checks membership,
 * needs only membership.
 */
export function handlerFloor(method: string, source: string): { floor: Floor; via: string } | null {
  let floor: Floor | null = null
  let via = ''

  const wrapper = FLOORED_WRAPPERS.find(name =>
    new RegExp(identifier(name, true).source + '\\s*[(<]').test(source),
  )
  if (wrapper) {
    const options = Array.from(source.matchAll(/floor:\s*'(view|write|administer)'/g), m => m[1] as Floor)
    if (options.length > 0) {
      floor = options.reduce((low, f) => (FLOOR_RANK[f] < FLOOR_RANK[low] ? f : low))
      via = `${wrapper} { floor: '${floor}' }`
    } else {
      floor = READ_METHODS.has(method) ? 'view' : 'write'
      via = `${wrapper} default`
    }
  }

  const guards: Array<{ floor: Floor; via: string }> = ROLE_GUARDS
    .filter(([name]) => identifier(name, true).test(source))
    .map(([name, f]) => ({ floor: f, via: name }))
  for (const m of source.matchAll(/guardWebhookRoute\s*\([^)]*?'(read|write|admin)'/g)) {
    guards.push({ floor: WEBHOOK_ACCESS[m[1]], via: `guardWebhookRoute '${m[1]}'` })
  }
  for (const guard of guards) {
    if (floor === null || FLOOR_RANK[guard.floor] > FLOOR_RANK[floor]) {
      floor = guard.floor
      via = guard.via
    }
  }

  if (floor === null) {
    const membership = MEMBERSHIP_CHECKS.filter(name => identifier(name, true).test(source))
    if (membership.length > 0) {
      floor = 'view'
      via = `${membership.join(', ')} only`
    }
  }
  return floor === null ? null : { floor, via }
}

/** Every handler in a route file that reaches a project through a session, with its floor. */
export function handlerFloors(file: string, src?: string): HandlerFloor[] {
  const route = routePath(file)
  return exportedHandlers(file, src).flatMap(({ method, source }) => {
    const found = handlerFloor(method, source)
    return found ? [{ route, method, ...found }] : []
  })
}

/** A handler that can change the project and admits any member of it. */
export function admitsAnyMember(handler: HandlerFloor): boolean {
  return MUTATING.has(handler.method) && handler.floor === 'view'
}

function handlerKey(route: string, method: string): string {
  return `${method} ${route}`
}

/**
 * The handlers that admit any member, against the baseline's floor entries.
 *
 *   added        admit any member and are not in the baseline
 *   stale        in the baseline, and no longer admit any member
 *   unexplained  in the baseline without a reason
 */
export function compareFloors(handlers: HandlerFloor[], entries: FloorBaselineEntry[]) {
  const open = handlers.filter(admitsAnyMember)
  const listed = new Set(entries.map(e => handlerKey(e.route, e.method)))
  const openKeys = new Set(open.map(h => handlerKey(h.route, h.method)))
  return {
    open,
    added: open.filter(h => !listed.has(handlerKey(h.route, h.method))),
    stale: entries.filter(e => !openKeys.has(handlerKey(e.route, e.method))),
    unexplained: entries.filter(e => !e.reason || !e.reason.trim() || e.reason === 'UNREVIEWED'),
  }
}

export function isFloorEntry(entry: BaselineEntry | FloorBaselineEntry): entry is FloorBaselineEntry {
  return 'floor' in entry
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
  let baseline: Array<BaselineEntry | FloorBaselineEntry> = []
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  } catch {
    console.error('')
    console.error(`  No baseline at ${relative(ROOT, BASELINE)}.`)
    console.error('  Generate one with --write-baseline, then review its entries.')
    console.error('')
    process.exit(1)
  }

  const routesOk = checkRoutes(records, baseline.filter((b): b is BaselineEntry => !isFloorEntry(b)))
  const floorsOk = checkFloors(records.flatMap(r => r.handlers), baseline.filter(isFloorEntry))
  if (!routesOk || !floorsOk) process.exit(1)
}

/** The route-level ratchet described above. True when nothing needs attention. */
function checkRoutes(records: RouteRecord[], baseline: BaselineEntry[]): boolean {
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
    return true
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

  return false
}

/** The role-floor ratchet (see "Role floors"). True when nothing needs attention. */
function checkFloors(handlers: HandlerFloor[], entries: FloorBaselineEntry[]): boolean {
  const { open, added, stale, unexplained } = compareFloors(handlers, entries)

  if (added.length === 0 && stale.length === 0 && unexplained.length === 0) {
    console.log(
      `  Role floors: ${open.length} mutating handler(s) admit any member of the project, ` +
      'each in the baseline with its reason.',
    )
    return true
  }

  if (added.length > 0) {
    console.error('')
    console.error('  These handlers can change the project and admit any member of it:')
    console.error('')
    for (const h of added) console.error(`    ${h.method.padEnd(7)} ${h.route}  (${h.via})`)
    console.error('')
    console.error('  Ask for the role the change needs: the wrappers hold this method to the')
    console.error('  Developer role unless given `{ floor }`, and a hand check uses')
    console.error('  canWriteProject or canAdministerProject. If the handler changes nothing,')
    console.error('  add { "route", "method", "floor": "view", "reason" } to the baseline.')
    console.error('')
  }

  if (unexplained.length > 0) {
    console.error('')
    console.error('  These baseline entries admit any member and give no reason. Say why the')
    console.error('  handler changes nothing:')
    for (const e of unexplained) console.error(`    ${e.method.padEnd(7)} ${e.route}`)
    console.error('')
  }

  if (stale.length > 0) {
    console.error('')
    console.error('  These baseline entries no longer admit any member. Remove them:')
    for (const e of stale) console.error(`    ${e.method.padEnd(7)} ${e.route}`)
    console.error('')
  }

  return false
}

function writeBaseline(records: RouteRecord[]): void {
  const flagged = records.filter(r => r.risk !== 'none')
  const existing = new Map<string, BaselineEntry>()
  const existingFloors = new Map<string, FloorBaselineEntry>()
  try {
    for (const b of JSON.parse(readFileSync(BASELINE, 'utf8')) as Array<BaselineEntry | FloorBaselineEntry>) {
      if (isFloorEntry(b)) existingFloors.set(handlerKey(b.route, b.method), b)
      else existing.set(b.route, b)
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

  // Floor entries follow the route entries, each keeping the reason written for it.
  const floors: FloorBaselineEntry[] = records
    .flatMap(r => r.handlers)
    .filter(admitsAnyMember)
    .map(h => ({
      route: h.route,
      method: h.method,
      floor: 'view' as const,
      reason: existingFloors.get(handlerKey(h.route, h.method))?.reason ?? 'UNREVIEWED',
    }))
    .sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method))

  writeFileSync(BASELINE, JSON.stringify([...out, ...floors], null, 2) + String.fromCharCode(10), 'utf8')
  console.log(`  Wrote ${out.length + floors.length} entries to ${relative(ROOT, BASELINE)}`)
  console.log(`  ${out.filter(e => (e.status ?? 'UNREVIEWED') === 'UNREVIEWED').length} are UNREVIEWED.`)
  const unexplained = floors.filter(f => f.reason === 'UNREVIEWED').length
  if (unexplained > 0) console.log(`  ${unexplained} floor entr(y/ies) need a reason.`)
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
  const open = records.flatMap(r => r.handlers).filter(admitsAnyMember)
  console.log(`  any member changes  ${open.length}  (mutating handlers that admit any member)`)
  console.log('')

  for (const r of (showAll ? records : flagged)) {
    if (r.risk === 'none' && !showAll) continue
    const tag = r.risk === 'high' ? 'HIGH' : r.risk === 'medium' ? 'MED ' : '    '
    console.log(`  ${tag}  ${r.verbs.join(',').padEnd(18)} ${r.route}`)
    for (const w of r.why) console.log(`          ${w}`)
    if (showAll) {
      for (const h of r.handlers) console.log(`          ${h.method.padEnd(7)} ${h.floor.padEnd(10)} ${h.via}`)
    }
  }

  if (open.length > 0) {
    console.log('')
    console.log('  Mutating handlers that admit any member of the project:')
    for (const h of open) console.log(`        ${h.method.padEnd(18)} ${h.route}  (${h.via})`)
  }

  console.log('')
  console.log('  Static analysis of route files only. It cannot see whether the SQL')
  console.log('  underneath is tenant-scoped, so a route it does not flag is NOT')
  console.log('  thereby proven safe.')
  console.log('')
}

if (require.main === module) main()
