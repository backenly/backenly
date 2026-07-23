// lib/ai/agents/planner-agent.ts
/** Planning agent: synthesizes multi-agent findings into a phased execution plan and a CTO-ready brief. */

import OpenAI from 'openai'
import type { AgentInput, AgentFinding, Phase, PlannerOutput } from './types'

// Severity ordering for sorting (lower = more urgent)
const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/**
 * Detects conflicting fix pairs.
 * Rule: migration (structural) and repair can conflict when both target the same table.
 */
function findConflicts(findings: AgentFinding[]): Set<string> {
  const conflictIds = new Set<string>()
  const migrationByTable = new Map<string, AgentFinding>()
  const repairByTable = new Map<string, AgentFinding>()

  for (const f of findings) {
    if (f.agentType === 'migration') migrationByTable.set(f.location, f)
    if (f.agentType === 'repair') repairByTable.set(f.location, f)
  }

  for (const [table, migFinding] of migrationByTable) {
    const repairFinding = repairByTable.get(table)
    if (repairFinding) {
      // Migration takes priority — defer the repair finding
      conflictIds.add(repairFinding.id)
    }
  }

  return conflictIds
}

/**
 * Estimate a human-readable fix time based on finding count and complexity.
 */
function estimateFixTime(
  phase1Count: number,
  phase2Count: number,
  phase3Count: number,
): string {
  const autoMinutes = phase1Count * 0.5    // ~30s per auto-fix
  const reviewMinutes = phase2Count * 3    // ~3 min per review item
  const totalMinutes = Math.ceil(autoMinutes + reviewMinutes)

  if (totalMinutes === 0) return 'No action required'
  if (totalMinutes < 2) return 'Under 2 minutes'
  if (totalMinutes < 10) return `~${totalMinutes} minutes`
  if (totalMinutes < 60) return `~${Math.round(totalMinutes / 5) * 5} minutes`
  return `~${Math.round(totalMinutes / 60)} hour(s)`
}

export async function planAgentResults(
  input: AgentInput,
  findings: AgentFinding[],
): Promise<PlannerOutput> {
  // ── 1. Sort by severity ───────────────────────────────────────────────
  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  )

  // ── 2. Detect conflicts ──────────────────────────────────────────────
  const conflictIds = findConflicts(sorted)

  // ── 3. Partition into phases ─────────────────────────────────────────
  const phase1: AgentFinding[] = []  // auto-fixable, no approval needed
  const phase2: AgentFinding[] = []  // needs user approval
  const phase3: AgentFinding[] = []  // monitor only (conflicts deferred here too)

  for (const f of sorted) {
    if (conflictIds.has(f.id)) {
      // Conflicting fix — defer to monitor phase
      phase3.push(f)
      continue
    }

    if (f.fix && !f.fix.requiresApproval) {
      phase1.push(f)
    } else if (f.fix && f.fix.requiresApproval) {
      phase2.push(f)
    } else {
      phase3.push(f)
    }
  }

  const executionPlan: Phase[] = [
    {
      name: 'Phase 1 — Auto-fix Now',
      actions: phase1,
      canAutoRun: true,
    },
    {
      name: 'Phase 2 — Needs Approval',
      actions: phase2,
      canAutoRun: false,
    },
    {
      name: 'Phase 3 — Monitor',
      actions: phase3,
      canAutoRun: false,
    },
  ].filter(p => p.actions.length > 0)

  // ── 4. LLM CTO brief ─────────────────────────────────────────────────
  let ctoBrief = 'Backend health analysis complete.'
  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 20_000,
      maxRetries: 1,
    })
    const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'

    const criticalCount = sorted.filter(f => f.severity === 'critical').length
    const highCount = sorted.filter(f => f.severity === 'high').length
    const topTitles = sorted.slice(0, 5).map(f => `- [${f.severity}] ${f.title}`).join('\n')

    const prompt =
      `You are briefing a CTO on the health of a backend project built on an autonomous backend platform.\n` +
      `Total findings: ${sorted.length} (${criticalCount} critical, ${highCount} high).\n` +
      `Auto-fixable: ${phase1.length}. Needs approval: ${phase2.length}. Monitor: ${phase3.length}.\n` +
      `Top issues:\n${topTitles || '(none)'}\n\n` +
      `Write a crisp 2–3 sentence brief that names the most urgent risk and the single most important action to take first. No bullet points.`

    const completion = await openai.chat.completions.create({
      model,
      max_tokens: 600,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are a senior backend architect. Write concise, actionable technical briefs. No fluff.',
        },
        { role: 'user', content: prompt },
      ],
    })

    const text = completion.choices[0]?.message?.content?.trim()
    if (text) ctoBrief = text
  } catch {
    // LLM step is non-fatal — fall back to generated summary
    const criticalCount = sorted.filter(f => f.severity === 'critical').length
    const highCount = sorted.filter(f => f.severity === 'high').length
    if (sorted.length === 0) {
      ctoBrief = 'No issues found — backend is healthy.'
    } else {
      const top = sorted[0]
      ctoBrief =
        `Found ${sorted.length} issue(s) across the backend (${criticalCount} critical, ${highCount} high). ` +
        `Top priority: "${top.title}" on ${top.location}. ` +
        `${phase1.length} fix(es) can be applied automatically; ${phase2.length} require your approval.`
    }
  }

  // ── 5. Estimated fix time ─────────────────────────────────────────────
  const estimatedFixTime = estimateFixTime(phase1.length, phase2.length, phase3.length)

  return {
    executionPlan,
    ctoBrief,
    estimatedFixTime,
  }
}
