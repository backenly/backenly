'use client'

/**
 * AgentKeysPanel — key management + live usage for the Connect page's Agents
 * tab. Absorbed from the deleted MCP tab (components/hub/McpPanel.tsx): both
 * tabs minted the same scoped key and showed the same install commands, so the
 * setup funnel lives once in AgentInstallGuide and this panel keeps the two
 * things the MCP tab alone had — list/revoke with per-key usage, and the live
 * activity feed (calls, error rate, recent tool calls).
 *
 * Renders in the right column of the Agents tab's split layout (funnel left,
 * capabilities + keys right). `refreshSignal` bumps when AgentInstallGuide
 * mints a key, so a key created in the funnel appears here without a reload.
 *
 * Presentation composes components/inspector/kit.tsx.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  AlertTriangle, Check, Copy, KeyRound, Loader2,
  Plug2, ShieldCheck, Trash2, Zap,
} from 'lucide-react'
import {
  KIT,
  KitCard,
  KitButton,
  KitInput,
  KitConfirmDialog,
  StatTile,
  SectionLabel,
  EmptyState,
} from '@/components/inspector/kit'

interface McpKey {
  id: string
  name: string
  label: string | null
  masked: string
  createdAt: string
  lastUsed: string | null
  expiresAt: string | null
}

interface McpUsage {
  calls24h: number
  calls7d: number
  errorRate: number
  byKey: Array<{ keyId: string; name: string; label: string | null; calls7d: number; lastUsed: string | null }>
  recent: Array<{
    id: string; keyId: string; endpoint: string; tool: string | null
    statusCode: number; ms: number | null; summary: string | null
    error: string | null; mutation: boolean; timestamp: string
  }>
}

async function readJson(res: Response): Promise<{ ok: boolean; status: number; data: any }> {
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  return { ok: res.ok, status: res.status, data }
}

export function AgentKeysPanel({
  projectId,
  refreshSignal = 0,
}: {
  projectId: string
  refreshSignal?: number
}) {
  const [keys, setKeys] = useState<McpKey[]>([])
  const [usage, setUsage] = useState<McpUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newKey, setNewKey] = useState<{ rawKey: string; label: string | null } | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<McpKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  const fetchAll = useCallback(async () => {
    if (!projectId) return
    try {
      const [kRes, uRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/mcp/keys`),
        fetch(`/api/projects/${projectId}/mcp/usage`),
      ])
      const k = await readJson(kRes)
      if (!k.ok) throw new Error(k.data?.error || `Could not load keys (HTTP ${k.status})`)
      setKeys(k.data?.keys ?? [])

      const u = await readJson(uRes)
      if (u.ok && u.data) setUsage(u.data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { fetchAll() }, [fetchAll, refreshSignal])

  async function createKey() {
    setCreating(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/mcp/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: newLabel.trim() || null }),
      })
      const { ok, status, data } = await readJson(res)
      if (!ok || !data?.rawKey) throw new Error(data?.error || `Could not create key (HTTP ${status})`)
      setNewKey({ rawKey: data.rawKey, label: data.key.label })
      setNewLabel('')
      setTestResult(null)
      fetchAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key')
    } finally {
      setCreating(false)
    }
  }

  async function revokeKey(id: string) {
    setRevoking(id)
    try {
      const res = await fetch(`/api/projects/${projectId}/mcp/keys/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Revoke failed')
      fetchAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed')
    } finally {
      setRevoking(null)
    }
  }

  async function testConnection() {
    if (!newKey) return
    setTesting(true)
    setTestResult(null)
    try {
      // Hits /api/mcp/health with the just-issued raw key — the same call the
      // npm package makes on boot, so this proves the key end-to-end without
      // leaving the dashboard.
      const res = await fetch('/api/mcp/health', {
        headers: { 'x-api-key': newKey.rawKey },
      })
      const { ok, status, data } = await readJson(res)
      if (!ok || !data) {
        setTestResult({ ok: false, message: data?.error || `HTTP ${status}` })
      } else {
        setTestResult({
          ok: true,
          message: `Connected: ${data.toolCount} tools on ${data.project?.name ?? data.projectId}.`,
        })
      }
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setTesting(false)
    }
  }

  function copyRaw(text: string) {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const hasLiveActivity = !!usage && usage.calls7d > 0

  return (
    <div className="min-w-0 space-y-8">
      {error && (
        <div className={`flex items-start gap-2 ${KIT.radiusSm} border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-[12.5px] text-rose-200`}>
          <AlertTriangle className="size-4 flex-none mt-0.5" />
          {error}
        </div>
      )}

      {/* ── LIVE ACTIVITY ──────────────────────────────────────────────── */}
      {hasLiveActivity && (
        <section>
          <SectionLabel className="mb-4">Live activity · last 7 days</SectionLabel>

          <div className="grid sm:grid-cols-3 gap-3 mb-4">
            <StatTile label="Calls (24h)" value={usage!.calls24h.toLocaleString()} />
            <StatTile label="Calls (7d)" value={usage!.calls7d.toLocaleString()} />
            <StatTile
              label="Error rate (24h)"
              value={`${(usage!.errorRate * 100).toFixed(1)}%`}
              tone={usage!.errorRate > 0.1 ? 'amber' : 'neutral'}
            />
          </div>

          {usage!.recent.length > 0 && (
            <KitCard className="overflow-hidden">
              <div className={`px-4 py-2.5 border-b ${KIT.hairline} flex items-center justify-between`}>
                <SectionLabel>Recent tool calls</SectionLabel>
                <span className="text-[10px] text-zinc-600 tabular-nums font-mono">{usage!.recent.length} events</span>
              </div>
              <div className={`divide-y ${KIT.divide} max-h-[360px] overflow-y-auto`}>
                {usage!.recent.map((r) => {
                  const ok = r.statusCode >= 200 && r.statusCode < 300
                  return (
                    <div key={r.id} className="px-4 py-2.5 flex items-center gap-3 hover:bg-white/[0.01] transition-colors">
                      <span className={`inline-flex items-center gap-1.5 flex-none w-14 ${ok ? 'text-emerald-300/90' : 'text-rose-300'}`}>
                        <span className={`size-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                        <span className="text-[10px] font-mono tabular-nums">{r.statusCode}</span>
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <code className="text-[12.5px] font-mono text-zinc-200 truncate">{r.tool ?? r.endpoint}</code>
                          {r.mutation && (
                            <span className={`text-[9px] font-semibold uppercase tracking-wider ${KIT.accentText} ${KIT.accentBg} border ${KIT.accentBorder} rounded px-1.5 py-0.5`}>
                              mut
                            </span>
                          )}
                        </div>
                        {(r.summary || r.error) && (
                          <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                            {plainText(r.error ?? r.summary ?? '')}
                          </div>
                        )}
                      </div>
                      <div className="text-[11px] text-zinc-500 flex-none tabular-nums font-mono w-14 text-right">
                        {r.ms ?? 0}ms
                      </div>
                      <div className="text-[10px] text-zinc-600 flex-none tabular-nums font-mono w-12 text-right">
                        {timeAgo(r.timestamp)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </KitCard>
          )}
        </section>
      )}

      {/* ── KEYS ───────────────────────────────────────────────────────── */}
      <section>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <SectionLabel>Your agent keys</SectionLabel>
          <div className="flex items-center gap-2">
            <KitInput
              type="text"
              placeholder="Label, e.g. CI server"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              disabled={creating}
              className="w-44 disabled:opacity-50"
            />
            <KitButton onClick={createKey} disabled={creating}>
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug2 className="w-3.5 h-3.5" />}
              New key
            </KitButton>
          </div>
        </div>

        {newKey && (
          <div className={`${KIT.radius} border border-violet-500/25 bg-white/[0.015] p-4 mb-4`}>
            <div className="flex items-center gap-2 text-violet-300 text-[12.5px] font-semibold mb-2">
              <Check className="size-4" />
              Key generated{newKey.label ? ` · ${newKey.label}` : ''}
            </div>
            <p className="text-zinc-400 text-[12px] mb-3 leading-relaxed">
              Copy this now. It will <strong className="text-zinc-100">not</strong> be shown again.
            </p>
            <div className={`flex items-center gap-2 bg-[#0f1015] border ${KIT.border} ${KIT.radiusSm} px-3 py-2.5 font-mono text-[12.5px]`}>
              <KeyRound className="size-3.5 text-violet-300/70 flex-none" />
              <span className="flex-1 truncate text-zinc-50 select-all">{newKey.rawKey}</span>
              <KitButton size="sm" icon={copied ? Check : Copy} onClick={() => copyRaw(newKey.rawKey)}>
                {copied ? 'Copied' : 'Copy'}
              </KitButton>
            </div>
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <KitButton size="sm" onClick={testConnection} disabled={testing}>
                {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                Test connection
              </KitButton>
              {testResult && (
                <div className={`flex items-center gap-1.5 text-[11.5px] ${testResult.ok ? 'text-emerald-300/90' : 'text-rose-300'}`}>
                  {testResult.ok ? <ShieldCheck className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                  {testResult.message}
                </div>
              )}
              <button
                onClick={() => { setNewKey(null); setTestResult(null) }}
                className="text-[11px] text-zinc-500 hover:text-zinc-200 transition-colors focus:outline-none"
              >
                I&apos;ve saved it
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-zinc-500 text-[12.5px] flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : keys.length === 0 ? (
          <KitCard>
            <EmptyState
              icon={KeyRound}
              title="No keys yet"
              description="Generate one above to wire your first agent."
              className="py-8"
            />
          </KitCard>
        ) : (
          <KitCard className="overflow-hidden">
            <div className={`hidden sm:grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-2.5 border-b ${KIT.hairline} text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600`}>
              <span>Key</span>
              <span>Created</span>
              <span>Last used</span>
              <span className="w-16 text-right">Actions</span>
            </div>
            <div className={`divide-y ${KIT.divide}`}>
              {keys.map((k) => {
                const stat = usage?.byKey.find((b) => b.keyId === k.id)
                return (
                  <div key={k.id} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 sm:gap-4 px-4 py-3.5 items-center hover:bg-white/[0.01] transition-colors">
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium text-zinc-200 truncate">
                        {k.label || k.name}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <code className="text-[11px] font-mono text-zinc-500">{k.masked}</code>
                        {stat && stat.calls7d > 0 && (
                          <span className="text-[10.5px] font-mono tabular-nums text-zinc-500">
                            {stat.calls7d.toLocaleString()} / 7d
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-[11.5px] text-zinc-500 tabular-nums font-mono">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </div>
                    <div className="text-[11.5px] text-zinc-500 tabular-nums font-mono">
                      {k.lastUsed ? timeAgo(k.lastUsed) : '—'}
                    </div>
                    <button
                      onClick={() => setRevokeTarget(k)}
                      disabled={revoking === k.id}
                      className={`justify-self-end inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 ${KIT.radiusXs} text-rose-300/80 hover:text-rose-200 hover:bg-rose-500/[0.08] transition-colors disabled:opacity-50 focus:outline-none`}
                    >
                      {revoking === k.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                      Revoke
                    </button>
                  </div>
                )
              })}
            </div>
          </KitCard>
        )}

        <div className="flex items-center gap-2 text-[11px] text-zinc-500 mt-3">
          <ShieldCheck className="size-3" />
          Server-side use only · per-key rate limits · audit log on every mutation
        </div>
      </section>

      <KitConfirmDialog
        open={!!revokeTarget}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) revokeKey(revokeTarget.id)
          setRevokeTarget(null)
        }}
        title={`Revoke ${revokeTarget?.label || revokeTarget?.name || 'key'}?`}
        description="Any agent using it will stop working immediately."
        confirmLabel="Revoke key"
        danger
      />
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

// MCP result summaries are stored as agent-facing markdown (bold, backticks,
// emoji bullets); this feed renders plain text, so strip the formatting.
function plainText(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\u2600-\u27BF\u2B00-\u2BFF\uFE0F]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDEFF]/g, '')
    .replace(/\s*[•·]\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim()
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
