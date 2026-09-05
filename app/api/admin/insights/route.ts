export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/insights
 *
 * Product intelligence for the founder dashboard:
 *   - Stuck users (signed up >48h, no backend generated)
 *   - Time-to-activate distribution (signup → first backend)
 *   - Top AI prompt topics (keyword grouping from ConversationMessage)
 *   - Common backend categories (from BackendGraph graphData)
 *   - AI error rate (messages with error metadata)
 *   - Project health summary (for heatmap)
 *   - Recent user prompts (last 30 excerpts)
 *
 * FOUNDER-ONLY.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

// ── Keyword topic buckets for AI prompt classification ───────────────────────

const TOPIC_BUCKETS: { label: string; keywords: string[] }[] = [
  { label: 'E-commerce / Shop',   keywords: ['shop', 'store', 'product', 'cart', 'order', 'payment', 'checkout', 'inventory', 'sku', 'price'] },
  { label: 'Social / Community',  keywords: ['post', 'comment', 'like', 'follow', 'feed', 'user profile', 'community', 'forum', 'reply', 'mention'] },
  { label: 'SaaS / Dashboard',    keywords: ['dashboard', 'subscription', 'tenant', 'workspace', 'saas', 'plan', 'billing', 'admin panel', 'role'] },
  { label: 'Blog / CMS',          keywords: ['blog', 'article', 'content', 'cms', 'publish', 'draft', 'tag', 'category', 'author', 'post'] },
  { label: 'Auth / Users',        keywords: ['auth', 'login', 'signup', 'register', 'user', 'password', 'profile', 'account', 'jwt', 'oauth'] },
  { label: 'Task / Project Mgmt', keywords: ['task', 'todo', 'project', 'kanban', 'board', 'issue', 'ticket', 'sprint', 'assignee', 'milestone'] },
  { label: 'Booking / Calendar',  keywords: ['booking', 'appointment', 'schedule', 'calendar', 'slot', 'availability', 'reservation', 'event'] },
  { label: 'Messaging / Chat',    keywords: ['chat', 'message', 'conversation', 'inbox', 'notification', 'realtime', 'socket', 'room'] },
  { label: 'Analytics / Metrics', keywords: ['analytics', 'metric', 'stat', 'report', 'chart', 'dashboard', 'kpi', 'track', 'event'] },
  { label: 'File / Storage',      keywords: ['file', 'upload', 'storage', 'image', 'photo', 'media', 'attachment', 'download', 'bucket'] },
  { label: 'API / Integration',   keywords: ['api', 'webhook', 'integration', 'endpoint', 'rest', 'graphql', 'third-party', 'external'] },
  { label: 'AI / ML',             keywords: ['ai', 'ml', 'machine learning', 'recommendation', 'prediction', 'model', 'embedding', 'openai'] },
]

function classifyPrompt(text: string): string {
  const lower = text.toLowerCase()
  let bestLabel = 'Other'
  let bestScore = 0
  for (const bucket of TOPIC_BUCKETS) {
    const score = bucket.keywords.filter(kw => lower.includes(kw)).length
    if (score > bestScore) {
      bestScore = score
      bestLabel = bucket.label
    }
  }
  return bestLabel
}

// ── Backend category extraction from graphData ────────────────────────────────

