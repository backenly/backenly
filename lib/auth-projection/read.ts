/**
 * WHAT AUTHORIZES A REQUEST: THE REGION'S COPY WHILE IT IS FRESH, HOME OTHERWISE
 * ==============================================================================
 * A request to a project kept outside the home region is authorized from its
 * key, its branch, its lock and pause, and its end-user signing secret. Those
 * rows live in the home platform database. The home region delivers each region
 * a copy of them with a watermark (lib/auth-projection/deliver.ts). This module
 * is where the request path reads them, by BACKENLY_AUTH_PROJECTION
 * (lib/auth-projection/mode.ts):
 *
 *   off       from home, exactly as before. Also the answer in the home
 *             region, and in any process whose service region is unknown.
 *   shadow    from home. The copy is read alongside and any difference is
 *             reported, so the copy can be trusted before anything relies on it.
 *   enforce   from the copy while it is fresh and holds the row; otherwise from
 *             home. When home cannot answer either, the request fails closed
 *             with AuthorizationUnavailableError (503 AUTHORIZATION_UNAVAILABLE):
 *             a copy past its bound is never used in its place.
 *
 * A row missing from the copy is not evidence: the copy holds only publishable
 * keys, so a service-role, MCP or dashboard key is always authorized at home,
 * as is anything not delivered yet. A key is taken from the copy only together
 * with its project and, when it has one, its branch, all three from the same
 * delivery.
 */

import { prisma } from '@/lib/db/prisma'
import { regionRawClient } from '@/lib/data-plane/regional'
import { serviceRegion } from '@/lib/data-plane/serving'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { authMaxStalenessMs, authProjectionMode } from '@/lib/auth-projection/mode'
import { isFreshAge } from '@/lib/auth-projection/copy'

/** Neither the region's copy nor home could say whether the request is allowed. */
export class AuthorizationUnavailableError extends Error {
  readonly code = 'AUTHORIZATION_UNAVAILABLE'
  readonly status = 503

  constructor(cause: unknown) {
    super(
      "This request could not be authorized: the region's copy of its authorization is not fresh, " +
        'and the home region could not be reached to check it. Nothing was served on stale authorization.',
    )
    this.name = 'AuthorizationUnavailableError'
    this.cause = cause
  }
}

export function isAuthorizationUnavailable(err: unknown): err is AuthorizationUnavailableError {
  return err instanceof AuthorizationUnavailableError
}

/** The key as the request path authorizes with it. */
export interface AuthorizingKey {
  id: string
  name: string
  keyPrefix: string
  projectId: string | null
  userId: string
  role: string
  permissions: string[]
  capabilities: string[]
  rateLimit: number
  rateLimitWindow: number
  expiresAt: Date | null
  serviceRole: boolean
  scope: string
  keyType: string
  branch: { id: string; name: string; status: string; schemaName: string; projectId: string } | null
}

/** The project as the request path authorizes with it. */
export interface AuthorizingProject {
  id: string
  lockedDownAt: Date | null
  lockedDownReason: string | null
  pausedAt: Date | null
  pauseReason: string | null
  jwtSecret: string | null
  userId: string | null
  organizationId: string | null
}

/**
 * Whether this process answers from its region's copy: the switch is at
 * `enforce` and this is a region other than home. Callers whose home path needs
 * more than the copy holds keep that path for every other case.
 */
export function answersFromCopy(): boolean {
  return authProjectionMode() === 'enforce' && copyRegion() !== null
}

/**
 * The region whose copy this process may read, or null when it reads home only:
 * the switch is off, this is the home region, or the service region is unknown.
 */
function copyRegion(): CloudRegionId | null {
  if (authProjectionMode() === 'off') return null
  try {
    const region = serviceRegion()
    return region === HOME_REGION ? null : region
  } catch {
    return null
  }
}

// ── Home ─────────────────────────────────────────────────────────────────────

const KEY_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  projectId: true,
  userId: true,
  role: true,
  permissions: true,
  capabilities: true,
  rateLimit: true,
  rateLimitWindow: true,
  expiresAt: true,
  serviceRole: true,
  scope: true,
  keyType: true,
  branch: { select: { id: true, name: true, status: true, schemaName: true, projectId: true } },
} as const

function keyAtHome(keyHash: string): Promise<AuthorizingKey | null> {
  return prisma.apiKey.findFirst({ where: { keyHash }, select: KEY_SELECT })
}

function projectAtHome(projectId: string): Promise<AuthorizingProject | null> {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      lockedDownAt: true,
      lockedDownReason: true,
      pausedAt: true,
      pauseReason: true,
      jwtSecret: true,
      userId: true,
      organizationId: true,
    },
  })
}

// ── The copy ─────────────────────────────────────────────────────────────────

interface CopyRead<T> {
  fresh: boolean
  ageMs: number | null
  row: T | null
}

