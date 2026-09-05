/**
 * Edition seam: the contract every edition implements.
 *
 * Backenly ships in two editions. Self-hosted is SINGLE TENANT: one deployment
 * is one project. Cloud is multi-tenant and owns organizations, teams, the
 * project lifecycle and fleet management. The difference is not a limit counter
 * on a shared control plane; it is a different implementation behind this file.
 *
 * ProjectResolver is the first seam because the codebase currently has roughly
 * seventy independent answers to "may this user reach this project", and only
 * six of them consult organization membership at all. That is not a style
 * problem. It means an invited organization member is granted a project by
 * lib/auth/project-access.ts and then denied by the storage, logs, monitoring
 * and env-var routes, each of which re-queries with `where: { id, userId }`.
 * The point of this interface is that there is exactly ONE authority.
 */

/** Which edition is running. Resolved once, in lib/edition/index.ts. */
export type Edition = 'single-tenant' | 'cloud'

/**
 * The caller's authority over a project, not merely whether they can see it.
 *
 * Mirrors the Cloud OrgRole, and is declared HERE rather than imported from the
 * organization layer because that layer is Cloud control plane and now lives in
 * the private repository, while this seam stays public. Declaring it here is
 * what lets public code reason about authority without depending on a module it
 * does not ship. Single-tenant has no organizations and reports OWNER for every
 * authenticated operator.
 */
export type ProjectRole = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER'

const ROLE_RANK: Record<ProjectRole, number> = { OWNER: 3, ADMIN: 2, DEVELOPER: 1, VIEWER: 0 }

/**
 * True when `role` is at least `minimum`.
 *
 * Access and authority are separate questions. Being a member of the
 * organization that owns a project answers the first and says nothing about the
 * second, which is how a VIEWER came to be able to delete a webhook: every one
 * of those routes had been owner-only, so nothing had ever needed to ask.
 */
