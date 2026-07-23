'use client'

/**
 * Frontend runtime cards — live SDK traffic + the origin allowlist, rendered
 * on Connect → Direct.
 *
 * These two cards used to live on the Connect → "Frontend SDK" tab. That tab
 * was removed 2026-07-19: its hero (the copy-paste SDK snippet) duplicated the
 * coordinates the Agents tab and llms.txt already hand to the agent, and the
 * audience is agent-native — the agent wires the SDK, not a human copying a
 * snippet. What was NOT redundant survives here:
 *
 *   • ActivityCard    — 24h SDK connection health from the deployed frontend:
 *                       traffic, failures grouped by origin, and copy-paste
 *                       fix prompts for the user's coding agent. This is the
 *                       click target of FrontendConnectionPill (sidebar +
 *                       Deploy page).
 *   • RegisteredCard  — the CORS origin allowlist (connected-apps registry).
 *                       Server-gated + audit-logged; the only human UI for it
 *                       (agents manage it over MCP via connect_frontend /
 *                       disconnect_frontend).
 */

import { useEffect, useState } from 'react'
import { Check, Copy, AlertCircle, RefreshCw, Link2, Trash2, X, Loader2 } from 'lucide-react'
import { KIT, KitCard, KitBadge, KitInput, SectionLabel } from '@/components/inspector/kit'

// ── Connection health types ───────────────────────────────────────────────────
type FailureKind = 'missing' | 'placeholder' | 'malformed' | 'unknown_key' | 'expired' | 'unknown'
interface FailureGroup {
  origin: string
  kind: FailureKind
  sentKeyShape: string | null
  count: number
  lastSeen: string
  hint: string
  fixPrompt: string
}
interface SuccessGroup { origin: string; count: number; lastSeen: string }
interface ConnectionHealth {
  failures: FailureGroup[]
  successes: SuccessGroup[]
  // Origin-less rejections (curl / bots / server scripts) — shown as a quiet
  // informational line, never as a red failure state.
  probes?: { count: number; lastSeen: string | null }
  totals: {
    failures24h: number
    failures1h: number
    bootstraps24h: number
    distinctOriginsFailing: number
    distinctOriginsConnected: number
  }
  summaryText: string
}

// ── Registered frontend ("connected app") types ──────────────────────────────
// These differ from `successes` in ConnectionHealth: those are origins that have
// *called* the API recently (auto-detected). A ConnectedApp is an origin that
// has been *bound* to this backend explicitly via /api/projects/[id]/connected-apps
// — versioned, audit-logged, and gated by a confirmation step server-side.
interface ConnectedApp {
  id: string
  origin: string
  isActive: boolean
  connectedBy: string
  backendVersion: number
  connectedAt: string
  disconnectedAt: string | null
}

// ── ActivityCard ──────────────────────────────────────────────────────────────
// Compact card showing live SDK runtime telemetry. Three states:
//   1. No data yet           → muted onboarding hint
//   2. Successes, no errors  → emerald "All clear" + last seen origins
//   3. Errors                → amber/red count + 1 expanded failure with Copy-fix

interface ActivityCardProps {
  health: ConnectionHealth | null
  refreshing: boolean
  onRefresh: () => void
  onCopyFix: (prompt: string, idx: number) => void
  copiedIdx: number | null
  formatTimeAgo: (iso: string) => string
}

