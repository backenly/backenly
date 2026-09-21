/**
 * OWNERSHIP INTENT — WHO A TABLE'S ROWS BELONG TO
 * ==============================================
 *
 * `docs/intent-and-authority-rfc.md` §5.2. The first intent that is not a
 * property of application code: column shape is a type, and "these rows belong
 * to the authenticated user through `user_id`" is not. It cannot be expressed as
 * a write-time validator, and it drifts independently of the code that reads it.
 *
 * It exists to answer one question the Phase 0 baseline proved Backenly could
 * not answer. The loop can SEE that `USING (true)` is wrong. Nothing tells it
 * what is right, so it either guesses a predicate or leaves the table open, and
 * the baseline measured it guessing — the single unsafe mutation in the bank.
 *
 * ── The rule that keeps this from becoming the next shortcut ────────────────
 *
 * It would be easy, and wrong, to write:
 *
 *     changesAuthorization && someIntentExists  ->  AUTO_EXECUTE
 *
 * "Some intent exists" is not authority. An intent for a different table, a
 * superseded version, a revoked one, or one Backenly inferred from watching
 * traffic must all fail to authorize anything. `authoritativeOwnershipIntent`
 * is the only way to satisfy the rule, and it requires ALL of:
 *
 *     the intent names THIS table
 *     it is the current version
 *     it has not been superseded
 *     it has not been revoked
 *     its provenance is a declaration, not an observation or a guess
 *     it determines the predicate the action would apply
 *
 * Failing any one of those is not an error; it is a `PROPOSE_ONLY`, which is the
 * correct answer when Backenly can see a problem and cannot establish the fix.
 */

import type { Principal } from '@/lib/principal'

/**
 * Where an ownership assertion came from.
 *
 * Only the two DECLARED forms may authorize a mutation. Observed and inferred
 * may explain, recommend, and ask for confirmation, and may never independently
 * widen authority — the rule that stops this architecture from recreating
 * "Backenly guessed X, therefore treated X as true, therefore changed
 * production" (RFC P9).
 */
export type IntentProvenance =
  | 'declared_by_user'
  | 'declared_by_authorized_agent'
  | 'observed_from_existing_state'
  | 'inferred_by_backenly'

const AUTHORITATIVE: ReadonlySet<IntentProvenance> = new Set([
  'declared_by_user',
  'declared_by_authorized_agent',
])

export function isAuthoritativeProvenance(p: string): boolean {
  return AUTHORITATIVE.has(p as IntentProvenance)
}

export interface OwnershipIntentRecord {
  id: string
  projectId: string
  tableName: string
  ownerColumn: string
  subject: string
  provenance: string
  version: number
  supersededById: string | null
  supersededAt: Date | null
  revokedAt: Date | null
  declaredBy: unknown
}

/** Why an intent could not authorize an action. Never thrown; always reported. */
export type IntentRefusal =
  | 'no_intent_for_resource'
  | 'intent_superseded'
  | 'intent_revoked'
  | 'intent_provenance_not_authoritative'
  | 'intent_does_not_determine_predicate'

export interface IntentEvaluation {
  /** The intent that authorizes this action, or null. */
  authoritative: OwnershipIntentRecord | null
  refusal: IntentRefusal | null
  /** One sentence, for the receipt. */
  note: string
}

/**
 * Does a declared, current, authoritative ownership intent cover this table?
 *
 * Pure over its input so the rule is testable without a database, and so the
 * same set of rows always gives the same answer.
 */
export function evaluateOwnershipIntent(
  candidates: OwnershipIntentRecord[],
  resourceTable: string,
): IntentEvaluation {
  const forTable = candidates.filter(c => c.tableName === resourceTable)
  if (forTable.length === 0) {
    return {
      authoritative: null,
      refusal: 'no_intent_for_resource',
      note: `No ownership intent names "${resourceTable}", so the correct rule for it is unknown.`,
    }
  }

  // Newest version first; the current one is the only one that can authorize.
  const ordered = [...forTable].sort((a, b) => b.version - a.version)
  const current = ordered[0]

  if (current.revokedAt) {
    return {
      authoritative: null,
      refusal: 'intent_revoked',
      note: `Ownership intent for "${resourceTable}" was revoked, so it authorizes nothing.`,
    }
  }
  if (current.supersededById || current.supersededAt) {
    return {
      authoritative: null,
      refusal: 'intent_superseded',
      note:
        `The newest ownership intent for "${resourceTable}" is marked superseded, so no ` +
        'current declaration describes it.',
    }
  }
  if (!isAuthoritativeProvenance(current.provenance)) {
    return {
      authoritative: null,
      refusal: 'intent_provenance_not_authoritative',
      note:
        `Ownership intent for "${resourceTable}" is ${current.provenance}. Observed and ` +
        'inferred intent may explain and recommend, never authorize.',
    }
  }
  // It must actually determine what to apply. An assertion with no owner column
  // names a property without saying how to enforce it.
  if (!current.ownerColumn || !current.subject) {
    return {
      authoritative: null,
      refusal: 'intent_does_not_determine_predicate',
      note:
        `Ownership intent for "${resourceTable}" does not name both an owner column and a ` +
        'subject, so it does not determine a policy predicate.',
    }
  }

  return {
    authoritative: current,
    refusal: null,
    note:
      `"${resourceTable}" is declared owned through "${current.ownerColumn}" ` +
      `(${current.provenance}, v${current.version}).`,
  }
}

/**
 * The policy predicate an ownership intent determines.
 *
 * Deterministic and derived only from the declaration — never from a model, and
 * never from inspecting traffic. This is the difference between applying what
 * the application said and guessing what it probably meant.
 *
 * Mirrors `ownRowsPredicate` in lib/postgrest/rls-translation, which is what the
 * product already emits for own-rows policies.
 */
export function predicateFor(intent: OwnershipIntentRecord): string {
  if (intent.subject !== 'authenticated_user') {
    throw new Error(`Unsupported ownership subject "${intent.subject}"`)
  }
  return `("${intent.ownerColumn}"::text = current_setting('request.jwt.claim.sub', true))`
}

/** Declare an ownership intent, superseding any current one for that table. */
export async function declareOwnershipIntent(
  prisma: any,
  input: {
    projectId: string
    tableName: string
    ownerColumn: string
    provenance: IntentProvenance
    declaredBy: Principal
    subject?: string
  },
): Promise<OwnershipIntentRecord> {
  const existing: OwnershipIntentRecord[] = await prisma.ownershipIntent.findMany({
    where: { projectId: input.projectId, tableName: input.tableName },
    orderBy: { version: 'desc' },
    take: 1,
  })
  const prev = existing[0]
  const version = prev ? prev.version + 1 : 1

  const created = await prisma.ownershipIntent.create({
    data: {
      projectId: input.projectId,
      tableName: input.tableName,
      ownerColumn: input.ownerColumn,
      subject: input.subject ?? 'authenticated_user',
      provenance: input.provenance,
      version,
      declaredBy: input.declaredBy as any,
    },
  })

  // Supersede rather than delete. The old row is what an incident review reads
  // to find out what was believed at the time something was applied.
  if (prev) {
    await prisma.ownershipIntent.update({
      where: { id: prev.id },
      data: { supersededById: created.id, supersededAt: new Date() },
    })
  }

  return created
}

/** Load every intent recorded for a table, newest first. */
export async function loadOwnershipIntents(
  prisma: any,
  projectId: string,
  tableName: string,
): Promise<OwnershipIntentRecord[]> {
  return prisma.ownershipIntent.findMany({
    where: { projectId, tableName },
    orderBy: { version: 'desc' },
  })
}
