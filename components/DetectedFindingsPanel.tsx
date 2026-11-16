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
 * Rebuilt in place 2026-11-16: a row leads with what happens to it next, ◐
 * "Fixed on the next pass" when the mode will repair it, ◆ "Needs your agent"
 * when Backenly has no repair; Copy for agent is a visible button on those;
 * Dismiss stays in ⋯ (a portal menu now, so no panel clips it); the severity
 * word appears only for Critical; the affected table links to its page; and a
 * failed read is an error row, never a silent nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ClipboardCopy, XCircle } from 'lucide-react'
import { KitButton, OverflowMenu, TextWithCode, type GlyphState } from '@/components/inspector/kit'
import { groupFindings, CATEGORY_LABEL, type FindingGroup } from '@/lib/core/finding-groups'
import { Disclosure, Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { hasExecutableFix } from '@/lib/core/fix-actions'
import { sharedRead } from '@/lib/client/shared-read'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { findingIcon } from '@/components/autonomy/row-icons'
import { FOCUS } from '@/components/console/tokens'
import { agentPrompt, CopyForAgent } from '@/components/ReviewQueuePanel'

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
  | { phase: 'dismissed' }
  | { phase: 'error'; message: string }

/**
 * What the loop does with these WITHOUT the user, said once above the rows
 * only where a row cannot say it for itself. Under Review-only, claiming
 * "Backenly fixes this itself" on a row would be a lie for every visible
 * repair: the next pass raises those for approval and applies only the silent
 * additive ones.
 */
function dispositionCopy(level: Level | undefined): string | null {
  if (level === 'CONSERVATIVE') {
    return 'On its next pass, Review-only applies the silent additive ones (indexes, API definitions) and asks you about the rest.'
  }
  if (level === 'OFF') {
    return 'Autonomy is off, so nothing here is applied until you pick a mode or fix it here.'
  }
  return null
}

/** What happens to a row next, as its lead and its first fact. */
function nextFor(level: Level | undefined, repairable: boolean): { glyph: GlyphState; word: string } {
  if (!repairable) return { glyph: 'waiting', word: 'Needs your agent' }
  if (level === 'AGGRESSIVE' || level === 'BALANCED') return { glyph: 'busy', word: 'Fixed on the next pass' }
  return { glyph: 'waiting', word: 'Fix now to apply it' }
}

/** Whether Backenly can run a repair for any member (the same test the Review Queue uses). */
const repairable = (g: FindingGroup<HealthFinding>) => g.members.some(m => hasExecutableFix(m.type, m.details))

/**
 * Where the affected object lives, so a finding links to it: a table to
 * Database, a function to Functions, a webhook endpoint to Webhooks. Auth and
 * provider findings have no single object page.
 */
function objectHref(projectId: string, type: string, subject: string | undefined): string | null {
  if (!subject) return null
  const base = `/app/projects/${projectId}`
  if (/webhook/i.test(type)) return `${base}/webhooks?endpoint=${encodeURIComponent(subject)}`
  if (/function/i.test(type)) return `${base}/functions?fn=${encodeURIComponent(subject)}`
  if (/auth|oauth|jwt|integration|smtp|deploy|key/i.test(type)) return null
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(subject)) return null
  return `${base}/database?table=${encodeURIComponent(subject)}`
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function DetectedFindingsPanel({
  projectId,
  level,
  refreshKey = 0,
  canFix = true,
}: {
  projectId: string
  level?: Level
  /** Bumped by the page every 30 s and on focus: the panel re-reads quietly. */
  refreshKey?: number
  /** Fixing or dismissing takes a developer or above. */
  canFix?: boolean
}) {
  const [data, setData] = useState<HealthPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  // Rows settled on this visit stay, with their outcome, until the page is left.
  const [settled, setSettled] = useState<Record<string, FindingGroup<HealthFinding>>>({})
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  const setRow = (id: string, s: RowState) =>
    setRowState(prev => ({ ...prev, [id]: s }))

  const fetchHealth = useCallback(async (fresh = false) => {
    try {
      // The first load shares the top bar's read; a refresh after an action,
      // or asked for, reads afresh (lib/client/shared-read.ts).
      const res = await sharedRead(`/api/projects/${projectId}/health`, { fresh })
      if (!res.ok) throw new Error('fetch failed')
      const j = res.data
      setData(j?.data ?? null)
      setError(false)
    } catch {
      // A failed refresh keeps what was shown; a failed first read says so.
      setError(true)
    } finally {
      setLoading(false)
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => { void fetchHealth(refreshKey > 0) }, [fetchHealth, refreshKey])

  const openFindings = useMemo(
    () => (data?.findings ?? [])
      .filter(f => f.status === 'open')
      .map(f => ({ ...f, details: f.details ?? null })),
    [data],
  )

  const groups = useMemo(() => groupFindings(openFindings), [openFindings])

  /**
   * Uncapped open count. `findings` is a 50-row preview, so measuring it would
   * silently under-report a project over the cap. Both uncapped totals come
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
    setSettled(prev => ({ ...prev, [g.key]: g }))
    void fetchHealth(true)
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
      setRow(g.key, { phase: 'dismissed' })
      setSettled(prev => ({ ...prev, [g.key]: g }))
      void fetchHealth(true)
    } catch {
      setRow(g.key, { phase: 'error', message: 'Network error. Try again.' })
    }
  }

  // A failed first read says so in the panel: an error must never read as
  // "nothing detected".
  if (error && !data) {
    return (
      <Section id="autonomy-detected" title="Detected">
        <Panel>
          <ErrorRow things="findings" onRetry={() => { setRetrying(true); void fetchHealth(true) }} retrying={retrying} />
        </Panel>
      </Section>
    )
  }

  const settledGroups = Object.values(settled).filter(g => !groups.some(x => x.key === g.key))
  // Nothing detected → render nothing. "Waiting on you" already owns the
  // all-clear message for this page; a second empty panel would repeat it.
  if (loading || (groups.length === 0 && settledGroups.length === 0)) return null

  return (
    <Section
      id="autonomy-detected"
      title="Detected"
      count={openTotal}
      description={dispositionCopy(level)}
      aside={
        groups.length > 0 && groups.length < openTotal ? (
          <span className="text-[12.5px] tabular-nums text-faint">
            in {groups.length} {groups.length === 1 ? 'issue' : 'issues'}
          </span>
        ) : undefined
      }
    >
      <Panel>
        <RowList>
          {[...settledGroups, ...groups].map(g => (
            <DetectedRow
              key={g.key}
              projectId={projectId}
              group={g}
              level={level}
              canFix={canFix}
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
  projectId,
  group: g,
  level,
  canFix,
  state,
  onFix,
  onDismiss,
  onResetError,
}: {
  projectId: string
  group: FindingGroup<HealthFinding>
  level?: Level
  canFix: boolean
  state: RowState
  /** Absent when Backenly has no repair to run: approving would only fail. */
  onFix?: () => void
  onDismiss: () => void
  onResetError: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const head = g.members[0]
  const many = g.members.length > 1
  const title = <p className={ROW_TITLE}><TextWithCode text={g.title} codeClassName="text-zinc-100" /></p>
  const next = nextFor(level, !!onFix)

  if (state.phase === 'verified' || state.phase === 'dismissed') {
    const fixed = state.phase === 'verified'
    return (
      <Row
        lead="well"
        icon={findingIcon(g.category)}
        tone="done"
        id={`finding-${g.key}`}
        title={title}
      >
        {!fixed && (
          <Facts>
            <Fact strong>Dismissed</Fact>
          </Facts>
        )}
        {fixed && (
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
        )}
      </Row>
    )
  }

  const busy = state.phase === 'applying' || state.phase === 'dismissing'
  const subject = !many ? g.subjects[0] : undefined
  const href = objectHref(projectId, head.type, subject)

  return (
    <Row
      lead="well"
      icon={findingIcon(g.category)}
      busy={state.phase === 'applying'}
      id={`finding-${g.key}`}
      title={title}
      actions={
        state.phase === 'error' ? (
          <KitButton variant="secondary" onClick={onResetError}>Try again</KitButton>
        ) : canFix ? (
          <>
            {onFix ? (
              <KitButton variant="secondary" onClick={onFix} disabled={busy} loading={state.phase === 'applying'}>
                {state.phase === 'applying' ? (many ? `Fixing ${g.members.length}…` : 'Fixing…') : many ? `Fix all ${g.members.length}` : 'Fix now'}
              </KitButton>
            ) : (
              <CopyForAgent prompt={agentPrompt(g)} />
            )}
            <OverflowMenu
              label={`More actions for: ${g.title}`}
              disabled={busy}
              width="w-[230px]"
              items={[
                ...(onFix ? [{ label: 'Copy for agent', icon: ClipboardCopy, onClick: () => { void navigator.clipboard?.writeText(agentPrompt(g)) } }] : []),
                { label: state.phase === 'dismissing' ? 'Dismissing…' : 'Dismiss', icon: XCircle, onClick: onDismiss },
              ]}
            />
          </>
        ) : (
          <CopyForAgent prompt={agentPrompt(g)} />
        )
      }
    >
      <Facts>
        <Fact strong>{next.word}</Fact>
        {g.severity === 'critical' && <Fact strong><span className="font-medium text-zinc-50">Critical</span></Fact>}
        <Fact>{CATEGORY_LABEL[g.category]}</Fact>
        {subject && !head.type.includes(subject) && (
          <Fact>
            {href ? (
              <Link href={href} className={`rounded-[3px] font-mono text-[12px] text-zinc-300 underline decoration-white/20 underline-offset-2 hover:text-zinc-50 ${FOCUS}`}>
                {subject}
              </Link>
            ) : (
              <code className="font-mono text-[12px] text-zinc-400">{subject}</code>
            )}
          </Fact>
        )}
        {head.detectedAt && <Fact><Time iso={head.detectedAt} /></Fact>}
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

      {state.phase === 'error' && <RefusedLine className="mt-2.5">{state.message}</RefusedLine>}
    </Row>
  )
}
