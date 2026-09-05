export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/builds
 *
 * Build-quality observability:
 *   - stuckNow      projects with repeated AI corrections / repair loops in
 *                   the last 3h (someone is fighting the AI right now)
 *   - failedBuilds  recent AI error responses paired with the user prompt
 *                   that triggered them + project + owner
 *   - prompts       searchable recent user prompts (?q=)
 *
 * FOUNDER-ONLY.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

// Mirrors the AI-error heuristic used by /api/admin/insights.
function looksLikeError(content: string, metadata: any): boolean {
  if (metadata && typeof metadata === 'object' && (metadata as any).error) return true
  const c = content || ''
  return (
    c.startsWith('Error:') ||
    c.startsWith('I encountered an error') ||
    c.includes('"error"') ||
    /\b(failed to|could not|unable to|something went wrong)\b/i.test(c.slice(0, 160))
  )
}

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const sp = request.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const since3h = new Date(Date.now() - 3 * 60 * 60 * 1000)

  const [correctionGroups, recentMsgs, promptRows] = await Promise.all([
    // Repair loops / self-corrections in the last 3h, grouped by project.
    prisma.correctionEvent.groupBy({
      by: ['projectId'],
      where: { createdAt: { gte: since3h } },
      _count: { id: true },
      _max: { createdAt: true },
    }),
    // Recent conversation messages — used to pair AI errors with their prompt.
    prisma.conversationMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: { id: true, projectId: true, role: true, content: true, metadata: true, createdAt: true },
    }),
    // Searchable recent user prompts.
    prisma.conversationMessage.findMany({
      where: {
        role: 'user',
        ...(q ? { content: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { id: true, projectId: true, content: true, createdAt: true },
    }),
  ])

  // ── Resolve project → name + owner for everything referenced ───────────────
  const allProjIds = [...new Set([
    ...correctionGroups.map(g => g.projectId),
    ...recentMsgs.map(m => m.projectId),
    ...promptRows.map(p => p.projectId),
  ])]
  const projects = allProjIds.length
    ? await prisma.project.findMany({
        where: { id: { in: allProjIds } },
        select: { id: true, name: true, userId: true, user: { select: { email: true } } },
      })
    : []
  const projMap = new Map(projects.map(p => [p.id, p]))

  // ── Stuck now ──────────────────────────────────────────────────────────────
  const stuckNow = correctionGroups
    .filter(g => g._count.id >= 2)
    .map(g => {
      const p = projMap.get(g.projectId)
      return {
        projectId: g.projectId,
        projectName: p?.name ?? '—',
        ownerEmail: p?.user?.email ?? null,
        ownerUserId: p?.userId ?? null,
        corrections: g._count.id,
        lastAt: g._max.createdAt?.toISOString() ?? null,
      }
    })
    .sort((a, b) => b.corrections - a.corrections)

  // ── Failed builds: walk messages per project, pair AI-error with the
  //    nearest preceding user prompt ──────────────────────────────────────────
  const byProject = new Map<string, typeof recentMsgs>()
  for (const m of recentMsgs) {
    const arr = byProject.get(m.projectId) ?? []
    arr.push(m)
    byProject.set(m.projectId, arr)
  }
  const failedBuilds: any[] = []
  for (const [pid, msgs] of byProject) {
    // msgs are desc; iterate and when we see an AI error, the next older
    // user message is the prompt that caused it.
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.role === 'ai' && looksLikeError(m.content, m.metadata)) {
        let prompt: string | null = null
        for (let j = i + 1; j < msgs.length; j++) {
          if (msgs[j].role === 'user') { prompt = msgs[j].content; break }
        }
        const p = projMap.get(pid)
        failedBuilds.push({
          id: m.id,
          projectId: pid,
          projectName: p?.name ?? '—',
          ownerEmail: p?.user?.email ?? null,
          ownerUserId: p?.userId ?? null,
          prompt: prompt ? prompt.slice(0, 300) : null,
          error: m.content.slice(0, 400).replace(/\s+/g, ' '),
          at: m.createdAt.toISOString(),
        })
      }
    }
  }
  failedBuilds.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

  // ── Prompts ────────────────────────────────────────────────────────────────
  const prompts = promptRows.map(p => {
    const proj = projMap.get(p.projectId)
    return {
      id: p.id,
      projectId: p.projectId,
      projectName: proj?.name ?? '—',
      ownerEmail: proj?.user?.email ?? null,
      excerpt: p.content.slice(0, 240).replace(/\n/g, ' '),
      at: p.createdAt.toISOString(),
    }
  })

  return NextResponse.json({
    stuckNow,
    failedBuilds: failedBuilds.slice(0, 40),
    prompts,
    query: q || null,
  })
}
