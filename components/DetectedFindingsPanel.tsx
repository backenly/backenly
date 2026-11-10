'use client'

/**
 * DetectedFindingsPanel — the OPEN half of the one queue.
 *
 * Why this exists (2026-07-28):
 *
 * The loop's Detect node counts `open + pending_approval`, but the only queue
 * surface in the product (ReviewQueuePanel) renders the trust report's
 * `pendingApprovals` — `pending_approval` ONLY. Findings sitting at `open` were
 * rendered by Overview's Backend health block until it was deleted on
 * 2026-07-21 for saying things twice, on the stated principle that "Autonomy
 * owns the one queue". Autonomy never actually took ownership of that half, so
 * from that day an `open` finding rendered NOWHERE in the product.
 *
 * The user-visible failure: Overview says "DETECT 2 need attention" and fires
 * the "A few things to clear before launch → Open inspector" hero (which gates
 * on open findings), you land on Autonomy, and it says "Nothing waiting on
 * you". Both statements were true and the pair was unusable — the dashboard
 * pointed at a page that had been built to not show the thing it pointed at.
 *
 * So: "Waiting on you" keeps its exact meaning (needs YOUR call, nothing else
 * appears there), and this panel carries the rest. Detect's number is now
 * visibly the sum of the two cards under it.
 *
 * Data source is `/health` — the SAME endpoint the Detect node counts from,
 * deliberately, not the trust report. Two endpoints over one table on
 * independent refresh schedules is exactly what once made the loop render
 * "10 need attention · 14 of those, held for you"; the counts here cannot
 * drift from the counts above because they are the same fetch of the same rows.
 *
 * Rows are ROOT-CAUSE GROUPS (lib/core/finding-groups), same as the approval
 * queue: the loop writes one finding per affected table, so one bad policy
 * across nine tables is one row, one decision.
 *
 * Visual language: the locked flat inspector kit — #16171d surface, hairline
 * borders, mono numerals, violet for the primary action only. No gradients,
 * no glow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RefreshCw, CheckCircle2, Loader2, XCircle, ClipboardCopy, Check, Gauge, ShieldAlert, Activity, Wrench,
} from 'lucide-react'
import { IconButton, KitButton, MetaCode, OverflowMenu, StatusDot, TextWithCode } from '@/components/inspector/kit'
import {
  groupFindings, CATEGORY_LABEL, severityWord, type FindingCategory, type FindingGroup,
} from '@/lib/core/finding-groups'
import { Disclosure, Fact, Facts, Panel, Row, RowList, RowNote, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { hasExecutableFix } from '@/lib/core/fix-actions'

// ── Types ────────────────────────────────────────────────────────────────────

/** The /health row shape. Structurally satisfies GroupableFinding. */
interface HealthFinding {
  id: string
  type: string
  severity: string
  details: Record<string, unknown> | null
  status: string
  detectedAt: string | null
}

interface HealthPayload {
  /** TRUNCATED preview — safe to render, never to count. */
  findings?: HealthFinding[]
  /** Uncapped open + pending_approval. */
  actionableTotal?: number
  /** Uncapped pending_approval. */
  needsAttention?: number
}

type Level = 'OFF' | 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'

type RowState =
  | { phase: 'idle' }
  | { phase: 'applying' }
  | { phase: 'dismissing' }
  /** How many of the fixes applied kept a snapshot to restore from. */
  | { phase: 'verified'; applied: number; snapshots: number }
  | { phase: 'error'; message: string }

