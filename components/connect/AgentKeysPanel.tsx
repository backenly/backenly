'use client'

/**
 * Connect → Agents: the agents that can reach this project, and what they did.
 *
 *   Agents  2                                                       [Add agent]
 *   ✳ Claude Code — MacBook ●                                                 ⋯
 *     mcp_live_af6a4f6…   486 calls this week   Last call 12 min ago
 *   ⌘ CI ○                                                                    ⋯
 *     mcp_live_8c891a0…   Read-only   42 calls this week   Last call 1 d ago
 *
 *   Tool calls                          64 in 24 h   1.6% failed   528 in 7 days
 *   Today
 *   ✓ 9:13:20 AM  read_backend_state   231 ms   Backend state Tables 8 follows…  ⌄
 *
 * Keys and agents signed in from the browser are one list, each with its own
 * ⋯ (Revoke key, or Disconnect): they are the same thing to the person, an
 * agent that can reach the project. A tool call expands in place to its full
 * result or error. One "Add agent" dialog creates every agent key
 * (AgentSetup.tsx), replacing "Generate key", the old "New key" dialog and
 * the reveal box, which all made the same request.
 *
 * With no agent yet the tab is the setup itself (AgentSetup), and it stays the
 * setup until the new key's first call, even though the key now exists, so
 * the command does not vanish the moment it is made.
 *
 * Creating and revoking keys is ADMIN (mcp/keys). Everyone else reads the list
 * and one sentence saying who can change it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KitButton, KitConfirmDialog, OverflowMenu, StatusGlyph } from '@/components/inspector/kit'
import { EmptyLine, Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { CodeWell, DayGroup, DayGroupList, EventRow } from '@/components/console/EventRow'
import { Time, useNow } from '@/components/console/Time'
import { duration, formatTime, groupByDay, plainText } from '@/components/console/format'
import { refreshAgentConnection, useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { AddAgentDialog, AgentSetup, AgentSetupSkeleton, agentMarkFor } from './AgentSetup'

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

/** An agent authorised by signing in from the browser (OAuth): no key was ever shown. */
interface McpConnection {
  id: string
  client: string
  readOnly: boolean
  createdAt: string
  lastUsed: string | null
}

interface McpUsage {
  calls24h: number
  calls7d: number
  errorRate: number
  byKey: Array<{ keyId: string; calls7d: number; lastUsed: string | null }>
  recent: Array<{
    id: string
    keyId: string
    endpoint: string
    tool: string | null
    statusCode: number
    ms: number | null
    summary: string | null
    error: string | null
    mutation: boolean
    timestamp: string
  }>
}

/** One row of the list: a key or a browser sign-in. */
interface AgentEntry {
  id: string
  kind: 'key' | 'connection'
  name: string
  masked: string | null
  readOnly: boolean
  createdAt: string
  lastUsed: string | null
}

async function readJson(res: Response): Promise<any> {
  try {
    if (typeof res.text === 'function') {
      const text = await res.text()
      return text ? JSON.parse(text) : null
    }
    return await res.json()
  } catch {
    return null
  }
}

/** Called within the hour: the one state that may show as live (lib/mcp/agent-connection.ts). */
const ACTIVE_WITHIN_MS = 60 * 60_000