interface CopiedKeyRow {
  ageMs: number | null
  id: string | null
  name: string
  keyPrefix: string
  projectId: string
  userId: string
  role: string
  permissions: string[]
  capabilities: string[]
  rateLimit: number
  rateLimitWindow: number
  expiresAt: Date | null
  serviceRole: boolean
  scope: string
  keyType: string
  branchId: string | null
  copiedProject: string | null
  copiedBranch: string | null
  branchName: string | null
  branchStatus: string | null
  branchSchema: string | null
  branchProject: string | null
}

async function keyFromCopy(region: CloudRegionId, keyHash: string): Promise<CopyRead<AuthorizingKey>> {
  const [found] = await regionRawClient(region).$queryRaw<CopiedKeyRow[]>`
    SELECT (EXTRACT(EPOCH FROM (clock_timestamp() - s."watermarkAt")) * 1000)::float8 AS "ageMs",
           k."id", k."name", k."keyPrefix", k."projectId", k."userId", k."role", k."permissions",
           k."capabilities", k."rateLimit", k."rateLimitWindow", k."expiresAt", k."serviceRole",
           k."scope", k."keyType", k."branchId",
           p."id" AS "copiedProject",
           b."id" AS "copiedBranch", b."name" AS "branchName", b."status" AS "branchStatus",
           b."schemaName" AS "branchSchema", b."projectId" AS "branchProject"
      FROM public.auth_projection_state s
      LEFT JOIN public.auth_projection_keys k ON k."keyHash" = ${keyHash}
      LEFT JOIN public.auth_projection_projects p ON p."id" = k."projectId"
      LEFT JOIN public.auth_projection_branches b ON b."id" = k."branchId"
     WHERE s."region" = ${region}`
  const ageMs = found?.ageMs === null || found?.ageMs === undefined ? null : Number(found.ageMs)
  const fresh = isFreshAge(ageMs, authMaxStalenessMs())
  // The key counts as copied only with its project, and with its branch when
  // it has one: a key delivered before them is not yet a whole answer.
  if (!found || !found.id || !found.copiedProject || (found.branchId && !found.copiedBranch)) {
    return { fresh, ageMs, row: null }
  }
  return {
    fresh,
    ageMs,
    row: {
      id: found.id,
      name: found.name,
      keyPrefix: found.keyPrefix,
      projectId: found.projectId,
      userId: found.userId,
      role: found.role,
      permissions: found.permissions,
      capabilities: found.capabilities,
      rateLimit: found.rateLimit,
      rateLimitWindow: found.rateLimitWindow,
      expiresAt: found.expiresAt,
      serviceRole: found.serviceRole,
      scope: found.scope,
      keyType: found.keyType,
      branch: found.branchId
        ? {
            id: found.branchId,
            name: found.branchName as string,
            status: found.branchStatus as string,
            schemaName: found.branchSchema as string,
            projectId: found.branchProject as string,
          }
        : null,
    },
  }
}

interface CopiedProjectRow extends Omit<AuthorizingProject, 'id'> {
  ageMs: number | null
  id: string | null
}

async function projectFromCopy(region: CloudRegionId, projectId: string): Promise<CopyRead<AuthorizingProject>> {
  const [found] = await regionRawClient(region).$queryRaw<CopiedProjectRow[]>`
    SELECT (EXTRACT(EPOCH FROM (clock_timestamp() - s."watermarkAt")) * 1000)::float8 AS "ageMs",
           p."id", p."lockedDownAt", p."lockedDownReason", p."pausedAt", p."pauseReason",
           p."jwtSecret", p."userId", p."organizationId"
      FROM public.auth_projection_state s
      LEFT JOIN public.auth_projection_projects p ON p."id" = ${projectId}
     WHERE s."region" = ${region}`
  const ageMs = found?.ageMs === null || found?.ageMs === undefined ? null : Number(found.ageMs)
  const fresh = isFreshAge(ageMs, authMaxStalenessMs())
  if (!found || !found.id) return { fresh, ageMs, row: null }
  return {
    fresh,
    ageMs,
    row: {
      id: found.id,
      lockedDownAt: found.lockedDownAt,
      lockedDownReason: found.lockedDownReason,
      pausedAt: found.pausedAt,
      pauseReason: found.pauseReason,
      jwtSecret: found.jwtSecret,
      userId: found.userId,
      organizationId: found.organizationId,
    },
  }
}

// ── The two lookups ──────────────────────────────────────────────────────────

/** The key whose hash this is, or null when home has none. */
export async function authorizingKeyByHash(keyHash: string): Promise<AuthorizingKey | null> {
  const { row } = await authorize({
    region: copyRegion(),
    fromCopy: (region) => keyFromCopy(region, keyHash),
    atHome: () => keyAtHome(keyHash),
    compare: compareKeys,
    entity: 'key',
  })
  return row
}

/** The project, or null when home has none. */
export async function authorizingProject(projectId: string): Promise<AuthorizingProject | null> {
  return (await authorizingProjectWithAge(projectId)).row
}

