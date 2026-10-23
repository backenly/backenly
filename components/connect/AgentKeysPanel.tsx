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
import { refreshAgentConnection } from '@/lib/hooks/useAgentConnection'
import {
  CopyField,
  EmptyState,
  GhostPreview,
  KitButton,
  KitConfirmDialog,
  KitField,
  KitInput,
  KitModal,
  KitNote,
  KitSwitch,
  SectionTitle,
  Skeleton,
  Stat,
  StatStrip,
  Tag,
} from '@/components/inspector/kit'
import { formatDay, plainText } from '@/components/console/format'

interface McpKey {
  id: string
  name: string
  label: string | null
  readOnly: boolean
  masked: string
  createdAt: string
  lastUsed: string | null
  expiresAt: string | null
}

/**
 * An agent the user authorised by signing in from the browser (OAuth). It has
 * no key to show: no plaintext was ever issued.
 */
interface McpConnection {
  id: string
  client: string
  readOnly: boolean
  createdAt: string
  lastUsed: string | null
}

/** What the confirm dialog is about to remove. */
interface RevokeTarget {
  id: string
  title: string
  kind: 'key' | 'connection'
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
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [usage, setUsage] = useState<McpUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newKey, setNewKey] = useState<{ rawKey: string; label: string | null } | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newReadOnly, setNewReadOnly] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null)
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
      // Agents authorised from the browser. The route always returned them;
      // nothing rendered them, so a connected agent could not be seen or
      // disconnected here, the one place the docs send people (T4, CON-09).
      setConnections(k.data?.connections ?? [])

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
        // The runtime serves a read-only key 16 tools instead of 23; the docs
        // say read-only is chosen at issuance, and this is the issuance.
        body: JSON.stringify({ label: newLabel.trim() || null, readOnly: newReadOnly }),
      })
      const { ok, status, data } = await readJson(res)
      if (!ok || !data?.rawKey) throw new Error(data?.error || `Could not create key (HTTP ${status})`)
      setNewKey({ rawKey: data.rawKey, label: data.key.label })
      setNewLabel('')
      setNewReadOnly(false)
      setTestResult(null)
      setShowNew(false)
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
      // Revoking the last used key disconnects the agent; the top bar and the
      // empty states should say so now, not on the next focus.
      void refreshAgentConnection(projectId)
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
        // The test authenticated with the key, which is what marks it used.
        void refreshAgentConnection(projectId)
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
      {error && !showNew && <KitNote tone="danger" icon={AlertTriangle}>{error}</KitNote>}

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
                <span className="text-[12px] tabular-nums text-faint">{usage!.recent.length} events</span>
              </div>
              <ul
                tabIndex={0}
                aria-label="Recent tool calls"
                className="max-h-[380px] divide-y divide-white/[0.05] overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300/60"
              >
                {usage!.recent.map((r) => {
                  const ok = r.statusCode >= 200 && r.statusCode < 300
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span
                        role="img"
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
                          <div className="mt-0.5 truncate text-[12px] text-faint">{plainText(r.error ?? r.summary ?? '')}</div>
                        )}
                      </div>
                      <div className="w-16 flex-shrink-0 text-right text-[12px] tabular-nums text-faint">{r.ms ?? 0} ms</div>
                      <div className="w-10 flex-shrink-0 text-right text-[12px] tabular-nums text-faint">{timeAgo(r.timestamp)}</div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* ── Connected agents (browser sign-in, no key) ────────────────── */}
      {connections.length > 0 && (
        <section aria-labelledby="agent-connections-heading">
          <div className="mb-4">
            <h2 id="agent-connections-heading" className="text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-100">Connected agents</h2>
            <p className="mt-1 text-[13px] text-zinc-400">Agents you authorised by signing in from the browser. There is no key to copy; disconnect one and it stops working at once.</p>
          </div>
          <div className="relative overflow-x-auto rounded-[10px] border border-white/[0.08] bg-[#0f1012]">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="border-b border-white/[0.06] text-[12px] text-faint">
                  <th scope="col" className="h-[36px] whitespace-nowrap px-4 font-medium">Agent</th>
                  <th scope="col" className="h-[36px] whitespace-nowrap px-4 font-medium">Connected</th>
                  <th scope="col" className="h-[36px] whitespace-nowrap px-4 font-medium">Last used</th>
                  <th scope="col" className="h-[36px] whitespace-nowrap px-4 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {connections.map((c) => {
                  const stat = usage?.byKey.find((b) => b.keyId === c.id)
                  return (
                    <tr key={c.id} className="group transition-colors hover:bg-white/[0.02]">
                      <td className="px-4 py-3">
                        <div className="truncate text-[13px] font-medium text-zinc-100">{c.client}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          {c.readOnly && <Tag tone="neutral">Read-only</Tag>}
                          {stat && stat.calls7d > 0 && (
                            <span className="text-[12px] tabular-nums text-faint">{stat.calls7d.toLocaleString()} calls this week</span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[13px] tabular-nums text-zinc-400">
                        {formatDay(c.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[13px] tabular-nums text-zinc-400">
                        {c.lastUsed ? `${timeAgo(c.lastUsed)} ago` : <span className="text-faint">Never</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <KitButton
                          size="sm"
                          variant="ghost"
                          icon={Trash2}
                          loading={revoking === c.id}
                          onClick={() => setRevokeTarget({ id: c.id, title: c.client, kind: 'connection' })}
                          className="hover:!bg-rose-500/[0.10] hover:!text-rose-200"
                        >
                          Disconnect
                        </KitButton>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Keys ────────────────────────────────────────────────────────
          The label and read-only choice open in a dialog behind New key. They
          sat inline in this header, which in the narrow right column pushed
          the button past the column's edge. */}
      <section aria-labelledby="agent-keys-heading">
        <SectionTitle
          title={<span id="agent-keys-heading">Agent keys</span>}
          description="Server-side only, rate limited per key, and every change is audited."
          actions={
            <KitButton
              icon={Plug2}
              onClick={() => {
                setError(null)
                setShowNew(true)
              }}
            >
              New key
            </KitButton>
          }
        />

        {newKey && (
          <div className="mb-4 rounded-[10px] border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
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
          <div className="rounded-[10px] border border-white/[0.08] bg-[#0f1012]">
            <EmptyState
              icon={KeyRound}
              preview={<GhostPreview kind="list" />}
              title="No agent keys yet"
              description="Generate one in step 1, or create a labelled key here, to wire your first agent."
              className="py-10"
            />
          </div>
        ) : (
          <div className="relative overflow-x-auto rounded-[10px] border border-white/[0.08] bg-[#0f1012]">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="border-b border-white/[0.06] text-[12px] text-faint">
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
                          <code className="font-mono text-[12px] text-faint">{k.masked}</code>
                          {k.readOnly && <Tag tone="neutral">Read-only</Tag>}
                          {stat && stat.calls7d > 0 && (
                            <span className="text-[12px] tabular-nums text-faint">{stat.calls7d.toLocaleString()} calls this week</span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[13px] tabular-nums text-zinc-400">
                        {formatDay(k.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[13px] tabular-nums text-zinc-400">
                        {k.lastUsed ? `${timeAgo(k.lastUsed)} ago` : <span className="text-faint">Never</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <KitButton
                          size="sm"
                          variant="ghost"
                          icon={Trash2}
                          loading={revoking === k.id}
                          onClick={() => setRevokeTarget({ id: k.id, title: k.label || k.name, kind: 'key' })}
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

      <KitModal
        open={showNew}
        onClose={() => {
          if (!creating) setShowNew(false)
        }}
        title="New agent key"
        description="Scoped to this project and revocable. The key is shown once, after you create it."
        footer={
          <>
            <KitButton variant="ghost" onClick={() => setShowNew(false)} disabled={creating}>
              Cancel
            </KitButton>
            <KitButton variant="primary" icon={Plug2} loading={creating} onClick={createKey}>
              {creating ? 'Creating…' : 'Create key'}
            </KitButton>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            createKey()
          }}
          className="space-y-4"
        >
          <KitField label="Label" hint="Optional. Name the machine or agent that will use it.">
            <KitInput
              name="agent-key-label"
              autoComplete="off"
              spellCheck={false}
              placeholder="CI server…"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              disabled={creating}
              aria-label="Label"
            />
          </KitField>
          <div className="flex items-start justify-between gap-4 rounded-[8px] border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-zinc-100">Read-only</span>
              <span className="mt-0.5 block text-[12.5px] leading-[18px] text-faint">
                The agent can read the schema and data but cannot change anything.
              </span>
            </span>
            <KitSwitch checked={newReadOnly} onChange={setNewReadOnly} disabled={creating} label="Read-only" className="mt-0.5" />
          </div>
          {error && (
            <KitNote tone="danger" icon={AlertTriangle}>
              {error}
            </KitNote>
          )}
        </form>
      </KitModal>

      <KitConfirmDialog
        open={!!revokeTarget}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) revokeKey(revokeTarget.id)
          setRevokeTarget(null)
        }}
        title={
          revokeTarget?.kind === 'connection'
            ? `Disconnect ${revokeTarget.title}?`
            : `Revoke ${revokeTarget?.title || 'key'}?`
        }
        description={
          revokeTarget?.kind === 'connection'
            ? 'It stops working immediately, and its sign-in cannot be refreshed. To use it again, sign in from the agent.'
            : 'Any agent using it will stop working immediately.'
        }
        confirmLabel={revokeTarget?.kind === 'connection' ? 'Disconnect' : 'Revoke key'}
        danger
      />
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

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
