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
}