export function roleAtLeast(role: ProjectRole, minimum: ProjectRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

/**
 * The project a request is allowed to act on.
 *
 * Deliberately shaped like the return of `verifyProjectAccess`, workspaces
 * included, so migrating a call site is a change of authority and not also a
 * change of data.
 */
export interface ResolvedProject {
  id: string
  name: string
  userId: string | null
  organizationId: string | null
  /** What this caller may DO here, as distinct from whether they may see it. */
  callerRole: ProjectRole
  workspaces: Array<{
    id: string
    postgresSchema: string | null
    mongodbDatabase: string | null
    databaseProvisioned: boolean
  }>
}

/** Base for every resolver refusal, so callers can map to a status in one place. */
export abstract class ProjectResolutionError extends Error {
  abstract readonly status: number
  abstract readonly code: string
}

/** The project does not exist. Distinct from forbidden, deliberately. */
export class ProjectNotFoundError extends ProjectResolutionError {
  readonly status = 404
  readonly code = 'PROJECT_NOT_FOUND'
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`)
    this.name = 'ProjectNotFoundError'
  }
}

/** It exists and this caller may not have it. */
export class ProjectAccessDeniedError extends ProjectResolutionError {
  readonly status = 403
  readonly code = 'PROJECT_FORBIDDEN'
  constructor(message = 'You do not have access to this project') {
    super(message)
    this.name = 'ProjectAccessDeniedError'
  }
}

/**
 * No project context was supplied on a Cloud request.
 *
 * This is a 400 rather than a fallback, and that is the whole point. The
 * previous behaviour resolved a missing projectId to the caller's OLDEST OWNED
 * project (lib/tenant/isolation.ts). In a multi-project product that is worse
 * than an error: a frontend that forgets to send projectId gets 200 OK carrying
 * a DIFFERENT project's data, so the bug ships looking like a working feature.
 * An organization member hitting such a route saw their own oldest project's
 * storage instead of the organization's, which renders as "the bucket is empty"
 * rather than as a failure.
 *
 * Single-tenant never raises this: with exactly one project there is nothing to
 * disambiguate, so implicit resolution is correct there and only there.
 */
export class ProjectContextRequiredError extends ProjectResolutionError {
  readonly status = 400
  readonly code = 'PROJECT_REQUIRED'
  constructor(message = 'A project must be specified for this request') {
    super(message)
    this.name = 'ProjectContextRequiredError'
  }
}

/** The credential an API key presents, after it has been authenticated. */
export interface ApiKeyIdentity {
  /** The project this key was issued for. Null keys are not project-scoped. */
  projectId: string | null
  /** The user who owns the key. Recorded, never used to widen access. */
  userId: string
}

/**
 * The single authority for project access.
 *
 * Credential types are separate methods ON PURPOSE. They are not the same
 * question wearing different hats:
 *
 *   resolveForUser    a human's session. Cloud consults organization
 *                     membership, project-scoped grants and the restricted
 *                     flag, because those describe what a PERSON may reach.
 *
 *   resolveForApiKey  a machine credential. Authorized by the project the KEY
 *                     was issued for, never by whether the human who created it
 *                     still holds organization membership. Routing keys through
 *                     the human check would silently revoke a production key
 *                     when its creator changes teams, and would silently WIDEN
 *                     one when its creator is promoted.
 *
 *   resolveTrusted    an internal operation with no requesting principal (cron
 *                     sweeps, reconcilers, backups). Takes a written reason so
 *                     that "this bypassed authorization" is always a decision
 *                     someone made and can be found by grep.
 */
export interface ProjectResolver {
  readonly edition: Edition

  /**
   * @param projectId Null or undefined means "no project context supplied".
   *        Cloud raises ProjectContextRequiredError. Single-tenant resolves the
   *        one project.
   */
  resolveForUser(userId: string, projectId: string | null | undefined): Promise<ResolvedProject>

  resolveForApiKey(identity: ApiKeyIdentity): Promise<ResolvedProject>

  resolveTrusted(projectId: string, reason: string): Promise<ResolvedProject>

  /**
   * A Prisma WHERE selecting every project this user may SEE in a list.
   *
   * Listing is a different question from resolving one project, and it was the
   * one place still answering it with a hand-written clause. On a self-hosted
   * deployment that clause required ownership, so the operator of a
   * single-project install was shown ZERO projects while
   * `GET /api/projects/<id>` on the very same project returned it. Two answers
   * to one question, which is exactly what this seam exists to prevent.
   *
   * Returns a clause matching nothing when there is nothing to show, so a
   * caller renders an empty list rather than handling an error.
   */
  accessibleProjectsWhere(userId: string): Promise<Record<string, unknown>>
}

// ============================================================================
// PROJECT LIFECYCLE
// ============================================================================

/**
 * A project as a listing shows it.
 *
 * Shaped like the `select` GET /api/projects has always used, so moving the
 * query behind this seam changed the authority for "which projects" and not
 * the payload any dashboard reads.
 */
export interface ProjectListEntry {
  id: string
  name: string
  slug: string | null
  description: string | null
  userId: string | null
  publicEnabled: boolean
  projectStatus: string
  deployedAt: Date | null
  environment: string
  apiUrlDev: string | null
  apiUrlStaging: string | null
  apiUrlProd: string | null
  apiRequests: number
  avgLatency: number
  errorCount: number
  storageUsed: bigint
  storageLimit: bigint
  maxFileSize: bigint
  maxFilesPerBucket: number
  activeUsers: number
  lastMetricsUpdate: Date | null
  createdAt: Date
  updatedAt: Date
  _count: { tables: number; workspaces: number }
}

export interface ProjectCreateInput {
  name: string
  description?: string | null
  environment?: string
  apiUrlDev?: string | null
  apiUrlStaging?: string | null
  apiUrlProd?: string | null
  /** The authenticated account creating it. */
  userId: string
}

export interface ProjectCreateResult {
  /** The created project, loaded in the shape the route serialises. */
  project: ProjectListEntry & { user: { id: string; email: string; name: string | null } | null }
  /**
   * The plaintext key, returned exactly once and never persisted.
   *
   * Null when key generation failed. Creation deliberately survives that: a
   * project with no default key is repairable from the dashboard, whereas
   * failing the whole request leaves a provisioned project the caller was never
   * told about.
   */
  apiKey: string | null
}

/**
 * Who may create and list projects, and what creating one actually does.
 *
 * ---- WHY THIS IS AN EDITION SEAM AND NOT A LIMIT ------------------------
 *
 * "One deployment is one project" is architectural, not `maxProjects = 1`. A
 * counter is a policy a caller can be granted an exception to; this is a
 * different implementation, and the single-tenant one has no code path that
 * inserts a second Project row at all. The distinction matters because the
 * single-tenant resolver treats every authenticated account as an operator of
 * the deployment: a second project appearing in that database would be
 * reachable by everyone with an account on it.
 *
 * Cloud creates projects. Single-tenant provisions its one project through
 * `npm run bootstrap`, which reconciles rather than inserts, and refuses here.
 */
export interface ProjectLifecycle {
  readonly edition: Edition

  /**
   * Every project this caller may see.
   *
   * Single-tenant resolves THE project rather than enumerating a table, so a
   * self-host install never runs a fleet-shaped query to answer a question with
   * exactly one answer.
   */
  list(userId: string): Promise<ProjectListEntry[]>

  /**
   * Create a project and everything that makes it usable.
   *
   * A Project row is not a project: without a workspace schema, a PostgREST
   * registration, a backend graph and a signing secret, every data-plane
   * request against it answers PGRST106 forever. Implementations MUST perform
   * the whole sequence, which is why they delegate to
   * `lib/projects/provision.ts` rather than reimplementing it.
   */
  create(input: ProjectCreateInput): Promise<ProjectCreateResult>
}
