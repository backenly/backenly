/**
 * PHASE 4 — carrying out a conclusion.
 *
 * Only reached for a CONCLUSIVE verdict whose remedy is marked auto-applicable.
 * Both conditions matter: the first says the evidence actually settled the
 * question, the second says this particular repair is one a machine may perform
 * unattended. A hypothesis can be certain and still not be safe to act on —
 * "these are credential tables, denied by design" is certain, and acting on it
 * would publish password hashes.
 *
 * Every action here is additive or restorative. None widens a security
 * boundary, none destroys data, and each is reversible by re-running the
 * provisioning it duplicates. That is not a coincidence — it is the criterion
 * for being allowed in this file at all.
 */

import { prisma } from '@/lib/db/prisma'
import type { InvestigationVerdict } from './types'

export interface RemedyOutcome {
  applied: boolean
  action?: string
  detail: string
  /** Work that could not be completed in-process and needs the supervisor. */
  escalation?: string
}

/**
 * Apply the remedy implied by a verdict.
 *
 * Refuses anything that is not a conclusive, auto-applicable verdict — the
 * refusal is the safety property, so it is enforced here rather than assumed of
 * every caller.
 */
export async function applyRemedy(
  projectId: string,
  verdict: InvestigationVerdict,
): Promise<RemedyOutcome> {
  if (verdict.kind !== 'conclusive') {
    return {
      applied: false,
      detail: `No remedy applied: the investigation was ${verdict.kind}.`,
    }
  }
  const { remedy } = verdict.hypothesis
  if (!remedy.autoApplicable || !remedy.action) {
    return {
      applied: false,
      detail: `Diagnosis: ${verdict.hypothesis.statement}. This repair needs a human decision.`,
    }
  }

  const schema = `workspace_${projectId}`

  switch (remedy.action) {
    case 'POSTGREST_RELOAD_SCHEMA': {
      // Purely a cache rebuild — no data, no privileges, no schema change.
      await prisma.$executeRawUnsafe(`SELECT public.backenly_pgrst_reload()`)
      return {
        applied: true,
        action: remedy.action,
        detail: 'Reloaded the PostgREST schema cache.',
      }
    }

    case 'POSTGREST_PREPARE_SCHEMA': {
      // Restores the documented default rather than widening it, and
      // prepare_schema re-asserts the credential-table exclusion last, so this
      // cannot end with `users` readable.
      await prisma.$executeRawUnsafe(`SELECT public.backenly_pgrst_prepare_schema($1)`, schema)
      await prisma.$executeRawUnsafe(`SELECT public.backenly_pgrst_reload()`)
      return {
        applied: true,
        action: remedy.action,
        detail: `Re-applied data-plane grants for ${schema} and reloaded the schema cache.`,
      }
    }

    case 'POSTGREST_PRUNE_AND_RESTART': {
      const before = await registeredSchemas()
      await prisma.$executeRawUnsafe(`SELECT public.backenly_pgrst_prune_schemas()`)
      const after = await registeredSchemas()
      const pruned = before.filter(s => !after.includes(s))

      // The SQL half is done and is the part that makes a restart safe. The
      // restart itself is deliberately NOT performed from here: process control
      // belongs to the supervisor, and a database-connected module reaching for
      // pm2 would be both unreliable and a privilege this code should not hold.
      return {
        applied: pruned.length > 0,
        action: remedy.action,
        detail:
          pruned.length > 0
            ? `Pruned ${pruned.length} dangling registration(s): ${pruned.join(', ')}.`
            : 'No dangling registrations found.',
        escalation:
          'PostgREST must be restarted to rebuild its schema cache — a failed cache ' +
          'does not clear on a config reload. Run: pm2 restart backenly-postgrest',
      }
    }

    case 'POSTGREST_RESTART': {
      return {
        applied: false,
        action: remedy.action,
        detail: 'The PostgREST process is not answering.',
        escalation: 'Run: pm2 restart backenly-postgrest',
      }
    }

    case 'GENERATE_API': {
      // Routed through the existing generator rather than reimplemented, so a
      // repaired resource is identical to one created normally.
      return {
        applied: false,
        action: remedy.action,
        detail:
          'The table exists but has no API. Generation runs through the standard ' +
          'GENERATE_API path in the fix engine.',
        escalation: 'Queue GENERATE_API for this table.',
      }
    }

    default:
      // An action the catalog names but this module does not implement. Saying
      // so beats returning a success that never happened.
      return {
        applied: false,
        action: remedy.action,
        detail: `No executor implemented for action "${remedy.action}".`,
      }
  }
}

async function registeredSchemas(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ list: string | null }>>(
    `SELECT public.backenly_pgrst_current_schemas() AS list`,
  )
  return (rows[0]?.list ?? '').split(',').filter(Boolean)
}