function ActivityCard({ health, refreshing, onRefresh, onCopyFix, copiedIdx, formatTimeAgo }: ActivityCardProps) {
  const totals = health?.totals
  const hasErrors = !!totals && totals.failures24h > 0
  const hasTraffic = !!totals && totals.bootstraps24h > 0
  const accent = hasErrors
    ? (totals!.failures1h > 0 ? 'red' : 'amber')
    : (hasTraffic ? 'ok' : 'neutral')

  return (
    <KitCard
      className={
        accent === 'red' ? '!border-rose-500/25' :
        accent === 'amber' ? '!border-amber-500/25' : ''
      }
    >
      <div className={`px-4 py-2.5 border-b ${KIT.hairline} flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <span className={`h-[5px] w-[5px] rounded-full ${
            accent === 'red' ? 'bg-rose-400' :
            accent === 'amber' ? 'bg-amber-400' :
            accent === 'ok' ? 'bg-emerald-400' :
            'bg-zinc-600'
          }`} />
          <SectionLabel>Activity · 24h</SectionLabel>
        </div>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className={`p-1 ${KIT.radiusXs} hover:bg-white/[0.04] disabled:opacity-40 focus:outline-none`}
          title="Refresh"
        >
          <RefreshCw className={`w-3 h-3 text-zinc-500 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        {!hasErrors && !hasTraffic && (
          <p className="text-[11.5px] text-zinc-500 leading-relaxed">
            No SDK requests yet. Traffic and failures appear here once your app calls Backenly.
          </p>
        )}

        {!hasErrors && hasTraffic && (
          <>
            <div className="flex items-center gap-2 text-[11.5px]">
              <KitBadge tone="operational">All clear</KitBadge>
              <span className="text-zinc-500 tabular-nums font-mono text-[10.5px]">· {totals!.bootstraps24h.toLocaleString()} req</span>
              {totals!.distinctOriginsConnected > 0 && (
                <span className="text-zinc-600 font-mono text-[10.5px]">· {totals!.distinctOriginsConnected} {totals!.distinctOriginsConnected === 1 ? 'origin' : 'origins'}</span>
              )}
            </div>
            {health!.successes.slice(0, 2).map(s => (
              <div key={s.origin} className="flex items-center justify-between text-[11px]">
                <code className="font-mono text-zinc-400 truncate">{s.origin}</code>
                <div className="flex items-center gap-2 flex-shrink-0 font-mono tabular-nums">
                  <span className="text-emerald-300/90">{s.count}</span>
                  <span className="text-zinc-600">{formatTimeAgo(s.lastSeen)}</span>
                </div>
              </div>
            ))}
          </>
        )}

        {hasErrors && (
          <>
            <div className="flex items-center gap-3 text-[11.5px] flex-wrap">
              <span className="flex items-center gap-1.5">
                <span className={`h-[5px] w-[5px] rounded-full ${accent === 'red' ? 'bg-rose-400' : 'bg-amber-400'}`} />
                <span className="text-zinc-200 tabular-nums font-mono font-semibold">{totals!.failures24h}</span>
                <span className="text-zinc-500">failed</span>
                {totals!.failures1h > 0 && (
                  <span className="text-rose-300 font-mono text-[10.5px]">({totals!.failures1h} in last hour)</span>
                )}
              </span>
              {hasTraffic && (
                <span className="flex items-center gap-1.5">
                  <span className="h-[5px] w-[5px] rounded-full bg-emerald-400" />
                  <span className="text-zinc-400 tabular-nums font-mono">{totals!.bootstraps24h}</span>
                  <span className="text-zinc-600">ok</span>
                </span>
              )}
            </div>
            {health!.failures.slice(0, 1).map((f, idx) => (
              <div
                key={`${f.origin}-${idx}`}
                className={`${KIT.radiusSm} border ${KIT.border} bg-[#0f1015] px-3 py-2.5`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <AlertCircle className="w-3 h-3 text-rose-300 flex-shrink-0" />
                  <code className="text-[11px] font-mono text-zinc-200 truncate flex-1">{f.origin}</code>
                  <span className="text-[10px] text-zinc-600 font-mono flex-shrink-0">{formatTimeAgo(f.lastSeen)}</span>
                </div>
                <p className="text-[10.5px] text-zinc-400 leading-relaxed mb-2 line-clamp-2">{f.hint}</p>
                <button
                  onClick={() => onCopyFix(f.fixPrompt, idx)}
                  className={`flex items-center gap-1 px-2 py-1 ${KIT.radiusXs} ${KIT.accentBg} hover:bg-white/[0.10] border ${KIT.accentBorder} ${KIT.accentText} text-[10px] font-semibold transition-colors focus:outline-none`}
                >
                  {copiedIdx === idx ? (
                    <><Check className="w-2.5 h-2.5" /> Copied. Paste into your agent</>
                  ) : (
                    <><Copy className="w-2.5 h-2.5" /> Copy fix prompt</>
                  )}
                </button>
              </div>
            ))}
            {health!.failures.length > 1 && (
              <p className="text-[10px] text-zinc-600">+{health!.failures.length - 1} more origin{health!.failures.length - 1 === 1 ? '' : 's'} failing</p>
            )}
          </>
        )}

        {/* Origin-less rejections — bots, curl, or server scripts probing the
            public endpoint. Informational: real browser frontends always send
            an Origin header, so these never flip the card red. */}
        {(health?.probes?.count ?? 0) > 0 && (
          <p className={`text-[10px] text-zinc-600 leading-relaxed border-t ${KIT.hairline} pt-2`}>
            {health!.probes!.count} unattributed request{health!.probes!.count === 1 ? '' : 's'} rejected
            {health!.probes!.lastSeen ? ` · ${formatTimeAgo(health!.probes!.lastSeen)}` : ''} · no Origin header;
            usually bots, curl, or a server script missing its API key.
          </p>
        )}
      </div>
    </KitCard>
  )
}

// ── RegisteredCard ────────────────────────────────────────────────────────────
// CORS lock-down. Optional — when no URL is bound, any origin can call the SDK.
// Once at least one URL is bound, the allowlist becomes strict.

interface RegisteredCardProps {
  apps: ConnectedApp[]
  urlInput: string
  setUrlInput: (v: string) => void
  busy: boolean
  error: string | null
  pendingConnect: { origin: string; backendVersion: number; message: string } | null
  pendingDisconnect: { origin: string; message: string } | null
  confirmText: string
  setConfirmText: (v: string) => void
  onConnect: (force: boolean) => void
  onDisconnect: (origin: string, force: boolean) => void
  cancelConnect: () => void
  cancelDisconnect: () => void
}

function RegisteredCard({
  apps, urlInput, setUrlInput, busy, error,
  pendingConnect, pendingDisconnect, confirmText, setConfirmText,
  onConnect, onDisconnect, cancelConnect, cancelDisconnect,
}: RegisteredCardProps) {
  const active = apps.filter(a => a.isActive)

  return (
    <KitCard>
      <div className={`px-4 py-2.5 border-b ${KIT.hairline} flex items-center justify-between`}>
        <SectionLabel>Registered frontends</SectionLabel>
        {active.length > 0 && (
          <span className="text-[10px] text-zinc-600 tabular-nums font-mono">{active.length} active</span>
        )}
      </div>

      <div className="px-4 py-3 space-y-2.5">
        <div className="flex gap-1.5">
          <KitInput
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://your-app.vercel.app"
            disabled={busy || !!pendingConnect}
            className="flex-1 min-w-0 disabled:opacity-50"
          />
          <button
            onClick={() => onConnect(false)}
            disabled={!urlInput.trim() || busy || !!pendingConnect}
            className={`flex items-center gap-1 px-2.5 h-8 ${KIT.accentBg} hover:bg-white/[0.10] border ${KIT.accentBorder} disabled:opacity-40 ${KIT.accentText} text-[11px] font-semibold ${KIT.radiusSm} transition-colors flex-shrink-0 focus:outline-none`}
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
            Bind
          </button>
        </div>

        {!error && !pendingConnect && active.length === 0 && (
          <p className="text-[10.5px] text-zinc-500 leading-snug">
            Optional. Without a URL bound, any origin can call your SDK.
          </p>
        )}

        {error && (
          <div className={`flex items-start gap-1.5 px-2.5 py-1.5 bg-rose-500/[0.06] border border-rose-500/20 ${KIT.radiusSm}`}>
            <AlertCircle className="w-3 h-3 text-rose-300 flex-shrink-0 mt-0.5" />
            <p className="text-[10.5px] text-rose-300/90 leading-snug whitespace-pre-line">{error}</p>
          </div>
        )}

        {pendingConnect && (
          <div className={`bg-amber-500/[0.05] border border-amber-500/20 ${KIT.radiusSm} p-2.5 space-y-1.5`}>
            <p className="text-[10.5px] text-amber-500/90 leading-snug whitespace-pre-line">{pendingConnect.message}</p>
            <div className="flex gap-1.5">
              <KitInput
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type CONNECT"
                className="flex-1 min-w-0 focus:border-amber-500/50 focus:ring-amber-500/15"
              />
              <button
                onClick={() => onConnect(true)}
                disabled={confirmText !== 'CONNECT' || busy}
                className={`px-2.5 h-8 bg-amber-500/[0.15] border border-amber-500/25 disabled:opacity-40 text-amber-500 text-[11px] font-semibold ${KIT.radiusSm} focus:outline-none`}
              >
                Confirm
              </button>
              <button onClick={cancelConnect} className={`px-2 h-8 bg-white/[0.04] border border-white/10 text-zinc-400 hover:text-zinc-100 ${KIT.radiusSm} focus:outline-none`}>
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {active.length > 0 && (
          <ul className={`${KIT.radiusSm} border ${KIT.hairline} bg-[#0f1015] divide-y ${KIT.divide}`}>
            {active.slice(0, 3).map(app => (
              <li key={app.id} className="flex items-center justify-between px-2.5 py-2 gap-2">
                <code className="text-[11px] font-mono text-zinc-200 truncate flex-1">{app.origin}</code>
                <button
                  onClick={() => onDisconnect(app.origin, false)}
                  disabled={busy}
                  className="text-rose-300/70 hover:text-rose-300 disabled:opacity-40 p-0.5 flex-shrink-0 focus:outline-none"
                  title="Disconnect"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </li>
            ))}
            {active.length > 3 && (
              <li className="px-2.5 py-1.5 text-[10px] text-zinc-600">+{active.length - 3} more</li>
            )}
          </ul>
        )}

        {pendingDisconnect && (
          <div className={`bg-rose-500/[0.05] border border-rose-500/20 ${KIT.radiusSm} p-2.5 space-y-1.5`}>
            <p className="text-[10.5px] text-rose-300/90 leading-snug whitespace-pre-line">{pendingDisconnect.message}</p>
            <div className="flex gap-1.5">
              <KitInput
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type DISCONNECT"
                className="flex-1 min-w-0 focus:border-rose-500/50 focus:ring-rose-500/15"
              />
              <button
                onClick={() => onDisconnect(pendingDisconnect.origin, true)}
                disabled={confirmText !== 'DISCONNECT' || busy}
                className={`px-2.5 h-8 bg-rose-500/[0.15] border border-rose-500/25 disabled:opacity-40 text-rose-300 text-[11px] font-semibold ${KIT.radiusSm} focus:outline-none`}
              >
                Confirm
              </button>
              <button onClick={cancelDisconnect} className={`px-2 h-8 bg-white/[0.04] border border-white/10 text-zinc-400 hover:text-zinc-100 ${KIT.radiusSm} focus:outline-none`}>
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}
      </div>
    </KitCard>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function FrontendRuntimeCards({ projectId }: { projectId: string }) {
  const [health, setHealth] = useState<ConnectionHealth | null>(null)
  const [healthRefreshing, setHealthRefreshing] = useState(false)
  const [fixPromptCopiedIdx, setFixPromptCopiedIdx] = useState<number | null>(null)

  // ── Registered frontends (connected-apps registry) ─────────────────────────
  const [apps, setApps] = useState<ConnectedApp[]>([])
  const [appsLoaded, setAppsLoaded] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connectBusy, setConnectBusy] = useState(false)
  const [pendingConnect, setPendingConnect] = useState<{ origin: string; backendVersion: number; message: string } | null>(null)
  const [pendingDisconnect, setPendingDisconnect] = useState<{ origin: string; message: string } | null>(null)
  const [confirmText, setConfirmText] = useState('')

  async function loadHealth() {
    setHealthRefreshing(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/connection-health`, { credentials: 'include' })
      if (res.ok) setHealth(await res.json())
    } catch {}
    finally { setHealthRefreshing(false) }
  }

  async function refreshApps() {
    try {
      const res = await fetch(`/api/projects/${projectId}/connected-apps`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setApps(data.apps || [])
      }
    } catch {}
    finally { setAppsLoaded(true) }
  }

  // Server-gated bind: status 202 means the server wants explicit confirmation
  // (e.g. you're rebinding to an older backend version). We surface that as the
  // typed-CONNECT box instead of forcing the bind through silently.
  async function submitConnect(force: boolean) {
    if (!urlInput.trim()) return
    setConnectBusy(true)
    setConnectError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/connected-apps`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput.trim(), force }),
      })
      const data = await res.json()

      if (res.status === 202 && data.requiresConfirmation) {
        setPendingConnect({ origin: data.origin, backendVersion: data.backendVersion, message: data.message })
        setConfirmText('')
        return
      }

      if (!data.success) {
        setConnectError(data.message || 'Connection failed')
        return
      }

      setPendingConnect(null)
      setUrlInput('')
      setConfirmText('')
      await refreshApps()
    } catch (e: any) {
      setConnectError(e.message || 'Connection failed')
    } finally {
      setConnectBusy(false)
    }
  }

  async function submitDisconnect(origin: string, force: boolean) {
    setConnectBusy(true)
    try {
      const qs = new URLSearchParams({ url: origin, force: String(force) })
      const res = await fetch(`/api/projects/${projectId}/connected-apps?${qs}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      const data = await res.json()

      if (res.status === 202 && data.requiresConfirmation) {
        setPendingDisconnect({ origin, message: data.message })
        setConfirmText('')
        return
      }

      setPendingDisconnect(null)
      setConfirmText('')
      await refreshApps()
    } finally {
      setConnectBusy(false)
    }
  }

  useEffect(() => {
    loadHealth()
    refreshApps()
    // Re-poll every 15s so a developer who pastes a fix into their agent sees
    // the failure count drop in real time. Cheap query (5k events cap).
    const t = setInterval(() => {
      loadHealth()
    }, 15_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function handleCopyFixPrompt(prompt: string, idx: number) {
    await navigator.clipboard.writeText(prompt)
    setFixPromptCopiedIdx(idx)
    setTimeout(() => setFixPromptCopiedIdx(null), 2500)
  }

  function formatTimeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime()
    const s = Math.floor(diff / 1000)
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  }

  return (
    <div className="mt-6">
      <SectionLabel>Frontend clients</SectionLabel>
      {/* Pointed a human at llms.txt, which is written for their agent. A
          person reading this panel needs /quickstart. */}
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-500 max-w-2xl">
        Live SDK traffic and the optional origin allowlist. Your agent wires the SDK — see{' '}
        <a href="/quickstart" target="_blank" rel="noreferrer" className="text-zinc-300 underline decoration-white/20 underline-offset-2 hover:text-zinc-100">
          Quickstart
        </a>
        .
      </p>
      <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <ActivityCard
          health={health}
          refreshing={healthRefreshing}
          onRefresh={loadHealth}
          onCopyFix={handleCopyFixPrompt}
          copiedIdx={fixPromptCopiedIdx}
          formatTimeAgo={formatTimeAgo}
        />
        {appsLoaded && (
          <RegisteredCard
            apps={apps}
            urlInput={urlInput}
            setUrlInput={setUrlInput}
            busy={connectBusy}
            error={connectError}
            pendingConnect={pendingConnect}
            pendingDisconnect={pendingDisconnect}
            confirmText={confirmText}
            setConfirmText={setConfirmText}
            onConnect={submitConnect}
            onDisconnect={submitDisconnect}
            cancelConnect={() => { setPendingConnect(null); setConfirmText('') }}
            cancelDisconnect={() => { setPendingDisconnect(null); setConfirmText('') }}
          />
        )}
      </div>
    </div>
  )
}
