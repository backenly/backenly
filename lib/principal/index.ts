/**
 * WHO ASKED, WHO ALLOWED IT, AND WHO DID IT
 * =========================================
 *
 * Backenly records actors four incompatible ways, and the two autonomous loops
 * record none of them:
 *
 *     human      AuditLog.userId / userEmail
 *     agent      AgentApprovalRequest.apiKeyId      (destructive approvals only)
 *     mixed      BackendEvent.actorType             ('user'|'backenly_agent'|'system')
 *     approver   MaintenanceApproval.approvedBy     (opaque String)
 *     autonomy   — nothing: recordAutonomousAction writes projectId + action
 *
 * So "who did this" has no single answer, and for anything the reconciler or the
 * maintenance loop did, it has no answer at all. Every rule in
 * `docs/intent-and-authority-rfc.md` — provenance classes, per-principal
 * delegation, telling an agent's change from a human's — needs to ask that
 * question first.
 *
 * ── The distinction that actually matters ───────────────────────────────────
 *
 * One actor field is not enough, because these are routinely three different
 * principals:
 *
 *     requestedBy    who asked for this
 *     authorizedBy   whose delegation permits it
 *     executedBy     who performed the mutation
 *
 * "Claude Code requested a Tier-2 migration, the owner's standing approval
 * authorized it, the maintenance loop executed it" is one sentence and three
 * principals, and today it is unrepresentable.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 *
 * This is deliberately a vocabulary, not an identity system. No grant engine, no
 * authorization chains, no new tables, and no backfill of historical rows.
 * Principals ride in `AuditLog.metadata`, which is already `Json?`, so nothing
 * needs migrating. Legacy representations are RESOLVED where they can be and
 * left unknown where they cannot.
 */

export type Principal =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; apiKeyId: string; onBehalfOf?: string }
  /**
   * A Backenly component acting on its own.
   *
   * `agent_orchestrator` is the auto-fix path reached from the background
   * monitor and the agents API. It is named narrowly rather than folded into
   * `reconciler`, because calling it the reconciler would attribute its
   * mutations to a loop that did not make them.
   */
  | { kind: 'backenly'; loop: 'reconciler' | 'maintenance' | 'agent_orchestrator' }
  | { kind: 'operator'; via: 'cli' | 'deployment' | 'system' }
  /**
   * A direct database connection. `role` is a PostgreSQL role name and nothing
   * more — see `isWeakAttribution`.
   */
  | { kind: 'external'; role: string }
  /**
   * Genuinely not known.
   *
   * Present on purpose. The alternative to an explicit unknown is a plausible
   * default, and "an inability to know, converted into a positive claim" is the
   * single defect the whole audit removed. A legacy row with no actor resolves
   * to this, never to `system`.
   */
  | { kind: 'unknown'; why: string }

/**
 * Where an authorization came from.
 *
 * `authorizedBy: user:<owner>` on its own is ambiguous and will be misread once
 * grants exist: today the owner's authority is TRANSITIVE, delegated through a
 * dial they set once, and it must never be presented as "the owner approved
 * this exact mutation". Naming the source keeps those apart before anything
 * depends on the difference.
 */
export type AuthorizationSource =
  /** The project's autonomy dial: standing, coarse, set once by the owner. */
  | 'project_autonomy_dial'
  /** A future explicit grant naming a principal, action class and scope. */
  | 'grant'
  /** A human approving this specific action, e.g. a maintenance approval. */
  | 'explicit_approval'
  /** Nothing establishes authority for this action. */
  | 'none'

/** The three roles an adaptation distinguishes. Any may be unknown. */
export interface PrincipalSet {
  requestedBy: Principal
  authorizedBy: Principal | null
  executedBy: Principal
  /** How `authorizedBy` came to authorize it. Never inferred from the principal. */
  authorizationSource?: AuthorizationSource
}

// ── Constructors ─────────────────────────────────────────────────────────────