function extractBackendCategory(graphData: any): string {
  try {
    const tables: string[] = []
    if (Array.isArray(graphData?.tables)) {
      tables.push(...graphData.tables.map((t: any) => (t.name || t.tableName || '').toLowerCase()))
    }
    if (typeof graphData === 'object' && graphData !== null) {
      for (const key of Object.keys(graphData)) {
        if (typeof graphData[key] === 'string') tables.push(graphData[key].toLowerCase())
      }
    }
    const combined = tables.join(' ')
    // Classify by table names
    if (/product|cart|order|inventory|sku/.test(combined)) return 'E-commerce'
    if (/post|comment|like|follow|feed/.test(combined)) return 'Social'
    if (/subscription|tenant|workspace|plan/.test(combined)) return 'SaaS'
    if (/article|blog|cms|draft|publish/.test(combined)) return 'Blog / CMS'
    if (/task|todo|board|issue|ticket/.test(combined)) return 'Task Mgmt'
    if (/booking|appointment|slot|schedule/.test(combined)) return 'Booking'
    if (/message|chat|conversation|inbox/.test(combined)) return 'Messaging'
    if (/file|upload|storage|media/.test(combined)) return 'File Storage'
    if (/metric|analytic|stat|report/.test(combined)) return 'Analytics'
    if (/user|profile|auth|account/.test(combined)) return 'Auth / Users'
  } catch { /* ignore */ }
  return 'General'
}

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const now = new Date()
  const cutoff48h = new Date(now.getTime() - 48 * 60 * 60 * 1000)

  // ── Parallel data fetches ──────────────────────────────────────────────────
  const [
    stuckUserRaw,
    allProjects,
    recentUserMessages,
    recentGraphs,
    errorMessages,
    totalAiMessages,
    activatedUsers,
  ] = await Promise.all([
    // Users signed up >48h ago with NO backend generated
    prisma.user.findMany({
      where: {
        deletedAt: null,
        createdAt: { lt: cutoff48h },
        projects: {
          none: { isBackendGenerated: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        lastLogin: true,
        lastActiveAt: true,
        tier: true,
        _count: { select: { projects: true } },
      },
    }),

    // All projects with funnel status for heatmap
    prisma.project.findMany({
      where: { expiresAt: null, deletedAt: null },
      select: {
        id: true,
        name: true,
        isBackendGenerated: true,
        isFrontendConnected: true,
        isDeployed: true,
        hasExternalUsers: true,
        createdAt: true,
        userId: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),

    // Recent user-role conversation messages (for topic analysis)
    prisma.conversationMessage.findMany({
      where: { role: 'user' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { content: true, createdAt: true, metadata: true },
    }),

    // Recent BackendGraphs (for backend category analysis)
    prisma.backendGraph.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { graphData: true, createdAt: true },
    }),

    // AI messages with error indicators in metadata
    prisma.conversationMessage.count({
      where: {
        role: 'ai',
        OR: [
          { metadata: { path: ['error'], not: null } },
          { content: { contains: '"error"' } },
          { content: { startsWith: 'Error:' } },
          { content: { startsWith: 'I encountered an error' } },
        ],
      },
    }),

    // Total AI-role messages
    prisma.conversationMessage.count({ where: { role: 'ai' } }),

    // Users who activated (generated a backend) and when
    prisma.productEvent.findMany({
      where: { eventType: 'backend_generated' },
      select: { userId: true, timestamp: true },
      orderBy: { timestamp: 'asc' },
      take: 1000,
    }),
  ])

  // ── Time-to-activate calculation ──────────────────────────────────────────
  let timeToActivate = { median: null as number | null, p25: null as number | null, p75: null as number | null, sampleSize: 0 }

  if (activatedUsers.length > 0) {
    // Get signup dates for activated users
    const activatedUserIds = [...new Set(activatedUsers.map(e => e.userId))]
    const signupDates = await prisma.user.findMany({
      where: { id: { in: activatedUserIds } },
      select: { id: true, createdAt: true },
    })
    const signupMap = new Map(signupDates.map(u => [u.id, u.createdAt]))

    // First activation event per user
    const firstActivation = new Map<string, Date>()
    for (const event of activatedUsers) {
      if (!firstActivation.has(event.userId)) {
        firstActivation.set(event.userId, event.timestamp)
      }
    }

    const hoursToActivate: number[] = []
    for (const [userId, activatedAt] of firstActivation) {
      const signedUpAt = signupMap.get(userId)
      if (signedUpAt) {
        const hours = (activatedAt.getTime() - signedUpAt.getTime()) / 3_600_000
        if (hours >= 0 && hours < 720) hoursToActivate.push(hours) // cap at 30 days
      }
    }

    if (hoursToActivate.length > 0) {
      hoursToActivate.sort((a, b) => a - b)
      const n = hoursToActivate.length
      timeToActivate = {
        median: Math.round(hoursToActivate[Math.floor(n * 0.5)] * 10) / 10,
        p25:    Math.round(hoursToActivate[Math.floor(n * 0.25)] * 10) / 10,
        p75:    Math.round(hoursToActivate[Math.floor(n * 0.75)] * 10) / 10,
        sampleSize: n,
      }
    }
  }

  // ── Prompt topics ─────────────────────────────────────────────────────────
  const topicCounts: Record<string, number> = {}
  for (const msg of recentUserMessages) {
    const topic = classifyPrompt(msg.content)
    topicCounts[topic] = (topicCounts[topic] ?? 0) + 1
  }
  const promptTopics = Object.entries(topicCounts)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)

  // ── Backend categories ────────────────────────────────────────────────────
  const categoryCounts: Record<string, number> = {}
  for (const graph of recentGraphs) {
    const cat = extractBackendCategory(graph.graphData)
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1
  }
  const backendCategories = Object.entries(categoryCounts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)

  // ── Error rate ────────────────────────────────────────────────────────────
  const errorRate = {
    total: totalAiMessages,
    errors: errorMessages,
    rate: totalAiMessages > 0 ? Math.round((errorMessages / totalAiMessages) * 1000) / 10 : 0,
  }

  // ── Project health heatmap data ───────────────────────────────────────────
  let deployedAndLive = 0, deployedOnly = 0, backendOnly = 0, empty = 0

  for (const p of allProjects) {
    if (p.isDeployed && p.hasExternalUsers) deployedAndLive++
    else if (p.isDeployed) deployedOnly++
    else if (p.isBackendGenerated) backendOnly++
    else empty++
  }

  const projectHealth = {
    deployedAndLive,
    deployedOnly,
    backendOnly,
    empty,
    total: allProjects.length,
    projects: allProjects.map(p => ({
      id: p.id,
      name: p.name,
      isBackendGenerated: p.isBackendGenerated,
      isFrontendConnected: p.isFrontendConnected,
      isDeployed: p.isDeployed,
      hasExternalUsers: p.hasExternalUsers,
      createdAt: p.createdAt,
      userId: p.userId,
    })),
  }

  // ── Recent prompts (excerpt for display) ─────────────────────────────────
  const recentPrompts = recentUserMessages.slice(0, 30).map(m => ({
    excerpt: m.content.slice(0, 120).replace(/\n/g, ' '),
    createdAt: m.createdAt,
  }))

  // ── Stuck users formatted ─────────────────────────────────────────────────
  const stuckUsers = stuckUserRaw.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    createdAt: u.createdAt,
    lastActive: u.lastActiveAt ?? u.lastLogin,
    tier: u.tier,
    projectCount: u._count.projects,
  }))

  return NextResponse.json({
    stuckUsers,
    timeToActivate,
    promptTopics,
    backendCategories,
    errorRate,
    projectHealth,
    recentPrompts,
  })
}
