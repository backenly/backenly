/**
 * ESCALATION DIAGNOSIS — Tier B of the 24/7 operator
 * ===================================================
 * The deterministic loop (Tier A: probes + auto-fix engine) handles the
 * routine 80%. Whatever it CANNOT fix — Tier-2 findings queued for approval,
 * recurrence escalations where a fix demonstrably didn't hold, and critical
 * findings with no executable repair — used to sit in the Review Queue as a
 * bare type string, leaving the human (or their coding agent) to re-derive the
 * situation from scratch.
 *
 * This module is the server-side "senior engineer pass". For each escalated
 * finding it first runs the deterministic investigation, whose conclusive
 * verdicts are written as fact. Only when that cannot conclude does the
 * investigator (lib/autonomy/investigator.ts) take over: Claude, with
 * read-only probes, writing a hypothesis that code then checks against what
 * actually ran and what actually exists. The diagnosis is stored on
 * `details.diagnosis` and surfaces in the Review Queue, the dashboard, and the
 * get_pending_incidents agent briefing, labelled by where it came from.
 *
 * DELIBERATE SAFETY CONTRACT (mirrors the reconciler's shadow-first stance):
 *   • This module NEVER executes anything. It writes words, not mutations.
 *     The human (or their agent, through the governed door) decides.
 *   • Bounded cost: max N per project per tick and a daily cap per project;
 *     once per evidence fingerprint (re-investigated only when the evidence
 *     changes); at most MAX_ATTEMPTS failed attempts, spaced 10m, 1h, 6h;
 *     and the deployment's own monthly AI budget (autonomy.* is
 *     platform-paid), which stops every call when it is used up.
 *   • Fail-silent per finding — a model error never breaks the autonomy tick.
 *
 * Runs on Backenly's servers 24/7 — the "laptop open at 3am" is not required;
 * intelligence is an API call, not a device.
 */

import { prisma } from '@/lib/db/prisma'
import { AiError } from '@/lib/ai/llm'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { EVOLUTION_FINDING_TYPE } from '@/lib/core/types'
import { classifyFix } from '@/lib/core/fix-classifier'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { workspaceRawClient, type WorkspaceRawClient } from '@/lib/data-plane/regional'
import { quotesKeptHere } from '@/lib/data-plane/residency'
import { investigateFinding, type CatalogTable, type Investigation } from './investigator'
import { evidenceFingerprint } from './finding-fingerprint'
import { proposableFor, proposeRepair } from './ai-proposals'

const MAX_PER_TICK = 2
/** Model investigations per project per 24h. Deterministic ones are not counted. */
const DAILY_CAP = 5
const MAX_ATTEMPTS = 3
/** Wait after the 1st, 2nd and 3rd failed attempt. */
const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000]
/** Wait while no model can be called at all (no provider, no budget). Not an attempt. */
const UNAVAILABLE_WAIT_MS = 60 * 60_000

/** Narrow an unknown detail field to a usable string, or undefined. */
function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export interface FindingDiagnosis {
  rootCause: string
  recommendation: string
  riskNote: string
  confidence: 'high' | 'medium' | 'low'
  model: string
  at: string
}

/** This module's own bookkeeping on a finding. */
interface InvestigationState {
  fingerprint: string
  attempts: number
  nextAt?: string
  lastError?: string
  history?: Array<{ at: string; verdict: string; rootCause: string }>
}

export { evidenceFingerprint }

/** Whether a finding should be investigated on this tick. */
export function isDue(details: Record<string, unknown>, fingerprint: string, now = Date.now()): boolean {
  const diagnosis = details.diagnosis as { fingerprint?: string } | undefined
  // A diagnosis from before fingerprints counts as current.
  if (diagnosis && (diagnosis.fingerprint ?? fingerprint) === fingerprint) return false
  const state = details.investigation as InvestigationState | undefined
  if (!state || state.fingerprint !== fingerprint) return true
  if (state.attempts >= MAX_ATTEMPTS) return false
  return !state.nextAt || Date.parse(state.nextAt) <= now
}

/** Table and column names of the project's workspace schema. Names only, never rows. */
async function loadCatalog(db: WorkspaceRawClient, projectId: string): Promise<CatalogTable[]> {
  const schema = await resolveWorkspaceSchema(projectId)
  const rows = await db.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
    schema,
  )
  const byTable = new Map<string, string[]>()
  for (const r of rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, [])
    byTable.get(r.table_name)!.push(r.column_name)
  }
  return [...byTable].slice(0, 80).map(([name, columns]) => ({ name, columns }))
}