/**
 * The project, and how old the answer already is: the copy's watermark age when
 * the copy answered, 0 when home did. A caller that caches the answer keeps it
 * no longer than the bound allows from there (lib/projects/serving-state.ts).
 */
export async function authorizingProjectWithAge(projectId: string): Promise<Answer<AuthorizingProject>> {
  return authorize({
    region: copyRegion(),
    fromCopy: (region) => projectFromCopy(region, projectId),
    atHome: () => projectAtHome(projectId),
    compare: compareProjects,
    entity: 'project',
  })
}

interface Answer<T> {
  row: T | null
  /** How old the answer is: the copy's watermark age, or 0 when home answered. */
  ageMs: number
}

async function authorize<T extends { id: string }>(lookup: {
  region: CloudRegionId | null
  fromCopy: (region: CloudRegionId) => Promise<CopyRead<T>>
  atHome: () => Promise<T | null>
  compare: (copied: T, home: T) => string[]
  entity: 'key' | 'project'
}): Promise<Answer<T>> {
  const { region } = lookup
  if (!region) return { row: await lookup.atHome(), ageMs: 0 }

  if (authProjectionMode() === 'shadow') {
    // Read side by side, so shadowing adds no wait; the copy never changes the answer.
    const [home, copy] = await Promise.all([lookup.atHome(), lookup.fromCopy(region).catch((err: unknown) => err)])
    shadowReport(lookup.entity, home, copy, lookup.compare)
    return { row: home, ageMs: 0 }
  }

  const copy = await lookup.fromCopy(region).catch((err: unknown) => {
    note('copy-unreadable', `the copy in ${region} could not be read, so home answers: ${describe(err)}`)
    return null
  })
  if (copy?.fresh && copy.row) return { row: copy.row, ageMs: Math.max(0, copy.ageMs ?? 0) }
  try {
    return { row: await lookup.atHome(), ageMs: 0 }
  } catch (err) {
    throw new AuthorizationUnavailableError(err)
  }
}

// ── Shadow reports ───────────────────────────────────────────────────────────

function shadowReport<T extends { id: string }>(
  entity: 'key' | 'project',
  home: T | null,
  copy: CopyRead<T> | unknown,
  compare: (copied: T, home: T) => string[],
): void {
  if (!isCopyRead<T>(copy)) {
    note('copy-unreadable', `shadow: the copy could not be read: ${describe(copy)}`)
    return
  }
  if (!copy.fresh) {
    note('copy-stale', `shadow: the copy is not fresh (${copy.ageMs === null ? 'no watermark' : `${Math.round(copy.ageMs)} ms old`})`)
    return
  }
  const age = `copy ${Math.round(copy.ageMs ?? 0)} ms old`
  if (copy.row && !home) {
    note(`${entity}-only-in-copy`, `shadow: the copy has ${entity} ${copy.row.id}, which home no longer has (${age})`)
    return
  }
  if (copy.row && home) {
    const differences = compare(copy.row, home)
    if (differences.length > 0) {
      note(`${entity}-differs`, `shadow: ${entity} ${home.id} differs from home in ${differences.join(', ')} (${age})`)
    }
  }
  // A row only home has is expected: the copy holds publishable keys only, and
  // nothing not delivered yet.
}

function isCopyRead<T>(value: unknown): value is CopyRead<T> {
  return typeof value === 'object' && value !== null && 'fresh' in value && 'row' in value
}

/** Equal as values: object keys in any order, dates by instant. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

function compareKeys(copied: AuthorizingKey, home: AuthorizingKey): string[] {
  const fields: (keyof AuthorizingKey)[] = [
    'projectId', 'userId', 'role', 'permissions', 'capabilities', 'rateLimit', 'rateLimitWindow',
    'expiresAt', 'serviceRole', 'scope', 'keyType', 'branch',
  ]
  return fields.filter((field) => !same(copied[field], home[field]))
}

function compareProjects(copied: AuthorizingProject, home: AuthorizingProject): string[] {
  const fields: (keyof AuthorizingProject)[] = [
    'lockedDownAt', 'lockedDownReason', 'pausedAt', 'pauseReason', 'userId', 'organizationId',
  ]
  const differences = fields.filter((field) => !same(copied[field], home[field]))
  // The copy keeps the secret encrypted under the active key, so its text never
  // equals home's; what it decrypts to is compared where it is used.
  if ((copied.jwtSecret === null) !== (home.jwtSecret === null)) differences.push('jwtSecret')
  return differences
}

// One line per kind of report per minute, with how many were held back.
const REPORT_EVERY_MS = 60_000
const reported = new Map<string, { at: number; held: number }>()

function note(kind: string, message: string): void {
  const now = Date.now()
  const last = reported.get(kind)
  if (last && now - last.at < REPORT_EVERY_MS) {
    last.held++
    return
  }
  const held = last?.held ? ` (${last.held} more like this since the last report)` : ''
  reported.set(kind, { at: now, held: 0 })
  console.warn(`[auth-projection] ${message}${held}`)
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300)
}
