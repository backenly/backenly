'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  Users, TrendingUp, X, ChevronRight, Activity, Database, Globe,
  Rocket, Code2, Clock, Calendar, ArrowUpRight, RefreshCw, Shield,
  CreditCard, Zap, AlertTriangle, CheckCircle, XCircle, Search,
  Filter, BarChart2, Layers, Heart, Terminal, Webhook, FileText,
  Settings, Minus, Plus, Ban, RotateCcw,
  MessageSquare, Package, Copy, Check, Mail, ArrowDownRight,
  Sparkles, DollarSign, UserPlus, ExternalLink, Inbox, Loader2,
  TrendingDown, Server, Wrench, Bot, ShieldCheck, ShieldAlert, GitCommitHorizontal,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'growth' | 'billing' | 'users' | 'funnel' | 'projects' | 'insights' | 'health' | 'webhooks' | 'audit' | 'ops' | 'control' | 'security' | 'activity' | 'builds' | 'feedback' | 'revenue' | 'system' | 'agents'

// ─── Agent operations ─────────────────────────────────────────────────────────
// Backs the Agents tab. Counts only work executed through an MCP-scoped API key
// — i.e. by Claude Code / Cursor / Codex / Cline against a live backend — as
// opposed to the Projects tab, which counts projects created and deployed.

interface AgentCounters {
  ops: number; statements: number
  schemaOps: number; schemaStatements: number
  policyOps: number; dataOps: number; chatOps: number; otherOps: number; reads: number
  applied: number; refused: number; unresolved: number; errored: number
  lastAt: string | null
}

interface AgentOpsData {
  window: { days: number; since: string; until: string }
  totals: AgentCounters & { activeUsers: number; activeProjects: number; activeClients: number }
  integrity: {
    unresolvedRunCount: number
    rollbacks: number
    failedRollbacks: number
    rolledBackIntents: number
    criticalFindings: number
    integrityEvents: number
    cleanRate: number | null
    unresolvedRuns: {
      id: string; projectId: string | null; projectName: string | null; ownerEmail: string | null
      client: string; tool: string; code: string; summary: string; statusCode: number; at: string
    }[]
  }
  byClient: (AgentCounters & { client: string; userCount: number; projectCount: number })[]
  byUser: (AgentCounters & {
    userId: string; email: string | null; name: string | null; tier: string | null
    projectCount: number; clientCount: number; clients: string[]
  })[]
  byProject: (AgentCounters & {
    projectId: string; name: string; isDeployed: boolean
    ownerUserId: string; ownerEmail: string | null
    clientCount: number; clients: string[]
    rollbacks: number; failedRollbacks: number; rolledBackIntents: number
    criticalFindings: number; integrityEvents: number
  })[]
  byTool: (AgentCounters & { tool: string; kind: string })[]
  guardrails: { code: string; label: string; count: number }[]
  monthly: { month: string; schemaOps: number; schemaStatements: number; applied: number; unresolved: number }[]
  caveats: string[]
  evaluatedAt: string
}

interface SystemData {
  aiCost: {
    spend30dUsd: number; spendMonthUsd: number; tokens30d: number
    mrrUsd: number; marginUsd: number
    byModel: { model: string; costUsd: number; tokens: number }[]
    topProjects: { projectId: string; projectName: string; ownerEmail: string | null; ownerUserId: string | null; costUsd: number; tokens: number }[]
    note: string
  }
  metrics: {
    db: { connections: number; max: number }
    jobs: Record<string, number>
    errors24h: number
    workspaceSchemas: number
  }
  noisyNeighbors: { projectId: string | null; projectName: string; dbWrites: number; apiCalls: number }[]
  schemaHealth: {
    totalBytes: number
    orphanCount: number
    schemas: { schema: string; projectId: string; bytes: number; orphaned: boolean }[]
  }
  deployments: {
    failed7d: number
    recent: { id: string; projectId: string; status: string; environment: string; url: string | null; errorMessage: string | null; duration: number | null; at: string }[]
  }
}

interface RevenueData {
  mrr: {
    totalCents: number
    byPlan: { plan: string; priceCents: number; count: number; mrrCents: number }[]
    movement: { newThisMonth: number; churnedThisMonth: number; net: number }
  }
  conversion: { totalUsers: number; paidUsers: number; conversionPct: number }
  economics: { arpuCents: number; ltvCents: number; ltvNote: string }
  dunning: { userId: string; userEmail: string; userName: string | null; plan: string; priceCents: number; status: string; graceUntil: string | null; paddleSubscriptionId: string | null; updatedAt: string }[]
}

interface FeedbackData {
  unsupported: { id: string; category: string; promptExcerpt: string; refusalMessage: string | null; userEmail: string | null; projectName: string | null; at: string }[]
  unsupportedByCategory: { category: string; count: number }[]
  categoryTrends: { month: string; categories: Record<string, number>; total: number }[]
  topCategories: { category: string; count: number }[]
  churn: { userId: string; userEmail: string; userName: string | null; plan: string; priceCents: number; status: string; startedAt: string; endedAt: string; daysActive: number }[]
  churnNote: string
  supportTickets: { id: string; subject: string; message: string; status: string; userId: string; userEmail: string; userName: string | null; createdAt: string }[]
  featureRequests: { id: string; title: string; body: string; status: string; userId: string; userEmail: string; userName: string | null; createdAt: string }[]
}

interface ActivityItem {
  id: string
  source: 'event' | 'audit' | 'security'
  kind: string
  summary: string
  severity?: string
  userId: string | null
  userEmail: string | null
  projectId: string | null
  projectName: string | null
  ts: string
}

interface BuildsData {
  stuckNow: { projectId: string; projectName: string; ownerEmail: string | null; ownerUserId: string | null; corrections: number; lastAt: string | null }[]
  failedBuilds: { id: string; projectId: string; projectName: string; ownerEmail: string | null; ownerUserId: string | null; prompt: string | null; error: string; at: string }[]
  prompts: { id: string; projectId: string; projectName: string; ownerEmail: string | null; excerpt: string; at: string }[]
  query: string | null
}

interface TimelineItem {
  id: string
  source: 'event' | 'audit' | 'security'
  kind: string
  summary: string
  severity?: string
  projectId: string | null
  ts: string
}

interface SecurityEventRow {
  id: string
  kind: string
  severity: 'info' | 'warn' | 'high' | 'critical'
  userId: string | null
  userEmail: string | null
  projectId: string | null
  ip: string | null
  summary: string
  detail: Record<string, unknown> | null
  resolved: boolean
  resolvedAt: string | null
  resolvedBy: string | null
  createdAt: string
}

interface SecurityData {
  events: SecurityEventRow[]
  summary: {
    total: number
    unresolved: number
    last24h: number
    byKind: Record<string, number>
    bySeverity: Record<string, number>
    topIps: { ip: string; count: number }[]
  }
}

interface ControlState {
  aiFrozen: boolean
  signupsDisabled: boolean
  maintenanceMode: boolean
  readOnly: boolean
  note: string | null
  updatedAt: string
  updatedBy: string | null
}

interface BlocklistEntry {
  id: string
  kind: 'ip' | 'email' | 'domain'
  value: string
  reason: string | null
  createdAt: string
  createdBy: string | null
}

interface FunnelStage { stage: string; count: number }

interface OverviewData {
  funnel: FunnelStage[]
  totalUsers: number
  totalProjects: number
  totalAiCalls: number
  recentEvents: RecentEvent[]
}

interface RetentionMetric {
  days: number
  eligibleUsers: number
  retainedUsers: number
  pct: number
}

interface DashboardData {
  users: {
    total: number
    suspended: number
    newThisWeek: number
    activeWeekly: number
    retention: RetentionMetric[]
    tierBreakdown: Record<string, number>
  }
  subscriptions: { active: number; gracePeriod: number }
  projects: { total: number; deployed: number }
  aiUsage: { month: string; intentCount: number; tokenCount: number; apiRequestCount: number }
  webhooks: { processedEvents: number }
  apiKeys: { total: number }
  recentPaymentEvents: PaddleEvent[]
  recentAuditLogs: AuditEntry[]
}

interface RecentEvent {
  id: string; eventType: string; userId: string; projectId: string | null; timestamp: string
  metadata: Record<string, unknown> | null
  projectName?: string | null
  userEmail?: string | null
  userName?: string | null
}

interface UserRow {
  id: string; name: string | null; email: string; createdAt: string; lastActive: string | null
  tier: string; projectCount: number
  usage: { apiCalls: number | null; dbReads: number | null; dbWrites: number | null; aiCalls: number | null }
  // Signup provenance (lib/trust/email-trust.ts). Older rows predate these
  // columns, so every field is optional and absence reads as "trusted".
  emailVerified?: boolean
  trustLevel?: string
  signupScore?: number | null
  signupSignals?: string[]
}

interface ProjectDetail {
  id: string; name: string; description: string | null; createdAt: string
  isBackendGenerated: boolean; isFrontendConnected: boolean; isDeployed: boolean
  hasExternalUsers: boolean; publicUrl: string | null; projectStatus: string
  apiRequests: number; storageUsed: number; activeUsers: number
}

interface UserDetail {
  user: { id: string; name: string | null; email: string; createdAt: string; lastLogin: string | null; lastActiveAt: string | null; tier: string; provider: string; suspendedAt?: string | null }
  projects: ProjectDetail[]
  usage: { apiCalls: number; dbReads: number; dbWrites: number; aiCalls: number; computeTime: number; storageUsed: number }
  recentEvents: RecentEvent[]
  timeline?: TimelineItem[]
  credits?: CreditInfo
}

interface CreditInfo {
  plan: string
  limits: { aiBuildActionsPerMonth: number | null; apiRequestsPerMonth: number | null }
  currentMonth: { month: string; intentCount: number; tokenCount: number; apiRequestCount: number }
  history: { month: string; intentCount: number; tokenCount: number; apiRequestCount: number }[]
}

interface ChatMessage { id: string; role: 'user' | 'ai'; content: string; createdAt: string }
interface ProjectConversation { projectId: string; projectName: string; createdAt: string; messageCount: number; messages: ChatMessage[] }
interface ConversationsData { projects: ProjectConversation[]; totalMessages: number; truncated: boolean }

interface PaymentsData {
  subscriptions: PaymentRow[]
  revenueBreakdown: { plan: string; priceCents: number; status: string; count: number; estimatedMRRCents: number }[]
  total: number
}

interface PaymentRow {
  id: string; user: { email: string; name: string | null }; plan: string | null
  priceCents: number | null; status: string; currentPeriodEnd: string | null; createdAt: string
}

interface PaddleEvent {
  id: string; userId: string; paddleSubscriptionId: string; status: string; nextBillDate: string | null; updatedAt: string
  user?: { email: string; name: string | null }
}

interface AuditEntry {
  id: string; action: string; type: string; timestamp: string; userId: string | null
  userEmail: string | null; projectId: string | null; details: string | null
}

interface HealthData {
  ok: boolean
  signals: string[]
  snapshot: {
    summary: { stuckCount: number; abandonedCount: number; repeatedHealingFailureCount: number; webhookFailureProjectCount: number }
    stuckExecutions: { projectId: string; executionId?: string; stuckSince?: string }[]
    failedWebhookClusters: { projectId: string; failCount?: number }[]
  }
}

interface JobsData {
  jobs: { id: string; status: string; _projectId: string; _table: string; createdAt: string; error_message?: string }[]
  total: number
}

interface WebhooksData {
  paddle?: { events: { id: string; eventId: string; processedAt: string }[]; total: number }
  project?: {
    webhooks: { id: string; projectId: string; eventType: string; targetUrl: string; active: boolean; project: { name: string } }[]
    total: number
    recentDeliveries: { id: string; webhookId: string; eventType: string; status: string; statusCode: number | null; createdAt: string }[]
  }
  auditLogs: AuditEntry[]
}

interface InsightsData {
  stuckUsers: { id: string; name: string | null; email: string; createdAt: string; lastActive: string | null; tier: string; projectCount: number }[]
  timeToActivate: { median: number | null; p25: number | null; p75: number | null; sampleSize: number }
  promptTopics: { topic: string; count: number }[]
  backendCategories: { category: string; count: number }[]
  errorRate: { total: number; errors: number; rate: number }
  projectHealth: {
    deployedAndLive: number; deployedOnly: number; backendOnly: number; empty: number; total: number
    projects: { id: string; name: string; isBackendGenerated: boolean; isFrontendConnected: boolean; isDeployed: boolean; hasExternalUsers: boolean; createdAt: string }[]
  }
  recentPrompts: { excerpt: string; createdAt: string }[]
}

interface GrowthData {
  daily90: { date: string; count: number }[]
  weekly:  { date: string; count: number }[]
  monthly: { date: string; count: number }[]
  dau: number
  wau: number
  mau: number
  totalProjects: number
  featureAdoption: { feature: string; projectCount: number; pct: number; description: string }[]
}

type ChartView = 'daily30' | 'daily90' | 'weekly' | 'monthly'