/** The diagnosis stored for a model investigation: a hypothesis, labelled as one. */
function hypothesisDiagnosis(
  investigation: Investigation,
  fingerprint: string,
  at: string,
  proposal: Awaited<ReturnType<typeof proposeRepair>> | null,
) {
  return {
    rootCause: investigation.rootCause.slice(0, 800),
    recommendation: investigation.recommendation.slice(0, 800),
    riskNote: investigation.riskNote.slice(0, 400),
    // At most medium, and low when it could not be tied to evidence or failed
    // the checks.
    confidence: investigation.verdict === 'explained' ? 'medium' : 'low',
    model: investigation.model,
    provenance: 'ai_hypothesis',
    verdict: investigation.verdict,
    evidenceRefs: investigation.evidenceRefs,
    ruledOut: investigation.ruledOut,
    evidence: investigation.evidence,
    proposedAction: investigation.proposedAction,
    validation: investigation.validation,
    // An approvable proposal, or the reason the suggestion stays advisory.
    ...(proposal && 'proposalId' in proposal ? { proposal: { id: proposal.proposalId, version: proposal.proposalVersion } } : {}),
    ...(proposal && 'reason' in proposal ? { proposalRefused: proposal.reason } : {}),
    fingerprint,
    at,
  }
}

/**
 * Diagnose up to MAX_PER_TICK escalated findings for one project.
 * Returns the number of diagnoses written. Never throws.
 */