export const P = {
  user: (userId: string): Principal => ({ kind: 'user', userId }),
  agent: (apiKeyId: string, onBehalfOf?: string): Principal => ({
    kind: 'agent',
    apiKeyId,
    ...(onBehalfOf ? { onBehalfOf } : {}),
  }),
  reconciler: (): Principal => ({ kind: 'backenly', loop: 'reconciler' }),
  maintenance: (): Principal => ({ kind: 'backenly', loop: 'maintenance' }),
  agentOrchestrator: (): Principal => ({ kind: 'backenly', loop: 'agent_orchestrator' }),
  operator: (via: 'cli' | 'deployment' | 'system'): Principal => ({ kind: 'operator', via }),
  external: (role: string): Principal => ({ kind: 'external', role }),
  unknown: (why: string): Principal => ({ kind: 'unknown', why }),
} as const

/**
 * Is this principal's identity weak — a credential and a context rather than a
 * person or a service?
 *
 * `external` is weak **by construction and permanently**, not as a gap to close
 * later. Several humans and several automated jobs can share one PostgreSQL
 * role, and the database cannot tell them apart. Nothing may render an
 * `external` principal as a person, and no authority decision may use it to
 * answer *who* acted. It is legitimate input for conflict detection ("something
 * outside the platform changed this recently"), which needs no identity.
 */
export function isWeakAttribution(p: Principal): boolean {
  return p.kind === 'external' || p.kind === 'unknown'
}

/** A short, stable, human-legible label. Never a person's name for `external`. */
export function describe(p: Principal): string {
  switch (p.kind) {
    case 'user':
      return `user:${p.userId}`
    case 'agent':
      return p.onBehalfOf ? `agent:${p.apiKeyId} on behalf of ${p.onBehalfOf}` : `agent:${p.apiKeyId}`
    case 'backenly':
      return `backenly:${p.loop}`
    case 'operator':
      return `operator:${p.via}`
    case 'external':
      return `database role ${p.role}`
    case 'unknown':
      return `unknown (${p.why})`
  }
}

// ── Adapters for what already exists ─────────────────────────────────────────

/** The existing ledger vocabulary, so `BackendEvent` rows stay valid. */
export type BackendActorType = 'user' | 'backenly_agent' | 'system'

/**
 * Narrow a Principal to `BackendEvent.actorType`.
 *
 * Lossy on purpose: the ledger has three values and this has six. It is the
 * direction that must not break existing rows, so the mapping is total.
 */
export function toBackendActor(p: Principal): { actorType: BackendActorType; actorId?: string } {
  switch (p.kind) {
    case 'user':
      return { actorType: 'user', actorId: p.userId }
    case 'agent':
      return { actorType: 'backenly_agent', actorId: p.apiKeyId }
    case 'backenly':
      return { actorType: 'backenly_agent', actorId: p.loop }
    case 'operator':
      return { actorType: 'system', actorId: p.via }
    case 'external':
      return { actorType: 'system', actorId: `role:${p.role}` }
    case 'unknown':
      return { actorType: 'system' }
  }
}

/**
 * Widen a `BackendEvent` row back into a Principal.
 *
 * `backenly_agent` is ambiguous in the old vocabulary — it covers both the AI
 * executor and the autonomy loops — so it resolves to `unknown` unless the
 * actorId names a loop. Guessing "reconciler" would invent an attribution the
 * row never carried.
 */
export function fromBackendActor(actorType: string, actorId?: string | null): Principal {
  if (actorType === 'user') {
    return actorId ? P.user(actorId) : P.unknown('user event with no actorId')
  }
  if (actorType === 'backenly_agent') {
    if (actorId === 'reconciler' || actorId === 'maintenance' || actorId === 'agent_orchestrator') {
      return { kind: 'backenly', loop: actorId }
    }
    return actorId ? P.agent(actorId) : P.unknown('backenly_agent event with no actorId')
  }
  if (actorType === 'system') {
    if (actorId?.startsWith('role:')) return P.external(actorId.slice('role:'.length))
    if (actorId === 'cli' || actorId === 'deployment' || actorId === 'system') {
      return P.operator(actorId)
    }
    return P.unknown('system event with no distinguishing actorId')
  }
  return P.unknown(`unrecognised actorType "${actorType}"`)
}

