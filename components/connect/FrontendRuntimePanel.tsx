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
import { Check, Copy, AlertCircle, RefreshCw, Link2, Trash2, X } from 'lucide-react'
import {
  IconButton,
  KIT,
  KitButton,
  KitCard,
  KitCardHeader,
  KitInput,
  KitNote,
  SectionTitle,
  StatusDot,
} from '@/components/inspector/kit'

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
// Live SDK runtime telemetry. Three states:
//   1. No data yet           → a one-line hint
//   2. Successes, no errors  → "All clear" and the origins seen
//   3. Errors                → the failure count and the first failing origin,
//                              with its copy-paste fix prompt

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
        accent === 'red' ? '!border-rose-400/25' :
        accent === 'amber' ? '!border-amber-400/25' : ''
      }
    >
      <KitCardHeader
        title="Activity"
        description="SDK requests in the last 24 hours"
        actions={
          <IconButton
            icon={RefreshCw}
            label="Refresh activity"
            onClick={onRefresh}
            disabled={refreshing}
            className={refreshing ? '[&_svg]:animate-spin' : ''}
          />
        }
      />

      <div className="space-y-3 px-4 py-3.5">
        {!hasErrors && !hasTraffic && (
          <p className="text-[13px] leading-[20px] text-zinc-500">
            No SDK requests yet. Traffic and failures appear here once your app calls Backenly.
          </p>
        )}

        {!hasErrors && hasTraffic && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusDot tone="operational" label="All clear" />
              <span className="text-[12px] tabular-nums text-zinc-500">
                {totals!.bootstraps24h.toLocaleString()} requests
                {totals!.distinctOriginsConnected > 0 &&
                  ` from ${totals!.distinctOriginsConnected} ${totals!.distinctOriginsConnected === 1 ? 'origin' : 'origins'}`}
              </span>
            </div>
            <ul className={`divide-y ${KIT.divide}`}>
              {health!.successes.slice(0, 2).map((s) => (
                <li key={s.origin} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <code className="min-w-0 truncate font-mono text-[12px] text-zinc-300">{s.origin}</code>
                  <span className="flex-shrink-0 text-[12px] tabular-nums text-zinc-500">
                    {s.count.toLocaleString()}, {formatTimeAgo(s.lastSeen)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {hasErrors && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusDot tone={accent === 'red' ? 'failed' : 'attention'} label={`${totals!.failures24h.toLocaleString()} failed`} />
              {totals!.failures1h > 0 && (
                <span className="text-[12px] tabular-nums text-rose-300">{totals!.failures1h} in the last hour</span>
              )}
              {hasTraffic && (
                <span className="text-[12px] tabular-nums text-zinc-500">{totals!.bootstraps24h.toLocaleString()} succeeded</span>
              )}
            </div>
            {health!.failures.slice(0, 1).map((f, idx) => (
              <div key={`${f.origin}-${idx}`} className={`${KIT.radiusSm} border ${KIT.border} bg-[#08090a] px-3 py-2.5`}>
                <div className="mb-1.5 flex items-center gap-2">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-rose-300" strokeWidth={1.75} />
                  <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-200">{f.origin}</code>
                  <span className="flex-shrink-0 text-[12px] tabular-nums text-zinc-500">{formatTimeAgo(f.lastSeen)}</span>
                </div>
                <p className="mb-2.5 line-clamp-2 text-[12.5px] leading-[18px] text-zinc-400">{f.hint}</p>
                <KitButton size="sm" icon={copiedIdx === idx ? Check : Copy} onClick={() => onCopyFix(f.fixPrompt, idx)}>
                  {copiedIdx === idx ? 'Copied. Paste it into your agent' : 'Copy fix prompt'}
                </KitButton>
              </div>
            ))}
            {health!.failures.length > 1 && (
              <p className="text-[12px] text-zinc-500">
                {health!.failures.length - 1} more {health!.failures.length - 1 === 1 ? 'origin is' : 'origins are'} failing
              </p>
            )}
          </>
        )}

        {/* Origin-less rejections: bots, curl, or server scripts probing the
            public endpoint. Informational: real browser frontends always send
            an Origin header, so these never turn the card red. */}
        {(health?.probes?.count ?? 0) > 0 && (
          <p className={`border-t ${KIT.hairline} pt-2.5 text-[12px] leading-[18px] text-zinc-500`}>
            {health!.probes!.count.toLocaleString()} {health!.probes!.count === 1 ? 'request' : 'requests'} without an Origin header
            {health!.probes!.lastSeen ? ` (last ${formatTimeAgo(health!.probes!.lastSeen)})` : ''} were rejected. These are
            usually bots, curl, or a server script missing its API key.
          </p>
        )}
      </div>
    </KitCard>
  )
}

// ── RegisteredCard ────────────────────────────────────────────────────────────
// CORS lock-down. Optional: when no URL is bound, any origin can call the SDK.
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
      <KitCardHeader
        title="Allowed origins"
        description={
          active.length > 0
            ? `${active.length} active. Only these origins can call the SDK.`
            : 'Optional. Until you add one, any origin can call the SDK.'
        }
      />

      <div className="space-y-3 px-4 py-3.5">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onConnect(false)
          }}
        >
          <KitInput
            type="url"
            inputMode="url"
            name="frontend-origin"
            autoComplete="off"
            spellCheck={false}
            aria-label="Frontend URL"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://your-app.vercel.app"
            disabled={busy || !!pendingConnect}
            className="min-w-0 flex-1"
          />
          <KitButton
            type="submit"
            icon={Link2}
            loading={busy && !pendingConnect && !pendingDisconnect}
            disabled={!urlInput.trim() || busy || !!pendingConnect}
          >
            Add
          </KitButton>
        </form>

        {error && (
          <KitNote tone="danger" icon={AlertCircle}>
            <span className="whitespace-pre-line">{error}</span>
          </KitNote>
        )}

        {pendingConnect && (
          <KitNote tone="warn" icon={AlertCircle} title="Confirm this origin">
            <span className="block whitespace-pre-line">{pendingConnect.message}</span>
            <span className="mt-2.5 flex gap-2">
              <KitInput
                type="text"
                aria-label="Type CONNECT to confirm"
                autoComplete="off"
                spellCheck={false}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type CONNECT"
                className="min-w-0 flex-1 focus:border-amber-400/50 focus:ring-amber-400/15"
              />
              <KitButton onClick={() => onConnect(true)} disabled={confirmText !== 'CONNECT' || busy} loading={busy}>
                Confirm
              </KitButton>
              <IconButton icon={X} label="Cancel" onClick={cancelConnect} />
            </span>
          </KitNote>
        )}

        {active.length > 0 && (
          <ul className={`overflow-hidden ${KIT.radiusSm} border ${KIT.border} bg-[#08090a] divide-y ${KIT.divide}`}>
            {active.slice(0, 3).map(app => (
              <li key={app.id} className="flex items-center justify-between gap-2 py-1 pl-3 pr-1">
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-200">{app.origin}</code>
                <IconButton
                  icon={Trash2}
                  label={`Remove ${app.origin}`}
                  onClick={() => onDisconnect(app.origin, false)}
                  disabled={busy}
                />
              </li>
            ))}
            {active.length > 3 && (
              <li className="px-3 py-2 text-[12px] text-zinc-500">{active.length - 3} more</li>
            )}
          </ul>
        )}

        {pendingDisconnect && (
          <KitNote tone="danger" icon={AlertCircle} title="Confirm removing this origin">
            <span className="block whitespace-pre-line">{pendingDisconnect.message}</span>
            <span className="mt-2.5 flex gap-2">
              <KitInput
                type="text"
                aria-label="Type DISCONNECT to confirm"
                autoComplete="off"
                spellCheck={false}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type DISCONNECT"
                className="min-w-0 flex-1 focus:border-rose-400/50 focus:ring-rose-400/15"
              />
              <KitButton
                variant="danger"
                onClick={() => onDisconnect(pendingDisconnect.origin, true)}
                disabled={confirmText !== 'DISCONNECT' || busy}
                loading={busy}
              >
                Confirm
              </KitButton>
              <IconButton icon={X} label="Cancel" onClick={cancelDisconnect} />
            </span>
          </KitNote>
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
    <section>
      {/* Pointed a human at llms.txt, which is written for their agent. A
          person reading this panel needs the docs hub. */}
      <SectionTitle
        title="Frontend clients"
        description={
          <>
            Live SDK traffic and the optional origin allowlist. Your agent wires the SDK; the{' '}
            <a
              href="/docs/connect"
              target="_blank"
              rel="noreferrer"
              className="text-zinc-300 underline decoration-white/20 underline-offset-2 hover:text-zinc-100"
            >
              Connect docs
            </a>{' '}
            cover the details.
          </>
        }
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
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
    </section>
  )
}
