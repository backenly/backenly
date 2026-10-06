/**
 * Architecture evolution — what changed, what is waiting, and the decisions
 * =========================================================================
 *
 * GET  /api/projects/[id]/architecture
 *        concise: recent changes in plain sentences, how many requests wait in
 *        the Autonomy queue, recommendations and "no change" reasons from the
 *        last assessment. Reads memory only; never re-analyses.
 * GET  /api/projects/[id]/architecture?detail=1
 *        also a fresh analysis (every concern, its evidence, the exact plans)
 * GET  /api/projects/[id]/architecture?decision=<id>
 *        one change's full trail: every state, rehearsal, snapshot, outcome
 * POST /api/projects/[id]/architecture  { action, ... }
 *        approve  { findingId, planVersion }   consent to that exact version;
 *                                               the spec is read from the
 *                                               request row, never the body
 *        pause    { decisionId }               stop before the next step
 *        resume   { decisionId }
 *        undo     { decisionId }               lossless, or refused
 *        assess   {}                            look for changes now (reads
 *                                               and rehearses only)
 *
 * Every decision is the engine's (lib/evolution-engine/engine.ts); this route
 * authenticates, parses and answers. Auth is `withProjectValidation`, which
 * needs a platform SESSION: an MCP agent's API key cannot reach any POST here,
 * so agents can read proposals and outcomes and can approve nothing.
 *
 * Refusals are 409: the request was well-formed and the world said no — the
 * plan moved, someone already decided, undo would lose a write. The caller's
 * next step is to re-read, not to fix a payload.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import {
  advance,
  approveRequest,
  architectureSummary,
  decisionDetail,
  isActionRefusal,
  isApprovalRefusal,
  pause,
  proposeChanges,
  resume,
  undo,
} from '@/lib/evolution-engine/engine'
import { allPrimitives } from '@/lib/evolution-engine/primitive'
import { readMemory, priorsFor, summarizeDecisions } from '@/lib/evolution-engine/memory'

export async function GET(request: NextRequest, _props: { params: Promise<{ id: string }> }) {
  return withProjectValidation<any>(request, async validated => {
    const { projectId } = validated
    const url = new URL(request.url)
    const decisionId = url.searchParams.get('decision')?.trim()
    if (decisionId) {
      const detail = await decisionDetail(projectId, decisionId)
      return detail ? NextResponse.json(detail) : NextResponse.json({ error: 'No such change' }, { status: 404 })
    }
    const summary = await architectureSummary(projectId)
    if (url.searchParams.get('detail') !== '1') return NextResponse.json(summary)

    const priors = priorsFor(summarizeDecisions(await readMemory(projectId)))
    const analyses = []
    for (const p of allPrimitives()) {
      analyses.push({ primitive: p.id, title: p.title, assessment: await p.assess(projectId, { priors }) })
    }
    return NextResponse.json({ ...summary, analyses })
  })
}

const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null)

export async function POST(request: NextRequest, _props: { params: Promise<{ id: string }> }) {
  return withProjectValidation<any>(request, async validated => {
    const { projectId, userId } = validated
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = str(body.action)

    if (action === 'approve') {
      const findingId = str(body.findingId)
      const planVersion = str(body.planVersion)
      if (!findingId || !planVersion) {
        return NextResponse.json({ error: 'approve needs findingId and the planVersion you were shown' }, { status: 400 })
      }
      const r = await approveRequest({ projectId, findingId, planVersion, userId })
      return isApprovalRefusal(r)
        ? NextResponse.json({ error: r.error, ...(r.currentPlanVersion ? { currentPlanVersion: r.currentPlanVersion } : {}) }, { status: r.status })
        : NextResponse.json({ ok: true, message: r.message, state: r.state })
    }

    if (action === 'pause' || action === 'resume' || action === 'undo' || action === 'advance') {
      const decisionId = str(body.decisionId)
      if (!decisionId) return NextResponse.json({ error: `${action} needs decisionId` }, { status: 400 })
      if (action === 'advance') {
        const r = await advance({ projectId, decisionId, actor: userId })
        return NextResponse.json({ ok: true, message: r.message, state: r.state })
      }
      const r =
        action === 'pause'
          ? await pause({ projectId, decisionId, userId })
          : action === 'resume'
            ? await resume({ projectId, decisionId, userId })
            : await undo({ projectId, decisionId, userId })
      return isActionRefusal(r)
        ? NextResponse.json({ error: r.error }, { status: r.status })
        : NextResponse.json({ ok: true, message: r.message, state: r.state })
    }

    if (action === 'assess') {
      const r = await proposeChanges(projectId)
      return NextResponse.json({ ok: true, ...r })
    }

    return NextResponse.json({ error: 'action must be approve, pause, resume, undo or assess' }, { status: 400 })
  })
}