function timeAgo(iso: string | null): string {
  if (!iso) return 'unknown'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * What the loop will do with these WITHOUT the user. Mode-dependent, because
 * claiming "Backenly fixes these itself" under Review-only would be a lie —
 * in that mode the next pass raises them for approval instead of applying.
 */
function dispositionCopy(level: Level | undefined, allRepairable: boolean): string {
  if (level === 'CONSERVATIVE') {
    return 'On its next pass, Review-only applies the silent additive ones (indexes, API definitions) and asks you about the rest. You can also fix any of them now.'
  }
  if (level === 'OFF') {
    return 'Autonomy is off, so nothing here is applied until you pick a mode or fix it here.'
  }
  // Only what Backenly has a repair for is queued. A finding with none (a
  // failed verification, a probe of the live API) was promised a next pass
  // that never fixed it.
  if (!allRepairable) {
    return 'Ones with Fix now are queued for Backenly’s next pass and need no approval. The others have no repair Backenly can run, so hand them to your coding agent.'
  }
  return 'Queued for Backenly’s next pass, with no approval needed. Fix now to skip the wait.'
}

/** Whether Backenly can run a repair for any member (the same test the Review Queue uses). */
const repairable = (g: FindingGroup<HealthFinding>) => g.members.some(m => hasExecutableFix(m.type, m.details))

/** The prompt handed to the user's coding agent — same contract as the approval queue. */
function agentPrompt(g: FindingGroup<HealthFinding>): string {
  const head = g.members[0]
  return [
    `My Backenly backend flagged a ${g.severity} ${CATEGORY_LABEL[g.category]} issue I want addressed in my app:`,
    ``,
    `Issue: ${g.title}`,
    `Type: ${head.type}`,
    g.subjects.length > 0 ? `Affected: ${g.subjects.join(', ')}` : '',
    `Context: ${JSON.stringify(head.details ?? {}, null, 2)}`,
    ``,
    `If this belongs in the backend (schema, RLS, API, auth), tell me to run it through Backenly so the change stays governed and reversible. If it belongs in my frontend/client code, make the change directly.`,
  ].filter(Boolean).join('\n')
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function DetectedFindingsPanel({
  projectId,
  level,
}: {
  projectId: string
  level?: Level
}) {
  const [data, setData] = useState<HealthPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  const setRow = (id: string, s: RowState) =>
    setRowState(prev => ({ ...prev, [id]: s }))

  const fetchHealth = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    setError(false)
    try {
      const res = await fetch(`/api/projects/${projectId}/health`, { credentials: 'include' })
      if (!res.ok) throw new Error('fetch failed')
      const j = await res.json()
      setData(j?.data ?? null)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [projectId])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  const openFindings = useMemo(
    () => (data?.findings ?? [])
      .filter(f => f.status === 'open')
      .map(f => ({ ...f, details: f.details ?? null })),
    [data],
  )

  const groups = useMemo(() => groupFindings(openFindings), [openFindings])

  /**
   * Uncapped open count. `findings` is a 50-row preview, so measuring it would
   * silently under-report a project over the cap — the precise mistake that
   * once capped the Detect node at its preview limit. Both uncapped totals come
   * from this payload, and open = actionable − held.
   */
  const openTotal = useMemo(() => {
    if (typeof data?.actionableTotal === 'number' && typeof data?.needsAttention === 'number') {
      return Math.max(0, data.actionableTotal - data.needsAttention)
    }
    return openFindings.length
  }, [data, openFindings])

  /** One finding's fix. 409 = project lock held by a scan; ride the server's wait. */
  const fixOne = async (
    findingId: string,
    retriesLeft = 3,
  ): Promise<{ ok: boolean; error?: string; snapshotId?: string | null }> => {
    try {
      const res = await fetch(`/api/projects/${projectId}/health/approve`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findingId }),
      })
      const j = await res.json().catch(() => ({} as any))
      if (res.ok && j?.success) return { ok: true, snapshotId: typeof j.snapshotId === 'string' ? j.snapshotId : null }
      if (res.status === 409 && retriesLeft > 0) {
        await new Promise(r => { timers.current.push(setTimeout(r, 2500)) })
        return fixOne(findingId, retriesLeft - 1)
      }
      return { ok: false, error: j?.error || 'The fix could not be applied. Try again in a moment.' }
    } catch {
      return { ok: false, error: 'Network error. Check your connection and try again.' }
    }
  }

  /**
   * Sequential, not parallel — the fix path takes a project-level lock, so
   * firing a group at once would have every member after the first bounce off
   * 409 and burn its retries against its own siblings.
   */
  const fixGroup = async (g: FindingGroup<HealthFinding>) => {
    setRow(g.key, { phase: 'applying' })
    let applied = 0
    let firstError: string | undefined
    let snapshots = 0
    for (const m of g.members) {
      const r = await fixOne(m.id)
      if (r.ok) {
        applied += 1
        if (r.snapshotId) snapshots += 1
      } else if (!firstError) firstError = r.error
    }

    if (applied === 0) {
      setRow(g.key, {
        phase: 'error',
        message: firstError ?? 'The fix could not be applied. Try again in a moment.',
      })
      return
    }

    setRow(g.key, { phase: 'verified', applied, snapshots })
    const t = setTimeout(async () => {
      await fetchHealth(true)
      setRowState(prev => {
        const { [g.key]: _gone, ...rest } = prev
        return rest
      })
    }, 2400)
    timers.current.push(t)
  }

  const dismissGroup = async (g: FindingGroup<HealthFinding>) => {
    setRow(g.key, { phase: 'dismissing' })
    try {
      for (const m of g.members) {
        const res = await fetch(`/api/projects/${projectId}/health`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ findingId: m.id }),
        })
        if (!res.ok) {
          setRow(g.key, { phase: 'error', message: 'Could not dismiss. Try again.' })
          return
        }
      }
      await fetchHealth(true)
      setRowState(prev => {
        const { [g.key]: _gone, ...rest } = prev
        return rest
      })
    } catch {
      setRow(g.key, { phase: 'error', message: 'Network error. Try again.' })
    }
  }

  // Nothing detected → render nothing. "Waiting on you" already owns the
  // all-clear message for this page; a second empty card would just repeat it.
  // A failed fetch is also silent: the Detect node above is the count of
  // record, and an error card here would imply findings exist that we cannot
  // show, which is a scarier claim than the one we can support.
  if (loading || error || groups.length === 0) return null

  return (
    <Section
      id="autonomy-detected"
      title="Detected"
      count={openTotal}
      description={dispositionCopy(level, groups.every(repairable))}
      aside={
        <>
          {groups.length < openTotal && (
            <span className="text-[12.5px] tabular-nums text-faint">
              in {groups.length} {groups.length === 1 ? 'issue' : 'issues'}
            </span>
          )}
          <IconButton
            icon={RefreshCw}
            label="Refresh findings"
            onClick={() => fetchHealth(true)}
            disabled={refreshing}
            className={refreshing ? '[&_svg]:animate-spin' : ''}
          />
        </>
      }
    >
      <Panel>
        <RowList>
          {groups.map(g => (
            <DetectedRow
              key={g.key}
              group={g}
              state={rowState[g.key] ?? { phase: 'idle' }}
              onFix={repairable(g) ? () => fixGroup(g) : undefined}
              onDismiss={() => dismissGroup(g)}
              onResetError={() => setRow(g.key, { phase: 'idle' })}
            />
          ))}
        </RowList>

        {/* The preview cap is stated rather than hidden: a project over 50
            actionable rows would otherwise look like it had exactly 50. */}
        {openTotal > openFindings.length && (
          <p className="border-t border-white/[0.06] px-5 py-3 text-[12.5px] tabular-nums text-faint">
            Showing {openFindings.length} of {openTotal}. The rest appear as these clear.
          </p>
        )}
      </Panel>
    </Section>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────

function DetectedRow({
  group: g,
  state,
  onFix,
  onDismiss,
  onResetError,
}: {
  group: FindingGroup<HealthFinding>
  state: RowState
  /** Absent when Backenly has no repair to run: approving would only fail. */
  onFix?: () => void
  onDismiss: () => void
  onResetError: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const head = g.members[0]
  const many = g.members.length > 1
  const title = <p className={ROW_TITLE}><TextWithCode text={g.title} codeClassName="text-zinc-100" /></p>

  if (state.phase === 'verified') {
    return (
      <Row icon={CheckCircle2} tone="done" title={title} className="animate-fade-in">
        <Facts>
          <Fact>Fixed{many ? ` on ${g.members.length} tables` : ''}</Fact>
          {/* Said only for what the approve route kept a snapshot of: a fix
              that takes none (an index, say) returns snapshotId null. */}
          {state.snapshots > 0 && (
            <Fact>
              {state.snapshots === state.applied
                ? 'Rollback snapshot captured'
                : `Rollback snapshot captured for ${state.snapshots} of ${state.applied}`}
            </Fact>
          )}
        </Facts>
      </Row>
    )
  }

  const busy = state.phase === 'applying' || state.phase === 'dismissing'

  const handToAgent = async () => {
    try {
      await navigator.clipboard.writeText(agentPrompt(g))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard blocked — no-op */ }
  }

  return (
    <Row
      icon={CATEGORY_ICON[g.category] ?? Activity}
      tone={g.severity === 'critical' ? 'danger' : 'neutral'}
      busy={state.phase === 'applying'}
      className={state.phase === 'error' ? 'bg-rose-500/[0.03]' : ''}
      title={title}
      actions={
        state.phase === 'error' ? (
          <KitButton variant="primary" onClick={onResetError}>Try again</KitButton>
        ) : (
          <>
            {onFix && (
              <KitButton variant="secondary" onClick={onFix} disabled={busy}>
                {state.phase === 'applying'
                  ? <><Loader2 className="size-3.5 animate-spin" /> {many ? `Fixing ${g.members.length}…` : 'Fixing…'}</>
                  : <><Wrench className="size-3.5" /> {many ? `Fix all ${g.members.length}` : 'Fix now'}</>}
              </KitButton>
            )}
            <OverflowMenu
              label={`More actions for: ${g.title}`}
              disabled={busy}
              width="w-[230px]"
              items={[
                { label: 'Hand to my agent', icon: ClipboardCopy, onClick: () => { void handToAgent() } },
                { label: state.phase === 'dismissing' ? 'Dismissing…' : 'Dismiss', icon: XCircle, onClick: onDismiss },
              ]}
            />
          </>
        )
      }
    >
      <Facts>
        <StatusDot tone={g.severity === 'critical' ? 'failed' : g.severity === 'warning' ? 'attention' : 'neutral'} label={severityWord(g.severity)} />
        <Fact>{CATEGORY_LABEL[g.category]}</Fact>
        {!many && g.subjects[0] && !head.type.includes(g.subjects[0]) && <Fact><MetaCode>{g.subjects[0]}</MetaCode></Fact>}
        <Fact><span className="tabular-nums">{timeAgo(head.detectedAt)}</span></Fact>
        {copied && <Fact icon={Check} strong>Copied for your agent</Fact>}
      </Facts>

      {many && (
        <>
          <Disclosure open={expanded} onToggle={() => setExpanded(v => !v)}>
            {g.members.length} findings, one cause
          </Disclosure>
          {expanded && (
            <ul className="mt-2 space-y-1 border-l-2 border-white/[0.08] pl-3">
              {g.members.map((m, i) => (
                <li key={m.id} className="font-mono text-[12px] leading-[19px] text-zinc-400">
                  {g.subjects[i] ?? m.type}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {state.phase === 'error' && (
        <RowNote tone="danger" icon={XCircle} role="alert">{state.message}</RowNote>
      )}
    </Row>
  )
}

/** What a finding is about, as the row's tile. */
const CATEGORY_ICON: Record<FindingCategory, typeof Gauge> = {
  security: ShieldAlert,
  performance: Gauge,
  reliability: Activity,
}
