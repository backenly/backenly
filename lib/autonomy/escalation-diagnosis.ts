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
 * This module is the server-side "senior engineer pass": for each escalated
 * finding it gathers the evidence (finding details, what autonomy already
 * tried, the project's table inventory) and asks a model to write a diagnosis:
 * root cause, recommended remediation, risk note. The diagnosis is stored on
 * `details.diagnosis` and surfaces in the Review Queue, the dashboard, and the
 * get_pending_incidents agent briefing.
 *
 * DELIBERATE SAFETY CONTRACT (mirrors the reconciler's shadow-first stance):
 *   • This module NEVER executes anything. It writes words, not mutations.
 *     The human (or their agent, through the governed door) decides.
 *   • Bounded cost: max N diagnoses per project per tick, only for findings
 *     without one, and re-diagnosis only when the finding's evidence changed.
 *   • Fail-silent per finding — a model error never breaks the autonomy tick.
 *
 * Runs on Backenly's servers 24/7 — the "laptop open at 3am" is not required;
 * intelligence is an API call, not a device.
 */

import { prisma } from '@/lib/db/prisma'
import { getOpenAIClient, trackCompletionCost } from '@/lib/ai/openai-service'
import { summariseFinding } from '@/lib/core/finding-summaries'

/**
 * Strong-model pass for the few escalations; env-overridable. Defaults to the
 * same strong model as the fix author (agentic-fix-author) — escalations are
 * the rare cases where the deterministic loop gave up, so a weak diagnosis
 * wastes the one human review it gets (founder decision 2026-07-18).
 */
function diagnosisModel(): string {
  return process.env.AUTONOMY_DIAGNOSIS_MODEL || 'gpt-4o'
}

const MAX_PER_TICK = 2

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

/**
 * Diagnose up to MAX_PER_TICK escalated findings for one project.
 * Returns the number of diagnoses written. Never throws.
 */
export async function diagnoseEscalatedFindings(projectId: string): Promise<number> {
  let written = 0
  try {
    // Escalated = waiting on a human, or critical with nothing auto-fixable.
    const candidates = await prisma.healthFinding.findMany({
      where: {
        projectId,
        OR: [
          { status: 'pending_approval' },
          { status: 'open', severity: 'critical' },
        ],
      },
      orderBy: { detectedAt: 'desc' },
      take: 10,
    })
    const undiagnosed = candidates.filter((f) => {
      const d = (f.details ?? {}) as Record<string, unknown>
      return !d.diagnosis
    }).slice(0, MAX_PER_TICK)
    if (undiagnosed.length === 0) return 0

    // Shared cheap context: what the backend looks like + what autonomy did
    // recently. One query each, reused across the findings in this tick.
    const [tables, recentAutonomy] = await Promise.all([
      prisma.table.findMany({
        where: { projectId },
        select: { name: true },
        take: 60,
      }).catch(() => [] as Array<{ name: string }>),
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
    ])

    const openai = getOpenAIClient()

    for (const finding of undiagnosed) {
      try {
        const details = (finding.details ?? {}) as Record<string, unknown>

        // ── Tier A½ — deterministic investigation, before the model ──────────
        // Where a symptom has several possible causes, real observations beat a
        // written argument: this pass eliminates explanations that predicted
        // something that did not happen, and reports the trail that did it. It
        // also declines to conclude when the evidence does not settle the
        // question, which a model asked for a root cause will never do — it
        // will always produce one, because that is what it is for.
        //
        // Only its CONCLUSIVE verdicts short-circuit the model. An inconclusive
        // investigation still narrowed the field, but a narrowed field is not a
        // diagnosis, and presenting it as one would trade a confident wrong
        // answer for a hesitant wrong answer.
        const { diagnoseFinding, renderDiagnosis } = await import('./hypothesis')
        const investigated = await diagnoseFinding(
          projectId,
          finding.type,
          { table: pickString(details.tableName) ?? pickString(details.table) },
        ).catch(() => null)

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
                    evidence: investigated.report.trail,
                    at: new Date().toISOString(),
                  },
                },
              },
            })
            written++
            continue
          }
        }

        const prompt = [
          `Finding type: ${finding.type} (severity ${finding.severity}, status ${finding.status}, detected ${finding.detectedAt.toISOString()})`,
          `One-line summary: ${summariseFinding(finding.type, details)}`,
          `Evidence (detector output): ${JSON.stringify(details).slice(0, 3000)}`,
          `Project tables: ${tables.map(t => t.name).join(', ') || '(none)'}`,
          `Recent autonomous activity (newest first): ${recentAutonomy
            .map(a => `${a.timestamp.toISOString()} ${a.action} ${String(a.details ?? '').slice(0, 140)}`)
            .join(' | ') || '(none)'}`,
        ].join('\n')

        const completion = await openai.chat.completions.create({
          model: diagnosisModel(),
          temperature: 0.2,
          max_tokens: 500,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are the senior backend engineer on call for an autonomous backend platform. ' +
                'A health finding was escalated because the deterministic fix engine could not (or is not allowed to) repair it. ' +
                'Write a diagnosis the project owner — often a non-engineer founder — and their coding agent can both act on. ' +
                'Ground every claim in the evidence given; if the evidence is insufficient, say so in rootCause and lower the confidence. ' +
                'NEVER invent tables, integrations, or errors not present in the evidence. ' +
                'Respond with JSON: {"rootCause": string (2-3 plain sentences), "recommendation": string (the single best next action, concrete), "riskNote": string (what could go wrong if remediated wrongly, 1 sentence), "confidence": "high"|"medium"|"low"}.',
            },
            { role: 'user', content: prompt },
          ],
        })
        trackCompletionCost(completion, projectId, 'autonomy-diagnosis')

        const raw = completion.choices[0]?.message?.content ?? '{}'
        let parsed: Partial<FindingDiagnosis>
        try { parsed = JSON.parse(raw) } catch { continue }
        if (!parsed.rootCause || !parsed.recommendation) continue

        const diagnosis: FindingDiagnosis = {
          rootCause: String(parsed.rootCause).slice(0, 800),
          recommendation: String(parsed.recommendation).slice(0, 800),
          riskNote: String(parsed.riskNote ?? '').slice(0, 400),
          confidence: parsed.confidence === 'high' || parsed.confidence === 'low' ? parsed.confidence : 'medium',
          model: completion.model,
          at: new Date().toISOString(),
        }

        await prisma.healthFinding.update({
          where: { id: finding.id },
          data: { details: { ...details, diagnosis } as any },
        })
        await prisma.auditLog.create({
          data: {
            projectId,
            action: 'AUTONOMY_DIAGNOSIS_WRITTEN',
            type: 'autonomy',
            details: JSON.stringify({
              findingId: finding.id,
              findingType: finding.type,
              confidence: diagnosis.confidence,
              model: diagnosis.model,
            }),
            timestamp: new Date(),
          },
        }).catch(() => {})
        written++
      } catch {
        // Per-finding isolation — one model failure never blocks the rest.
      }
    }
  } catch {
    // Fail-silent by contract: diagnosis is enrichment, never a dependency.
  }
  return written
}