/** Agent-written text with its markdown taken out, line breaks kept. */
function readable(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

/** A result's first line for its row: agent text flattened, its bullets read as a list rather than middle dots. */
function oneLine(s: string): string {
  return plainText(s).replace(/:\s*·\s*/g, ': ').replace(/\s*·\s*/g, ', ')
}

/** How many tool calls show before "Show all". */
const CALLS_SHOWN = 10

export function AgentKeysPanel({ projectId, refreshSignal = 0 }: { projectId: string; refreshSignal?: number }) {
  const role = useProjectRole(projectId)
  const agent = useAgentConnection(projectId)
  const now = useNow()
  const [keys, setKeys] = useState<McpKey[]>([])
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [usage, setUsage] = useState<McpUsage | null>(null)
  const [usageFailed, setUsageFailed] = useState(false)
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [staleAt, setStaleAt] = useState<number | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [adding, setAdding] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<AgentEntry | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [refusal, setRefusal] = useState<{ id: string; message: string } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showAllCalls, setShowAllCalls] = useState(false)
  const loaded = useRef(false)
  // The setup stays on screen from its Generate key until the agent's first call.
  const [setupPinned, setSetupPinned] = useState(false)

  const fetchAll = useCallback(async () => {
    try {
      const [kRes, uRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/mcp/keys`, { credentials: 'include' }),
        fetch(`/api/projects/${projectId}/mcp/usage`, { credentials: 'include' }),
      ])
      const k = await readJson(kRes)
      if (!kRes.ok || !k) throw new Error(k?.error || `HTTP ${kRes.status}`)
      setKeys(Array.isArray(k.keys) ? k.keys : [])
      // Agents authorised from the browser: the route always returned them.
      setConnections(Array.isArray(k.connections) ? k.connections : [])
      const u = await readJson(uRes)
      if (uRes.ok && u) {
        setUsage(u)
        setUsageFailed(false)
      } else {
        setUsageFailed(true)
      }
      loaded.current = true
      setLoad('ready')
      setStaleAt(null)
    } catch {
      // A failed refresh keeps the list and says how old it is; a failed first read says so instead.
      if (loaded.current) setStaleAt(Date.now())
      else setLoad('error')
    } finally {
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll, refreshSignal])

  // A passed Test connection is not the agent calling: the setup stays until the person moves on.
  const [setupTested, setSetupTested] = useState(false)
  // The agent's first call ends the setup: show the list it now belongs to.
  useEffect(() => {
    if (setupPinned && agent.connected && !setupTested) {
      setSetupPinned(false)
      void fetchAll()
    }
  }, [setupPinned, agent.connected, setupTested, fetchAll])

  const entries = useMemo<AgentEntry[]>(
    () => [
      ...keys.map((k) => ({
        id: k.id,
        kind: 'key' as const,
        name: k.label || k.name,
        masked: k.masked,
        readOnly: k.readOnly,
        createdAt: k.createdAt,
        lastUsed: k.lastUsed,
      })),
      ...connections.map((c) => ({
        id: c.id,
        kind: 'connection' as const,
        name: c.client,
        masked: null,
        readOnly: c.readOnly,
        createdAt: c.createdAt,
        lastUsed: c.lastUsed,
      })),
    ],
    [keys, connections],
  )

  async function revoke(target: AgentEntry) {
    setRevoking(true)
    setRefusal(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/mcp/keys/${target.id}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) {
        const body = await readJson(res)
        throw new Error(body?.error || 'Could not revoke it. Try again.')
      }
      setRevokeTarget(null)
      await fetchAll()
      // Revoking the last used key disconnects the agent: every surface should say so now.
      void refreshAgentConnection(projectId)
    } catch (err) {
      setRevokeTarget(null)
      setRefusal({ id: target.id, message: err instanceof Error ? err.message : 'Could not revoke it. Try again.' })
    } finally {
      setRevoking(false)
    }
  }

  const canChange = role.canAdminister

  if (load === 'loading' || (role.loading && entries.length === 0)) {
    return (
      <Section id="agents" title="Agents">
        <Panel>
          <RowSkeleton rows={2} lead="icon" />
        </Panel>
      </Section>
    )
  }

  if (load === 'error') {
    return (
      <Section id="agents" title="Agents">
        <Panel>
          <ErrorRow
            things="agents"
            onRetry={() => {
              setRetrying(true)
              void fetchAll()
            }}
            retrying={retrying}
          />
        </Panel>
      </Section>
    )
  }

  // No agent yet: the tab is the setup, as on a new project's Overview.
  if (entries.length === 0 || setupPinned) {
    if (role.loading) {
      return (
        <Section id="agents-setup" title="Connect your coding agent">
          <AgentSetupSkeleton />
        </Section>
      )
    }
    if (canChange || setupPinned) {
      return (
        <Section id="agents-setup" title="Connect your coding agent">
          <AgentSetup
            projectId={projectId}
            onKeyCreated={() => {
              setSetupPinned(true)
              void fetchAll()
            }}
            onTested={() => setSetupTested(true)}
          />
        </Section>
      )
    }
    return (
      <Section id="agents" title="Agents">
        <Panel>
          <div className="px-[20px] py-[18px]">
            <h3 className="text-[15px] font-medium leading-[22px] tracking-[-0.012em] text-white">No agents yet</h3>
            <p className="mt-[4px] text-[13px] leading-[20px] text-zinc-400">
              Agents connected to this project appear here. Only an owner or admin can connect one.
            </p>
          </div>
        </Panel>
      </Section>
    )
  }

  const statOf = (id: string) => usage?.byKey.find((b) => b.keyId === id)
  const recent = usage?.recent ?? []
  const calls = showAllCalls ? recent : recent.slice(0, CALLS_SHOWN)

  return (
    <div className="space-y-[36px]">
      <Section
        id="agents"
        title="Agents"
        count={entries.length}
        aside={
          canChange ? (
            <KitButton size="sm" onClick={() => setAdding(true)}>
              Add agent
            </KitButton>
          ) : undefined
        }
      >
        <Panel clip={false}>
          {staleAt && (
            <ErrorRow
              things="agents"
              staleAt={staleAt}
              onRetry={() => {
                setRetrying(true)
                void fetchAll()
              }}
              retrying={retrying}
            />
          )}
          <RowList>
            {entries.map((e) => {
              const stat = statOf(e.id)
              const lastMs = e.lastUsed ? Date.parse(e.lastUsed) : NaN
              const active = now !== null && Number.isFinite(lastMs) && now - lastMs < ACTIVE_WITHIN_MS
              return (
                <Row
                  key={e.id}
                  lead="icon"
                  icon={agentMarkFor(e.name)}
                  title={
                    <p className={`flex min-w-0 flex-wrap items-center gap-x-[8px] ${ROW_TITLE}`}>
                      <span className="min-w-0 [overflow-wrap:anywhere]">{e.name}</span>
                      <StatusGlyph
                        state={active ? 'live' : 'idle'}
                        label={active ? 'Called within the hour' : e.lastUsed ? 'Quiet' : 'Never used'}
                      />
                    </p>
                  }
                  actions={
                    canChange ? (
                      <OverflowMenu
                        label={`Actions for ${e.name}`}
                        items={[
                          e.kind === 'key'
                            ? { label: 'Revoke key', danger: true, onClick: () => setRevokeTarget(e) }
                            : { label: 'Disconnect', danger: true, onClick: () => setRevokeTarget(e) },
                        ]}
                      />
                    ) : undefined
                  }
                >
                  <Facts>
                    {e.masked ? (
                      <Fact>
                        <code className="font-mono text-[11.5px] text-zinc-400">{e.masked}</code>
                      </Fact>
                    ) : (
                      <Fact>Signed in from the browser</Fact>
                    )}
                    {e.readOnly && <Fact strong>Read-only</Fact>}
                    {stat && stat.calls7d > 0 && (
                      <Fact>
                        {stat.calls7d.toLocaleString('en-US')} {stat.calls7d === 1 ? 'call' : 'calls'} this week
                      </Fact>
                    )}
                    <Fact>{e.lastUsed ? <Time iso={e.lastUsed} prefix="Last call" /> : 'Never used'}</Fact>
                  </Facts>
                  {refusal?.id === e.id && <RefusedLine className="mt-[8px]">{refusal.message}</RefusedLine>}
                </Row>
              )
            })}
          </RowList>
        </Panel>
        {!canChange && !role.loading && (
          <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">Only owners and admins can add or revoke keys.</p>
        )}
      </Section>

      <Section
        id="tool-calls"
        title="Tool calls"
        aside={
          usage && usage.calls7d > 0 ? (
            <span className="flex flex-wrap items-center justify-end gap-x-[14px] gap-y-[2px] text-[12.5px] tabular-nums text-faint">
              <span>{usage.calls24h.toLocaleString('en-US')} in 24 h</span>
              <span className={usage.errorRate > 0.1 ? 'font-medium text-zinc-50' : ''}>{(usage.errorRate * 100).toFixed(1)}% failed</span>
              <span>{usage.calls7d.toLocaleString('en-US')} in 7 days</span>
            </span>
          ) : undefined
        }
      >
        <Panel>
          {usageFailed && !usage ? (
            <ErrorRow things="tool calls" stillWorks="Your agents keep working." onRetry={() => void fetchAll()} />
          ) : recent.length === 0 ? (
            <EmptyLine>No tool calls in the last 7 days.</EmptyLine>
          ) : (
            <>
              <DayGroupList>
                {groupByDay(calls, (r) => r.timestamp).map((g) => (
                  <DayGroup key={g.key} label={g.label}>
                    {g.items.map((r) => {
                      const ok = r.statusCode >= 200 && r.statusCode < 300
                      const text = readable(r.error ?? r.summary ?? '')
                      return (
                        <EventRow
                          key={r.id}
                          glyph={ok ? 'done' : 'failed'}
                          glyphLabel={ok ? 'Succeeded' : `Failed with ${r.statusCode}`}
                          time={r.timestamp}
                          what={r.tool ?? r.endpoint}
                          mono
                          result={r.ms === null ? '' : duration(r.ms)}
                          line={text ? oneLine(text) : ok ? '' : String(r.statusCode)}
                          lineMono={!ok && /^[A-Z_]+$/.test(text)}
                          expanded={expanded === r.id}
                          onToggle={() => setExpanded((cur) => (cur === r.id ? null : r.id))}
                          columns={{ what: 168, result: 64 }}
                        >
                          <CodeWell
                            label={ok ? (r.mutation ? 'What it changed' : 'What it returned') : `Failed with ${r.statusCode}`}
                            copy={text || undefined}
                          >
                            {text || (ok ? 'It returned nothing to show.' : `HTTP ${r.statusCode}`)}
                            {'\n\n'}
                            {formatTime(r.timestamp, 'dateTime')}
                            {r.ms !== null ? `, ${duration(r.ms)}` : ''}
                          </CodeWell>
                        </EventRow>
                      )
                    })}
                  </DayGroup>
                ))}
              </DayGroupList>
              {recent.length > CALLS_SHOWN && (
                <div className="border-t border-white/[0.06] px-[20px] py-[10px]">
                  <KitButton size="sm" variant="ghost" onClick={() => setShowAllCalls((v) => !v)} className="-ml-[10px]">
                    {showAllCalls ? 'Show fewer' : `Show all ${recent.length}`}
                  </KitButton>
                </div>
              )}
            </>
          )}
        </Panel>
      </Section>

      <AddAgentDialog open={adding} projectId={projectId} onClose={() => setAdding(false)} onCreated={() => void fetchAll()} />

      <KitConfirmDialog
        open={!!revokeTarget}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) void revoke(revokeTarget)
        }}
        busy={revoking}
        danger
        title={revokeTarget?.kind === 'connection' ? `Disconnect ${revokeTarget.name}?` : `Revoke ${revokeTarget?.name ?? 'key'}?`}
        description={
          revokeTarget?.kind === 'connection'
            ? 'It stops working immediately. To use it again, sign in from the agent.'
            : 'Any agent using it stops working immediately.'
        }
        undoable={false}
        confirmLabel={revokeTarget?.kind === 'connection' ? 'Disconnect' : 'Revoke key'}
      />
    </div>
  )
}