/** Resolve an `AuditLog` row's actor. Legacy autonomy rows have none. */
export function fromAuditLog(row: {
  userId?: string | null
  userEmail?: string | null
  type?: string | null
  metadata?: unknown
}): Principal {
  const carried = readPrincipals(row.metadata)
  if (carried?.executedBy) return carried.executedBy
  if (row.userId) return P.user(row.userId)
  if (row.type === 'autonomy') {
    // Written before principals existed. The loop is genuinely not recoverable
    // from the row, and naming one would be a fabrication.
    return P.unknown('autonomy audit row written before principals were recorded')
  }
  return P.unknown('audit row carries no actor')
}

/** An approval's approver. `approvedBy` is an opaque string by schema. */
export function fromApprovedBy(approvedBy: string | null | undefined): Principal {
  if (!approvedBy) return P.unknown('approval carries no approver')
  // Stored as a user id in practice; it has no type, so it is not asserted to
  // be one beyond the shape check.
  return /^[0-9a-f-]{36}$/i.test(approvedBy)
    ? P.user(approvedBy)
    : P.unknown(`approver "${approvedBy}" is not a resolvable identity`)
}

// ── Carrying principals on rows that have nowhere to put them ────────────────

const KEY = 'principals'

/**
 * Principals as they ride in `AuditLog.metadata`.
 *
 * Metadata rather than columns because Phase 1 is a vocabulary, not a
 * migration. When the Adaptation model lands these become real columns; until
 * then this keeps new autonomy activity principal-aware without touching the
 * schema or rewriting history.
 */
export function principalsToMetadata(set: Partial<PrincipalSet>): Record<string, unknown> {
  return {
    [KEY]: {
      requestedBy: set.requestedBy ?? null,
      authorizedBy: set.authorizedBy ?? null,
      executedBy: set.executedBy ?? null,
      authorizationSource: set.authorizationSource ?? 'none',
      v: 1,
    },
  }
}

/** Read principals back, returning null when the row predates them. */
export function readPrincipals(metadata: unknown): Partial<PrincipalSet> | null {
  if (!metadata || typeof metadata !== 'object') return null
  const block = (metadata as Record<string, unknown>)[KEY]
  if (!block || typeof block !== 'object') return null
  const b = block as Record<string, unknown>
  return {
    requestedBy: (b.requestedBy as Principal) ?? undefined,
    authorizedBy: (b.authorizedBy as Principal) ?? undefined,
    executedBy: (b.executedBy as Principal) ?? undefined,
    authorizationSource: (b.authorizationSource as AuthorizationSource) ?? undefined,
  }
}

// ── Resolving the standing authorizer ────────────────────────────────────────

/**
 * Who authorized a Backenly loop to act on this project?
 *
 * Today's delegation is the project's autonomy dial, and the dial is a setting
 * the project OWNER controls. So the owner is the standing authorizer for
 * anything the loops do, and recording them is what makes "who allowed this"
 * answerable before a real grant model exists.
 *
 * Returns `unknown` rather than throwing when the project cannot be read: a
 * failed lookup is not evidence that nobody authorized the action.
 */
export async function projectOwnerPrincipal(
  prisma: { project: { findUnique: (a: any) => Promise<any> } },
  projectId: string,
): Promise<Principal> {
  try {
    const proj = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    return proj?.userId
      ? P.user(proj.userId)
      : P.unknown('project has no owner on record')
  } catch {
    return P.unknown('project owner could not be read')
  }
}

/**
 * The principal set for an autonomous action a Backenly loop both requests and
 * performs under the project's standing delegation.
 */
export async function loopPrincipals(
  prisma: { project: { findUnique: (a: any) => Promise<any> } },
  projectId: string,
  loop: 'reconciler' | 'maintenance' | 'agent_orchestrator',
  requestedBy?: Principal,
): Promise<PrincipalSet> {
  const self: Principal = { kind: 'backenly', loop }
  const owner = await projectOwnerPrincipal(prisma, projectId)
  return {
    requestedBy: requestedBy ?? self,
    authorizedBy: owner,
    executedBy: self,
    // Transitive, through the dial the owner controls. NOT a per-mutation
    // approval, and Phase 2 must not read it as one.
    authorizationSource: owner.kind === 'unknown' ? 'none' : 'project_autonomy_dial',
  }
}