export async function diagnoseEscalatedFindings(projectId: string): Promise<number> {
  let written = 0
  try {
    // Escalated = waiting on a human, critical with nothing auto-fixable, or
    // open with no repair the rules will run on their own (notify-only or
    // approval-only): the cases the deterministic loop leaves to a person.
    const rows = await prisma.healthFinding.findMany({
      where: {
        projectId,
        OR: [
          { status: 'pending_approval' },
          { status: 'open', severity: { in: ['critical', 'warning'] } },
        ],
        // An architecture change awaiting a person is explained by the engine
        // that prepared it, deterministically; its row is the engine's handle
        // and is never rewritten, or shown to a model, by generic code.
        type: { not: EVOLUTION_FINDING_TYPE },
      },
      orderBy: { detectedAt: 'desc' },
      take: 20,
    })
    // A held action of a project kept in another region keeps its target and
    // arguments there (lib/operational-memory/held-action-targets.ts). Its
    // diagnosis would be written here, by a model that may run outside the
    // region, about an action the owner asked for and only has to decide on,
    // so it is not investigated (lib/data-plane/residency.ts).
    const quote = await quotesKeptHere(projectId)
    const candidates = rows.filter(
      (f) =>
        (quote || f.type !== 'ai_action_pending') &&
        (f.status === 'pending_approval' ||
          f.severity === 'critical' ||
          classifyFix(f.type, (f.details ?? {}) as Record<string, unknown>).decision !== 'auto'),
    )
    const due = candidates
      .map((f) => {
        const details = (f.details ?? {}) as Record<string, unknown>
        return { finding: f, details, fingerprint: evidenceFingerprint(f.type, details) }
      })
      .filter((c) => isDue(c.details, c.fingerprint))
      .slice(0, MAX_PER_TICK)
    if (due.length === 0) return 0

    // The catalog is in the project's region. Resolved here rather than in the
    // fail-soft catalog read below, so a project whose region this process
    // cannot reach gets no diagnosis at all instead of one reasoned from an
    // empty catalog.
    const db = await workspaceRawClient(projectId)

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const [recentAutonomy, investigatedToday] = await Promise.all([
      prisma.auditLog.findMany({
        where: {
          projectId,
          type: { in: ['autonomy', 'mutation'] },
          timestamp: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
        },
        orderBy: { timestamp: 'desc' },
        take: 15,
        select: { action: true, details: true, timestamp: true },
      }).catch(() => [] as Array<{ action: string; details: string | null; timestamp: Date }>),
      // Unreadable counts as spent: the cap fails closed.
      prisma.auditLog.count({
        where: { projectId, action: 'AUTONOMY_INVESTIGATION', timestamp: { gte: since } },
      }).catch(() => DAILY_CAP),
    ])
    let modelBudget = Math.max(0, DAILY_CAP - investigatedToday)
    let catalog: CatalogTable[] | null = null
    let modelUnavailable = false

    for (const { finding, details, fingerprint } of due) {
      try {
        // ── Tier A½ — deterministic investigation, before the model ──────────
        // Where a symptom has several possible causes, real observations beat a
        // written argument: this pass eliminates explanations that predicted
        // something that did not happen, and reports the trail that did it. It
        // also declines to conclude when the evidence does not settle the
        // question, which a model asked for a root cause will never do — it
        // will always produce one, because that is what it is for.
        //
        // Only its CONCLUSIVE verdicts short-circuit the model. An inconclusive
        // investigation still narrowed the field, and the investigator starts
        // from what it ruled out.
        const { diagnoseFinding, renderDiagnosis, PROBE_REGISTRY } = await import('./hypothesis')
        const table = pickString(details.tableName) ?? pickString(details.table)
        const investigated = await diagnoseFinding(projectId, finding.type, { table }).catch(() => null)

        if (investigated && investigated.report.verdict.kind === 'conclusive') {
          const rendered = renderDiagnosis(investigated.report)
          if (rendered) {
            await prisma.healthFinding.update({
              where: { id: finding.id },
              data: {
                details: {
                  ...details,
                  diagnosis: {
                    ...rendered,
                    // Marked so the trail is attributable: this diagnosis came
                    // from evidence, not from a model, and a reader should be
                    // able to tell which without asking.
                    model: 'deterministic-investigation',
                    provenance: 'investigation',
                    evidence: investigated.report.trail,
                    fingerprint,
                    at: new Date().toISOString(),
                  },
                },
              },
            })
            written++
            continue
          }
        }

        if (modelUnavailable || modelBudget <= 0) continue
        modelBudget--
        if (!catalog) catalog = await loadCatalog(db, projectId).catch(() => [])

        const state = details.investigation as InvestigationState | undefined
        const prior = state?.fingerprint === fingerprint ? state : undefined
        let investigation: Investigation
        try {
          investigation = await investigateFinding(
            {
              projectId,
              finding: {
                type: finding.type,
                severity: finding.severity,
                status: finding.status,
                detectedAt: finding.detectedAt,
                summary: summariseFinding(finding.type, details),
                details,
              },
              deterministic: investigated?.report ?? null,
              catalog,
              recentActivity: recentAutonomy.map(
                (a) => `${a.timestamp.toISOString()} ${a.action} ${String(a.details ?? '').slice(0, 140)}`,
              ),
              priorAttempts: prior?.history ?? [],
              proposable: proposableFor({ type: finding.type, details }),
            },
            (probe, probeTable) => PROBE_REGISTRY[probe]({ projectId, table: probeTable ?? table }),
            Object.keys(PROBE_REGISTRY),
          )
        } catch (err) {
          const ai = err instanceof AiError ? err : null
          // No provider, or no budget: nothing ran and nothing will this tick.
          // Not counted as an attempt, so the finding is investigated once AI
          // is available again.
          const unavailable = ai !== null && ai.consumption === 'none' && !ai.retryable
          if (unavailable) modelUnavailable = true
          const attempts = (prior?.attempts ?? 0) + (unavailable ? 0 : 1)
          const wait = unavailable ? UNAVAILABLE_WAIT_MS : BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]
          const next: InvestigationState = {
            fingerprint,
            attempts,
            nextAt: new Date(Date.now() + wait).toISOString(),
            lastError: ai?.kind ?? 'error',
            history: prior?.history ?? [],
          }
          await prisma.healthFinding.update({
            where: { id: finding.id },
            data: { details: { ...details, investigation: next } as any },
          }).catch(() => {})
          continue
        }

        // A suggested repair becomes an approvable proposal only when it is
        // explained by checked evidence and passes every proposal condition.
        // Nothing runs it here: only a person's approval does.
        let proposal: Awaited<ReturnType<typeof proposeRepair>> | null = null
        if (investigation.proposedAction) {
          proposal = investigation.verdict === 'explained' && investigation.validation.ok
            ? await proposeRepair({
                projectId,
                findingId: finding.id,
                action: investigation.proposedAction.action,
                paramsJson: investigation.proposedAction.paramsJson,
                model: investigation.model,
                rationale: investigation.rootCause,
              }).catch((err) => ({ ok: false as const, reason: `it could not be recorded: ${err instanceof Error ? err.message : String(err)}` }))
            : { ok: false as const, reason: 'the investigation did not explain the finding with checked evidence' }
        }

        const at = new Date().toISOString()
        const done: InvestigationState = {
          fingerprint,
          attempts: (prior?.attempts ?? 0) + 1,
          history: [
            ...(prior?.history ?? []),
            { at, verdict: investigation.verdict, rootCause: investigation.rootCause.slice(0, 200) },
          ].slice(-3),
        }
        await prisma.healthFinding.update({
          where: { id: finding.id },
          data: {
            details: {
              ...details,
              diagnosis: hypothesisDiagnosis(investigation, fingerprint, at, proposal),
              investigation: done,
            } as any,
          },
        })
        await prisma.auditLog.create({
          data: {
            projectId,
            action: 'AUTONOMY_INVESTIGATION',
            type: 'autonomy',
            details: JSON.stringify({
              findingId: finding.id,
              findingType: finding.type,
              verdict: investigation.verdict,
              valid: investigation.validation.ok,
              problems: investigation.validation.problems,
              toolCalls: investigation.evidence.length,
              model: investigation.model,
            }),
            timestamp: new Date(),
          },
        }).catch(() => {})
        written++
      } catch {
        // Per-finding isolation — one failure never blocks the rest.
      }
    }
  } catch {
    // Fail-silent by contract: diagnosis is enrichment, never a dependency.
  }
  return written
}