interface OperatorData {
  window: { since: string; until: string }
  builds: { activeBuilds: number; autoFixCount: number; repairLoopCount: number; correctionEventTotal: number }
  approvals: { pending: number; applied: number; dismissed: number }
  aiUsage: { intentCount: number; tokenCount: number; apiRequestCount: number }
  projects: { total: number; deployed: number }
  mutations: { count: number; perDay: number }
  blockedIntegrations: { count: number; recent: { action: string; projectId: string; timestamp: string }[] }
  topFailedIntents: { action: string; count: number }[]
  domainBreakdown: { domain: string; count: number }[]
  timeline: { hour: string; count: number }[]
  recentAuditLogs: { id: string; action: string; type: string; timestamp: string; userId: string | null; userEmail: string | null; projectId: string | null }[]
  evaluatedAt: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read an admin API response as JSON without assuming it IS JSON.
 *
 * Every /api/admin route is supposed to answer JSON, but the two failure modes
 * that matter most on this page do not: a route that dies before its handler
 * runs (a chunk missing because a build overwrote `.next` under the running
 * server, a module that throws at import) gets Next's plain-text "Internal
 * Server Error", and anything nginx rejects on its own gets an HTML page.
 * Calling r.json() on those throws `Unexpected token 'I'` / `'<'`, and that
 * parser message is what the operator sees instead of the status code — which
 * is the one piece of information that would have told them what broke.
 *
 * So: read the body once as text, parse if it parses, and otherwise synthesise
 * an { error } shaped like the real ones, carrying the status and a snippet of
 * whatever the server actually said.
 */
async function readJson(r: Response): Promise<any> {
  const text = await r.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    const snippet = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
    const status = `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''}`
    return { error: snippet ? `${status} — ${snippet}` : status }
  }
}

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString()
const percent = (v: number | null | undefined) => {
  const value = Number(v ?? 0)
  if (!Number.isFinite(value)) return '0%'
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}
const cents = (c: number) => `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
const centsExact = (c: number) => `$${(c / 100).toFixed(2)}`

function ago(d: string | null | undefined) {
  if (!d) return 'Never'
  const ms = Date.now() - new Date(d).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d ago`
  return new Date(d).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtBytes(b: number) {
  if (!b || b < 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = b
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

function fmtTime(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
}

// Turn a raw product event into a human sentence using the project name +
// metadata the logger records. Without this the feed is just "Backend · 3d ago".
function describeEvent(e: RecentEvent): string {
  const meta = (e.metadata ?? {}) as Record<string, any>
  const proj = e.projectName ? `“${e.projectName}”` : (meta.name ? `“${meta.name}”` : 'a project')
  switch (e.eventType) {
    case 'signup':
      return meta.provider ? `Signed up via ${meta.provider}` : 'Signed up'
    case 'project_created':
      return `Created project ${proj}`
    case 'backend_generated':
      return `Generated a backend for ${proj}`
    case 'frontend_connected':
      return `Connected a frontend to ${proj}`
    case 'deployed':
      return `Deployed ${proj}`
    case 'external_usage_started':
      return `Got first real users on ${proj}`
    case 'ai_prompt':
      return typeof meta.messageLength === 'number'
        ? `Sent an AI prompt (${meta.messageLength} chars)`
        : 'Sent an AI prompt'
    case 'api_call':
      return e.projectName ? `API traffic on ${proj}` : 'API traffic'
    default:
      return e.eventType.replace(/_/g, ' ')
  }
}

const EVENT_COLOR: Record<string, { bg: string; dot: string; label: string }> = {
  signup:                 { bg: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20', dot: 'bg-emerald-400', label: 'Signup' },
  project_created:        { bg: 'bg-blue-500/10 text-blue-300 border-blue-500/20',          dot: 'bg-blue-400',    label: 'Project' },
  backend_generated:      { bg: 'bg-violet-500/10 text-violet-300 border-violet-500/20',    dot: 'bg-violet-400',  label: 'Backend' },
  frontend_connected:     { bg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',       dot: 'bg-amber-400',   label: 'Frontend' },
  deployed:               { bg: 'bg-orange-500/10 text-orange-300 border-orange-500/20',    dot: 'bg-orange-400',  label: 'Deploy' },
  external_usage_started: { bg: 'bg-pink-500/10 text-pink-300 border-pink-500/20',          dot: 'bg-pink-400',    label: 'Live Users' },
  ai_prompt:              { bg: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20',          dot: 'bg-cyan-400',    label: 'AI Prompt' },
}

const SEVERITY_STYLE: Record<string, string> = {
  info:     'bg-zinc-800 text-zinc-400 border-zinc-700',
  warn:     'bg-amber-500/10 text-amber-500 border-amber-500/20',
  high:     'bg-orange-500/10 text-orange-300 border-orange-500/20',
  critical: 'bg-red-500/10 text-red-300 border-red-500/20',
}

const STATUS_COLOR: Record<string, string> = {
  ACTIVE:    'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  GRACE:     'bg-amber-500/10 text-amber-500 border-amber-500/20',
  CANCELED:  'bg-zinc-800 text-zinc-400 border-zinc-700',
  PAST_DUE:  'bg-red-500/10 text-red-300 border-red-500/20',
  active:    'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  success:   'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  failed:    'bg-red-500/10 text-red-300 border-red-500/20',
  pending:   'bg-amber-500/10 text-amber-500 border-amber-500/20',
}

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview',  label: 'Overview',  icon: <Activity className="w-3.5 h-3.5" /> },
  { id: 'agents',    label: 'Agents',    icon: <Bot className="w-3.5 h-3.5" /> },
  { id: 'activity',  label: 'Activity',  icon: <Inbox className="w-3.5 h-3.5" /> },
  { id: 'growth',    label: 'Growth',    icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { id: 'billing',   label: 'Billing',   icon: <CreditCard className="w-3.5 h-3.5" /> },
  { id: 'revenue',   label: 'Revenue',   icon: <DollarSign className="w-3.5 h-3.5" /> },
  { id: 'users',     label: 'Users',     icon: <Users className="w-3.5 h-3.5" /> },
  { id: 'funnel',    label: 'Funnel',    icon: <BarChart2 className="w-3.5 h-3.5" /> },
  { id: 'projects',  label: 'Projects',  icon: <Layers className="w-3.5 h-3.5" /> },
  { id: 'insights',  label: 'Insights',  icon: <Sparkles className="w-3.5 h-3.5" /> },
  { id: 'builds',    label: 'Builds',    icon: <Wrench className="w-3.5 h-3.5" /> },
  { id: 'feedback',  label: 'Feedback',  icon: <MessageSquare className="w-3.5 h-3.5" /> },
  { id: 'health',    label: 'Health',    icon: <Heart className="w-3.5 h-3.5" /> },
  { id: 'system',    label: 'System',    icon: <Server className="w-3.5 h-3.5" /> },
  { id: 'webhooks',  label: 'Webhooks',  icon: <Webhook className="w-3.5 h-3.5" /> },
  { id: 'audit',     label: 'Audit',     icon: <FileText className="w-3.5 h-3.5" /> },
  { id: 'ops',       label: 'Ops',       icon: <Terminal className="w-3.5 h-3.5" /> },
  { id: 'security',  label: 'Security',  icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  { id: 'control',   label: 'Control',   icon: <Shield className="w-3.5 h-3.5" /> },
]

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('overview')

  // Per-tab data
  const [overview, setOverview]   = useState<OverviewData | null>(null)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [users, setUsers]         = useState<UserRow[]>([])
  const [payments, setPayments]   = useState<PaymentsData | null>(null)
  const [health, setHealth]       = useState<HealthData | null>(null)
  const [jobs, setJobs]           = useState<JobsData | null>(null)
  const [webhooks, setWebhooks]   = useState<WebhooksData | null>(null)
  const [insights, setInsights]   = useState<InsightsData | null>(null)
  const [growth, setGrowth]       = useState<GrowthData | null>(null)
  const [chartView, setChartView] = useState<ChartView>('daily30')

  // Loading / error / freshness
  const [loading, setLoading]   = useState<Partial<Record<Tab, boolean>>>({ overview: true })
  const [errors, setErrors]     = useState<Partial<Record<Tab, string>>>({})
  const [lastFetched, setLastFetched] = useState<Partial<Record<Tab, number>>>({})
  const [, forceRender] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceRender(x => x + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // User detail slide-over
  const [detail, setDetail]               = useState<UserDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [detailError, setDetailError]     = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionMsg, setActionMsg]         = useState<string | null>(null)

  // AI conversations (lazy-loaded on section expand)
  const [convos, setConvos]             = useState<ConversationsData | null>(null)
  const [convosLoading, setConvosLoading] = useState(false)
  const [convosError, setConvosError]   = useState<string | null>(null)
  const [convosOpen, setConvosOpen]     = useState(false)
  const [openConvoProjects, setOpenConvoProjects] = useState<Set<string>>(new Set())
  const [convoSearch, setConvoSearch]   = useState('')

  // Users tab filters
  const [userSearch, setUserSearch] = useState('')
  const [tierFilter, setTierFilter] = useState('all')
  // 'all' | 'real' | 'flagged' | 'unverified' — lets the Users tab separate
  // customers from signup noise instead of showing one undifferentiated list.
  const [trustFilter, setTrustFilter] = useState('all')
  const [userSort, setUserSort]     = useState<'recent' | 'active' | 'projects' | 'ai'>('recent')

  // Credits modal
  const [creditModal, setCreditModal]   = useState(false)
  const [creditAction, setCreditAction] = useState<'reset' | 'reduce'>('reset')
  const [creditAmount, setCreditAmount] = useState('10')

  // Ops state
  const [opsResults, setOpsResults] = useState<Record<string, any>>({})
  const [opsLoading, setOpsLoading] = useState<Record<string, boolean>>({})
  const [operatorData, setOperatorData] = useState<OperatorData | null>(null)
  const [operatorWindow, setOperatorWindow] = useState<'1h' | '24h' | '7d'>('24h')

  // Jobs filter
  const [jobsStatus, setJobsStatus] = useState<'failed' | 'stuck' | 'processing'>('failed')

  // Control tab state
  const [controls, setControls] = useState<ControlState | null>(null)
  const [blocklist, setBlocklist] = useState<BlocklistEntry[]>([])
  const [controlActionMsg, setControlActionMsg] = useState<string | null>(null)
  const [controlBusy, setControlBusy] = useState<string | null>(null)
  const [blockForm, setBlockForm] = useState<{ kind: 'ip' | 'email' | 'domain'; value: string; reason: string }>({ kind: 'email', value: '', reason: '' })
  const [lockForm, setLockForm] = useState<{ projectId: string; reason: string }>({ projectId: '', reason: '' })
  const [logoutTargetId, setLogoutTargetId] = useState('')

  // Activity + Builds tab state
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [actSource, setActSource] = useState<'all' | 'event' | 'audit' | 'security'>('all')
  const [actQuery, setActQuery] = useState('')
  const [actQueryDebounced, setActQueryDebounced] = useState('')
  const [builds, setBuilds] = useState<BuildsData | null>(null)
  const [buildsQuery, setBuildsQuery] = useState('')
  const [buildsQueryDebounced, setBuildsQueryDebounced] = useState('')
  const [feedback, setFeedback] = useState<FeedbackData | null>(null)
  const [system, setSystem] = useState<SystemData | null>(null)
  const [revenue, setRevenue] = useState<RevenueData | null>(null)
  const [agentOps, setAgentOps] = useState<AgentOpsData | null>(null)
  const [agentDays, setAgentDays] = useState<30 | 90 | 365>(30)
  const [agentBreakdown, setAgentBreakdown] = useState<'project' | 'user' | 'client' | 'tool'>('project')
  const [revActionMsg, setRevActionMsg] = useState<string | null>(null)
  const [revBusy, setRevBusy] = useState<string | null>(null)
  const [compForm, setCompForm] = useState<{ userId: string; planName: string }>({ userId: '', planName: 'PRO' })

  // Security tab state
  const [security, setSecurity] = useState<SecurityData | null>(null)
  const [secKindFilter, setSecKindFilter] = useState<string>('all')
  const [secResolvedFilter, setSecResolvedFilter] = useState<'open' | 'all'>('open')

  // Copy feedback
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null)
  const copyEmail = (e: React.MouseEvent, email: string) => {
    e.stopPropagation()
    navigator.clipboard.writeText(email)
    setCopiedEmail(email)
    setTimeout(() => setCopiedEmail(null), 1500)
  }

  // ── Step-up ("sudo") state ─────────────────────────────────────────────────
  // Admin reads need only the founder session. Admin WRITES need a second
  // factor, earned by re-entering a password/TOTP at /api/admin/reauth and
  // good for 15 minutes. See lib/admin/auth/adminStepUp.ts.
  const [sudoOpen, setSudoOpen] = useState(false)
  const [sudoMethods, setSudoMethods] = useState<{ password: boolean; totp: boolean }>({ password: false, totp: false })
  const [sudoSecret, setSudoSecret] = useState('')
  const [sudoErr, setSudoErr] = useState<string | null>(null)
  const [sudoBusy, setSudoBusy] = useState(false)
  const sudoResolverRef = useRef<((granted: boolean) => void) | null>(null)

  const fetchedRef = useRef<Set<string>>(new Set())
  const setLoad = (t: Tab, v: boolean) => setLoading(p => ({ ...p, [t]: v }))
  const setErr  = (t: Tab, e: string)  => setErrors(p => ({ ...p, [t]: e }))
  const markFetched = (t: Tab) => setLastFetched(p => ({ ...p, [t]: Date.now() }))

  /** Open the step-up prompt and resolve once the founder confirms or cancels. */
  const promptForSudo = useCallback(async (): Promise<boolean> => {
    const info = await fetch('/api/admin/reauth').then(readJson).catch(() => ({}))
    setSudoMethods({ password: !!info?.methods?.password, totp: !!info?.methods?.totp })
    setSudoSecret('')
    setSudoErr(null)
    setSudoOpen(true)
    return new Promise<boolean>(resolve => { sudoResolverRef.current = resolve })
  }, [])

  /**
   * Every admin mutation goes through here. A write that comes back
   * 401 SUDO_REQUIRED is not an error to show the operator — it means the
   * 15-minute window lapsed, so prompt, then replay the exact same request
   * once. Bodies are plain JSON strings, so the init object is replayable.
   */
  const adminMutate = useCallback(async (
    url: string,
    init: RequestInit,
  ): Promise<{ r: Response; d: any }> => {
    let r = await fetch(url, init)
    let d = await readJson(r)
    if (r.status === 401 && d?.code === 'SUDO_REQUIRED') {
      const granted = await promptForSudo()
      if (!granted) return { r, d: { ...d, error: 'Admin change cancelled.' } }
      r = await fetch(url, init)
      d = await readJson(r)
    }
    return { r, d }
  }, [promptForSudo])

  const submitSudo = useCallback(async () => {
    const secret = sudoSecret.trim()
    if (!secret) return
    setSudoBusy(true)
    setSudoErr(null)
    try {
      // A 6-digit string is a TOTP code; anything else is a password. Sending
      // the right field matters — the server prefers TOTP when 2FA is on.
      const payload = sudoMethods.totp && /^\d{6}$/.test(secret) ? { totp: secret } : { password: secret }
      const r = await fetch('/api/admin/reauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const d = await readJson(r)
      if (!r.ok) throw new Error(d.error || `${r.status}`)
      setSudoOpen(false)
      setSudoSecret('')
      sudoResolverRef.current?.(true)
      sudoResolverRef.current = null
    } catch (e: any) {
      setSudoErr(e.message)
    } finally {
      setSudoBusy(false)
    }
  }, [sudoSecret, sudoMethods.totp])

  const cancelSudo = useCallback(() => {
    setSudoOpen(false)
    setSudoSecret('')
    setSudoErr(null)
    sudoResolverRef.current?.(false)
    sudoResolverRef.current = null
  }, [])

  // ── Fetch functions ────────────────────────────────────────────────────────

  const fetchOverview = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('overview')) return
    fetchedRef.current.add('overview')
    setLoad('overview', true); setErr('overview', '')
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/admin/analytics'),
        fetch('/api/admin/dashboard'),
      ])
      if (!r1.ok) throw new Error(`${r1.status}`)
      const [d1, d2] = await Promise.all([readJson(r1), r2.ok ? readJson(r2) : null])
      setOverview(d1)
      if (d2) setDashboard(d2)
      markFetched('overview')
      markFetched('audit')
    } catch (e: any) {
      setErr('overview', e.message)
    } finally {
      setLoad('overview', false)
    }
  }, [])

  const fetchBilling = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('billing')) return
    fetchedRef.current.add('billing')
    setLoad('billing', true); setErr('billing', '')
    try {
      const r = await fetch('/api/admin/payments')
      if (!r.ok) throw new Error(`${r.status}`)
      setPayments(await readJson(r))
      markFetched('billing')
    } catch (e: any) {
      setErr('billing', e.message)
    } finally {
      setLoad('billing', false)
    }
  }, [])

  const fetchUsers = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('users')) return
    fetchedRef.current.add('users')
    setLoad('users', true); setErr('users', '')
    try {
      const r = await fetch('/api/admin/analytics/users')
      if (!r.ok) throw new Error(`${r.status}`)
      const d = await readJson(r)
      setUsers(d.users ?? [])
      markFetched('users')
    } catch (e: any) {
      setErr('users', e.message)
    } finally {
      setLoad('users', false)
    }
  }, [])

  const fetchInsights = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('insights')) return
    fetchedRef.current.add('insights')
    setLoad('insights', true); setLoad('funnel', true); setLoad('projects', true)
    try {
      const r = await fetch('/api/admin/insights')
      if (!r.ok) throw new Error(`${r.status}`)
      setInsights(await readJson(r))
      markFetched('insights'); markFetched('funnel'); markFetched('projects')
    } catch (e: any) {
      setErr('insights', e.message); setErr('funnel', e.message); setErr('projects', e.message)
    } finally {
      setLoad('insights', false); setLoad('funnel', false); setLoad('projects', false)
    }
  }, [])

  const fetchHealth = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('health')) return
    fetchedRef.current.add('health')
    setLoad('health', true); setErr('health', '')
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/admin/health'),
        fetch(`/api/admin/jobs?status=${jobsStatus}&limit=20`),
      ])
      if (r1.ok) setHealth(await readJson(r1))
      if (r2.ok) setJobs(await readJson(r2))
      markFetched('health')
    } catch (e: any) {
      setErr('health', e.message)
    } finally {
      setLoad('health', false)
    }
  }, [jobsStatus])

  const fetchWebhooks = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('webhooks')) return
    fetchedRef.current.add('webhooks')
    setLoad('webhooks', true); setErr('webhooks', '')
    try {
      const r = await fetch('/api/admin/webhooks')
      if (!r.ok) throw new Error(`${r.status}`)
      setWebhooks(await readJson(r))
      markFetched('webhooks')
    } catch (e: any) {
      setErr('webhooks', e.message)
    } finally {
      setLoad('webhooks', false)
    }
  }, [])

  const fetchGrowth = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('growth')) return
    fetchedRef.current.add('growth')
    setLoad('growth', true); setErr('growth', '')
    try {
      const r = await fetch('/api/admin/growth')
      if (!r.ok) throw new Error(`${r.status}`)
      setGrowth(await readJson(r))
      markFetched('growth')
    } catch (e: any) {
      setErr('growth', e.message)
    } finally {
      setLoad('growth', false)
    }
  }, [])

  const fetchAudit = useCallback(async () => {
    setLoad('audit', true); setErr('audit', '')
    try {
      const r = await fetch('/api/admin/dashboard')
      if (!r.ok) throw new Error(`${r.status}`)
      setDashboard(await readJson(r))
      markFetched('audit')
    } catch (e: any) {
      setErr('audit', e.message)
    } finally {
      setLoad('audit', false)
    }
  }, [])

  const fetchActivity = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('activity')) return
    fetchedRef.current.add('activity')
    setLoad('activity', true); setErr('activity', '')
    try {
      const qs = new URLSearchParams()
      if (actSource !== 'all') qs.set('source', actSource)
      if (actQueryDebounced) qs.set('q', actQueryDebounced)
      const r = await fetch(`/api/admin/activity?${qs.toString()}`)
      if (!r.ok) throw new Error(`${r.status}`)
      const d = await readJson(r)
      setActivity(d.items ?? [])
      markFetched('activity')
    } catch (e: any) {
      setErr('activity', e.message)
    } finally {
      setLoad('activity', false)
    }
  }, [actSource, actQueryDebounced])

  const fetchBuilds = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('builds')) return
    fetchedRef.current.add('builds')
    setLoad('builds', true); setErr('builds', '')
    try {
      const qs = new URLSearchParams()
      if (buildsQueryDebounced) qs.set('q', buildsQueryDebounced)
      const r = await fetch(`/api/admin/builds?${qs.toString()}`)
      if (!r.ok) throw new Error(`${r.status}`)
      setBuilds(await readJson(r))
      markFetched('builds')
    } catch (e: any) {
      setErr('builds', e.message)
    } finally {
      setLoad('builds', false)
    }
  }, [buildsQueryDebounced])

  const fetchSystem = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('system')) return
    fetchedRef.current.add('system')
    setLoad('system', true); setErr('system', '')
    try {
      const r = await fetch('/api/admin/system')
      if (!r.ok) throw new Error(`${r.status}`)
      setSystem(await readJson(r))
      markFetched('system')
    } catch (e: any) {
      setErr('system', e.message)
    } finally {
      setLoad('system', false)
    }
  }, [])

  const fetchRevenue = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('revenue')) return
    fetchedRef.current.add('revenue')
    setLoad('revenue', true); setErr('revenue', '')
    try {
      const r = await fetch('/api/admin/revenue')
      if (!r.ok) throw new Error(`${r.status}`)
      setRevenue(await readJson(r))
      markFetched('revenue')
    } catch (e: any) {
      setErr('revenue', e.message)
    } finally {
      setLoad('revenue', false)
    }
  }, [])

  const fetchAgentOps = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('agents')) return
    fetchedRef.current.add('agents')
    setLoad('agents', true); setErr('agents', '')
    try {
      const r = await fetch(`/api/admin/agent-ops?days=${agentDays}`)
      if (!r.ok) throw new Error(`${r.status}`)
      setAgentOps(await readJson(r))
      markFetched('agents')
    } catch (e: any) {
      setErr('agents', e.message)
    } finally {
      setLoad('agents', false)
    }
  }, [agentDays])

  const billingAction = useCallback(async (payload: Record<string, any>, busyKey: string) => {
    setRevBusy(busyKey); setRevActionMsg(null)
    try {
      const { r, d } = await adminMutate('/api/admin/billing-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!r.ok) throw new Error(d.error || `${r.status}`)
      if (d.url) window.open(d.url, '_blank', 'noopener')
      setRevActionMsg(d.message || d.note || 'Done')
      fetchedRef.current.delete('revenue')
      fetchRevenue(true)
      setTimeout(() => setRevActionMsg(null), 4000)
      return d
    } catch (e: any) {
      setRevActionMsg(`Error: ${e.message}`)
    } finally {
      setRevBusy(null)
    }
  }, [fetchRevenue, adminMutate])

  const fetchFeedback = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('feedback')) return
    fetchedRef.current.add('feedback')
    setLoad('feedback', true); setErr('feedback', '')
    try {
      const r = await fetch('/api/admin/feedback')
      if (!r.ok) throw new Error(`${r.status}`)
      setFeedback(await readJson(r))
      markFetched('feedback')
    } catch (e: any) {
      setErr('feedback', e.message)
    } finally {
      setLoad('feedback', false)
    }
  }, [])

  const fetchSecurity = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('security')) return
    fetchedRef.current.add('security')
    setLoad('security', true); setErr('security', '')
    try {
      const qs = new URLSearchParams()
      if (secKindFilter !== 'all') qs.set('kind', secKindFilter)
      if (secResolvedFilter === 'open') qs.set('resolved', 'false')
      const r = await fetch(`/api/admin/security?${qs.toString()}`)
      if (!r.ok) throw new Error(`${r.status}`)
      setSecurity(await readJson(r))
      markFetched('security')
    } catch (e: any) {
      setErr('security', e.message)
    } finally {
      setLoad('security', false)
    }
  }, [secKindFilter, secResolvedFilter])

  const resolveSecurityEvent = useCallback(async (id: string, resolved: boolean) => {
    try {
      const { r } = await adminMutate('/api/admin/security', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, resolved }),
      })
      if (!r.ok) return
      setSecurity(prev => prev ? {
        ...prev,
        events: prev.events.map(e => e.id === id ? { ...e, resolved } : e),
        summary: { ...prev.summary, unresolved: prev.summary.unresolved + (resolved ? -1 : 1) },
      } : prev)
    } catch {}
  }, [adminMutate])

  const fetchControl = useCallback(async (force = false) => {
    if (!force && fetchedRef.current.has('control')) return
    fetchedRef.current.add('control')
    setLoad('control', true); setErr('control', '')
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/admin/controls'),
        fetch('/api/admin/blocklist'),
      ])
      if (r1.ok) {
        const j = await readJson(r1)
        setControls(j.controls ?? null)
      }
      if (r2.ok) {
        const j = await readJson(r2)
        setBlocklist(j.entries ?? [])
      }
      markFetched('control')
    } catch (e: any) {
      setErr('control', e.message)
    } finally {
      setLoad('control', false)
    }
  }, [])

  const toggleControl = useCallback(async (patch: Partial<ControlState>) => {
    setControlBusy(Object.keys(patch)[0] ?? 'patch')
    setControlActionMsg(null)
    try {
      const { r, d } = await adminMutate('/api/admin/controls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!r.ok) throw new Error(d.error || `${r.status}`)
      setControls(d.controls)
      setControlActionMsg('Saved')
      setTimeout(() => setControlActionMsg(null), 2000)
    } catch (e: any) {
      setControlActionMsg(`Error: ${e.message}`)
    } finally {
      setControlBusy(null)
    }
  }, [adminMutate])

  const addBlocklist = useCallback(async () => {
    if (!blockForm.value.trim()) return
    setControlBusy('block-add')
    setControlActionMsg(null)
    try {
      const { r, d } = await adminMutate('/api/admin/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: blockForm.kind,
          value: blockForm.value.trim(),
          reason: blockForm.reason.trim() || undefined,
        }),
      })
      if (!r.ok) throw new Error(d.error || `${r.status}`)
      setBlocklist(prev => [d.entry, ...prev.filter(e => e.id !== d.entry.id)])
      setBlockForm({ kind: blockForm.kind, value: '', reason: '' })
      setControlActionMsg('Added')
      setTimeout(() => setControlActionMsg(null), 2000)
    } catch (e: any) {
      setControlActionMsg(`Error: ${e.message}`)
    } finally {
      setControlBusy(null)
    }
  }, [blockForm, adminMutate])

  const removeBlocklist = useCallback(async (id: string) => {
    setControlBusy('block-remove')
    try {
      const { r, d } = await adminMutate(`/api/admin/blocklist?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(d.error || `${r.status}`)
      setBlocklist(prev => prev.filter(e => e.id !== id))
    } catch (e: any) {
      setControlActionMsg(`Error: ${e.message}`)
    } finally {
      setControlBusy(null)
    }
  }, [adminMutate])

  const lockProject = useCallback(async (lock: boolean) => {
    if (!lockForm.projectId.trim()) return
    setControlBusy('lock')
    setControlActionMsg(null)
    try {
      const { r, d } = await adminMutate(`/api/admin/projects/${encodeURIComponent(lockForm.projectId.trim())}/lockdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lock, reason: lockForm.reason.trim() || undefined }),
      })
      if (!r.ok) throw new Error(d.error || `${r.status}`)
      setControlActionMsg(lock ? 'Project locked down' : 'Lockdown lifted')
      setTimeout(() => setControlActionMsg(null), 2500)
    } catch (e: any) {
      setControlActionMsg(`Error: ${e.message}`)
    } finally {
      setControlBusy(null)
    }
  }, [lockForm, adminMutate])

  const forceLogoutUser = useCallback(async (userId: string) => {
    if (!userId.trim()) return
    setControlBusy('logout')
    setControlActionMsg(null)
    try {
      const { r, d } = await adminMutate(`/api/admin/users/${encodeURIComponent(userId.trim())}/force-logout`, {
        method: 'POST',
      })
      if (!r.ok) throw new Error(d.error || `${r.status}`)
      setControlActionMsg(`Logged out ${d.email} (${d.sessionsRevoked} session${d.sessionsRevoked === 1 ? '' : 's'})`)
      setTimeout(() => setControlActionMsg(null), 3000)
    } catch (e: any) {
      setControlActionMsg(`Error: ${e.message}`)
    } finally {
      setControlBusy(null)
    }
  }, [adminMutate])

  const fetchOperator = useCallback(async (win?: '1h' | '24h' | '7d') => {
    const w = win ?? operatorWindow
    const since = w === '1h'
      ? new Date(Date.now() - 60 * 60 * 1000).toISOString()
      : w === '7d'
        ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    setLoad('ops', true); setErr('ops', '')
    try {
      const r = await fetch(`/api/admin/operator?since=${encodeURIComponent(since)}`)
      if (!r.ok) throw new Error(`${r.status}`)
      setOperatorData(await readJson(r))
      markFetched('ops')
    } catch (e: any) {
      setErr('ops', e.message)
    } finally {
      setLoad('ops', false)
    }
  }, [operatorWindow])

  // Refetch jobs when filter changes
  useEffect(() => {
    if (fetchedRef.current.has('health')) {
      fetch(`/api/admin/jobs?status=${jobsStatus}&limit=20`)
        .then(r => r.ok ? readJson(r) : null)
        .then(d => d && setJobs(d))
    }
  }, [jobsStatus])

  // Per-tab refresh
  const refresh = useCallback(() => {
    if (tab === 'overview') fetchOverview(true)
    else if (tab === 'growth') fetchGrowth(true)
    else if (tab === 'billing') fetchBilling(true)
    else if (tab === 'users') fetchUsers(true)
    else if (tab === 'funnel' || tab === 'projects' || tab === 'insights') fetchInsights(true)
    else if (tab === 'health') fetchHealth(true)
    else if (tab === 'webhooks') fetchWebhooks(true)
    else if (tab === 'audit') fetchAudit()
    else if (tab === 'ops') { fetchOverview(true); fetchOperator() }
    else if (tab === 'control') fetchControl(true)
    else if (tab === 'security') fetchSecurity(true)
    else if (tab === 'activity') fetchActivity(true)
    else if (tab === 'builds') fetchBuilds(true)
    else if (tab === 'feedback') fetchFeedback(true)
    else if (tab === 'revenue') fetchRevenue(true)
    else if (tab === 'system') fetchSystem(true)
    else if (tab === 'agents') fetchAgentOps(true)
  }, [tab, fetchOverview, fetchGrowth, fetchBilling, fetchUsers, fetchInsights, fetchHealth, fetchWebhooks, fetchAudit, fetchOperator, fetchControl, fetchSecurity, fetchActivity, fetchBuilds, fetchFeedback, fetchRevenue, fetchSystem, fetchAgentOps])

  // Tab routing
  useEffect(() => {
    if (tab === 'overview') fetchOverview()
    else if (tab === 'growth') fetchGrowth()
    else if (tab === 'billing') fetchBilling()
    else if (tab === 'users') fetchUsers()
    else if (tab === 'funnel' || tab === 'projects' || tab === 'insights') fetchInsights()
    else if (tab === 'health') fetchHealth()
    else if (tab === 'webhooks') fetchWebhooks()
    else if (tab === 'ops') fetchOperator()
    else if (tab === 'control') fetchControl()
    else if (tab === 'security') fetchSecurity()
    else if (tab === 'activity') fetchActivity()
    else if (tab === 'builds') fetchBuilds()
    else if (tab === 'feedback') fetchFeedback()
    else if (tab === 'revenue') fetchRevenue()
    else if (tab === 'system') fetchSystem()
    else if (tab === 'agents') fetchAgentOps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Refetch agent ops when the window changes
  useEffect(() => {
    if (fetchedRef.current.has('agents')) fetchAgentOps(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentDays])

  // Refetch security when its filters change
  useEffect(() => {
    if (fetchedRef.current.has('security')) fetchSecurity(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secKindFilter, secResolvedFilter])

  // Debounce free-text search inputs (300ms)
  useEffect(() => {
    const t = setTimeout(() => setActQueryDebounced(actQuery.trim()), 300)
    return () => clearTimeout(t)
  }, [actQuery])
  useEffect(() => {
    const t = setTimeout(() => setBuildsQueryDebounced(buildsQuery.trim()), 300)
    return () => clearTimeout(t)
  }, [buildsQuery])

  // Refetch activity / builds when filters change
  useEffect(() => {
    if (fetchedRef.current.has('activity')) fetchActivity(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actSource, actQueryDebounced])
  useEffect(() => {
    if (fetchedRef.current.has('builds')) fetchBuilds(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildsQueryDebounced])

  // Always pre-fetch overview + health (for badges)
  useEffect(() => {
    fetchOverview()
    fetchHealth()
    fetchInsights()
    fetchControl()
    fetchSecurity()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── User detail ────────────────────────────────────────────────────────────

  const openUser = useCallback(async (userId: string) => {
    setDetail(null); setDetailError(null); setActionMsg(null); setLoadingDetail(true)
    setConvos(null); setConvosError(null); setConvosOpen(false); setOpenConvoProjects(new Set()); setConvoSearch('')
    try {
      const [r1, r2] = await Promise.all([
        fetch(`/api/admin/analytics/users/${userId}`),
        fetch(`/api/admin/users/${userId}/credits`),
      ])
      if (!r1.ok) throw new Error(`${r1.status}`)
      const d1 = await readJson(r1)
      const d2 = r2.ok ? await readJson(r2) : null
      setDetail({ ...d1, credits: d2 })
    } catch (e: any) {
      setDetailError(e.message || 'Failed to load user')
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  const closeDetail = useCallback(() => {
    setDetail(null); setDetailError(null); setLoadingDetail(false); setActionMsg(null); setCreditModal(false)
    setConvos(null); setConvosError(null); setConvosOpen(false); setOpenConvoProjects(new Set()); setConvoSearch('')
  }, [])

  // Lazily load AI chat transcripts when the founder expands the section.
  const loadConversations = useCallback(async (userId: string) => {
    setConvosLoading(true); setConvosError(null)
    try {
      const r = await fetch(`/api/admin/analytics/users/${userId}/conversations`)
      if (!r.ok) throw new Error(`${r.status}`)
      const d: ConversationsData = await readJson(r)
      setConvos(d)
      // Auto-open the first project so the founder sees a transcript immediately.
      if (d.projects.length > 0) setOpenConvoProjects(new Set([d.projects[0].projectId]))
    } catch (e: any) {
      setConvosError(e.message || 'Failed to load conversations')
    } finally {
      setConvosLoading(false)
    }
  }, [])

  const toggleConvos = useCallback((userId: string) => {
    setConvosOpen(prev => {
      const next = !prev
      if (next && !convos && !convosLoading) loadConversations(userId)
      return next
    })
  }, [convos, convosLoading, loadConversations])

  const toggleConvoProject = useCallback((projectId: string) => {
    setOpenConvoProjects(prev => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId)
      return next
    })
  }, [])

  // When a search is active, filter down to matching messages and hide empty
  // projects. Otherwise show every project's full transcript.
  const filteredConvoProjects = useMemo(() => {
    if (!convos) return []
    const q = convoSearch.trim().toLowerCase()
    if (!q) return convos.projects
    return convos.projects
      .map(p => ({ ...p, messages: p.messages.filter(m => m.content.toLowerCase().includes(q)) }))
      .filter(p => p.messages.length > 0)
  }, [convos, convoSearch])

  const adminAction = useCallback(async (payload: Record<string, any>) => {
    setActionLoading(true); setActionMsg(null)
    try {
      const { r, d } = await adminMutate('/api/admin/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!r.ok) throw new Error(d.error || `${r.status}`)
      setActionMsg(d.message ?? 'Done')
      if (payload.userId && detail) await openUser(payload.userId)
      // If user was suspended/unsuspended, refresh users list
      if (payload.action === 'suspend') {
        fetchedRef.current.delete('users')
        if (tab === 'users') fetchUsers(true)
      }
      return d
    } catch (e: any) {
      setActionMsg(`Error: ${e.message}`)
    } finally {
      setActionLoading(false)
    }
  }, [detail, openUser, fetchUsers, tab, adminMutate])

  const opsAction = useCallback(async (action: string) => {
    setOpsLoading(p => ({ ...p, [action]: true }))
    try {
      const { d } = await adminMutate('/api/admin/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      setOpsResults(p => ({ ...p, [action]: d }))
    } catch (e: any) {
      setOpsResults(p => ({ ...p, [action]: { error: e.message } }))
    } finally {
      setOpsLoading(p => ({ ...p, [action]: false }))
    }
  }, [adminMutate])

  const retryJob = useCallback(async (job: JobsData['jobs'][number]) => {
    try {
      await adminMutate('/api/admin/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: job._projectId, table: job._table, jobId: job.id, action: 'retry' }),
      })
      fetchedRef.current.delete('health')
      fetchHealth(true)
    } catch {}
  }, [fetchHealth, adminMutate])

  // ESC closes detail
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDetail() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeDetail])

  // Cmd/Ctrl+R intercept (use our refresh)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        refresh()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [refresh])

  // ── Derived ────────────────────────────────────────────────────────────────

  const filteredUsers = useMemo(() => {
    let list = users.filter(u => {
      const matchSearch = !userSearch || u.email.toLowerCase().includes(userSearch.toLowerCase()) || (u.name ?? '').toLowerCase().includes(userSearch.toLowerCase())
      const matchTier = tierFilter === 'all' || u.tier === tierFilter
      const matchTrust =
        trustFilter === 'all' ||
        (trustFilter === 'flagged' && u.trustLevel === 'untrusted') ||
        (trustFilter === 'unverified' && u.emailVerified === false) ||
        (trustFilter === 'real' && u.trustLevel !== 'untrusted' && u.projectCount > 0)
      return matchSearch && matchTier && matchTrust
    })
    if (userSort === 'recent') list = [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    else if (userSort === 'active') list = [...list].sort((a, b) => new Date(b.lastActive ?? 0).getTime() - new Date(a.lastActive ?? 0).getTime())
    else if (userSort === 'projects') list = [...list].sort((a, b) => b.projectCount - a.projectCount)
    else if (userSort === 'ai') list = [...list].sort((a, b) => (b.usage.aiCalls ?? 0) - (a.usage.aiCalls ?? 0))
    return list
  }, [users, userSearch, tierFilter, trustFilter, userSort])

  const auditLogs: AuditEntry[] = dashboard?.recentAuditLogs ?? []

  const totalMRRCents = (payments?.revenueBreakdown ?? [])
    .filter(r => r.status === 'ACTIVE' || r.status === 'GRACE')
    .reduce((sum, row) => sum + row.estimatedMRRCents, 0)

  // Tab badges
  const tabAlerts = useMemo(() => {
    const alerts: Partial<Record<Tab, { color: 'red' | 'amber'; count?: number }>> = {}
    if (health && !health.ok) {
      alerts.health = { color: 'red' }
    }
    if (insights?.stuckUsers?.length) {
      alerts.funnel = { color: 'amber', count: insights.stuckUsers.length }
    }
    if (insights?.errorRate?.rate && insights.errorRate.rate > 10) {
      alerts.insights = { color: 'red' }
    }
    if (controls && (controls.aiFrozen || controls.maintenanceMode || controls.readOnly || controls.signupsDisabled)) {
      alerts.control = { color: 'red' }
    }
    if (security?.summary?.unresolved) {
      const crit = (security.summary.bySeverity?.critical ?? 0) + (security.summary.bySeverity?.high ?? 0)
      alerts.security = { color: crit > 0 ? 'red' : 'amber', count: security.summary.unresolved }
    }
    return alerts
  }, [health, insights, controls, security])

  const controlBanner = controls && (controls.aiFrozen || controls.maintenanceMode || controls.readOnly || controls.signupsDisabled)
    ? [
        controls.aiFrozen && 'AI frozen',
        controls.maintenanceMode && 'Maintenance mode',
        controls.readOnly && 'Read-only',
        controls.signupsDisabled && 'Signups disabled',
      ].filter(Boolean).join(' · ')
    : null

  const showModal = loadingDetail || !!detail || !!detailError

  // ── Error access denied ────────────────────────────────────────────────────
  if (errors.overview && !overview) {
    return (
      <div className="min-h-screen bg-[#0a0a0b] flex items-center justify-center">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-14 h-14 mx-auto rounded-xl bg-rose-500/[0.08] border border-rose-500/20 flex items-center justify-center">
            <Shield className="w-6 h-6 text-rose-300" />
          </div>
          <div>
            <div className="text-zinc-50 font-semibold mb-1 tracking-tight">Access Denied</div>
            <div className="text-zinc-500 text-[13px]">You need founder credentials to view this page.</div>
          </div>
        </div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white font-sans antialiased">

      {/* ── Top Nav ── */}
      <nav className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#0a0a0b]/90 backdrop-blur-xl">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/backenly-icon-hd.svg"
              alt="Backenly"
              width={32}
              height={32}
              className="w-8 h-8 rounded-lg ring-1 ring-white/[0.08]"
            />
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-semibold text-[15px] tracking-[-0.01em] text-zinc-50">Backenly</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500 bg-white/[0.03] border border-white/[0.07] px-2 py-1 rounded-md leading-none">Founder</span>
              {dashboard && totalMRRCents > 0 && (
                <span className="hidden md:inline-flex items-center gap-1.5 font-mono text-[11.5px] font-medium text-emerald-300/90 tabular-nums">
                  <span className="h-[5px] w-[5px] rounded-full bg-emerald-400" />{cents(totalMRRCents)}/mo
                </span>
              )}
              {dashboard && (
                <span className={`hidden md:inline-flex items-center gap-1.5 font-mono text-[11.5px] font-medium tabular-nums ${
                  dashboard.subscriptions.active > 0 ? 'text-emerald-300/90' : 'text-zinc-500'
                }`}>
                  <span className={`h-[5px] w-[5px] rounded-full ${dashboard.subscriptions.active > 0 ? 'bg-emerald-400' : 'bg-zinc-600'}`} />{dashboard.subscriptions.active} paid
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {lastFetched[tab] && (
              <span className="hidden lg:inline font-mono text-[11px] text-zinc-600 tabular-nums">
                updated {ago(new Date(lastFetched[tab]!).toISOString())}
              </span>
            )}
            <button
              onClick={refresh}
              disabled={loading[tab]}
              className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 hover:border-white/20 h-8 px-3 rounded-lg transition-colors disabled:opacity-50"
              title="Refresh (⌘K)"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading[tab] ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Tab strip */}
        <div className="max-w-[1400px] mx-auto px-6 border-t border-white/[0.05]">
          <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-none -mb-px">
            {TABS.map(t => {
              const alert = tabAlerts[t.id]
              const isActive = tab === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`relative flex items-center gap-1.5 px-3 py-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors border-b-2 focus:outline-none ${
                    isActive
                      ? 'text-zinc-50 border-violet-400'
                      : 'text-zinc-500 hover:text-zinc-200 border-transparent'
                  }`}
                >
                  <span className={isActive ? 'text-violet-300' : 'text-zinc-600'}>{t.icon}</span>
                  {t.label}
                  {alert && (
                    <span className={`ml-0.5 font-mono text-[10.5px] font-semibold tabular-nums ${
                      alert.color === 'red' ? 'text-rose-300' : 'text-amber-500'
                    }`}>
                      {alert.count ?? '!'}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </nav>

      <div className="max-w-[1400px] mx-auto px-6 py-8">
        {controlBanner && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-200 text-sm flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Shield className="w-4 h-4 flex-shrink-0" />
              <span className="font-semibold">Platform controls engaged:</span>
              <span className="truncate">{controlBanner}</span>
            </div>
            {tab !== 'control' && (
              <button onClick={() => setTab('control')} className="text-[11px] font-semibold underline hover:text-white flex-shrink-0">
                Manage →
              </button>
            )}
          </div>
        )}
        {errors[tab] && tab !== 'overview' && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Failed to load: {errors[tab]}
          </div>
        )}

        {/* ════════ OVERVIEW ════════ */}
        {tab === 'overview' && (
          loading.overview && !overview ? <Skeleton /> : overview && (
            <div className="space-y-6">
              <SectionHeader title="Overview" sub="Platform-wide health & activity at a glance" />

              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
                <StatCard
                  icon={<Users className="w-4 h-4" />}
                  label="Total Users"
                  value={n(overview.totalUsers)}
                  color="violet"
                  trend={dashboard?.users.newThisWeek ? { value: dashboard.users.newThisWeek, label: 'this week', positive: true } : undefined}
                />
                <StatCard
                  icon={<Activity className="w-4 h-4" />}
                  label="Weekly Active"
                  value={dashboard ? n(dashboard.users.activeWeekly) : '...'}
                  color="emerald"
                  sub={dashboard ? `${percent((dashboard.users.activeWeekly / Math.max(dashboard.users.total, 1)) * 100)} of users` : 'last 7 days'}
                />
                <StatCard
                  icon={<Layers className="w-4 h-4" />}
                  label="Projects"
                  value={n(overview.totalProjects)}
                  color="blue"
                  sub={dashboard ? `${dashboard.projects.deployed} deployed` : undefined}
                />
                <StatCard
                  icon={<Sparkles className="w-4 h-4" />}
                  label="AI Prompts"
                  value={n(overview.totalAiCalls)}
                  color="amber"
                  sub="lifetime"
                />
                <StatCard
                  icon={<DollarSign className="w-4 h-4" />}
                  label="MRR (est.)"
                  value={cents(totalMRRCents)}
                  color="emerald"
                  sub={dashboard ? `${dashboard.subscriptions.active} subs active` : undefined}
                />
              </div>

              {dashboard && (
                <Card title="This Month — AI Usage" sub={dashboard.aiUsage.month}>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <UsageStat icon={<Zap className="w-3.5 h-3.5" />} label="Intent Calls" value={n(dashboard.aiUsage.intentCount)} />
                    <UsageStat icon={<MessageSquare className="w-3.5 h-3.5" />} label="Tokens Used" value={n(dashboard.aiUsage.tokenCount)} />
                    <UsageStat icon={<Globe className="w-3.5 h-3.5" />} label="API Requests" value={n(dashboard.aiUsage.apiRequestCount)} />
                  </div>
                </Card>
              )}

              {dashboard && (
                <Card title="Signup Retention" sub="Users active again after signup">
                  <RetentionSummary retention={dashboard.users.retention} />
                </Card>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {dashboard && (
                  <Card title="User Tier Breakdown" sub={`${n(dashboard.users.total)} total`}>
                    <TierBreakdown breakdown={dashboard.users.tierBreakdown} total={dashboard.users.total} />
                  </Card>
                )}
                <Card title="Product Funnel" sub="Conversion by stage">
                  <FunnelChart funnel={overview.funnel} compact />
                </Card>
              </div>

              <Card
                title="Recent Events"
                sub={`Latest ${overview.recentEvents.length} events`}
                action={<button onClick={() => setTab('insights')} className="text-[11px] text-violet-400 hover:text-violet-300 flex items-center gap-1">View all<ChevronRight className="w-3 h-3" /></button>}
              >
                <EventFeed events={overview.recentEvents} onUserClick={openUser} />
              </Card>
            </div>
          )
        )}

        {/* ════════ GROWTH ════════ */}
        {tab === 'growth' && (
          loading.growth && !growth ? <Skeleton /> : growth && (
            <div className="space-y-6">
              <SectionHeader title="Growth" sub="User acquisition, engagement & feature adoption" />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard icon={<UserPlus className="w-4 h-4" />} label="DAU" value={n(growth.dau)} color="violet" sub="logins last 24h" />
                <StatCard icon={<Activity className="w-4 h-4" />} label="WAU" value={n(growth.wau)} color="blue" sub="logins last 7 days" />
                <StatCard icon={<TrendingUp className="w-4 h-4" />} label="MAU" value={n(growth.mau)} color="emerald" sub="logins last 30 days" />
              </div>

              <Card
                title="Signup Trend"
                sub="New user registrations over time"
                action={
                  <div className="flex items-center gap-1 bg-white/[0.04] rounded-lg p-1 border border-white/[0.06]">
                    {([
                      { id: 'daily30', label: '30D' },
                      { id: 'daily90', label: '90D' },
                      { id: 'weekly',  label: '1Y W' },
                      { id: 'monthly', label: '2Y M' },
                    ] as { id: ChartView; label: string }[]).map(v => (
                      <button
                        key={v.id}
                        onClick={() => setChartView(v.id)}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                          chartView === v.id
                            ? 'bg-white/[0.08] text-violet-300 shadow-sm'
                            : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                }
              >
                <GrowthBarChart
                  data={
                    chartView === 'daily30' ? growth.daily90.slice(-30)
                    : chartView === 'daily90' ? growth.daily90
                    : chartView === 'weekly' ? growth.weekly
                    : growth.monthly
                  }
                  unit={chartView === 'monthly' ? 'month' : chartView === 'weekly' ? 'week' : 'day'}
                />
              </Card>

              <Card title="Feature Adoption" sub={`% of ${n(growth.totalProjects)} active projects using each feature`}>
                <div className="space-y-3">
                  {growth.featureAdoption.length === 0 ? (
                    <EmptyState icon={<Inbox className="w-5 h-5" />} text="No projects yet." />
                  ) : (
                    growth.featureAdoption.map(f => (
                      <div key={f.feature}>
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="min-w-0 flex-1">
                            <span className="text-zinc-200 text-xs font-semibold">{f.feature}</span>
                            <span className="text-zinc-500 text-[11px] ml-2">{f.description}</span>
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                            <span className="text-zinc-500 text-[11px]">{f.projectCount} project{f.projectCount === 1 ? '' : 's'}</span>
                            <span className={`font-mono text-xs font-medium tabular-nums w-12 text-right ${
                              f.pct >= 50 ? 'text-emerald-300'
                              : f.pct >= 20 ? 'text-amber-500'
                              : 'text-zinc-500'
                            }`}>
                              {f.pct}%
                            </span>
                          </div>
                        </div>
                        <div className="h-1 bg-white/[0.04] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${
                              f.pct >= 50 ? 'bg-emerald-400'
                              : f.pct >= 20 ? 'bg-violet-500/85'
                              : 'bg-zinc-700'
                            }`}
                            style={{ width: `${Math.max(f.pct, f.projectCount > 0 ? 1 : 0)}%` }}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </Card>
            </div>
          )
        )}

        {/* ════════ BILLING ════════ */}
        {tab === 'billing' && (
          loading.billing && !payments ? <Skeleton /> : (
            <div className="space-y-6">
              <SectionHeader title="Billing & Revenue" sub="MRR, subscriptions & Paddle event log" />

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard icon={<DollarSign className="w-4 h-4" />} label="MRR (est.)" value={cents(totalMRRCents)} color="emerald" sub="active + grace" />
                <StatCard icon={<Users className="w-4 h-4" />} label="Active Subs" value={n(dashboard?.subscriptions.active)} color="violet" />
                <StatCard icon={<AlertTriangle className="w-4 h-4" />} label="Grace Period" value={n(dashboard?.subscriptions.gracePeriod)} color="amber" sub="failed billing retry" />
                <StatCard icon={<Package className="w-4 h-4" />} label="Total Subs" value={n(payments?.total)} color="blue" sub="all-time" />
              </div>

              {payments?.revenueBreakdown && payments.revenueBreakdown.length > 0 && (
                <Card title="Revenue by Plan" sub="Monthly breakdown">
                  <div className="space-y-3">
                    {payments.revenueBreakdown.map((row, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <div className="w-28 text-xs text-zinc-300 font-semibold truncate">{row.plan}</div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wide ${STATUS_COLOR[row.status] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
                          {row.status}
                        </span>
                        <div className="flex-1 h-6 bg-white/[0.03] rounded-md overflow-hidden border border-white/[0.05]">
                          <div
                            className="h-full bg-emerald-500/80 transition-all duration-500"
                            style={{ width: `${Math.min(100, (row.estimatedMRRCents / (totalMRRCents || 1)) * 100)}%` }}
                          />
                        </div>
                        <div className="text-zinc-200 font-mono text-xs font-medium w-20 text-right tabular-nums">{cents(row.estimatedMRRCents)}/mo</div>
                        <div className="text-zinc-500 font-mono text-xs w-16 text-right tabular-nums">{row.count} user{row.count === 1 ? '' : 's'}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              <Card title="Subscriptions" sub={`${payments?.total ?? 0} total`}>
                <div className="overflow-x-auto -mx-6 px-6">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06]">
                        {['User', 'Plan', 'Status', 'Price', 'Period End', 'Created'].map(h => (
                          <th key={h} className="text-left py-2.5 pr-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(payments?.subscriptions ?? []).slice(0, 50).map(s => (
                        <tr key={s.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
                          <td className="py-3 pr-4">
                            <div className="text-white text-xs font-semibold">{s.user?.name || s.user?.email}</div>
                            {s.user?.name && <div className="text-zinc-500 text-[11px]">{s.user.email}</div>}
                          </td>
                          <td className="py-3 pr-4 text-zinc-300 text-xs font-medium">{s.plan ?? '—'}</td>
                          <td className="py-3 pr-4">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide ${STATUS_COLOR[s.status] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
                              {s.status}
                            </span>
                          </td>
                          <td className="py-3 pr-4 text-zinc-300 text-xs font-semibold tabular-nums">{s.priceCents ? centsExact(s.priceCents) : '—'}</td>
                          <td className="py-3 pr-4 text-zinc-500 text-xs">{fmtDate(s.currentPeriodEnd ?? undefined)}</td>
                          <td className="py-3 text-zinc-500 text-xs">{ago(s.createdAt)}</td>
                        </tr>
                      ))}
                      {!payments?.subscriptions?.length && (
                        <tr><td colSpan={6} className="py-12">
                          <EmptyState icon={<CreditCard className="w-5 h-5" />} text="No subscriptions yet" />
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>

              {dashboard?.recentPaymentEvents && dashboard.recentPaymentEvents.length > 0 && (
                <Card title="Recent Paddle Events" sub={`Last ${dashboard.recentPaymentEvents.length}`}>
                  <div className="space-y-1">
                    {dashboard.recentPaymentEvents.map(ev => (
                      <div key={ev.id} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded transition-colors">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide ${STATUS_COLOR[ev.status] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
                          {ev.status}
                        </span>
                        <span className="text-zinc-300 text-xs flex-1 truncate">{ev.user?.email ?? ev.userId.slice(0, 12)}</span>
                        {ev.nextBillDate && <span className="text-zinc-500 text-xs hidden md:inline">next: {fmtDate(ev.nextBillDate)}</span>}
                        <span className="text-zinc-600 text-xs">{ago(ev.updatedAt)}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          )
        )}

        {/* ════════ USERS ════════ */}
        {tab === 'users' && (
          <div className="space-y-5">
            <SectionHeader title="Users" sub={`${users.length} platform users — search, filter & manage`} />

            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[240px] max-w-md">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search by name or email..."
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-9 pr-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-colors"
                />
              </div>
              <div className="flex items-center gap-1.5 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2">
                <Filter className="w-3.5 h-3.5 text-zinc-500" />
                <select
                  value={tierFilter}
                  onChange={e => setTierFilter(e.target.value)}
                  className="bg-transparent text-xs text-zinc-200 outline-none cursor-pointer pr-1"
                >
                  <option value="all" className="bg-zinc-900">All tiers</option>
                  <option value="FREE" className="bg-zinc-900">Free</option>
                  <option value="STARTER" className="bg-zinc-900">Starter</option>
                  <option value="PRO" className="bg-zinc-900">Pro</option>
                  <option value="ENTERPRISE" className="bg-zinc-900">Enterprise</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2">
                <ShieldAlert className="w-3.5 h-3.5 text-zinc-500" />
                <select
                  value={trustFilter}
                  onChange={e => setTrustFilter(e.target.value)}
                  className="bg-transparent text-xs text-zinc-200 outline-none cursor-pointer pr-1"
                >
                  <option value="all" className="bg-zinc-900">All signups</option>
                  <option value="real" className="bg-zinc-900">Real users</option>
                  <option value="flagged" className="bg-zinc-900">Flagged at signup</option>
                  <option value="unverified" className="bg-zinc-900">Unverified email</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2">
                <BarChart2 className="w-3.5 h-3.5 text-zinc-500" />
                <select
                  value={userSort}
                  onChange={e => setUserSort(e.target.value as any)}
                  className="bg-transparent text-xs text-zinc-200 outline-none cursor-pointer pr-1"
                >
                  <option value="recent" className="bg-zinc-900">Newest first</option>
                  <option value="active" className="bg-zinc-900">Last active</option>
                  <option value="projects" className="bg-zinc-900">Most projects</option>
                  <option value="ai" className="bg-zinc-900">Most AI calls</option>
                </select>
              </div>
              <span className="text-zinc-500 text-xs ml-auto">{filteredUsers.length} of {users.length}</span>
            </div>

            <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] overflow-hidden">
              {loading.users ? (
                <div className="p-12 flex items-center justify-center">
                  <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                        {['User', 'Joined', 'Last Active', 'Projects', 'Tier', 'API Calls', 'AI Calls', ''].map(h => (
                          <th key={h} className="text-left px-5 py-3 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map(u => (
                        <tr
                          key={u.id}
                          onClick={() => openUser(u.id)}
                          className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.03] cursor-pointer group transition-colors"
                        >
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500/30 to-indigo-500/30 border border-violet-500/20 flex items-center justify-center text-xs font-bold text-violet-300 flex-shrink-0">
                                {(u.name || u.email)[0].toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-semibold text-white text-xs truncate">{u.name || u.email.split('@')[0]}</span>
                                  <SignupTrustFlag user={u} />
                                </div>
                                <div className="flex items-center gap-1 group/email">
                                  <span className="text-zinc-500 text-[11px] truncate">{u.email}</span>
                                  <button
                                    onClick={e => copyEmail(e, u.email)}
                                    className="opacity-0 group-hover/email:opacity-100 transition-opacity p-0.5 rounded hover:bg-white/[0.08] flex-shrink-0"
                                    title="Copy email"
                                  >
                                    {copiedEmail === u.email
                                      ? <Check className="w-3 h-3 text-emerald-400" />
                                      : <Copy className="w-3 h-3 text-zinc-500" />
                                    }
                                  </button>
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-zinc-400 text-xs whitespace-nowrap">{ago(u.createdAt)}</td>
                          <td className="px-5 py-3.5 whitespace-nowrap">
                            <span className={`text-xs ${u.lastActive ? 'text-zinc-300' : 'text-zinc-600'}`}>{ago(u.lastActive)}</span>
                          </td>
                          <td className="px-5 py-3.5"><span className="text-white font-bold tabular-nums">{u.projectCount}</span></td>
                          <td className="px-5 py-3.5"><TierBadge tier={u.tier} /></td>
                          <td className="px-5 py-3.5 text-zinc-300 text-xs tabular-nums">{n(u.usage.apiCalls)}</td>
                          <td className="px-5 py-3.5 text-zinc-300 text-xs tabular-nums">{n(u.usage.aiCalls)}</td>
                          <td className="px-5 py-3.5">
                            <ChevronRight className="w-4 h-4 text-zinc-700 group-hover:text-zinc-400 transition-colors" />
                          </td>
                        </tr>
                      ))}
                      {filteredUsers.length === 0 && (
                        <tr><td colSpan={8} className="px-5 py-16">
                          <EmptyState icon={<Users className="w-5 h-5" />} text="No users found" sub={userSearch ? 'Try a different search term' : undefined} />
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ════════ FUNNEL ════════ */}
        {tab === 'funnel' && (
          loading.funnel && !insights ? <Skeleton /> : (
            <div className="space-y-6">
              <SectionHeader title="Activation Funnel" sub="Where users drop off & who needs outreach" />

              {overview && (
                <Card title="Product Funnel" sub="Conversion at each stage">
                  <FunnelChart funnel={overview.funnel} />
                </Card>
              )}

              {insights?.timeToActivate && insights.timeToActivate.median !== null && (
                <Card title="Time to Activate" sub={`signup → first backend generated · n=${insights.timeToActivate.sampleSize}`}>
                  <div className="grid grid-cols-3 gap-3">
                    <PercentileCard label="P25 (fast)" value={`${insights.timeToActivate.p25}h`} color="emerald" />
                    <PercentileCard label="Median" value={`${insights.timeToActivate.median}h`} color="violet" emphasized />
                    <PercentileCard label="P75 (slow)" value={`${insights.timeToActivate.p75}h`} color="amber" />
                  </div>
                </Card>
              )}

              <Card
                title="Stuck Users"
                sub={`${insights?.stuckUsers?.length ?? 0} signed up >48h ago with no backend — your outreach list`}
              >
                {!insights?.stuckUsers?.length ? (
                  <EmptyState icon={<CheckCircle className="w-5 h-5 text-emerald-400" />} text="No stuck users" sub="Everyone who signed up is making progress" />
                ) : (
                  <div className="overflow-x-auto -mx-6 px-6">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-white/[0.06]">
                          {['User', 'Signed Up', 'Last Active', 'Projects', 'Tier'].map(h => (
                            <th key={h} className="text-left py-2.5 pr-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {insights.stuckUsers.map(u => (
                          <tr
                            key={u.id}
                            onClick={() => openUser(u.id)}
                            className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.03] cursor-pointer transition-colors"
                          >
                            <td className="py-3 pr-4">
                              <div className="text-white text-xs font-semibold">{u.name || u.email}</div>
                              <div className="flex items-center gap-1 group/email mt-0.5">
                                {u.name && <span className="text-zinc-500 text-[11px]">{u.email}</span>}
                                <button
                                  onClick={e => copyEmail(e, u.email)}
                                  className="opacity-0 group-hover/email:opacity-100 transition-opacity p-0.5 rounded hover:bg-white/[0.08]"
                                  title="Copy email"
                                >
                                  {copiedEmail === u.email
                                    ? <Check className="w-3 h-3 text-emerald-400" />
                                    : <Copy className="w-3 h-3 text-zinc-500" />
                                  }
                                </button>
                              </div>
                            </td>
                            <td className="py-3 pr-4 text-zinc-400 text-xs">{ago(u.createdAt)}</td>
                            <td className="py-3 pr-4">
                              <span className={`text-xs ${u.lastActive ? 'text-zinc-300' : 'text-zinc-600'}`}>{ago(u.lastActive)}</span>
                            </td>
                            <td className="py-3 pr-4"><span className="text-white font-bold">{u.projectCount}</span></td>
                            <td className="py-3"><TierBadge tier={u.tier} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          )
        )}

        {/* ════════ PROJECTS ════════ */}
        {tab === 'projects' && (
          loading.projects && !insights ? <Skeleton /> : insights?.projectHealth && (
            <div className="space-y-6">
              <SectionHeader title="Projects" sub={`Health map across ${insights.projectHealth.total} projects`} />

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard icon={<CheckCircle className="w-4 h-4" />} label="Deployed + Live" value={n(insights.projectHealth.deployedAndLive)} color="emerald" sub="real users" />
                <StatCard icon={<Rocket className="w-4 h-4" />} label="Deployed Only" value={n(insights.projectHealth.deployedOnly)} color="blue" sub="no traffic yet" />
                <StatCard icon={<Code2 className="w-4 h-4" />} label="Backend Only" value={n(insights.projectHealth.backendOnly)} color="amber" sub="not deployed" />
                <StatCard icon={<Inbox className="w-4 h-4" />} label="Empty" value={n(insights.projectHealth.empty)} color="zinc" sub="no progress" />
              </div>

              <Card title="Project Health Map" sub={`${insights.projectHealth.total} total — hover for project name`}>
                <div className="mb-5 flex items-center gap-4 flex-wrap">
                  {[
                    { color: 'bg-emerald-500', label: 'Deployed + Live Users' },
                    { color: 'bg-blue-500', label: 'Deployed' },
                    { color: 'bg-amber-500', label: 'Backend Generated' },
                    { color: 'bg-zinc-700', label: 'Empty' },
                  ].map(item => (
                    <div key={item.label} className="flex items-center gap-1.5">
                      <div className={`w-2.5 h-2.5 rounded-sm ${item.color}`} />
                      <span className="text-zinc-500 text-[11px]">{item.label}</span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {insights.projectHealth.projects.map(p => {
                    let color = 'bg-zinc-800 hover:bg-zinc-700'
                    let title = `${p.name} — Empty`
                    if (p.isDeployed && p.hasExternalUsers) { color = 'bg-emerald-600 hover:bg-emerald-500'; title = `${p.name} — Deployed + Live` }
                    else if (p.isDeployed) { color = 'bg-blue-600 hover:bg-blue-500'; title = `${p.name} — Deployed` }
                    else if (p.isBackendGenerated) { color = 'bg-amber-500 hover:bg-amber-400'; title = `${p.name} — Backend Generated` }
                    return (
                      <div
                        key={p.id}
                        title={title}
                        className={`w-4 h-4 rounded-sm cursor-pointer transition-colors ${color}`}
                      />
                    )
                  })}
                  {insights.projectHealth.projects.length === 0 && (
                    <EmptyState icon={<Layers className="w-5 h-5" />} text="No projects yet" />
                  )}
                </div>
              </Card>
            </div>
          )
        )}

        {/* ════════ INSIGHTS ════════ */}
        {tab === 'insights' && (
          loading.insights && !insights ? <Skeleton /> : insights && (
            <div className="space-y-6">
              <SectionHeader title="Product Intelligence" sub="What users are building & where AI is failing" />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard icon={<Activity className="w-4 h-4" />} label="AI Responses" value={n(insights.errorRate.total)} color="blue" sub="total volume" />
                <StatCard icon={<AlertTriangle className="w-4 h-4" />} label="Errors" value={n(insights.errorRate.errors)} color="amber" sub="error responses" />
                <StatCard
                  icon={<XCircle className="w-4 h-4" />}
                  label="Error Rate"
                  value={`${insights.errorRate.rate}%`}
                  color={insights.errorRate.rate > 10 ? 'red' : insights.errorRate.rate > 5 ? 'amber' : 'emerald'}
                  sub={insights.errorRate.rate > 10 ? '⚠ High — fix before scaling' : insights.errorRate.rate > 5 ? 'Investigate trends' : 'Within range'}
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card title="Top AI Prompt Topics" sub="Last 200 user messages">
                  {insights.promptTopics.length === 0 ? (
                    <EmptyState icon={<MessageSquare className="w-5 h-5" />} text="No conversations yet" />
                  ) : (
                    <div className="space-y-2">
                      {insights.promptTopics.map((t, i) => {
                        const max = insights.promptTopics[0].count
                        const pct = Math.round((t.count / max) * 100)
                        return (
                          <div key={t.topic} className="flex items-center gap-3">
                            <span className="text-zinc-600 text-xs w-4 text-right tabular-nums">{i + 1}</span>
                            <span className="text-zinc-300 text-xs w-32 truncate">{t.topic}</span>
                            <div className="flex-1 h-5 bg-white/[0.04] rounded overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-r from-violet-700 via-violet-600 to-violet-500 rounded transition-all duration-500"
                                style={{ width: `${Math.max(pct, 3)}%` }}
                              />
                            </div>
                            <span className="text-zinc-400 text-xs font-bold w-8 text-right tabular-nums">{t.count}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </Card>

                <Card title="Backend Categories" sub="What users are actually building">
                  {insights.backendCategories.length === 0 ? (
                    <EmptyState icon={<Database className="w-5 h-5" />} text="No backends generated yet" />
                  ) : (
                    <div className="space-y-2">
                      {insights.backendCategories.map((c, i) => {
                        const max = insights.backendCategories[0].count
                        const pct = Math.round((c.count / max) * 100)
                        return (
                          <div key={c.category} className="flex items-center gap-3">
                            <span className="text-zinc-600 text-xs w-4 text-right tabular-nums">{i + 1}</span>
                            <span className="text-zinc-300 text-xs w-32 truncate">{c.category}</span>
                            <div className="flex-1 h-5 bg-white/[0.04] rounded overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-r from-blue-700 via-blue-600 to-blue-500 rounded transition-all duration-500"
                                style={{ width: `${Math.max(pct, 3)}%` }}
                              />
                            </div>
                            <span className="text-zinc-400 text-xs font-bold w-8 text-right tabular-nums">{c.count}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </Card>
              </div>

              <Card title="Recent User Prompts" sub={`Last ${insights.recentPrompts.length} — what users are typing to AI`}>
                {insights.recentPrompts.length === 0 ? (
                  <EmptyState icon={<MessageSquare className="w-5 h-5" />} text="No prompts yet" />
                ) : (
                  <div className="space-y-1">
                    {insights.recentPrompts.map((p, i) => (
                      <div key={i} className="flex items-start gap-3 py-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded transition-colors">
                        <MessageSquare className="w-3 h-3 text-zinc-700 mt-1 flex-shrink-0" />
                        <span className="text-zinc-300 text-xs leading-relaxed flex-1">{p.excerpt}{p.excerpt.length >= 120 ? '…' : ''}</span>
                        <span className="text-zinc-600 text-[11px] flex-shrink-0">{ago(p.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )
        )}

        {/* ════════ HEALTH ════════ */}
        {tab === 'health' && (
          loading.health && !health ? <Skeleton /> : (
            <div className="space-y-6">
              <SectionHeader title="System Health" sub="Operator-facing alerts & background job status" />

              <div className={`rounded-2xl border p-6 flex items-center gap-4 ${
                health?.ok
                  ? 'bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 border-emerald-500/20'
                  : health
                    ? 'bg-gradient-to-br from-red-500/10 to-red-500/5 border-red-500/20'
                    : 'bg-white/[0.03] border-white/[0.06]'
              }`}>
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
                  health?.ok ? 'bg-emerald-500/15' : health ? 'bg-red-500/15' : 'bg-white/[0.04]'
                }`}>
                  {health?.ok
                    ? <CheckCircle className="w-6 h-6 text-emerald-400" />
                    : health
                      ? <AlertTriangle className="w-6 h-6 text-red-400" />
                      : <Loader2 className="w-6 h-6 text-zinc-600 animate-spin" />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`font-semibold text-base ${health?.ok ? 'text-emerald-200' : health ? 'text-red-200' : 'text-zinc-400'}`}>
                    {health?.ok ? 'All systems operating normally' : health ? 'Issues detected' : 'Loading health data…'}
                  </div>
                  {health?.signals && health.signals.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {health.signals.map((s, i) => (
                        <li key={i} className="text-xs text-zinc-400">• {s}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {health?.snapshot && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard icon={<AlertTriangle className="w-4 h-4" />} label="Stuck Executions" value={n(health.snapshot.summary.stuckCount)} color={health.snapshot.summary.stuckCount > 0 ? 'red' : 'emerald'} sub="processing >15min" />
                  <StatCard icon={<XCircle className="w-4 h-4" />} label="Abandoned" value={n(health.snapshot.summary.abandonedCount)} color={health.snapshot.summary.abandonedCount > 0 ? 'amber' : 'emerald'} sub="user may retry" />
                  <StatCard icon={<Webhook className="w-4 h-4" />} label="Webhook Failures" value={n(health.snapshot.summary.webhookFailureProjectCount)} color={health.snapshot.summary.webhookFailureProjectCount > 0 ? 'red' : 'emerald'} sub="project clusters" />
                  <StatCard icon={<RotateCcw className="w-4 h-4" />} label="Healing Failures" value={n(health.snapshot.summary.repeatedHealingFailureCount)} color={health.snapshot.summary.repeatedHealingFailureCount > 0 ? 'red' : 'emerald'} sub="auto-fix gave up" />
                </div>
              )}

              {health?.snapshot?.stuckExecutions && health.snapshot.stuckExecutions.length > 0 && (
                <Card title="Stuck Executions" sub={`${health.snapshot.stuckExecutions.length} stuck`}>
                  <div className="space-y-1">
                    {health.snapshot.stuckExecutions.map((ex, i) => (
                      <div key={i} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                        <span className="text-zinc-300 text-xs font-mono flex-1 truncate">project: {ex.projectId}</span>
                        {ex.executionId && <span className="text-zinc-500 text-[11px] font-mono">exec: {ex.executionId.slice(0, 8)}</span>}
                        {ex.stuckSince && <span className="text-zinc-500 text-xs">{ago(ex.stuckSince)}</span>}
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {health?.snapshot?.failedWebhookClusters && health.snapshot.failedWebhookClusters.length > 0 && (
                <Card title="Failed Webhook Clusters" sub="Projects with repeated webhook failures">
                  <div className="space-y-1">
                    {health.snapshot.failedWebhookClusters.map((c, i) => (
                      <div key={i} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0">
                        <Webhook className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                        <span className="text-zinc-300 text-xs font-mono flex-1 truncate">project: {c.projectId}</span>
                        {c.failCount && <span className="text-red-400 text-xs font-bold">{c.failCount} failures</span>}
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              <Card
                title={`Background Jobs — ${jobsStatus}`}
                sub={`${jobs?.total ?? 0} total`}
                action={
                  <div className="flex items-center gap-1 bg-white/[0.04] rounded-lg p-1 border border-white/[0.06]">
                    {(['failed', 'stuck', 'processing'] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => setJobsStatus(s)}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-all ${
                          jobsStatus === s ? 'bg-white/[0.08] text-violet-300' : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                }
              >
                {!jobs?.jobs?.length ? (
                  <EmptyState
                    icon={<CheckCircle className="w-5 h-5 text-emerald-400" />}
                    text={jobs ? 'Everything is healthy' : 'Loading…'}
                    sub={jobs ? `No ${jobsStatus} jobs.` : undefined}
                  />
                ) : (
                  <div className="space-y-1">
                    {jobs.jobs.slice(0, 20).map((job, i) => (
                      <div key={i} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0 group hover:bg-white/[0.02] -mx-2 px-2 rounded transition-colors">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide ${STATUS_COLOR[job.status] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
                          {job.status}
                        </span>
                        <span className="text-zinc-300 text-[11px] font-mono flex-shrink-0 truncate max-w-[180px]">{job._table}</span>
                        <span className="text-zinc-500 text-[11px] font-mono">{job._projectId?.slice(0, 8)}</span>
                        {job.error_message && <span className="text-red-300/70 text-[11px] truncate max-w-xs flex-1">{job.error_message}</span>}
                        <span className="text-zinc-600 text-[11px] ml-auto">{ago(job.createdAt)}</span>
                        <button
                          onClick={() => retryJob(job)}
                          className="text-[11px] px-2 py-0.5 rounded bg-white/[0.05] hover:bg-white/[0.08] hover:text-violet-300 text-zinc-400 transition-colors flex items-center gap-1 border border-white/[0.06] hover:border-white/[0.2]"
                        >
                          <RotateCcw className="w-3 h-3" />Retry
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )
        )}

        {/* ════════ WEBHOOKS ════════ */}
        {tab === 'webhooks' && (
          loading.webhooks && !webhooks ? <Skeleton /> : webhooks && (
            <div className="space-y-6">
              <SectionHeader title="Webhooks" sub="Inbound Paddle events & outbound project webhooks" />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard icon={<Webhook className="w-4 h-4" />} label="Paddle Events" value={n(webhooks.paddle?.total)} color="violet" sub="inbound · processed" />
                <StatCard icon={<Globe className="w-4 h-4" />} label="Project Webhooks" value={n(webhooks.project?.total)} color="blue" sub="outbound · configured" />
                <StatCard icon={<CheckCircle className="w-4 h-4" />} label="Recent Deliveries" value={n(webhooks.project?.recentDeliveries?.length)} color="emerald" sub="last 50 attempts" />
              </div>

              {webhooks.project?.webhooks && webhooks.project.webhooks.length > 0 && (
                <Card title="Outbound Project Webhooks" sub={`${webhooks.project.total} configured`}>
                  <div className="space-y-1">
                    {webhooks.project.webhooks.map(wh => (
                      <div key={wh.id} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded transition-colors">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${wh.active ? 'bg-emerald-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' : 'bg-zinc-600'}`} />
                        <span className="text-zinc-200 text-xs font-medium w-32 truncate">{wh.project.name}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide bg-blue-500/10 text-blue-300 border-blue-500/20">
                          {wh.eventType}
                        </span>
                        <span className="text-zinc-500 text-xs font-mono flex-1 truncate">{wh.targetUrl}</span>
                        <span className={`text-[10px] font-semibold uppercase tracking-wide ${wh.active ? 'text-emerald-400' : 'text-zinc-600'}`}>
                          {wh.active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {webhooks.project?.recentDeliveries && webhooks.project.recentDeliveries.length > 0 && (
                <Card title="Recent Deliveries" sub="Last 50 attempts">
                  <div className="space-y-1">
                    {webhooks.project.recentDeliveries.map(d => {
                      const ok = d.status === 'success' || (d.statusCode && d.statusCode < 300)
                      return (
                        <div key={d.id} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold tabular-nums ${ok ? STATUS_COLOR.success : STATUS_COLOR.failed}`}>
                            {d.statusCode ?? d.status}
                          </span>
                          <span className="text-zinc-300 text-xs">{d.eventType}</span>
                          <span className="text-zinc-600 text-xs ml-auto">{ago(d.createdAt)}</span>
                        </div>
                      )
                    })}
                  </div>
                </Card>
              )}

              {webhooks.auditLogs?.length > 0 && (
                <Card title="Webhook Audit Log" sub={`${webhooks.auditLogs.length} entries`}>
                  <AuditTable entries={webhooks.auditLogs} />
                </Card>
              )}
            </div>
          )
        )}

        {/* ════════ AUDIT ════════ */}
        {tab === 'audit' && (
          <div className="space-y-5">
            <SectionHeader title="Audit Log" sub="Compliance-grade record of platform mutations" />

            <Card title="Recent Activity" sub={`Last ${auditLogs.length} platform events`}>
              {loading.audit ? (
                <div className="py-8 flex items-center justify-center">
                  <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
                </div>
              ) : auditLogs.length === 0 ? (
                <EmptyState icon={<FileText className="w-5 h-5" />} text="No audit events recorded yet" sub="Mutations will appear here" />
              ) : (
                <AuditTable entries={auditLogs} />
              )}
            </Card>
          </div>
        )}

        {/* ════════ OPS ════════ */}
        {tab === 'ops' && (
          <div className="space-y-6">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">Operations</h1>
                <p className="text-zinc-500 text-xs mt-1">Manual tools + build-runtime observability</p>
              </div>
              {/* Window selector for build-runtime metrics */}
              <div className="flex items-center gap-1 rounded-lg bg-white/[0.03] border border-white/[0.06] p-1">
                {(['1h', '24h', '7d'] as const).map(w => (
                  <button
                    key={w}
                    onClick={() => { setOperatorWindow(w); fetchOperator(w) }}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                      operatorWindow === w ? 'bg-white/[0.08] text-white' : 'text-zinc-600 hover:text-zinc-400'
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Build-Runtime Observability ─────────────────────────── */}
            {operatorData && (
              <>
                {/* Key metrics */}
                <Card title="Build Runtime" sub={`Last ${operatorWindow} · ${operatorData.builds.correctionEventTotal} correction events`}>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    <UsageStat icon={<Activity className="w-3.5 h-3.5" />} label="Active Builds" value={n(operatorData.builds.activeBuilds)} />
                    <UsageStat icon={<Wrench className="w-3.5 h-3.5" />}   label="Auto-fixes" value={n(operatorData.builds.autoFixCount)} />
                    <UsageStat
                      icon={<RotateCcw className={`w-3.5 h-3.5 ${operatorData.builds.repairLoopCount > 5 ? 'text-red-400' : ''}`} />}
                      label="Repair Loops"
                      value={n(operatorData.builds.repairLoopCount)}
                    />
                    <UsageStat
                      icon={<Shield className={`w-3.5 h-3.5 ${operatorData.approvals.pending > 3 ? 'text-amber-500' : ''}`} />}
                      label="Approvals Pending"
                      value={n(operatorData.approvals.pending)}
                    />
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <UsageStat icon={<Database className="w-3.5 h-3.5" />} label="Mutations" value={n(operatorData.mutations.perDay)} />
                    <UsageStat icon={<Zap className="w-3.5 h-3.5" />}      label="AI Intents" value={n(operatorData.aiUsage.intentCount)} />
                    <UsageStat icon={<CheckCircle className={`w-3.5 h-3.5 ${operatorData.approvals.applied > 0 ? 'text-emerald-400' : ''}`} />} label="Approvals Applied" value={n(operatorData.approvals.applied)} />
                    <UsageStat icon={<XCircle className="w-3.5 h-3.5" />}  label="Approvals Dismissed" value={n(operatorData.approvals.dismissed)} />
                  </div>
                </Card>

                {/* Blocked integrations alert */}
                {operatorData.blockedIntegrations.count > 0 && (
                  <div className="rounded-2xl border border-amber-800/30 bg-amber-950/10 p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      <h2 className="text-sm font-bold text-white">Blocked Integrations — {operatorData.blockedIntegrations.count} credential gates hit</h2>
                    </div>
                    <div className="space-y-2">
                      {operatorData.blockedIntegrations.recent.map((item, i) => (
                        <div key={i} className="flex items-center gap-3 text-[12px]">
                          <span className="font-mono text-amber-500/80">{item.action}</span>
                          <span className="text-zinc-600 font-mono">{item.projectId?.slice(0, 8)}…</span>
                          <span className="text-zinc-700 ml-auto">{ago(item.timestamp)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Top failed intents + domain breakdown */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Card title="Top Failed / Corrected Intents" sub="Most-corrected AI actions">
                    {operatorData.topFailedIntents.length === 0 ? (
                      <p className="text-[12px] text-zinc-600">No correction events in this window</p>
                    ) : (
                      <div className="space-y-2.5">
                        {operatorData.topFailedIntents.map(({ action, count }) => (
                          <div key={action} className="flex items-center justify-between gap-3">
                            <span className="text-[12px] font-mono text-zinc-400 truncate">{action}</span>
                            <span className="text-[12px] font-bold tabular-nums text-white flex-shrink-0">{count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>

                  <Card title="Domain Breakdown" sub="Correction events by backend type">
                    {operatorData.domainBreakdown.length === 0 ? (
                      <p className="text-[12px] text-zinc-600">No domain data in this window</p>
                    ) : (
                      <div className="space-y-2.5">
                        {operatorData.domainBreakdown.map(({ domain, count }) => (
                          <div key={domain} className="flex items-center justify-between gap-3">
                            <span className="text-[12px] text-zinc-400 capitalize">{domain}</span>
                            <span className="text-[12px] font-bold tabular-nums text-white">{count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>

                {/* Correction event timeline */}
                {operatorData.timeline.length > 0 && (
                  <Card title="Correction Events / Hour" sub="Build self-healing activity over time">
                    {(() => {
                      const maxVal = operatorData.timeline.reduce((m, t) => Math.max(m, t.count), 1)
                      return (
                        <div className="space-y-1.5 max-h-52 overflow-y-auto">
                          {operatorData.timeline.slice(-24).map(({ hour, count }) => (
                            <div key={hour} className="flex items-center gap-3">
                              <span className="text-[10px] text-zinc-700 w-12 flex-shrink-0 tabular-nums">{hour.slice(11)}:00</span>
                              <div className="flex-1 h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                                <div className="h-full bg-violet-500/50 rounded-full" style={{ width: `${Math.round((count / maxVal) * 100)}%` }} />
                              </div>
                              <span className="text-[10px] text-zinc-600 w-5 tabular-nums text-right">{count}</span>
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                  </Card>
                )}

                {/* Recent build-runtime audit log */}
                {operatorData.recentAuditLogs.length > 0 && (
                  <Card title="Recent Audit Log" sub="Schema + API mutations in window">
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {operatorData.recentAuditLogs.map(log => (
                        <div key={log.id} className="flex items-start gap-3 py-1.5 border-b border-white/[0.03] last:border-0">
                          <span className="text-[10px] text-zinc-700 flex-shrink-0 tabular-nums pt-0.5">{fmtTime(log.timestamp)}</span>
                          <span className="text-[11px] font-mono text-zinc-400 flex-shrink-0">{log.action}</span>
                          <span className="text-[11px] text-zinc-600 truncate">{log.userEmail ?? log.userId ?? '—'}</span>
                          {log.projectId && <span className="text-[10px] text-zinc-800 font-mono ml-auto flex-shrink-0">{log.projectId.slice(0, 8)}…</span>}
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
              </>
            )}

            {loading['ops'] && !operatorData && (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
              </div>
            )}

            {errors['ops'] && (
              <div className="rounded-xl border border-red-900/30 bg-red-950/10 px-4 py-3 text-[12px] text-red-400 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                {errors['ops']}
              </div>
            )}

            {/* ── Manual tools (unchanged) ────────────────────────────── */}
            <Card title="Operational Tools" sub="One-click admin actions — use with care">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <OpsCard
                  icon={<RotateCcw className="w-5 h-5 text-amber-500" />}
                  title="Sandbox Cleanup"
                  description="Delete all expired sandbox projects and their workspace schemas. Runs automatically every hour via cron."
                  loading={opsLoading['sandbox-cleanup']}
                  result={opsResults['sandbox-cleanup']}
                  onRun={() => opsAction('sandbox-cleanup')}
                  buttonLabel="Run Cleanup Now"
                  buttonColor="amber"
                />
                <OpsCard
                  icon={<Settings className="w-5 h-5 text-blue-400" />}
                  title="Repair API Keys"
                  description="Find API keys missing plaintext values and regenerate them. Used after migrations or key corruption."
                  loading={opsLoading['repair-keys']}
                  result={opsResults['repair-keys']}
                  onRun={() => opsAction('repair-keys')}
                  buttonLabel="Scan & Repair"
                  buttonColor="blue"
                />
              </div>
            </Card>

            {dashboard && (
              <Card title="Platform Snapshot" sub="Live counts">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <UsageStat icon={<Shield className="w-3.5 h-3.5" />} label="API Keys" value={n(dashboard.apiKeys.total)} />
                  <UsageStat icon={<Webhook className="w-3.5 h-3.5" />} label="Paddle Events" value={n(dashboard.webhooks.processedEvents)} />
                  <UsageStat icon={<Ban className="w-3.5 h-3.5" />} label="Suspended Users" value={n(dashboard.users.suspended)} />
                  <UsageStat icon={<Rocket className="w-3.5 h-3.5" />} label="Deployed" value={n(dashboard.projects.deployed)} />
                </div>
              </Card>
            )}

            <Card title="System Info">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <InfoRow icon={<Server className="w-3.5 h-3.5" />} label="Environment" value="production" />
                <InfoRow icon={<Globe className="w-3.5 h-3.5" />} label="Region" value="hetzner-eu" />
                <InfoRow icon={<Database className="w-3.5 h-3.5" />} label="Database" value="postgres-15" />
              </div>
            </Card>
          </div>
        )}

        {/* ════════ SYSTEM (Phase F — reliability & cost) ════════ */}
        {tab === 'system' && (
          loading.system && !system ? <Skeleton /> : system && (
            <div className="space-y-6">
              <SectionHeader title="System" sub="OpenAI spend & margin, live infra, noisy tenants, schema health, deploys" />

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard icon={<DollarSign className="w-4 h-4" />} label="AI Spend 30d" value={`$${system.aiCost.spend30dUsd.toLocaleString()}`} color="amber" sub={`${n(system.aiCost.tokens30d)} tokens`} />
                <StatCard icon={<DollarSign className="w-4 h-4" />} label="AI Spend (mo)" value={`$${system.aiCost.spendMonthUsd.toLocaleString()}`} color="blue" sub="this month" />
                <StatCard icon={<TrendingUp className="w-4 h-4" />} label="MRR" value={`$${system.aiCost.mrrUsd.toLocaleString()}`} color="emerald" sub="active + grace" />
                <StatCard
                  icon={system.aiCost.marginUsd >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  label="Margin (mo)"
                  value={`$${system.aiCost.marginUsd.toLocaleString()}`}
                  color={system.aiCost.marginUsd >= 0 ? 'emerald' : 'red'}
                  sub={system.aiCost.marginUsd >= 0 ? 'MRR − AI cost' : '⚠ AI cost > MRR'}
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card title="AI Cost by Model" sub="Last 30 days">
                  {system.aiCost.byModel.length === 0 ? (
                    <EmptyState icon={<Sparkles className="w-5 h-5" />} text="No AI cost recorded" />
                  ) : (
                    <div className="space-y-2">
                      {system.aiCost.byModel.map(m => {
                        const max = system.aiCost.byModel[0].costUsd || 1
                        return (
                          <div key={m.model} className="flex items-center gap-3">
                            <span className="text-zinc-300 text-xs w-40 truncate font-mono">{m.model}</span>
                            <div className="flex-1 h-5 bg-white/[0.04] rounded overflow-hidden">
                              <div className="h-full bg-gradient-to-r from-amber-700 to-amber-500 rounded" style={{ width: `${Math.max((m.costUsd / max) * 100, 2)}%` }} />
                            </div>
                            <span className="text-zinc-300 text-xs font-bold w-16 text-right tabular-nums">${m.costUsd.toFixed(2)}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <p className="text-[11px] text-zinc-600 mt-3">{system.aiCost.note}</p>
                </Card>

                <Card title="Top Cost Projects" sub="Last 7 days — your most expensive tenants">
                  {system.aiCost.topProjects.length === 0 ? (
                    <EmptyState icon={<Layers className="w-5 h-5" />} text="No project AI cost" />
                  ) : (
                    <div className="space-y-1">
                      {system.aiCost.topProjects.map(p => (
                        <div key={p.projectId} onClick={() => p.ownerUserId && openUser(p.ownerUserId)} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded cursor-pointer transition-colors">
                          <div className="min-w-0 flex-1">
                            <div className="text-zinc-200 text-xs truncate">{p.projectName}</div>
                            <div className="text-zinc-600 text-[10px]">{p.ownerEmail ?? '—'} · {n(p.tokens)} tokens</div>
                          </div>
                          <span className="text-amber-500 text-xs font-bold tabular-nums">${p.costUsd.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>

              <Card title="Live Infrastructure" sub="Right now">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <UsageStat
                    icon={<Database className={`w-3.5 h-3.5 ${system.metrics.db.max > 0 && system.metrics.db.connections / system.metrics.db.max > 0.8 ? 'text-red-400' : ''}`} />}
                    label="DB Connections"
                    value={`${system.metrics.db.connections}/${system.metrics.db.max || '?'}`}
                  />
                  <UsageStat icon={<Loader2 className="w-3.5 h-3.5" />} label="Jobs Queued" value={n((system.metrics.jobs.queued ?? 0) + (system.metrics.jobs.running ?? 0))} />
                  <UsageStat icon={<XCircle className={`w-3.5 h-3.5 ${system.metrics.errors24h > 0 ? 'text-red-400' : ''}`} />} label="Errors 24h" value={n(system.metrics.errors24h)} />
                  <UsageStat icon={<Layers className="w-3.5 h-3.5" />} label="Workspace Schemas" value={n(system.metrics.workspaceSchemas)} />
                </div>
                {(system.metrics.jobs.failed || system.metrics.jobs.dead_letter) && (
                  <div className="mt-3 text-[11px] text-red-300/80">
                    {n(system.metrics.jobs.failed ?? 0)} failed · {n(system.metrics.jobs.dead_letter ?? 0)} dead-letter background jobs
                  </div>
                )}
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card title="Noisy Neighbors" sub="Top tenants by DB writes — last 7 days">
                  {system.noisyNeighbors.length === 0 ? (
                    <EmptyState icon={<Activity className="w-5 h-5" />} text="No write activity" />
                  ) : (
                    <div className="space-y-1">
                      {system.noisyNeighbors.map((nn, i) => (
                        <div key={i} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0">
                          <span className="text-zinc-600 text-xs w-4 text-right tabular-nums">{i + 1}</span>
                          <span className="text-zinc-200 text-xs flex-1 truncate">{nn.projectName}</span>
                          <span className="text-zinc-500 text-[11px] tabular-nums">{n(nn.apiCalls)} API</span>
                          <span className="text-zinc-300 text-xs font-bold tabular-nums w-20 text-right">{n(nn.dbWrites)} writes</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card title="Workspace Schema Health" sub={`${fmtBytes(system.schemaHealth.totalBytes)} total · ${system.schemaHealth.orphanCount} orphaned`}>
                  {system.schemaHealth.schemas.length === 0 ? (
                    <EmptyState icon={<Database className="w-5 h-5" />} text="No workspace schemas" />
                  ) : (
                    <div className="space-y-1 max-h-72 overflow-y-auto">
                      {system.schemaHealth.schemas.map(s => (
                        <div key={s.schema} className="flex items-center gap-3 py-1.5 border-b border-white/[0.03] last:border-0">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.orphaned ? 'bg-red-400' : 'bg-emerald-500'}`} />
                          <span className="text-zinc-400 text-[11px] font-mono flex-1 truncate">{s.projectId.slice(0, 18)}</span>
                          {s.orphaned && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/20 font-semibold uppercase">Orphan</span>}
                          <span className="text-zinc-300 text-xs font-bold tabular-nums w-16 text-right">{fmtBytes(s.bytes)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>

              <Card title="Deployment Board" sub={`${system.deployments.failed7d} failed in last 7d · last ${system.deployments.recent.length} deploys`}>
                {system.deployments.recent.length === 0 ? (
                  <EmptyState icon={<Rocket className="w-5 h-5" />} text="No deployments yet" />
                ) : (
                  <div className="space-y-1">
                    {system.deployments.recent.map(d => {
                      const ok = d.status === 'success' || d.status === 'completed' || d.status === 'deployed' || d.status === 'live'
                      const failed = d.status === 'failed' || d.status === 'error'
                      return (
                        <div key={d.id} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded transition-colors">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide flex-shrink-0 ${
                            ok ? STATUS_COLOR.success : failed ? STATUS_COLOR.failed : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                          }`}>{d.status}</span>
                          <span className="text-zinc-500 text-[10px] uppercase tracking-wide flex-shrink-0">{d.environment}</span>
                          <span className="text-zinc-400 text-[11px] font-mono flex-1 truncate">{d.projectId.slice(0, 12)}{d.errorMessage ? ` — ${d.errorMessage.slice(0, 80)}` : ''}</span>
                          {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300 text-[11px] flex-shrink-0 flex items-center gap-0.5">open<ExternalLink className="w-2.5 h-2.5" /></a>}
                          {d.duration != null && <span className="text-zinc-600 text-[10px] flex-shrink-0 tabular-nums">{(d.duration / 1000).toFixed(1)}s</span>}
                          <span className="text-zinc-600 text-[11px] flex-shrink-0">{ago(d.at)}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Card>
            </div>
          )
        )}

        {/* ════════ REVENUE (Phase E — revenue movement + retention ops) ════════ */}
        {tab === 'revenue' && (
          loading.revenue && !revenue ? <Skeleton /> : revenue && (
            <div className="space-y-6">
              <SectionHeader title="Revenue & Retention" sub="MRR movement, conversion, dunning & comp tools" />

              {revActionMsg && (
                <div className={`px-3 py-2 rounded-lg text-xs flex items-center gap-2 ${
                  revActionMsg.startsWith('Error') ? 'bg-red-500/10 text-red-300 border border-red-500/20' : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                }`}>
                  {revActionMsg.startsWith('Error') ? <XCircle className="w-3.5 h-3.5" /> : <CheckCircle className="w-3.5 h-3.5" />}
                  <span>{revActionMsg}</span>
                </div>
              )}

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard icon={<DollarSign className="w-4 h-4" />} label="MRR" value={cents(revenue.mrr.totalCents)} color="emerald" sub="active + grace" />
                <StatCard
                  icon={revenue.mrr.movement.net >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  label="Net Subs / mo"
                  value={`${revenue.mrr.movement.net >= 0 ? '+' : ''}${revenue.mrr.movement.net}`}
                  color={revenue.mrr.movement.net >= 0 ? 'emerald' : 'red'}
                  sub={`+${revenue.mrr.movement.newThisMonth} new · -${revenue.mrr.movement.churnedThisMonth} churned`}
                />
                <StatCard icon={<Users className="w-4 h-4" />} label="Free→Paid" value={`${revenue.conversion.conversionPct}%`} color="violet" sub={`${revenue.conversion.paidUsers}/${revenue.conversion.totalUsers} users`} />
                <StatCard icon={<Sparkles className="w-4 h-4" />} label="ARPU / LTV" value={cents(revenue.economics.arpuCents)} color="blue" sub={`LTV ~${cents(revenue.economics.ltvCents)}`} />
              </div>

              {revenue.mrr.byPlan.length > 0 && (
                <Card title="MRR by Plan" sub="Active + grace subscriptions">
                  <div className="space-y-3">
                    {revenue.mrr.byPlan.map(p => (
                      <div key={p.plan} className="flex items-center gap-3">
                        <div className="w-24 text-xs text-zinc-300 font-semibold truncate">{p.plan}</div>
                        <div className="flex-1 h-7 bg-white/[0.03] rounded-md overflow-hidden border border-white/[0.04]">
                          <div className="h-full bg-gradient-to-r from-emerald-700 via-emerald-600 to-emerald-500 transition-all duration-500" style={{ width: `${Math.min(100, (p.mrrCents / (revenue.mrr.totalCents || 1)) * 100)}%` }} />
                        </div>
                        <div className="text-zinc-200 text-xs font-bold w-20 text-right tabular-nums">{cents(p.mrrCents)}/mo</div>
                        <div className="text-zinc-500 text-xs w-16 text-right tabular-nums">{p.count} sub{p.count === 1 ? '' : 's'}</div>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-zinc-600 mt-3">{revenue.economics.ltvNote}</p>
                </Card>
              )}

              <Card title="Comp a User" sub="Grant a paid plan for free (no Paddle) — or revert to FREE">
                <div className="grid grid-cols-1 md:grid-cols-[1fr_140px_auto_auto] gap-2">
                  <input
                    type="text"
                    placeholder="User ID (UUID)"
                    value={compForm.userId}
                    onChange={e => setCompForm({ ...compForm, userId: e.target.value })}
                    className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono outline-none focus:border-violet-500/50"
                  />
                  <select
                    value={compForm.planName}
                    onChange={e => setCompForm({ ...compForm, planName: e.target.value })}
                    className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                  >
                    {['STARTER', 'GROWTH', 'PRO', 'ENTERPRISE'].map(p => <option key={p} value={p} className="bg-zinc-900">{p}</option>)}
                  </select>
                  <button
                    onClick={() => billingAction({ action: 'comp', userId: compForm.userId.trim(), planName: compForm.planName }, 'comp')}
                    disabled={revBusy === 'comp' || !compForm.userId.trim()}
                    className="px-3 py-2 rounded-lg text-xs font-semibold bg-white/[0.06] text-violet-300 hover:bg-white/[0.10] border border-white/[0.14] disabled:opacity-50 transition-colors"
                  >
                    Comp
                  </button>
                  <button
                    onClick={() => billingAction({ action: 'uncomp', userId: compForm.userId.trim() }, 'uncomp')}
                    disabled={revBusy === 'uncomp' || !compForm.userId.trim()}
                    className="px-3 py-2 rounded-lg text-xs font-semibold bg-white/[0.05] text-zinc-300 hover:bg-white/[0.1] border border-white/[0.08] disabled:opacity-50 transition-colors"
                  >
                    Revert FREE
                  </button>
                </div>
              </Card>

              <Card title="Dunning" sub={`${revenue.dunning.length} subscription(s) in grace / past-due — act before they churn`}>
                {revenue.dunning.length === 0 ? (
                  <EmptyState icon={<CheckCircle className="w-5 h-5 text-emerald-400" />} text="No dunning" sub="No subscriptions in grace or past-due" />
                ) : (
                  <div className="overflow-x-auto -mx-6 px-6">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-white/[0.06]">
                          {['User', 'Plan', 'Status', 'Grace Until', 'Actions'].map(h => (
                            <th key={h} className="text-left py-2.5 pr-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {revenue.dunning.map((d, i) => (
                          <tr key={i} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
                            <td className="py-3 pr-4">
                              <div onClick={() => openUser(d.userId)} className="text-white text-xs font-semibold cursor-pointer hover:text-violet-300">{d.userName || d.userEmail}</div>
                              {d.userName && <div className="text-zinc-500 text-[11px]">{d.userEmail}</div>}
                            </td>
                            <td className="py-3 pr-4 text-zinc-300 text-xs font-medium">{d.plan}</td>
                            <td className="py-3 pr-4">
                              <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide ${STATUS_COLOR[d.status] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>{d.status}</span>
                            </td>
                            <td className="py-3 pr-4 text-zinc-500 text-xs">{d.graceUntil ? fmtDate(d.graceUntil) : '—'}</td>
                            <td className="py-3">
                              <div className="flex items-center gap-1.5">
                                <button onClick={() => billingAction({ action: 'extend_grace', userId: d.userId, days: 7 }, `g_${d.userId}`)} disabled={revBusy === `g_${d.userId}`}
                                  className="text-[11px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20 hover:bg-amber-500/20 disabled:opacity-50 transition-colors">+7d grace</button>
                                <button onClick={() => billingAction({ action: 'cancel', userId: d.userId }, `c_${d.userId}`)} disabled={revBusy === `c_${d.userId}`}
                                  className="text-[11px] px-2 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/20 hover:bg-red-500/20 disabled:opacity-50 transition-colors">Cancel</button>
                                <button onClick={() => billingAction({ action: 'refund_link', userId: d.userId }, `r_${d.userId}`)} disabled={revBusy === `r_${d.userId}`}
                                  className="text-[11px] px-2 py-0.5 rounded bg-white/[0.05] text-zinc-400 border border-white/[0.06] hover:bg-white/[0.1] disabled:opacity-50 transition-colors flex items-center gap-1">
                                  Refund<ExternalLink className="w-2.5 h-2.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          )
        )}

        {/* ════════ FEEDBACK (Phase D — product roadmap signal) ════════ */}
        {tab === 'feedback' && (
          loading.feedback && !feedback ? <Skeleton /> : feedback && (
            <div className="space-y-6">
              <SectionHeader title="Product Feedback" sub="Direct user submissions · what users ask for that we don't do · what they build · who churned" />

              {/* Direct user submissions — Settings → Contact support / Request a feature */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card title={`Feature Requests (${feedback.featureRequests.length})`} sub="Submitted via Settings → Request a feature">
                  {feedback.featureRequests.length === 0 ? (
                    <EmptyState icon={<Sparkles className="w-5 h-5" />} text="No feature requests yet" sub="Users haven't asked for anything via the in-app form" />
                  ) : (
                    <div className="space-y-1 max-h-[420px] overflow-y-auto -mx-2 pr-1">
                      {feedback.featureRequests.map(f => (
                        <div key={f.id} className="py-2.5 px-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] rounded transition-colors">
                          <div className="flex items-start justify-between gap-3 mb-1">
                            <div className="text-[12.5px] font-semibold text-white leading-tight flex-1 min-w-0">{f.title}</div>
                            <span className="text-[10px] px-2 py-0.5 rounded-md border font-semibold uppercase tracking-wide bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/20 flex-shrink-0">{f.status}</span>
                          </div>
                          <div className="text-[11.5px] text-white/55 leading-snug whitespace-pre-wrap mb-1.5">{f.body}</div>
                          <div className="flex items-center gap-2 text-[10.5px] text-white/35">
                            <span>{f.userName || f.userEmail}</span>
                            <span>·</span>
                            <span>{new Date(f.createdAt).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card title={`Support Tickets (${feedback.supportTickets.length})`} sub="Submitted via Settings → Contact support">
                  {feedback.supportTickets.length === 0 ? (
                    <EmptyState icon={<MessageSquare className="w-5 h-5" />} text="No support tickets" sub="No one has reached out via the in-app form" />
                  ) : (
                    <div className="space-y-1 max-h-[420px] overflow-y-auto -mx-2 pr-1">
                      {feedback.supportTickets.map(t => (
                        <div key={t.id} className="py-2.5 px-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] rounded transition-colors">
                          <div className="flex items-start justify-between gap-3 mb-1">
                            <div className="text-[12.5px] font-semibold text-white leading-tight flex-1 min-w-0">{t.subject}</div>
                            <span className="text-[10px] px-2 py-0.5 rounded-md border font-semibold uppercase tracking-wide bg-emerald-500/10 text-emerald-300 border-emerald-500/20 flex-shrink-0">{t.status}</span>
                          </div>
                          <div className="text-[11.5px] text-white/55 leading-snug whitespace-pre-wrap mb-1.5">{t.message}</div>
                          <div className="flex items-center gap-2 text-[10.5px] text-white/35">
                            <button onClick={() => openUser(t.userId)} className="hover:text-white/70 transition-colors">{t.userName || t.userEmail}</button>
                            <span>·</span>
                            <span>{new Date(t.createdAt).toLocaleString()}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card title="Unsupported Requests by Category" sub="Your roadmap, ranked by demand">
                  {feedback.unsupportedByCategory.length === 0 ? (
                    <EmptyState icon={<CheckCircle className="w-5 h-5 text-emerald-400" />} text="No unsupported requests logged" sub="Users aren't asking for things we refuse — yet" />
                  ) : (
                    <div className="space-y-2">
                      {feedback.unsupportedByCategory.map((c, i) => {
                        const max = feedback.unsupportedByCategory[0].count
                        const pct = Math.round((c.count / max) * 100)
                        return (
                          <div key={c.category} className="flex items-center gap-3">
                            <span className="text-zinc-600 text-xs w-4 text-right tabular-nums">{i + 1}</span>
                            <span className="text-zinc-300 text-xs w-36 truncate">{c.category}</span>
                            <div className="flex-1 h-5 bg-white/[0.04] rounded overflow-hidden">
                              <div className="h-full bg-gradient-to-r from-amber-700 via-amber-600 to-amber-500 rounded transition-all duration-500" style={{ width: `${Math.max(pct, 3)}%` }} />
                            </div>
                            <span className="text-zinc-400 text-xs font-bold w-8 text-right tabular-nums">{c.count}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </Card>

                <Card title="What Users Build" sub="Backend categories — last 90 days">
                  {feedback.topCategories.length === 0 ? (
                    <EmptyState icon={<Database className="w-5 h-5" />} text="No backends generated yet" />
                  ) : (
                    <div className="space-y-2">
                      {feedback.topCategories.map((c, i) => {
                        const max = feedback.topCategories[0].count
                        const pct = Math.round((c.count / max) * 100)
                        return (
                          <div key={c.category} className="flex items-center gap-3">
                            <span className="text-zinc-600 text-xs w-4 text-right tabular-nums">{i + 1}</span>
                            <span className="text-zinc-300 text-xs w-32 truncate">{c.category}</span>
                            <div className="flex-1 h-5 bg-white/[0.04] rounded overflow-hidden">
                              <div className="h-full bg-gradient-to-r from-blue-700 via-blue-600 to-blue-500 rounded transition-all duration-500" style={{ width: `${Math.max(pct, 3)}%` }} />
                            </div>
                            <span className="text-zinc-400 text-xs font-bold w-8 text-right tabular-nums">{c.count}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </Card>
              </div>

              {feedback.categoryTrends.length > 0 && (
                <Card title="Category Trend by Month" sub="What users build, over time">
                  <div className="space-y-2">
                    {feedback.categoryTrends.map(m => {
                      const sorted = Object.entries(m.categories).sort((a, b) => b[1] - a[1])
                      return (
                        <div key={m.month} className="flex items-center gap-3">
                          <span className="text-zinc-500 text-[11px] w-16 tabular-nums">{m.month}</span>
                          <div className="flex-1 flex h-5 rounded overflow-hidden bg-white/[0.03]">
                            {sorted.map(([cat, cnt], idx) => {
                              const colors = ['bg-violet-600', 'bg-blue-600', 'bg-emerald-600', 'bg-amber-600', 'bg-pink-600', 'bg-cyan-600', 'bg-zinc-600']
                              return (
                                <div key={cat} className={`${colors[idx % colors.length]} h-full`} style={{ width: `${(cnt / m.total) * 100}%` }} title={`${cat}: ${cnt}`} />
                              )
                            })}
                          </div>
                          <span className="text-zinc-400 text-xs font-bold w-8 text-right tabular-nums">{m.total}</span>
                        </div>
                      )
                    })}
                  </div>
                </Card>
              )}

              <Card title="Recent Unsupported Requests" sub={`${feedback.unsupported.length} — what users typed that we refuse`}>
                {feedback.unsupported.length === 0 ? (
                  <EmptyState icon={<MessageSquare className="w-5 h-5" />} text="Nothing logged yet" />
                ) : (
                  <div className="space-y-1">
                    {feedback.unsupported.map(u => (
                      <div key={u.id} className="flex items-start gap-3 py-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded transition-colors">
                        <span className="text-[10px] px-2 py-0.5 rounded-md border font-semibold uppercase tracking-wide bg-amber-500/10 text-amber-500 border-amber-500/20 flex-shrink-0 mt-0.5">{u.category}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-zinc-200 text-xs">{u.promptExcerpt}</div>
                          <div className="text-zinc-600 text-[10px] mt-0.5">
                            {u.userEmail ?? 'unknown'}{u.projectName ? ` · ${u.projectName}` : ''}
                          </div>
                        </div>
                        <span className="text-zinc-600 text-[11px] flex-shrink-0 mt-0.5">{ago(u.at)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Churn" sub={feedback.churnNote}>
                {feedback.churn.length === 0 ? (
                  <EmptyState icon={<CheckCircle className="w-5 h-5 text-emerald-400" />} text="No churned subscriptions" sub="Nobody has canceled or gone past-due" />
                ) : (
                  <div className="overflow-x-auto -mx-6 px-6">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-white/[0.06]">
                          {['User', 'Plan', 'Status', 'Days Active', 'Ended'].map(h => (
                            <th key={h} className="text-left py-2.5 pr-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {feedback.churn.map((c, i) => (
                          <tr key={i} onClick={() => openUser(c.userId)} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.03] cursor-pointer transition-colors">
                            <td className="py-3 pr-4">
                              <div className="text-white text-xs font-semibold">{c.userName || c.userEmail}</div>
                              {c.userName && <div className="text-zinc-500 text-[11px]">{c.userEmail}</div>}
                            </td>
                            <td className="py-3 pr-4 text-zinc-300 text-xs font-medium">{c.plan}</td>
                            <td className="py-3 pr-4">
                              <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide ${STATUS_COLOR[c.status] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>{c.status}</span>
                            </td>
                            <td className="py-3 pr-4 text-zinc-300 text-xs tabular-nums">{c.daysActive}d</td>
                            <td className="py-3 text-zinc-500 text-xs">{ago(c.endedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          )
        )}

        {/* ════════ AGENTS — what coding agents executed, and how it landed ════════ */}
        {tab === 'agents' && (
          loading.agents && !agentOps ? <Skeleton /> : errors.agents ? (
            <Card title="Agents" sub="Failed to load">
              <EmptyState icon={<Bot className="w-5 h-5" />} text={`Error: ${errors.agents}`} />
            </Card>
          ) : agentOps && (
            <div className="space-y-6">
              <div className="flex items-end justify-between gap-4 flex-wrap">
                <SectionHeader
                  title="Agent Operations"
                  sub="Work executed against live backends through an MCP key — Claude Code, Cursor, Codex, Cline. Not projects created or deployed: operations performed."
                />
                <div className="flex items-center gap-1 bg-white/[0.04] rounded-lg p-1 border border-white/[0.06]">
                  {([30, 90, 365] as const).map(d => (
                    <button
                      key={d}
                      onClick={() => setAgentDays(d)}
                      className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                        agentDays === d ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {d === 365 ? '1y' : `${d}d`}
                    </button>
                  ))}
                </div>
              </div>

              {/* The headline row — the four numbers an external claim is built from. */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                  icon={<GitCommitHorizontal className="w-4 h-4" />}
                  label="Schema Changes"
                  value={n(agentOps.totals.schemaStatements)}
                  color="violet"
                  sub={`${n(agentOps.totals.schemaOps)} calls · statements is the change count`}
                />
                <StatCard
                  icon={<CheckCircle className="w-4 h-4" />}
                  label="Landed Clean"
                  value={agentOps.integrity.cleanRate === null ? '—' : `${agentOps.integrity.cleanRate}%`}
                  color={
                    agentOps.integrity.cleanRate === null ? 'zinc'
                    : agentOps.integrity.cleanRate >= 100 ? 'emerald'
                    : agentOps.integrity.cleanRate >= 99 ? 'amber' : 'red'
                  }
                  sub={`${n(agentOps.integrity.integrityEvents)} of ${n(agentOps.totals.applied + agentOps.totals.unresolved)} writes needed undoing`}
                />
                <StatCard
                  icon={<Users className="w-4 h-4" />}
                  label="Users w/ Agents"
                  value={n(agentOps.totals.activeUsers)}
                  color="blue"
                  sub={`${n(agentOps.totals.activeProjects)} projects · ${n(agentOps.totals.activeClients)} clients`}
                />
                <StatCard
                  icon={<ShieldCheck className="w-4 h-4" />}
                  label="Guardrail Stops"
                  value={n(agentOps.totals.refused)}
                  color="amber"
                  sub="refused before anything changed"
                />
              </div>

              {/* Outcome ledger. Named for what each bucket means, because the
                  difference between "refused" and "unresolved" is the whole
                  safety story and a generic "failed" column erases it. */}
              <Card
                title="Outcome of every agent write"
                sub={`${n(agentOps.totals.ops)} write operations in the last ${agentOps.window.days} days · ${n(agentOps.totals.reads)} reads excluded`}
              >
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <OutcomeStat label="Applied" value={agentOps.totals.applied} tone="emerald" note="Tool reported success — the change is in." />
                  <OutcomeStat label="Refused" value={agentOps.totals.refused} tone="zinc" note="A gate stopped it. Nothing was applied." />
                  <OutcomeStat label="Unresolved" value={agentOps.totals.unresolved} tone="amber" note="Multi-step run stopped part-way. May have half-applied." />
                  <OutcomeStat label="Errored" value={agentOps.totals.errored} tone="red" note="The platform itself failed (5xx)." />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                  <UsageStat icon={<Database className="w-3.5 h-3.5" />} label="Schema" value={n(agentOps.totals.schemaOps)} />
                  <UsageStat icon={<Shield className="w-3.5 h-3.5" />} label="Policy / RLS" value={n(agentOps.totals.policyOps)} />
                  <UsageStat icon={<Layers className="w-3.5 h-3.5" />} label="Row writes" value={n(agentOps.totals.dataOps)} />
                  <UsageStat icon={<MessageSquare className="w-3.5 h-3.5" />} label="backend_chat" value={n(agentOps.totals.chatOps)} />
                </div>
              </Card>

              {/* Integrity — the evidence behind a "no corruption" statement. */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card title="Data integrity" sub="Everything on record that argues against a clean landing">
                  <div className="grid grid-cols-2 gap-3">
                    <UsageStat icon={<RotateCcw className="w-3.5 h-3.5" />} label="Rollbacks" value={n(agentOps.integrity.rollbacks)} />
                    <UsageStat icon={<XCircle className="w-3.5 h-3.5" />} label="Failed rollbacks" value={n(agentOps.integrity.failedRollbacks)} />
                    <UsageStat icon={<RotateCcw className="w-3.5 h-3.5" />} label="Reverted intents" value={n(agentOps.integrity.rolledBackIntents)} />
                    <UsageStat icon={<AlertTriangle className="w-3.5 h-3.5" />} label="Critical findings" value={n(agentOps.integrity.criticalFindings)} />
                  </div>
                  <p className="text-[11px] text-zinc-600 mt-3 leading-relaxed">
                    Critical findings are context on projects with agent traffic — the detectors
                    record no cause, so they are not attributed to agents.
                  </p>
                </Card>

                <Card
                  title="Guardrails that fired"
                  sub="Why refused operations were refused"
                >
                  {agentOps.guardrails.length === 0 ? (
                    <EmptyState icon={<ShieldCheck className="w-5 h-5" />} text="No refusals in this window" />
                  ) : (
                    <div className="space-y-2">
                      {agentOps.guardrails.slice(0, 8).map(g => {
                        const max = agentOps.guardrails[0].count || 1
                        return (
                          <div key={g.code} className="flex items-center gap-3">
                            <span className="text-zinc-300 text-[11px] w-52 truncate" title={g.code}>{g.label}</span>
                            <div className="flex-1 h-4 bg-white/[0.04] rounded overflow-hidden">
                              <div className="h-full bg-amber-500/60 rounded" style={{ width: `${Math.max((g.count / max) * 100, 2)}%` }} />
                            </div>
                            <span className="text-zinc-300 text-xs font-mono tabular-nums w-12 text-right">{n(g.count)}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </Card>
              </div>

              {/* Unresolved runs. Listed one by one on purpose: a zero-corruption
                  claim is only as good as someone having read each of these. */}
              {agentOps.integrity.unresolvedRuns.length > 0 && (
                <Card
                  title="Unresolved runs — review before claiming zero corruption"
                  sub="Multi-step operations that stopped part-way. The usage row does not record how far they got."
                >
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-white/[0.06]">
                          <th className="pb-2 text-zinc-500 text-[10px] uppercase tracking-[0.12em] font-semibold">When</th>
                          <th className="pb-2 text-zinc-500 text-[10px] uppercase tracking-[0.12em] font-semibold">Project</th>
                          <th className="pb-2 text-zinc-500 text-[10px] uppercase tracking-[0.12em] font-semibold">Client</th>
                          <th className="pb-2 text-zinc-500 text-[10px] uppercase tracking-[0.12em] font-semibold">Tool</th>
                          <th className="pb-2 text-zinc-500 text-[10px] uppercase tracking-[0.12em] font-semibold">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agentOps.integrity.unresolvedRuns.map(r => (
                          <tr key={r.id} className="border-b border-white/[0.04] last:border-0">
                            <td className="py-2.5 text-zinc-500 text-[11px] whitespace-nowrap">{ago(r.at)}</td>
                            <td className="py-2.5 text-zinc-200 text-[11px] max-w-[160px] truncate">
                              {r.projectName ?? '—'}
                              <div className="text-zinc-600 text-[10px]">{r.ownerEmail ?? '—'}</div>
                            </td>
                            <td className="py-2.5 text-zinc-400 text-[11px] max-w-[140px] truncate">{r.client}</td>
                            <td className="py-2.5"><Pill>{r.tool}</Pill></td>
                            <td className="py-2.5 text-zinc-400 text-[11px] max-w-[380px] truncate" title={r.summary}>
                              <span className="text-amber-500/90 font-mono text-[10px]">{r.code || r.statusCode}</span>
                              {r.summary ? ` · ${r.summary}` : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              {/* The per-user / per-project breakdown the tab exists for. */}
              <Card
                title="Breakdown"
                sub="Same ledger, sliced four ways"
                action={
                  <div className="flex items-center gap-1 bg-white/[0.04] rounded-lg p-1 border border-white/[0.06]">
                    {(['project', 'user', 'client', 'tool'] as const).map(b => (
                      <button
                        key={b}
                        onClick={() => setAgentBreakdown(b)}
                        className={`px-3 py-1 rounded-md text-[11px] font-medium capitalize transition-colors ${
                          agentBreakdown === b ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                }
              >
                {agentBreakdown === 'project' && (
                  agentOps.byProject.length === 0
                    ? <EmptyState icon={<Layers className="w-5 h-5" />} text="No agent traffic on any project in this window" />
                    : <AgentTable
                        head={['Project', 'Owner', 'Schema', 'Policy', 'Rows', 'Applied', 'Refused', 'Unresolved', 'Integrity', 'Last']}
                        rows={agentOps.byProject.map(p => ({
                          key: p.projectId,
                          onClick: () => openUser(p.ownerUserId),
                          cells: [
                            { v: p.name, sub: `${p.clientCount} client${p.clientCount === 1 ? '' : 's'}${p.isDeployed ? ' · deployed' : ''}`, wide: true },
                            { v: p.ownerEmail ?? '—', muted: true },
                            { v: n(p.schemaStatements), sub: `${n(p.schemaOps)} calls`, mono: true },
                            { v: n(p.policyOps), mono: true },
                            { v: n(p.dataOps), mono: true },
                            { v: n(p.applied), mono: true, tone: 'emerald' },
                            { v: n(p.refused), mono: true, muted: true },
                            { v: n(p.unresolved), mono: true, tone: p.unresolved > 0 ? 'amber' : undefined },
                            { v: n(p.integrityEvents), mono: true, tone: p.integrityEvents > 0 ? 'red' : undefined },
                            { v: ago(p.lastAt), muted: true },
                          ],
                        }))}
                      />
                )}

                {agentBreakdown === 'user' && (
                  agentOps.byUser.length === 0
                    ? <EmptyState icon={<Users className="w-5 h-5" />} text="No user ran an agent in this window" />
                    : <AgentTable
                        head={['User', 'Tier', 'Projects', 'Schema', 'Policy', 'Rows', 'Applied', 'Refused', 'Unresolved', 'Last']}
                        rows={agentOps.byUser.map(u => ({
                          key: u.userId,
                          onClick: () => openUser(u.userId),
                          cells: [
                            { v: u.email ?? u.userId, sub: u.clients.join(', '), wide: true },
                            { v: (u.tier ?? 'free').toUpperCase(), muted: true },
                            { v: n(u.projectCount), mono: true },
                            { v: n(u.schemaStatements), sub: `${n(u.schemaOps)} calls`, mono: true },
                            { v: n(u.policyOps), mono: true },
                            { v: n(u.dataOps), mono: true },
                            { v: n(u.applied), mono: true, tone: 'emerald' },
                            { v: n(u.refused), mono: true, muted: true },
                            { v: n(u.unresolved), mono: true, tone: u.unresolved > 0 ? 'amber' : undefined },
                            { v: ago(u.lastAt), muted: true },
                          ],
                        }))}
                      />
                )}

                {agentBreakdown === 'client' && (
                  agentOps.byClient.length === 0
                    ? <EmptyState icon={<Bot className="w-5 h-5" />} text="No MCP client has connected in this window" />
                    : <AgentTable
                        head={['Client', 'Users', 'Projects', 'Writes', 'Schema', 'Applied', 'Refused', 'Unresolved', 'Reads', 'Last']}
                        rows={agentOps.byClient.map(c => ({
                          key: c.client,
                          cells: [
                            { v: c.client, wide: true },
                            { v: n(c.userCount), mono: true },
                            { v: n(c.projectCount), mono: true },
                            { v: n(c.ops), mono: true },
                            { v: n(c.schemaStatements), sub: `${n(c.schemaOps)} calls`, mono: true },
                            { v: n(c.applied), mono: true, tone: 'emerald' },
                            { v: n(c.refused), mono: true, muted: true },
                            { v: n(c.unresolved), mono: true, tone: c.unresolved > 0 ? 'amber' : undefined },
                            { v: n(c.reads), mono: true, muted: true },
                            { v: ago(c.lastAt), muted: true },
                          ],
                        }))}
                      />
                )}

                {agentBreakdown === 'tool' && (
                  agentOps.byTool.length === 0
                    ? <EmptyState icon={<Terminal className="w-5 h-5" />} text="No write tool was called in this window" />
                    : <AgentTable
                        head={['Tool', 'Kind', 'Calls', 'Statements', 'Applied', 'Refused', 'Unresolved', 'Errored', 'Last']}
                        rows={agentOps.byTool.map(t => ({
                          key: t.tool,
                          cells: [
                            { v: t.tool, mono: true, wide: true },
                            { v: t.kind, muted: true },
                            { v: n(t.ops), mono: true },
                            { v: n(t.statements), mono: true },
                            { v: n(t.applied), mono: true, tone: 'emerald' },
                            { v: n(t.refused), mono: true, muted: true },
                            { v: n(t.unresolved), mono: true, tone: t.unresolved > 0 ? 'amber' : undefined },
                            { v: n(t.errored), mono: true, tone: t.errored > 0 ? 'red' : undefined },
                            { v: ago(t.lastAt), muted: true },
                          ],
                        }))}
                      />
                )}
              </Card>

              {/* Monthly trend — so "last month we handled N" is read off a row. */}
              <Card title="Schema changes by month" sub="Last 12 months — the row to quote when a claim names a month">
                {agentOps.monthly.length === 0 ? (
                  <EmptyState icon={<BarChart2 className="w-5 h-5" />} text="No agent schema changes recorded yet" />
                ) : (
                  <div className="space-y-2">
                    {agentOps.monthly.map(m => {
                      const max = Math.max(...agentOps.monthly.map(x => x.schemaStatements), 1)
                      return (
                        <div key={m.month} className="flex items-center gap-3">
                          <span className="text-zinc-400 text-[11px] w-20 font-mono tabular-nums">{m.month}</span>
                          <div className="flex-1 h-5 bg-white/[0.04] rounded overflow-hidden">
                            <div className="h-full bg-violet-500/50 rounded" style={{ width: `${Math.max((m.schemaStatements / max) * 100, 2)}%` }} />
                          </div>
                          <span className="text-zinc-100 text-xs font-mono tabular-nums w-16 text-right">{n(m.schemaStatements)}</span>
                          <span className="text-zinc-600 text-[10px] font-mono tabular-nums w-24 text-right">
                            {n(m.schemaOps)} calls
                          </span>
                          <span className={`text-[10px] font-mono tabular-nums w-20 text-right ${m.unresolved > 0 ? 'text-amber-500' : 'text-zinc-700'}`}>
                            {m.unresolved > 0 ? `${n(m.unresolved)} unresolved` : 'clean'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Card>

              {/* How each number is defined. Kept on the page, not in a doc:
                  these figures leave the building in marketing copy, and the
                  definition has to travel with them. */}
              <Card title="How these numbers are defined" sub={`Evaluated ${ago(agentOps.evaluatedAt)}`}>
                <ul className="space-y-2">
                  {agentOps.caveats.map((c, i) => (
                    <li key={i} className="flex gap-2.5 text-[11.5px] text-zinc-400 leading-relaxed">
                      <span className="text-violet-400/60 flex-shrink-0 mt-0.5">•</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )
        )}

        {/* ════════ ACTIVITY (Phase C — live merged stream) ════════ */}
        {tab === 'activity' && (
          <div className="space-y-5">
            <SectionHeader title="Activity" sub="Every product event, mutation & security signal — one live stream" />

            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[240px] max-w-md">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search activity (action, summary, event type)…"
                  value={actQuery}
                  onChange={e => setActQuery(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-9 pr-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50"
                />
              </div>
              <div className="flex items-center gap-1 bg-white/[0.04] rounded-lg p-1 border border-white/[0.06]">
                {(['all', 'event', 'audit', 'security'] as const).map(s => (
                  <button key={s} onClick={() => setActSource(s)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-all ${actSource === s ? 'bg-white/[0.08] text-violet-300' : 'text-zinc-500 hover:text-zinc-300'}`}>
                    {s}
                  </button>
                ))}
              </div>
              <span className="text-zinc-500 text-xs ml-auto">{activity.length} shown</span>
            </div>

            <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] p-6">
              {loading.activity && activity.length === 0 ? (
                <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 text-zinc-600 animate-spin" /></div>
              ) : activity.length === 0 ? (
                <EmptyState icon={<Inbox className="w-5 h-5" />} text="No activity" sub={actQueryDebounced ? 'Try a different search' : undefined} />
              ) : (
                <div className="space-y-0.5">
                  {activity.map(a => {
                    const srcStyle = a.source === 'security'
                      ? (SEVERITY_STYLE[a.severity ?? 'info'] ?? SEVERITY_STYLE.info)
                      : a.source === 'audit'
                        ? 'bg-white/[0.06] text-zinc-300 border-zinc-700'
                        : 'bg-violet-500/10 text-violet-300 border-violet-500/20'
                    return (
                      <div
                        key={a.id}
                        onClick={() => a.userId && openUser(a.userId)}
                        className={`flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded transition-colors ${a.userId ? 'cursor-pointer' : ''}`}
                      >
                        <span className={`text-[10px] px-2 py-0.5 rounded-md border font-semibold uppercase tracking-wide flex-shrink-0 ${srcStyle}`}>
                          {a.source === 'security' ? (a.severity ?? 'sec') : a.source}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-zinc-200 text-xs truncate">{a.summary}</div>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="text-zinc-600 text-[10px] font-mono uppercase tracking-wide">{a.kind.replace(/_/g, ' ')}</span>
                            {a.userEmail && <span className="text-zinc-600 text-[10px]">· {a.userEmail}</span>}
                            {a.projectName && <span className="text-zinc-700 text-[10px]">· {a.projectName}</span>}
                          </div>
                        </div>
                        <span className="text-zinc-600 text-[11px] flex-shrink-0" title={fmtDate(a.ts) + ' ' + fmtTime(a.ts)}>{ago(a.ts)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ════════ BUILDS (Phase C — build quality) ════════ */}
        {tab === 'builds' && (
          loading.builds && !builds ? <Skeleton /> : builds && (
            <div className="space-y-6">
              <SectionHeader title="Builds" sub="Who's fighting the AI right now, what failed, and what users are asking for" />

              <Card title="Stuck Now" sub="Projects with ≥2 AI corrections / repair loops in the last 3 hours">
                {builds.stuckNow.length === 0 ? (
                  <EmptyState icon={<CheckCircle className="w-5 h-5 text-emerald-400" />} text="Nobody is stuck" sub="No repeated AI corrections in the last 3h" />
                ) : (
                  <div className="space-y-1">
                    {builds.stuckNow.map(s => (
                      <div
                        key={s.projectId}
                        onClick={() => s.ownerUserId && openUser(s.ownerUserId)}
                        className="flex items-center gap-3 py-2.5 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded cursor-pointer transition-colors"
                      >
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-zinc-200 text-xs font-semibold truncate">{s.projectName}</div>
                          <div className="text-zinc-600 text-[11px]">{s.ownerEmail ?? s.ownerUserId?.slice(0, 12)}</div>
                        </div>
                        <span className="text-amber-500 text-xs font-bold tabular-nums">{s.corrections} corrections</span>
                        <span className="text-zinc-600 text-[11px] flex-shrink-0">{ago(s.lastAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Failed Build Inspector" sub={`${builds.failedBuilds.length} recent AI errors — prompt + what broke`}>
                {builds.failedBuilds.length === 0 ? (
                  <EmptyState icon={<CheckCircle className="w-5 h-5 text-emerald-400" />} text="No recent failed builds" />
                ) : (
                  <div className="space-y-3">
                    {builds.failedBuilds.map(f => (
                      <div key={f.id} className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <div
                            onClick={() => f.ownerUserId && openUser(f.ownerUserId)}
                            className={`text-xs font-semibold text-zinc-200 truncate ${f.ownerUserId ? 'cursor-pointer hover:text-white' : ''}`}
                          >
                            {f.projectName} <span className="text-zinc-600 font-normal">· {f.ownerEmail ?? '—'}</span>
                          </div>
                          <span className="text-zinc-600 text-[11px] flex-shrink-0">{ago(f.at)}</span>
                        </div>
                        {f.prompt && (
                          <div className="text-[11px] text-zinc-400 mb-2">
                            <span className="text-zinc-600 uppercase tracking-wide font-semibold mr-1">Prompt</span>
                            {f.prompt}
                          </div>
                        )}
                        <div className="text-[11px] text-red-300/80 font-mono bg-red-500/5 border border-red-500/15 rounded-lg px-3 py-2">
                          {f.error}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card
                title="User Prompts"
                sub={builds.query ? `Search: “${builds.query}”` : 'Most recent — search to find what users ask for'}
                action={
                  <div className="relative w-56">
                    <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search prompts…"
                      value={buildsQuery}
                      onChange={e => setBuildsQuery(e.target.value)}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-9 pr-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50"
                    />
                  </div>
                }
              >
                {builds.prompts.length === 0 ? (
                  <EmptyState icon={<MessageSquare className="w-5 h-5" />} text="No prompts" sub={builds.query ? 'No match' : undefined} />
                ) : (
                  <div className="space-y-1">
                    {builds.prompts.map(p => (
                      <div key={p.id} className="flex items-start gap-3 py-2 border-b border-white/[0.04] last:border-0">
                        <MessageSquare className="w-3 h-3 text-zinc-700 mt-1 flex-shrink-0" />
                        <span className="text-zinc-300 text-xs leading-relaxed flex-1">{p.excerpt}</span>
                        <span className="text-zinc-600 text-[11px] flex-shrink-0">{p.projectName}</span>
                        <span className="text-zinc-700 text-[11px] flex-shrink-0">{ago(p.at)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )
        )}

        {/* ════════ SECURITY (Phase B — threat observability) ════════ */}
        {tab === 'security' && (
          loading.security && !security ? <Skeleton /> : security && (
            <div className="space-y-6">
              <SectionHeader title="Security" sub="Cross-tenant probes, auth anomalies, secret leaks, prompt injection & API abuse" />

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard icon={<AlertTriangle className="w-4 h-4" />} label="Open Events" value={n(security.summary.unresolved)} color={security.summary.unresolved > 0 ? 'red' : 'emerald'} sub="unresolved" />
                <StatCard icon={<Activity className="w-4 h-4" />} label="Last 24h" value={n(security.summary.last24h)} color="amber" sub="new signals" />
                <StatCard icon={<XCircle className="w-4 h-4" />} label="Critical / High" value={n((security.summary.bySeverity.critical ?? 0) + (security.summary.bySeverity.high ?? 0))} color={((security.summary.bySeverity.critical ?? 0) + (security.summary.bySeverity.high ?? 0)) > 0 ? 'red' : 'emerald'} sub="open, severe" />
                <StatCard icon={<FileText className="w-4 h-4" />} label="Total Logged" value={n(security.summary.total)} color="blue" sub="all-time" />
              </div>

              {security.summary.topIps.length > 0 && (
                <Card title="Top Offending IPs" sub="Most security signals in the last 7 days">
                  <div className="space-y-1">
                    {security.summary.topIps.map(t => (
                      <div key={t.ip} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0">
                        <Globe className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
                        <span className="text-zinc-200 text-xs font-mono flex-1 truncate">{t.ip}</span>
                        <button
                          onClick={() => { setBlockForm({ kind: 'ip', value: t.ip, reason: 'High security-signal volume' }); setTab('control') }}
                          className="text-[11px] px-2 py-0.5 rounded bg-white/[0.05] hover:bg-red-500/20 hover:text-red-300 text-zinc-400 transition-colors border border-white/[0.06] hover:border-red-500/30"
                          title="Pre-fill this IP on the Control → Blocklist form"
                        >
                          Block IP
                        </button>
                        <span className="text-red-300 text-xs font-bold tabular-nums w-10 text-right">{t.count}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              <Card
                title="Security Feed"
                sub={`${security.events.length} shown · ${secResolvedFilter === 'open' ? 'open only' : 'all'}`}
                action={
                  <div className="flex items-center gap-1 bg-white/[0.04] rounded-lg p-1 border border-white/[0.06]">
                    {(['open', 'all'] as const).map(v => (
                      <button key={v} onClick={() => setSecResolvedFilter(v)}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-all ${secResolvedFilter === v ? 'bg-white/[0.08] text-violet-300' : 'text-zinc-500 hover:text-zinc-300'}`}>
                        {v}
                      </button>
                    ))}
                  </div>
                }
              >
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {['all', 'cross_tenant', 'auth_anomaly', 'secret_leak', 'suspicious_prompt', 'api_abuse', 'blocklist_hit', 'lockdown', 'kill_switch'].map(k => {
                    const count = k === 'all' ? null : security.summary.byKind[k]
                    return (
                      <button
                        key={k}
                        onClick={() => setSecKindFilter(k)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors border ${
                          secKindFilter === k
                            ? 'bg-white/[0.08] text-violet-300 border-white/[0.14]'
                            : 'bg-white/[0.03] text-zinc-500 border-white/[0.06] hover:text-zinc-300'
                        }`}
                      >
                        {k.replace(/_/g, ' ')}{count ? ` (${count})` : ''}
                      </button>
                    )
                  })}
                </div>

                {security.events.length === 0 ? (
                  <EmptyState icon={<CheckCircle className="w-5 h-5 text-emerald-400" />} text="No security events" sub={secResolvedFilter === 'open' ? 'Nothing open right now' : 'Nothing logged for this filter'} />
                ) : (
                  <div className="space-y-1">
                    {security.events.map(ev => {
                      const sev = SEVERITY_STYLE[ev.severity] ?? SEVERITY_STYLE.info
                      return (
                        <div key={ev.id} className={`flex items-start gap-3 py-2.5 border-b border-white/[0.04] last:border-0 -mx-2 px-2 rounded transition-colors ${ev.resolved ? 'opacity-50' : 'hover:bg-white/[0.02]'}`}>
                          <span className={`text-[10px] px-2 py-0.5 rounded-md border font-bold uppercase tracking-wide flex-shrink-0 mt-0.5 ${sev}`}>{ev.severity}</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-zinc-200 text-xs">{ev.summary}</div>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="text-zinc-600 text-[10px] font-mono uppercase tracking-wide">{ev.kind.replace(/_/g, ' ')}</span>
                              {ev.userEmail && <span className="text-zinc-600 text-[10px]">· {ev.userEmail}</span>}
                              {ev.ip && <span className="text-zinc-600 text-[10px] font-mono">· {ev.ip}</span>}
                              {ev.projectId && <span className="text-zinc-700 text-[10px] font-mono">· proj {ev.projectId.slice(0, 8)}</span>}
                              {ev.detail && typeof (ev.detail as any).excerpt === 'string' && (
                                <span className="text-amber-500/60 text-[10px] font-mono truncate max-w-[280px]">“{(ev.detail as any).excerpt}”</span>
                              )}
                            </div>
                          </div>
                          <span className="text-zinc-600 text-[11px] flex-shrink-0 mt-0.5" title={fmtDate(ev.createdAt) + ' ' + fmtTime(ev.createdAt)}>{ago(ev.createdAt)}</span>
                          <button
                            onClick={() => resolveSecurityEvent(ev.id, !ev.resolved)}
                            className={`text-[11px] px-2 py-0.5 rounded border transition-colors flex-shrink-0 mt-0.5 ${
                              ev.resolved
                                ? 'bg-white/[0.05] text-zinc-500 border-white/[0.06] hover:text-zinc-300'
                                : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20 hover:bg-emerald-500/20'
                            }`}
                          >
                            {ev.resolved ? 'Reopen' : 'Resolve'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Card>
            </div>
          )
        )}

        {/* ════════ CONTROL (Phase A — emergency kill switches) ════════ */}
        {tab === 'control' && (
          loading.control && !controls ? <Skeleton /> : (
            <div className="space-y-6">
              <SectionHeader title="Platform Control" sub="Emergency switches, blocklist, per-project lockdown, force-logout" />

              {controlActionMsg && (
                <div className={`px-3 py-2 rounded-lg text-xs flex items-center gap-2 ${
                  controlActionMsg.startsWith('Error')
                    ? 'bg-red-500/10 text-red-300 border border-red-500/20'
                    : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                }`}>
                  {controlActionMsg.startsWith('Error')
                    ? <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    : <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />}
                  <span>{controlActionMsg}</span>
                </div>
              )}

              <Card title="Kill Switches" sub="One toggle flips the rule platform-wide within ~5 seconds.">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <KillSwitchRow
                    label="AI Frozen"
                    description="Block /api/ai/chat and /api/projects/[id]/execute. No new backends can be generated."
                    on={!!controls?.aiFrozen}
                    busy={controlBusy === 'aiFrozen'}
                    onChange={v => toggleControl({ aiFrozen: v })}
                    danger
                  />
                  <KillSwitchRow
                    label="Signups Disabled"
                    description="Block email + OAuth (Google/GitHub) signup. Existing users can still log in."
                    on={!!controls?.signupsDisabled}
                    busy={controlBusy === 'signupsDisabled'}
                    onChange={v => toggleControl({ signupsDisabled: v })}
                  />
                  <KillSwitchRow
                    label="Maintenance Mode"
                    description="Block all writes platform-wide: AI, end-user runtime, project creation. Banner shown."
                    on={!!controls?.maintenanceMode}
                    busy={controlBusy === 'maintenanceMode'}
                    onChange={v => toggleControl({ maintenanceMode: v })}
                    danger
                  />
                  <KillSwitchRow
                    label="Read-Only"
                    description="Block AI + end-user writes. Reads still flow. Lighter than Maintenance."
                    on={!!controls?.readOnly}
                    busy={controlBusy === 'readOnly'}
                    onChange={v => toggleControl({ readOnly: v })}
                  />
                </div>
                {controls?.updatedAt && (
                  <div className="mt-4 text-[11px] text-zinc-600">
                    Last changed {ago(controls.updatedAt)}{controls.updatedBy ? ` by ${controls.updatedBy.slice(0, 12)}…` : ''}
                  </div>
                )}
              </Card>

              <Card title="Blocklist" sub="Block an IP, email, or domain at signup + login. Cache refreshes in ≤10s.">
                <div className="grid grid-cols-1 md:grid-cols-[120px_1fr_1fr_auto] gap-2 mb-4">
                  <select
                    value={blockForm.kind}
                    onChange={e => setBlockForm({ ...blockForm, kind: e.target.value as any })}
                    className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                  >
                    <option value="email" className="bg-zinc-900">email</option>
                    <option value="domain" className="bg-zinc-900">domain</option>
                    <option value="ip" className="bg-zinc-900">ip</option>
                  </select>
                  <input
                    type="text"
                    placeholder={blockForm.kind === 'email' ? 'user@example.com' : blockForm.kind === 'domain' ? 'spambot.com' : '203.0.113.42'}
                    value={blockForm.value}
                    onChange={e => setBlockForm({ ...blockForm, value: e.target.value })}
                    className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                  />
                  <input
                    type="text"
                    placeholder="Reason (optional)"
                    value={blockForm.reason}
                    onChange={e => setBlockForm({ ...blockForm, reason: e.target.value })}
                    className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                  />
                  <button
                    onClick={addBlocklist}
                    disabled={controlBusy === 'block-add' || !blockForm.value.trim()}
                    className="px-3 py-2 rounded-lg text-xs font-semibold bg-white/[0.06] text-violet-300 hover:bg-white/[0.10] border border-white/[0.14] disabled:opacity-50 transition-colors"
                  >
                    Add
                  </button>
                </div>

                {blocklist.length === 0 ? (
                  <EmptyState icon={<Ban className="w-5 h-5" />} text="Blocklist is empty" />
                ) : (
                  <div className="space-y-1">
                    {blocklist.map(e => (
                      <div key={e.id} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded transition-colors">
                        <span className="text-[10px] px-2 py-0.5 rounded-md border font-semibold uppercase tracking-wide bg-red-500/10 text-red-300 border-red-500/20 flex-shrink-0">{e.kind}</span>
                        <span className="text-zinc-200 text-xs font-mono truncate flex-1">{e.value}</span>
                        {e.reason && <span className="text-zinc-500 text-[11px] truncate hidden md:inline max-w-xs">{e.reason}</span>}
                        <span className="text-zinc-600 text-[11px] flex-shrink-0">{ago(e.createdAt)}</span>
                        <button
                          onClick={() => removeBlocklist(e.id)}
                          disabled={controlBusy === 'block-remove'}
                          className="text-[11px] px-2 py-0.5 rounded bg-white/[0.05] hover:bg-red-500/20 hover:text-red-300 text-zinc-400 transition-colors flex items-center gap-1 border border-white/[0.06] hover:border-red-500/30 disabled:opacity-50"
                          title="Remove"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card title="Per-Project Lockdown" sub="Seal one project's public API immediately.">
                  <div className="space-y-2">
                    <input
                      type="text"
                      placeholder="Project ID (UUID)"
                      value={lockForm.projectId}
                      onChange={e => setLockForm({ ...lockForm, projectId: e.target.value })}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono outline-none focus:border-violet-500/50"
                    />
                    <input
                      type="text"
                      placeholder="Reason (optional, e.g. compromised key)"
                      value={lockForm.reason}
                      onChange={e => setLockForm({ ...lockForm, reason: e.target.value })}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-200 outline-none focus:border-violet-500/50"
                    />
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => lockProject(true)}
                        disabled={controlBusy === 'lock' || !lockForm.projectId.trim()}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-red-500/15 text-red-300 hover:bg-red-500/25 border border-red-500/20 disabled:opacity-50 transition-colors"
                      >
                        <Ban className="w-3.5 h-3.5" /> Lock down
                      </button>
                      <button
                        onClick={() => lockProject(false)}
                        disabled={controlBusy === 'lock' || !lockForm.projectId.trim()}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 border border-emerald-500/20 disabled:opacity-50 transition-colors"
                      >
                        <CheckCircle className="w-3.5 h-3.5" /> Lift lockdown
                      </button>
                    </div>
                    <p className="text-[11px] text-zinc-600 leading-relaxed pt-1">
                      Locked projects return 503 on every {'/api/v1/{projectId}/*'} call. API keys are left untouched so lifting the lockdown is fully reversible.
                    </p>
                  </div>
                </Card>

                <Card title="Force Logout User" sub="Kill every session for one user immediately.">
                  <div className="space-y-2">
                    <input
                      type="text"
                      placeholder="User ID (UUID)"
                      value={logoutTargetId}
                      onChange={e => setLogoutTargetId(e.target.value)}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono outline-none focus:border-violet-500/50"
                    />
                    <button
                      onClick={() => forceLogoutUser(logoutTargetId)}
                      disabled={controlBusy === 'logout' || !logoutTargetId.trim()}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 border border-amber-500/20 disabled:opacity-50 transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Revoke all sessions
                    </button>
                    <p className="text-[11px] text-zinc-600 leading-relaxed pt-1">
                      Deletes every Session row for the user; existing tokens become invalid within ~15s (session cache TTL). They will be redirected to /auth/login on the next request.
                    </p>
                  </div>
                </Card>
              </div>
            </div>
          )
        )}
      </div>

      {/* ══════ USER DETAIL SLIDE-OVER ══════ */}
      {showModal && (
        <>
          <div className="fixed inset-0 bg-black/70 z-40 backdrop-blur-sm" onClick={closeDetail} />
          <div className="fixed right-0 top-0 h-full w-full max-w-xl z-50 bg-[#0c0c0e] border-l border-white/[0.08] overflow-y-auto flex flex-col shadow-2xl">

            <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-3.5 border-b border-white/[0.06] bg-[#0c0c0e]/95 backdrop-blur-md flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">User Detail</span>
                {detail && <span className="text-[10px] text-zinc-500 font-mono bg-white/[0.04] px-1.5 py-0.5 rounded">id: {detail.user.id.slice(0, 8)}</span>}
              </div>
              <button onClick={closeDetail} className="w-8 h-8 rounded-lg hover:bg-white/[0.06] flex items-center justify-center text-zinc-500 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {loadingDetail && (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
              </div>
            )}

            {detailError && (
              <div className="flex-1 flex items-center justify-center p-8">
                <div className="text-center">
                  <AlertTriangle className="w-8 h-8 mx-auto text-red-400 mb-3" />
                  <p className="text-zinc-400 text-sm">{detailError}</p>
                </div>
              </div>
            )}

            {detail && !loadingDetail && (
              <div className="flex-1 overflow-y-auto">
                {/* Profile */}
                <div className="px-6 pt-6 pb-5 border-b border-white/[0.06]">
                  <div className="flex items-start gap-4 mb-4">
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500/40 to-indigo-600/40 border border-white/[0.14] flex items-center justify-center text-xl font-bold text-violet-200 flex-shrink-0 shadow-lg shadow-violet-500/10">
                      {(detail.user.name || detail.user.email)[0].toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h2 className="font-bold text-white text-lg truncate">{detail.user.name || detail.user.email}</h2>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Mail className="w-3 h-3 text-zinc-500 flex-shrink-0" />
                        <span className="text-zinc-400 text-xs truncate">{detail.user.email}</span>
                        <button
                          onClick={e => copyEmail(e, detail.user.email)}
                          className="flex-shrink-0 p-0.5 rounded hover:bg-white/[0.08] transition-colors"
                          title="Copy email"
                        >
                          {copiedEmail === detail.user.email
                            ? <Check className="w-3 h-3 text-emerald-400" />
                            : <Copy className="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
                          }
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                        <TierBadge tier={detail.user.tier} />
                        <Pill>{detail.user.provider}</Pill>
                        {detail.user.suspendedAt && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/20 font-bold uppercase tracking-wide">Suspended</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-4">
                    <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-0.5">Joined</div>
                      <div className="text-zinc-200 text-xs font-semibold">{fmtDate(detail.user.createdAt)}</div>
                    </div>
                    <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-0.5">Last Active</div>
                      <div className="text-zinc-200 text-xs font-semibold">{ago(detail.user.lastActiveAt ?? detail.user.lastLogin)}</div>
                    </div>
                  </div>
                </div>

                {/* Admin Actions */}
                <div className="px-6 py-5 border-b border-white/[0.06]">
                  <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Admin Actions</h3>
                  {actionMsg && (
                    <div className={`mb-3 px-3 py-2 rounded-lg text-xs flex items-start gap-2 ${
                      actionMsg.startsWith('Error')
                        ? 'bg-red-500/10 text-red-300 border border-red-500/20'
                        : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                    }`}>
                      {actionMsg.startsWith('Error') ? <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
                      <span className="flex-1">{actionMsg}</span>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={actionLoading}
                      onClick={() => adminAction({ action: 'suspend', userId: detail.user.id, suspend: !detail.user.suspendedAt })}
                      className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 border ${
                        detail.user.suspendedAt
                          ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 border-emerald-500/20'
                          : 'bg-red-500/15 text-red-300 hover:bg-red-500/25 border-red-500/20'
                      }`}
                    >
                      <Ban className="w-3.5 h-3.5" />
                      {detail.user.suspendedAt ? 'Unsuspend User' : 'Suspend User'}
                    </button>
                    <button
                      disabled={actionLoading}
                      onClick={() => setCreditModal(true)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 border border-blue-500/20 transition-colors disabled:opacity-50"
                    >
                      <Zap className="w-3.5 h-3.5" />Manage Credits
                    </button>
                    <button
                      disabled={controlBusy === 'logout'}
                      onClick={() => forceLogoutUser(detail.user.id)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 border border-amber-500/20 transition-colors disabled:opacity-50"
                      title="Kill every session for this user"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />Force Logout
                    </button>
                  </div>
                </div>

                {creditModal && (
                  <div className="px-6 py-5 border-b border-white/[0.06] bg-violet-500/[0.03]">
                    <h3 className="text-[10px] font-bold text-violet-300 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                      <Zap className="w-3 h-3" />Manage AI Credits
                    </h3>
                    {detail.credits && (
                      <div className="mb-3 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                        <div className="text-[11px] text-zinc-500 mb-0.5">{detail.credits.currentMonth.month}</div>
                        <div className="text-xs text-zinc-200">
                          <span className="text-white font-bold">{n(detail.credits.currentMonth.intentCount)}</span> AI actions used
                          {detail.credits.limits.aiBuildActionsPerMonth && (
                            <span className="text-zinc-500"> / {n(detail.credits.limits.aiBuildActionsPerMonth)} limit</span>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-2 mb-3">
                      {(['reset', 'reduce'] as const).map(a => (
                        <button
                          key={a}
                          onClick={() => setCreditAction(a)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors border ${
                            creditAction === a
                              ? 'bg-white/[0.08] text-violet-300 border-white/[0.14]'
                              : 'bg-white/[0.04] text-zinc-500 border-white/[0.06]'
                          }`}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                    {creditAction === 'reduce' && (
                      <div className="mb-3 flex items-center gap-2">
                        <button onClick={() => setCreditAmount(a => String(Math.max(1, +a - 10)))} className="w-7 h-7 rounded bg-white/[0.06] flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.1] transition-colors">
                          <Minus className="w-3 h-3" />
                        </button>
                        <input
                          type="number"
                          min="1"
                          value={creditAmount}
                          onChange={e => setCreditAmount(e.target.value)}
                          className="w-20 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-white text-center outline-none focus:border-violet-500/50 tabular-nums"
                        />
                        <button onClick={() => setCreditAmount(a => String(+a + 10))} className="w-7 h-7 rounded bg-white/[0.06] flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.1] transition-colors">
                          <Plus className="w-3 h-3" />
                        </button>
                        <span className="text-zinc-500 text-xs">to refund</span>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button
                        disabled={actionLoading}
                        onClick={async () => {
                          await adminAction({
                            action: 'credits',
                            userId: detail.user.id,
                            creditAction,
                            ...(creditAction === 'reduce' ? { amount: +creditAmount } : {}),
                          })
                          setCreditModal(false)
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/[0.06] text-violet-300 hover:bg-white/[0.10] border border-white/[0.14] transition-colors disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {actionLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                        {actionLoading ? 'Processing…' : creditAction === 'reset' ? 'Reset Credits' : `Refund ${creditAmount}`}
                      </button>
                      <button onClick={() => setCreditModal(false)} className="px-3 py-1.5 rounded-lg text-xs text-zinc-500 hover:text-zinc-300">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {detail.credits?.history && detail.credits.history.length > 0 && (
                  <div className="px-6 py-5 border-b border-white/[0.06]">
                    <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">AI Usage History</h3>
                    <div className="space-y-1.5">
                      {detail.credits.history.slice(0, 6).map(h => {
                        const max = Math.max(...detail.credits!.history.map(x => x.intentCount), 1)
                        return (
                          <div key={h.month} className="flex items-center gap-3">
                            <span className="text-zinc-500 text-[11px] w-16 tabular-nums">{h.month}</span>
                            <div className="flex-1 h-4 bg-white/[0.04] rounded overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-r from-violet-700 to-violet-500 rounded transition-all duration-500"
                                style={{ width: `${Math.min(100, (h.intentCount / max) * 100)}%` }}
                              />
                            </div>
                            <span className="text-zinc-300 text-xs w-12 text-right font-bold tabular-nums">{n(h.intentCount)}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div className="px-6 py-5 border-b border-white/[0.06]">
                  <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Lifetime Usage</h3>
                  <div className="grid grid-cols-3 gap-2">
                    <UsageStat icon={<Globe className="w-3.5 h-3.5" />} label="API Calls" value={n(detail.usage.apiCalls)} />
                    <UsageStat icon={<Database className="w-3.5 h-3.5" />} label="DB Reads" value={n(detail.usage.dbReads)} />
                    <UsageStat icon={<Database className="w-3.5 h-3.5" />} label="DB Writes" value={n(detail.usage.dbWrites)} />
                    <UsageStat icon={<Activity className="w-3.5 h-3.5" />} label="AI Calls" value={n(detail.usage.aiCalls)} />
                    <UsageStat icon={<Clock className="w-3.5 h-3.5" />} label="Compute ms" value={n(detail.usage.computeTime)} />
                  </div>
                </div>

                <div className="px-6 py-5 border-b border-white/[0.06]">
                  <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
                    Projects <span className="text-zinc-700 font-normal">({detail.projects.length})</span>
                  </h3>
                  {detail.projects.length === 0 ? (
                    <p className="text-zinc-600 text-xs py-2">No projects yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {detail.projects.map(p => (
                        <div key={p.id} className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 hover:border-white/[0.1] transition-colors">
                          <div className="flex items-start justify-between mb-3 gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold text-sm text-white truncate">{p.name}</div>
                              {p.description && <div className="text-zinc-500 text-[11px] mt-0.5 line-clamp-1">{p.description}</div>}
                            </div>
                            <div className="flex items-center gap-1 text-zinc-600 text-[11px] flex-shrink-0">
                              <Clock className="w-3 h-3" />{ago(p.createdAt)}
                            </div>
                          </div>
                          <div className="flex gap-1 flex-wrap mb-3">
                            <FunnelStep done={p.isBackendGenerated} label="Backend" />
                            <FunnelStep done={p.isFrontendConnected} label="Frontend" />
                            <FunnelStep done={p.isDeployed} label="Deployed" />
                            <FunnelStep done={p.hasExternalUsers} label="Live" />
                          </div>
                          <div className="flex gap-3 text-[11px] text-zinc-500 flex-wrap">
                            <span><span className="text-zinc-300 font-semibold tabular-nums">{n(p.apiRequests)}</span> API</span>
                            <span><span className="text-zinc-300 font-semibold tabular-nums">{p.activeUsers}</span> users</span>
                            {p.publicUrl && (
                              <a href={p.publicUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="ml-auto text-violet-400 hover:text-violet-300 flex items-center gap-0.5 font-medium">
                                Open <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Agent Messages — what a coding agent SENT to backend_chat.
                    There is no in-product chat door any more, so these rows can
                    only come from an agent over MCP: /api/mcp/chat → runBrain →
                    saveTurn → ConversationMessage.

                    Deliberately NOT labelled as what the user typed. What
                    someone types in Claude Code goes to Anthropic's model and
                    never reaches us; what lands here is the message the model
                    composed and sent on their behalf. Those differ, and the old
                    "User / Backenly AI" framing asserted the stronger claim. */}
                <div className="px-6 py-5 border-b border-white/[0.06]">
                  <button
                    onClick={() => toggleConvos(detail.user.id)}
                    className="w-full flex items-center gap-2 group"
                  >
                    <MessageSquare className="w-3.5 h-3.5 text-violet-400" />
                    <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest group-hover:text-zinc-300 transition-colors">Agent Messages</h3>
                    {convos && (
                      <span className="text-[10px] text-zinc-600 font-mono">
                        {n(convos.totalMessages)} msg{convos.truncated ? '+' : ''}
                      </span>
                    )}
                    <ChevronRight className={`w-3.5 h-3.5 text-zinc-600 ml-auto transition-transform ${convosOpen ? 'rotate-90' : ''}`} />
                  </button>

                  {convosOpen && (
                    <div className="mt-3">
                      {convosLoading && (
                        <div className="flex items-center justify-center py-8">
                          <Loader2 className="w-4 h-4 text-zinc-600 animate-spin" />
                        </div>
                      )}

                      {convosError && (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-300 border border-red-500/20 text-xs">
                          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>{convosError}</span>
                        </div>
                      )}

                      {convos && !convosLoading && convos.projects.length === 0 && (
                        <p className="text-zinc-600 text-xs py-2 leading-relaxed">
                          No agent has used <span className="font-mono text-zinc-500">backend_chat</span> on this
                          user&rsquo;s projects. Typed tool calls (
                          <span className="font-mono text-zinc-500">apply_migration</span>,{' '}
                          <span className="font-mono text-zinc-500">db_insert</span>, …) carry no message and are
                          counted on the Agents tab instead.
                        </p>
                      )}

                      {convos && !convosLoading && convos.projects.length > 0 && (
                        <>
                          <div className="relative mb-3">
                            <Search className="w-3.5 h-3.5 text-zinc-600 absolute left-2.5 top-1/2 -translate-y-1/2" />
                            <input
                              value={convoSearch}
                              onChange={e => setConvoSearch(e.target.value)}
                              placeholder="Search prompts & answers…"
                              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-8 pr-3 py-2 text-xs text-white placeholder:text-zinc-600 outline-none focus:border-violet-500/50"
                            />
                          </div>

                          {convos.truncated && (
                            <div className="mb-3 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-500/80 border border-amber-500/20 text-[11px]">
                              Showing the most recent {n(convos.totalMessages)} messages. Older history is truncated.
                            </div>
                          )}

                          {filteredConvoProjects.length === 0 ? (
                            <p className="text-zinc-600 text-xs py-2">No messages match “{convoSearch}”.</p>
                          ) : (
                            <div className="space-y-2">
                              {filteredConvoProjects.map(p => {
                                const isOpen = convoSearch.trim() ? true : openConvoProjects.has(p.projectId)
                                return (
                                  <div key={p.projectId} className="rounded-xl border border-white/[0.06] overflow-hidden">
                                    <button
                                      onClick={() => toggleConvoProject(p.projectId)}
                                      className="w-full flex items-center gap-2 px-3 py-2.5 bg-white/[0.03] hover:bg-white/[0.05] transition-colors text-left"
                                    >
                                      <ChevronRight className={`w-3.5 h-3.5 text-zinc-600 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                                      <span className="text-xs font-semibold text-white truncate flex-1">{p.projectName}</span>
                                      <span className="text-[10px] text-zinc-500 font-mono flex-shrink-0">{n(p.messages.length)} msg</span>
                                    </button>
                                    {isOpen && (
                                      <div className="px-3 py-3 space-y-3 bg-black/20">
                                        {p.messages.map(m => (
                                          <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                                            <div className="flex items-center gap-1.5 mb-1 px-0.5">
                                              <span
                                                className={`text-[9px] font-bold uppercase tracking-wider ${m.role === 'user' ? 'text-violet-300' : 'text-zinc-400'}`}
                                                title={m.role === 'user'
                                                  ? 'Message the coding agent sent to backend_chat, not necessarily what the user typed'
                                                  : "Backenly brain's reply to the agent"}
                                              >
                                                {m.role === 'user' ? 'Agent' : 'Backenly'}
                                              </span>
                                              <span className="text-[9px] text-zinc-600 tabular-nums" title={fmtDate(m.createdAt) + ' ' + fmtTime(m.createdAt)}>{ago(m.createdAt)}</span>
                                            </div>
                                            <div className={`max-w-[88%] rounded-xl px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words ${
                                              m.role === 'user'
                                                ? 'bg-violet-500/15 text-violet-100 border border-violet-500/20 rounded-tr-sm'
                                                : 'bg-white/[0.04] text-zinc-300 border border-white/[0.06] rounded-tl-sm'
                                            }`}>
                                              {m.content}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="px-6 py-5">
                  <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Activity Timeline</h3>
                  {detail.timeline && detail.timeline.length > 0 ? (
                    <div className="space-y-1">
                      {detail.timeline.map(t => {
                        const badge = t.source === 'security'
                          ? (SEVERITY_STYLE[t.severity ?? 'info'] ?? SEVERITY_STYLE.info)
                          : t.source === 'audit'
                            ? 'bg-white/[0.06] text-zinc-300 border-zinc-700'
                            : 'bg-violet-500/10 text-violet-300 border-violet-500/20'
                        const label = t.source === 'event' ? (EVENT_COLOR[t.kind]?.label ?? t.kind.replace(/_/g, ' ')) : t.source
                        return (
                          <div key={t.id} className="flex items-center gap-3 py-1.5">
                            <span className={`text-[10px] px-2 py-0.5 rounded-md border font-semibold uppercase tracking-wide flex-shrink-0 ${badge}`}>{label}</span>
                            <span className="text-zinc-300 text-xs truncate flex-1" title={fmtDate(t.ts) + ' ' + fmtTime(t.ts)}>{t.summary}</span>
                            <span className="text-zinc-600 text-[11px] flex-shrink-0">{ago(t.ts)}</span>
                          </div>
                        )
                      })}
                    </div>
                  ) : detail.recentEvents.length === 0 ? (
                    <p className="text-zinc-600 text-xs py-2">No activity recorded yet.</p>
                  ) : (
                    <div className="space-y-1">
                      {detail.recentEvents.map(e => {
                        const style = EVENT_COLOR[e.eventType] ?? { bg: 'bg-zinc-800 text-zinc-400 border-zinc-700', dot: 'bg-zinc-500', label: e.eventType }
                        return (
                          <div key={e.id} className="flex items-center gap-3 py-1.5">
                            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${style.dot}`} />
                            <span className={`text-[10px] px-2 py-0.5 rounded-md border font-semibold uppercase tracking-wide flex-shrink-0 ${style.bg}`}>{style.label}</span>
                            <span className="text-zinc-300 text-xs truncate flex-1" title={fmtDate(e.timestamp) + ' ' + fmtTime(e.timestamp)}>
                              {describeEvent(e)}
                            </span>
                            <span className="text-zinc-600 text-[11px] flex-shrink-0">{ago(e.timestamp)}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ══════ ADMIN STEP-UP ("sudo") ══════ */}
      {sudoOpen && (
        <>
          <div className="fixed inset-0 bg-black/70 z-40" onClick={cancelSudo} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm admin change"
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm bg-[#0e0f13] border border-white/[0.08] rounded-2xl overflow-hidden"
          >
            <div className="flex items-center gap-2 px-5 py-3.5 border-b border-white/[0.06]">
              <ShieldCheck className="w-4 h-4 text-violet-400" />
              <span className="text-sm font-semibold text-white">Confirm admin change</span>
            </div>

            <div className="px-5 py-4 space-y-3">
              <p className="text-xs text-zinc-400 leading-relaxed">
                Admin writes need a second factor. Your session alone can read this
                dashboard but cannot change it. Confirmation lasts 15 minutes.
              </p>

              {!sudoMethods.password && !sudoMethods.totp ? (
                <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  This account has neither a password nor TOTP configured, so admin
                  changes cannot be confirmed. Set one up first.
                </p>
              ) : (
                <input
                  autoFocus
                  type={sudoMethods.totp && !sudoMethods.password ? 'text' : 'password'}
                  inputMode={sudoMethods.totp && !sudoMethods.password ? 'numeric' : undefined}
                  value={sudoSecret}
                  onChange={e => setSudoSecret(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') submitSudo()
                    if (e.key === 'Escape') cancelSudo()
                  }}
                  placeholder={
                    sudoMethods.totp && sudoMethods.password
                      ? 'Password or 6-digit code'
                      : sudoMethods.totp ? '6-digit code' : 'Password'
                  }
                  className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder:text-zinc-600 outline-none focus:border-white/20"
                />
              )}

              {sudoErr && (
                <div className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                  <span>{sudoErr}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
              <button
                onClick={cancelSudo}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitSudo}
                disabled={sudoBusy || !sudoSecret.trim()}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-black hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              >
                {sudoBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                Confirm
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold text-zinc-50 tracking-[-0.01em] leading-tight">{title}</h1>
        {sub && <p className="text-zinc-500 text-[12.5px] mt-1 leading-snug">{sub}</p>}
      </div>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-12 w-64 rounded-lg bg-white/[0.04]" />
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map(i => <div key={i} className="h-28 rounded-2xl bg-white/[0.04]" />)}
      </div>
      <div className="h-48 rounded-2xl bg-white/[0.04]" />
      <div className="h-32 rounded-2xl bg-white/[0.04]" />
    </div>
  )
}

type StatColor = 'violet' | 'blue' | 'amber' | 'emerald' | 'red' | 'zinc'

function StatCard({
  icon, label, value, color, sub, trend,
}: {
  icon: React.ReactNode; label: string; value: string; color: StatColor; sub?: string
  trend?: { value: number; label: string; positive: boolean }
}) {
  // Color lives on the numeral + a muted icon — not a gradient wash. Follows
  // the kit language: flat panel, one soft inset shadow, tone as accent only.
  const valueColors: Record<StatColor, string> = {
    violet: 'text-violet-300', blue: 'text-sky-300', amber: 'text-amber-500',
    emerald: 'text-emerald-300', red: 'text-rose-300', zinc: 'text-zinc-100',
  }
  const iconColors: Record<StatColor, string> = {
    violet: 'text-violet-300/70', blue: 'text-sky-300/70', amber: 'text-amber-500/70',
    emerald: 'text-emerald-300/70', red: 'text-rose-300/70', zinc: 'text-zinc-600',
  }
  return (
    <div className="relative rounded-xl bg-[#16171d] border border-white/[0.07] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500 leading-none">{label}</span>
        <span className={`flex-shrink-0 [&>svg]:w-3.5 [&>svg]:h-3.5 ${iconColors[color]}`}>{icon}</span>
      </div>
      <div className={`mt-3 font-mono text-[24px] font-medium tabular-nums tracking-tight leading-none ${valueColors[color]}`}>{value}</div>
      {trend ? (
        <div className={`flex items-center gap-1 font-mono text-[11px] font-medium tabular-nums mt-2 ${trend.positive ? 'text-emerald-300/90' : 'text-rose-300'}`}>
          {trend.positive ? '+' : ''}{trend.value}
          <span className="text-zinc-600 font-sans">{trend.label}</span>
        </div>
      ) : sub && (
        <div className="text-[11px] text-zinc-500 mt-2 leading-none">{sub}</div>
      )}
    </div>
  )
}

function Card({
  title, sub, action, children,
}: {
  title: string; sub?: string; action?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className="rounded-xl bg-[#16171d] border border-white/[0.07] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)] p-6">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-zinc-100 tracking-tight leading-tight">{title}</h2>
          {sub && <p className="text-[11.5px] text-zinc-500 mt-1 leading-snug">{sub}</p>}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  )
}

/**
 * Signup provenance marker.
 *
 * Only renders when there is something to say — a clean, verified account shows
 * nothing, so the table stays quiet and a flag actually means something. The
 * title attribute carries the score and the reason codes, which is what you
 * need to tell a false positive from a real catch.
 */
function SignupTrustFlag({ user }: { user: UserRow }) {
  const flagged = user.trustLevel === 'untrusted'
  const unverified = user.emailVerified === false

  if (!flagged && !unverified) return null

  if (flagged) {
    const detail = [
      `Flagged at signup — score ${user.signupScore ?? '?'}/100`,
      user.signupSignals?.length ? user.signupSignals.join(', ') : null,
      'Cannot create projects until the email is verified.',
    ]
      .filter(Boolean)
      .join('\n')
    return (
      <span
        title={detail}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-500/25 bg-amber-500/10 text-[9px] font-bold uppercase tracking-wider text-amber-400 flex-shrink-0"
      >
        <ShieldAlert className="w-2.5 h-2.5" />
        Flagged
      </span>
    )
  }

  return (
    <span
      title="Email never verified."
      className="inline-flex items-center px-1.5 py-0.5 rounded border border-white/[0.10] bg-white/[0.04] text-[9px] font-bold uppercase tracking-wider text-zinc-500 flex-shrink-0"
    >
      Unverified
    </span>
  )
}

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    FREE:       'bg-zinc-800 text-zinc-400 border-zinc-700',
    STARTER:    'bg-blue-500/15 text-blue-300 border-blue-500/20',
    PRO:        'bg-violet-500/15 text-violet-300 border-violet-500/20',
    ENTERPRISE: 'bg-amber-500/15 text-amber-500 border-amber-500/20',
  }
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wider ${colors[tier] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
      {tier}
    </span>
  )
}

function TierBreakdown({ breakdown, total }: { breakdown: Record<string, number>; total: number }) {
  const tiers = ['FREE', 'STARTER', 'PRO', 'ENTERPRISE']
  const colors: Record<string, string> = {
    FREE: 'bg-zinc-600', STARTER: 'bg-blue-500', PRO: 'bg-violet-500', ENTERPRISE: 'bg-amber-500',
  }
  return (
    <div className="space-y-2.5">
      {tiers.map(tier => {
        const count = breakdown[tier] ?? 0
        const pct = total > 0 ? Math.round((count / total) * 100) : 0
        return (
          <div key={tier} className="flex items-center gap-3">
            <span className="text-zinc-400 text-[10px] w-20 uppercase tracking-[0.12em] font-semibold">{tier}</span>
            <div className="flex-1 h-4 bg-white/[0.04] rounded-md overflow-hidden">
              <div className={`h-full ${colors[tier]} rounded-md transition-all duration-700`} style={{ width: `${Math.max(pct, count > 0 ? 2 : 0)}%` }} />
            </div>
            <span className="text-zinc-100 font-mono text-xs font-medium w-6 text-right tabular-nums">{count}</span>
            <span className="text-zinc-600 font-mono text-[11px] w-8 text-right tabular-nums">{pct}%</span>
          </div>
        )
      })}
    </div>
  )
}

function RetentionSummary({ retention }: { retention: RetentionMetric[] }) {
  const byDay = new Map(retention.map(metric => [metric.days, metric]))
  const windows = [7, 14, 30].map(days => byDay.get(days) ?? {
    days,
    eligibleUsers: 0,
    retainedUsers: 0,
    pct: 0,
  })

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {windows.map(metric => {
        const hasCohort = metric.eligibleUsers > 0
        const width = hasCohort ? Math.min(100, Math.max(metric.pct, metric.retainedUsers > 0 ? 2 : 0)) : 0
        const tone = !hasCohort
          ? 'text-zinc-500'
          : metric.pct >= 50
            ? 'text-emerald-300'
            : metric.pct >= 25
              ? 'text-amber-500'
              : 'text-rose-300'
        const bar = !hasCohort
          ? 'bg-zinc-700'
          : metric.pct >= 50
            ? 'bg-emerald-400'
            : metric.pct >= 25
              ? 'bg-amber-400'
              : 'bg-rose-400'

        return (
          <div key={metric.days} className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="text-[10px] uppercase tracking-[0.12em] text-zinc-500 font-semibold">D{metric.days}</span>
              <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
                {n(metric.retainedUsers)} / {n(metric.eligibleUsers)}
              </span>
            </div>
            <div className={`font-mono text-[24px] font-medium tabular-nums tracking-tight leading-none ${tone}`}>
              {hasCohort ? percent(metric.pct) : 'n/a'}
            </div>
            <div className="h-1 bg-white/[0.05] rounded-full overflow-hidden mt-3">
              <div className={`h-full rounded-full transition-all duration-700 ${bar}`} style={{ width: `${width}%` }} />
            </div>
            <div className="text-[11px] text-zinc-500 mt-2">retained after {metric.days}d</div>
          </div>
        )
      })}
    </div>
  )
}

function FunnelChart({ funnel, compact = false }: { funnel: FunnelStage[]; compact?: boolean }) {
  const max = funnel[0]?.count || 1
  return (
    <div className="space-y-2.5">
      {funnel.map((stage, i) => {
        const pct = Math.round((stage.count / max) * 100)
        const retention = i > 0 && funnel[i - 1].count > 0
          ? Math.round((stage.count / funnel[i - 1].count) * 100)
          : null
        const retColor = retention === null ? '' : retention >= 70 ? 'text-emerald-300' : retention >= 40 ? 'text-amber-500' : 'text-rose-300'
        return (
          <div key={stage.stage} className="flex items-center gap-3">
            <div className={`${compact ? 'w-24' : 'w-28'} text-right text-[11px] text-zinc-400 font-medium flex-shrink-0`}>{stage.stage}</div>
            <div className={`flex-1 ${compact ? 'h-6' : 'h-7'} bg-white/[0.03] rounded-md overflow-hidden relative border border-white/[0.05]`}>
              <div
                className="h-full bg-violet-500/85 rounded-md transition-all duration-700 flex items-center px-3"
                style={{ width: `${Math.max(pct, 3)}%` }}
              >
                {pct > 18 && <span className="text-white font-mono text-xs font-medium tabular-nums">{stage.count}</span>}
              </div>
              {pct <= 18 && (
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-300 font-mono text-xs font-medium tabular-nums">{stage.count}</span>
              )}
            </div>
            <div className={`${compact ? 'w-16' : 'w-20'} text-right flex-shrink-0`}>
              {retention !== null
                ? <span className={`font-mono text-[11px] font-medium ${retColor}`}>{retention}%</span>
                : <span className="text-[11px] text-zinc-600 font-medium">baseline</span>
              }
            </div>
          </div>
        )
      })}
    </div>
  )
}

function EventFeed({ events, onUserClick }: { events: RecentEvent[]; onUserClick?: (id: string) => void }) {
  if (events.length === 0) {
    return <EmptyState icon={<Activity className="w-5 h-5" />} text="No events tracked yet" />
  }
  return (
    <div className="space-y-0.5">
      {events.map(e => {
        const style = EVENT_COLOR[e.eventType] ?? { bg: 'bg-zinc-800 text-zinc-400 border-zinc-700', dot: 'bg-zinc-500', label: e.eventType }
        return (
          <div
            key={e.id}
            onClick={() => onUserClick?.(e.userId)}
            className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded cursor-pointer transition-colors"
          >
            <span className="flex items-center gap-1.5 w-[92px] flex-shrink-0">
              <span className={`w-[5px] h-[5px] rounded-full flex-shrink-0 ${style.dot}`} />
              <span className="font-mono text-[10.5px] font-medium text-zinc-400 truncate">{style.label}</span>
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-zinc-200 text-xs truncate">{describeEvent(e)}</div>
              <div className="text-zinc-600 text-[11px] truncate">
                {e.userName || e.userEmail || `${e.userId.slice(0, 12)}…`}
              </div>
            </div>
            <span className="font-mono text-zinc-600 text-[11px] flex-shrink-0 tabular-nums">{ago(e.timestamp)}</span>
          </div>
        )
      })}
    </div>
  )
}

function AuditTable({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="space-y-0.5">
      {entries.map(entry => (
        <div key={entry.id} className="flex items-start gap-3 py-2.5 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] -mx-2 px-2 rounded transition-colors">
          <span className="text-[10px] px-2 py-0.5 rounded bg-white/[0.06] text-zinc-300 font-mono font-semibold flex-shrink-0 mt-0.5 uppercase tracking-wide">{entry.action}</span>
          <div className="flex-1 min-w-0">
            <div className="text-zinc-200 text-xs truncate">{entry.details ?? entry.userEmail ?? entry.userId ?? '—'}</div>
            {entry.projectId && <div className="text-zinc-600 text-[11px] font-mono mt-0.5">proj: {entry.projectId.slice(0, 8)}</div>}
          </div>
          <span className="text-zinc-600 text-[11px] flex-shrink-0 mt-0.5" title={fmtDate(entry.timestamp) + ' ' + fmtTime(entry.timestamp)}>
            {ago(entry.timestamp)}
          </span>
        </div>
      ))}
    </div>
  )
}

function UsageStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] px-4 py-3">
      <div className="flex items-center gap-1.5 text-zinc-600 mb-2">{icon}<span className="text-[10px] uppercase tracking-[0.12em] font-semibold text-zinc-500">{label}</span></div>
      <div className="text-zinc-100 font-mono text-[18px] font-medium tabular-nums leading-none">{value}</div>
    </div>
  )
}

// One outcome bucket on the Agents tab. Carries its definition inline because
// "refused" vs "unresolved" is the distinction the whole safety claim rests on,
// and a bare number invites reading them as the same kind of failure.
function OutcomeStat({
  label, value, tone, note,
}: { label: string; value: number; tone: 'emerald' | 'amber' | 'red' | 'zinc'; note: string }) {
  const tones = {
    emerald: 'text-emerald-300',
    amber:   'text-amber-500',
    red:     'text-rose-300',
    zinc:    'text-zinc-300',
  }
  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-zinc-500">{label}</div>
      <div className={`font-mono text-[20px] font-medium tabular-nums leading-none mt-2 ${tones[tone]}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-[10.5px] text-zinc-600 mt-2 leading-snug">{note}</div>
    </div>
  )
}

interface AgentCell {
  v: string
  sub?: string
  mono?: boolean
  muted?: boolean
  wide?: boolean
  tone?: 'emerald' | 'amber' | 'red'
}

// Shared table for the Agents tab's four breakdowns. They differ only in
// columns, so one table beats four near-identical copies drifting apart.
function AgentTable({
  head, rows,
}: {
  head: string[]
  rows: { key: string; onClick?: () => void; cells: AgentCell[] }[]
}) {
  const tones = { emerald: 'text-emerald-300', amber: 'text-amber-500', red: 'text-rose-300' }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-white/[0.06]">
            {head.map((h, i) => (
              <th
                key={h}
                className={`pb-2 text-zinc-500 text-[10px] uppercase tracking-[0.12em] font-semibold whitespace-nowrap ${i === 0 ? '' : 'text-right'}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr
              key={r.key}
              onClick={r.onClick}
              className={`border-b border-white/[0.04] last:border-0 ${r.onClick ? 'cursor-pointer hover:bg-white/[0.02]' : ''}`}
            >
              {r.cells.map((c, i) => (
                <td
                  key={i}
                  className={`py-2.5 text-[11.5px] whitespace-nowrap ${i === 0 ? '' : 'text-right'} ${
                    c.wide ? 'max-w-[220px] truncate' : ''
                  } ${c.mono ? 'font-mono tabular-nums' : ''} ${
                    c.tone ? tones[c.tone] : c.muted ? 'text-zinc-500' : 'text-zinc-200'
                  }`}
                  title={c.v}
                >
                  {c.v}
                  {c.sub && <div className="text-zinc-600 text-[10px] font-sans">{c.sub}</div>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] px-4 py-3 flex items-center gap-3">
      <div className="text-zinc-500">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
        <div className="text-zinc-200 text-xs font-mono">{value}</div>
      </div>
    </div>
  )
}

function PercentileCard({ label, value, color, emphasized }: { label: string; value: string; color: 'emerald' | 'violet' | 'amber'; emphasized?: boolean }) {
  const colors = {
    emerald: 'text-emerald-300',
    violet:  'text-violet-300',
    amber:   'text-amber-500',
  }
  return (
    <div className={`rounded-lg bg-white/[0.02] border p-4 text-center ${
      emphasized ? 'border-white/[0.16] bg-white/[0.05]' : 'border-white/[0.06]'
    }`}>
      <div className={`font-mono text-[24px] font-medium ${colors[color]} tabular-nums leading-none`}>{value}</div>
      <div className="text-zinc-500 text-[10px] mt-2 uppercase tracking-[0.12em] font-semibold">{label}</div>
    </div>
  )
}

function EmptyState({ icon, text, sub }: { icon: React.ReactNode; text: string; sub?: string }) {
  return (
    <div className="py-8 flex flex-col items-center text-center">
      <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center text-zinc-500 mb-2">
        {icon}
      </div>
      <div className="text-zinc-400 text-sm font-medium">{text}</div>
      {sub && <div className="text-zinc-600 text-[11px] mt-1">{sub}</div>}
    </div>
  )
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-2 py-0.5 bg-white/[0.04] border border-white/[0.06] rounded-full text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
      {children}
    </span>
  )
}

function FunnelStep({ done, label }: { done: boolean; label: string }) {
  return (
    <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide ${
      done ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20' : 'bg-white/[0.03] text-zinc-600 border border-white/[0.05]'
    }`}>
      {done ? <Check className="w-2.5 h-2.5" /> : <span className="w-2.5 h-2.5 rounded-full border border-current opacity-50" />}
      {label}
    </span>
  )
}

function GrowthBarChart({ data, unit }: { data: { date: string; count: number }[]; unit: 'day' | 'week' | 'month' }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const max = Math.max(...data.map(d => d.count), 1)

  function fmtLabel(dateStr: string) {
    if (unit === 'month') {
      const [y, m] = dateStr.split('-')
      return new Date(+y, +m - 1).toLocaleDateString('en', { month: 'short', year: '2-digit' })
    }
    const d = new Date(dateStr)
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' })
  }

  const showEvery = Math.ceil(data.length / 8)
  const totalSignups = data.reduce((s, d) => s + d.count, 0)
  const peakDay = data.reduce((best, d) => d.count > best.count ? d : best, data[0] ?? { date: '', count: 0 })

  return (
    <div>
      <div className="flex items-center gap-6 mb-5 text-xs text-zinc-500">
        <span>
          <span className="text-white font-bold text-base mr-1 tabular-nums">{totalSignups.toLocaleString()}</span>
          total signups
        </span>
        {peakDay.count > 0 && (
          <span>
            Peak: <span className="text-violet-300 font-bold tabular-nums">{peakDay.count}</span> on <span className="text-zinc-400">{fmtLabel(peakDay.date)}</span>
          </span>
        )}
      </div>

      <div className="relative">
        <div className="absolute -top-1 left-0 text-[10px] text-zinc-600 font-medium tabular-nums">{max}</div>

        {hovered !== null && data[hovered] && (
          <div className="absolute -top-9 left-1/2 -translate-x-1/2 bg-zinc-900 border border-white/[0.1] rounded-lg px-3 py-1.5 text-xs text-white whitespace-nowrap z-10 shadow-xl pointer-events-none">
            <div className="font-semibold">{fmtLabel(data[hovered].date)}</div>
            <div className="text-violet-300 tabular-nums">{data[hovered].count} signup{data[hovered].count === 1 ? '' : 's'}</div>
          </div>
        )}

        <div className="flex items-end gap-px h-44 mt-4">
          {data.map((d, i) => {
            const heightPct = max > 0 ? (d.count / max) * 100 : 0
            const isHovered = hovered === i
            return (
              <div
                key={i}
                className="flex-1 flex flex-col justify-end cursor-crosshair group/bar"
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              >
                <div
                  className={`w-full rounded-t transition-all ${
                    isHovered ? 'bg-violet-300' : d.count > 0 ? 'bg-violet-500/80' : 'bg-white/[0.03]'
                  }`}
                  style={{ height: `${Math.max(heightPct, d.count > 0 ? 2 : 0)}%`, minHeight: d.count > 0 ? '2px' : '0' }}
                />
              </div>
            )
          })}
        </div>

        <div className="flex mt-2">
          {data.map((d, i) => (
            <div key={i} className="flex-1 text-center">
              {i % showEvery === 0 && (
                <span className="text-[10px] text-zinc-600 font-medium">{fmtLabel(d.date)}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function KillSwitchRow({
  label, description, on, busy, onChange, danger,
}: {
  label: string; description: string; on: boolean; busy: boolean
  onChange: (v: boolean) => void; danger?: boolean
}) {
  return (
    <div className={`rounded-xl border p-4 flex items-start justify-between gap-4 transition-colors ${
      on
        ? danger
          ? 'bg-red-500/10 border-red-500/30'
          : 'bg-amber-500/10 border-amber-500/30'
        : 'bg-white/[0.02] border-white/[0.06]'
    }`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-xs font-bold ${on ? (danger ? 'text-red-200' : 'text-amber-500') : 'text-white'}`}>{label}</span>
          {on && <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
            danger ? 'bg-red-500/20 text-red-200' : 'bg-amber-500/20 text-amber-500'
          }`}>ON</span>}
        </div>
        <p className="text-[11px] text-zinc-500 leading-relaxed">{description}</p>
      </div>
      <button
        onClick={() => onChange(!on)}
        disabled={busy}
        className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
          on ? (danger ? 'bg-red-500' : 'bg-amber-500') : 'bg-zinc-700'
        }`}
        title={on ? 'Click to disable' : 'Click to enable'}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )
}

function OpsCard({
  icon, title, description, loading, result, onRun, buttonLabel, buttonColor,
}: {
  icon: React.ReactNode; title: string; description: string; loading: boolean
  result: any; onRun: () => void; buttonLabel: string; buttonColor: 'amber' | 'blue'
}) {
  const btnColors = {
    amber: 'bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 border-amber-500/20',
    blue:  'bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 border-blue-500/20',
  }
  return (
    <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-5 hover:border-white/[0.1] transition-colors">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center flex-shrink-0">
          {icon}
        </div>
        <h3 className="font-bold text-sm text-white">{title}</h3>
      </div>
      <p className="text-zinc-500 text-xs leading-relaxed mb-4">{description}</p>
      <button
        onClick={onRun}
        disabled={loading}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50 ${btnColors[buttonColor]}`}
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
        {loading ? 'Running…' : buttonLabel}
      </button>
      {result && (
        <div className={`mt-3 rounded-lg p-3 text-xs font-mono ${
          result.error
            ? 'bg-red-500/10 text-red-300 border border-red-500/20'
            : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
        }`}>
          {result.error
            ? `Error: ${result.error}`
            : result.message ?? `Done — deleted: ${result.deleted ?? 0}, repaired: ${result.repaired ?? 0}, duration: ${result.durationMs ?? 0}ms`
          }
        </div>
      )}
    </div>
  )
}
