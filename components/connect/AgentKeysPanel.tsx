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
import { AlertTriangle, Check, KeyRound, Plug2, ShieldCheck, Trash2, Zap } from 'lucide-react'
import {
  CopyField,
  EmptyState,
  KitButton,
  KitConfirmDialog,
  KitInput,
  KitNote,
  SectionTitle,
  Skeleton,
  Stat,
  StatStrip,
  Tag,
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

  const hasLiveActivity = !!usage && usage.calls7d > 0

  return (
    <div className="min-w-0 space-y-10">
      {error && <KitNote tone="danger" icon={AlertTriangle}>{error}</KitNote>}

      {/* ── Live activity ─────────────────────────────────────────────── */}
      {hasLiveActivity && (
        <section aria-labelledby="agent-activity-heading">
          <SectionTitle title={<span id="agent-activity-heading">Agent activity</span>} description="Tool calls your agents made in the last 7 days." />
          <StatStrip className="mb-3">
            <Stat label="Calls, 24 hours" value={usage!.calls24h.toLocaleString()} />
            <Stat label="Calls, 7 days" value={usage!.calls7d.toLocaleString()} />
            <Stat
              label="Error rate, 24 hours"
              value={`${(usage!.errorRate * 100).toFixed(1)}%`}
              tone={usage!.errorRate > 0.1 ? 'warn' : 'neutral'}
            />
          </StatStrip>

          {usage!.recent.length > 0 && (
            <div className="overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#0f1012]">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
                <h3 className="text-[13px] font-medium text-zinc-100">Recent tool calls</h3>
                <span className="text-[12px] tabular-nums text-zinc-500">{usage!.recent.length} events</span>
              </div>
              <ul className="max-h-[380px] divide-y divide-white/[0.05] overflow-y-auto overscroll-contain">
                {usage!.recent.map((r) => {
                  const ok = r.statusCode >= 200 && r.statusCode < 300
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span
                        className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-400'}`}
                        aria-label={ok ? `Succeeded (${r.statusCode})` : `Failed (${r.statusCode})`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <code className="truncate font-mono text-[12.5px] text-zinc-100">{r.tool ?? r.endpoint}</code>
                          {r.mutation && <Tag tone="violet">Write</Tag>}
                          {!ok && <span className="text-[12px] tabular-nums text-rose-300">{r.statusCode}</span>}
                        </div>
                        {(r.summary || r.error) && (
                          <div className="mt-0.5 truncate text-[12px] text-zinc-500">{plainText(r.error ?? r.summary ?? '')}</div>
                        )}
                      </div>
                      <div className="w-16 flex-shrink-0 text-right text-[12px] tabular-nums text-zinc-500">{r.ms ?? 0} ms</div>
                      <div className="w-10 flex-shrink-0 text-right text-[12px] tabular-nums text-zinc-600">{timeAgo(r.timestamp)}</div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* ── Keys ──────────────────────────────────────────────────────── */}
      <section aria-labelledby="agent-keys-heading">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="agent-keys-heading" className="text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-100">Agent keys</h2>
            <p className="mt-1 text-[13px] text-zinc-400">Server-side only, rate limited per key, and every mutation is audited.</p>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); createKey() }}
          >
            <label className="sr-only" htmlFor="agent-key-label">Label for a new key</label>
            <KitInput
              id="agent-key-label"
              name="agent-key-label"
              autoComplete="off"
              type="text"
              placeholder="Label, e.g. CI server…"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              disabled={creating}
              className="w-full sm:w-48"
            />
            <KitButton type="submit" icon={Plug2} loading={creating}>
              New key
            </KitButton>
          </form>
        </div>

        {newKey && (
          <div className="mb-4 rounded-[10px] border border-violet-300/25 bg-violet-400/[0.04] p-4">
            <p className="flex items-center gap-2 text-[13px] font-medium text-zinc-100">
              <Check className="h-4 w-4 text-emerald-300" />
              Key created{newKey.label ? `: ${newKey.label}` : ''}
            </p>
            <p className="mb-3 mt-1 text-[12.5px] text-zinc-400">Copy it now. It will not be shown again.</p>
            <CopyField value={newKey.rawKey} />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <KitButton size="sm" icon={Zap} loading={testing} onClick={testConnection}>
                Test connection
              </KitButton>
              {testResult && (
                <span
                  role="status"
                  className={`flex items-center gap-1.5 text-[12.5px] ${testResult.ok ? 'text-emerald-300' : 'text-rose-300'}`}
                >
                  {testResult.ok ? <ShieldCheck className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {testResult.message}
                </span>
              )}
              <KitButton size="sm" variant="ghost" className="ml-auto" onClick={() => { setNewKey(null); setTestResult(null) }}>
                I’ve saved it
              </KitButton>
            </div>
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-[56px] w-full rounded-[10px]" />
          </div>
        ) : keys.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-white/[0.10]">
            <EmptyState
              icon={KeyRound}
              title="No agent keys yet"
              description="Generate one in step 1, or add a labelled key here, to wire your first agent."
              className="py-10"
            />
          </div>
        ) : (
          <div className="overflow-x-auto rounded-[10px] border border-white/[0.08] bg-[#0f1012]">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="border-b border-white/[0.06] text-[12px] text-zinc-500">
                  <th scope="col" className="h-[36px] whitespace-nowrap px-4 font-medium">Key</th>
                  <th scope="col" className="h-[36px] whitespace-nowrap px-4 font-medium">Created</th>
                  <th scope="col" className="h-[36px] whitespace-nowrap px-4 font-medium">Last used</th>
                  <th scope="col" className="h-[36px] whitespace-nowrap px-4 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {keys.map((k) => {
                  const stat = usage?.byKey.find((b) => b.keyId === k.id)
                  return (
                    <tr key={k.id} className="group transition-colors hover:bg-white/[0.02]">
                      <td className="px-4 py-3">
                        <div className="truncate text-[13px] font-medium text-zinc-100">{k.label || k.name}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          <code className="font-mono text-[12px] text-zinc-500">{k.masked}</code>
                          {stat && stat.calls7d > 0 && (
                            <span className="text-[12px] tabular-nums text-zinc-500">{stat.calls7d.toLocaleString()} calls this week</span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[13px] tabular-nums text-zinc-400">
                        {new Date(k.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[13px] tabular-nums text-zinc-400">
                        {k.lastUsed ? `${timeAgo(k.lastUsed)} ago` : <span className="text-zinc-600">Never</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <KitButton
                          size="sm"
                          variant="ghost"
                          icon={Trash2}
                          loading={revoking === k.id}
                          onClick={() => setRevokeTarget(k)}
                          className="hover:!bg-rose-500/[0.10] hover:!text-rose-200"
                        >
                          Revoke
                        </KitButton>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
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
