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
 *        dismiss  { findingId }                 decline a waiting approval
 *                                               (remembered), or set a stopped
 *                                               change's queue row aside
 *        pause    { decisionId }               stop before the next step
 *        resume   { decisionId }
 *        undo     { decisionId }               lossless, or refused
 *        assess   {}                            look for changes now (reads
 *                                               and rehearses only)
 *
 * For a project kept in another region, what runs against its tables (the
 * start of an approved change, a rehearsal again after its table moved, an
 * undo, a look for changes) is queued for that region's worker, and the answer
 * says so: from here, those statements outlast the request.
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
  approveRequest,
  architectureSummary,
  decisionDetail,
  dismissRequest,
  isActionRefusal,
  isApprovalRefusal,
  liveStatements,
  pause,
  proposeWhereTheTablesAre,
  resume,
  startWhereTheTablesAre,
  undoWhereTheTablesAre,
} from '@/lib/evolution-engine/engine'
import { allPrimitives } from '@/lib/evolution-engine/primitive'
import { readMemory, priorsFor, summarizeDecisions } from '@/lib/evolution-engine/memory'

export async function GET(request: NextRequest, _props: { params: Promise<{ id: string }> }) {
  return withProjectValidation<any>(request, async validated => {
    const { projectId } = validated
    const url = new URL(request.url)
    // A waiting request's exact statements, rendered now from the project's own
    // tables: a project kept in another region does not store them at home.
    const statementsOf = url.searchParams.get('statements')?.trim()
    if (statementsOf) {
      const live = await liveStatements(projectId, statementsOf)
      return live ? NextResponse.json(live) : NextResponse.json({ error: 'No such request' }, { status: 404 })
    }
    const decisionId = url.searchParams.get('decision')?.trim()
    if (decisionId) {
      const detail = await decisionDetail(projectId, decisionId)
      return detail ? NextResponse.json(detail) : NextResponse.json({ error: 'No such change' }, { status: 404 })
    }
    const detail = url.searchParams.get('detail') === '1'
    const summary = await architectureSummary(projectId, { detail })
    if (!detail) return NextResponse.json(summary)

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

    if (action === 'dismiss') {
      const findingId = str(body.findingId)
      if (!findingId) return NextResponse.json({ error: 'dismiss needs findingId' }, { status: 400 })
      const r = await dismissRequest({ projectId, findingId, userId })
      return isActionRefusal(r)
        ? NextResponse.json({ error: r.error }, { status: r.status })
        : NextResponse.json({ ok: true, message: r.message, state: r.state })
    }

    if (action === 'pause' || action === 'resume' || action === 'undo' || action === 'advance') {
      const decisionId = str(body.decisionId)
      if (!decisionId) return NextResponse.json({ error: `${action} needs decisionId` }, { status: 400 })
      if (action === 'advance') {
        // Where the project's tables are: a project of another region is
        // started by that region's worker, not run from this request.
        const r = await startWhereTheTablesAre({ projectId, decisionId, actor: userId })
        return NextResponse.json({ ok: true, message: r.message, state: r.state })
      }
      const r =
        action === 'pause'
          ? await pause({ projectId, decisionId, userId })
          : action === 'resume'
            ? await resume({ projectId, decisionId, userId })
            : await undoWhereTheTablesAre({ projectId, decisionId, userId })
      return isActionRefusal(r)
        ? NextResponse.json({ error: r.error }, { status: r.status })
        : NextResponse.json({ ok: true, message: r.message, state: r.state })
    }

    if (action === 'assess') {
      const r = await proposeWhereTheTablesAre(projectId)
      return NextResponse.json({ ok: true, ...r })
    }

    return NextResponse.json({ error: 'action must be approve, dismiss, pause, resume, advance, undo or assess' }, { status: 400 })
    // Every action here decides what happens to a production table, like
    // maintenance consent: an organization ADMIN's call, never a VIEWER's.
  }, { floor: 'administer' })
}
