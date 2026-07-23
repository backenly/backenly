'use client'

/**
 * AdvisorBlock — the Overview "Backend health" summary.
 *
 * WHAT THIS IS NOT, ANYMORE (2026-07-21): a working queue.
 *
 * It used to render every open finding with Approve & fix / Hand to my agent /
 * Details — the same list, with a different set of buttons, that the Autonomy
 * page renders under "Waiting on you". Two working queues over one table meant
 * the counts drifted, approving in one left the other stale, and the user met
 * the same ten rows twice on the way to fixing one thing. Autonomy owns the
 * queue now (it is the page with the dial that governs it); Overview answers
 * the only question Overview should answer — is my backend healthy, and if not,
 * what is wrong — and hands off.
 *
 * Rows are ROOT-CAUSE GROUPS, not findings (lib/core/finding-groups). Nine
 * `rls_expression_invalid` rows are one wrong policy dialect across nine
 * tables; showing them as nine rows told the user "you have nine problems"
 * when they had one. The group count is kept visible so nothing is hidden by
 * the fold.
 *
 * The auto-heal choreography stays: when the loop closes a finding on its own,
 * the row resolves in place before it leaves. That is the product's signature
 * moment and it is driven by a real state transition, never a timer.
 *
 * Design is the locked flat kit: #16171d panel, hairlines, mono numerals,
 * violet only for the hand-off link. No gradients, no glows.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ShieldCheck, RefreshCw, Check, ArrowUpRight } from 'lucide-react'
import {
  groupFindings, countFindings, categoryOf, severityLabel, CATEGORY_LABEL,
  type GroupableFinding,
} from '@/lib/core/finding-groups'
import { summariseFinding } from '@/lib/core/finding-summaries'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AdvisorFinding extends GroupableFinding {
  id: string
  type: string
  severity: 'critical' | 'warning' | 'info' | string
  details: Record<string, any> | null
  status: string // 'open' | 'pending_approval' | 'auto_fixed' | 'fixed' | 'dismissed'
  detectedAt: string | null
}

interface AdvisorBlockProps {
  projectId: string
  /** TRUNCATED preview from /health — safe to render, never to count. */
  findings: AdvisorFinding[]
  /**
   * Uncapped totals from the same payload. The preview array stops at the API's
   * limit, so a project over that limit would otherwise report its own truncated
   * length as the total and quietly understate what is wrong.
   */
  actionableTotal: number | null
  heldForYou: number | null
  lastCheckedIso: string | null
  /** Called after a re-scan so the parent can refresh its own state. */
  onChanged?: () => void
  /** Hand-off to the one working queue. */
  onReview: () => void
}

// How many groups to show before folding the rest into a count. Three rows is
// the point where the panel still reads as a summary rather than a list.
const VISIBLE_GROUPS = 4

// ── Component ────────────────────────────────────────────────────────────────

export function AdvisorBlock({
  projectId, findings, actionableTotal, heldForYou, lastCheckedIso, onChanged, onReview,
}: AdvisorBlockProps) {
  const [scanning, setScanning] = useState(false)

  const actionable = useMemo(
    () => findings.filter((f) => f.status === 'open' || f.status === 'pending_approval'),
    [findings],
  )

  const groups = useMemo(() => groupFindings(actionable), [actionable])
  // The preview's own count, used only to detect that the API truncated.
  const shownFindings = countFindings(groups)
  // What the user actually has. Falls back to the preview when the API predates
  // the uncapped field, which can only ever under-report — never invent.
  const total = actionableTotal ?? shownFindings
  const held = heldForYou ?? actionable.filter((f) => f.status === 'pending_approval').length
  const truncated = total > shownFindings

  // Auto-heal watch: when a finding that was actionable disappears from the
  // incoming list on its own (the autonomous loop closed it), hold the row
  // briefly to play a resolve animation — the fix becoming visible, not just
  // the row vanishing.
  const prevActionableRef = useRef<Map<string, AdvisorFinding> | null>(null)
  const [autoHealed, setAutoHealed] = useState<AdvisorFinding[]>([])
  useEffect(() => {
    const curr = new Map(actionable.map((f) => [f.id, f]))
    const prev = prevActionableRef.current
    prevActionableRef.current = curr
    if (prev == null) return
    const healed: AdvisorFinding[] = []
    for (const [id, f] of prev) if (!curr.has(id)) healed.push(f)
    if (healed.length === 0) return
    setAutoHealed((list) => [...list, ...healed.filter((h) => !list.some((x) => x.id === h.id))])
    for (const h of healed) {
      setTimeout(() => setAutoHealed((list) => list.filter((x) => x.id !== h.id)), 2600)
    }
  }, [actionable])

  const rescan = async () => {
    if (scanning) return
    setScanning(true)
    try {
      await fetch(`/api/projects/${projectId}/health`, { method: 'PATCH', credentials: 'include' })
      onChanged?.()
    } catch { /* silent — the button just re-enables */ } finally {
      setScanning(false)
    }
  }

  const lastScan = lastCheckedIso ? relativeTime(lastCheckedIso) : null
  const shown = groups.slice(0, VISIBLE_GROUPS)
  const foldedGroups = groups.length - shown.length
  const foldedFindings = total - countFindings(shown)

  return (
    <section className="relative overflow-hidden rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-violet-300" />
          <h2 className="text-[13px] font-semibold tracking-tight text-zinc-100">Backend health</h2>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-[10.5px] tabular-nums text-zinc-600">
            {lastScan ? `Last scan ${lastScan}` : 'First scan running…'}
          </span>
          <button
            onClick={rescan}
            disabled={scanning}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 text-[11.5px] font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-60"
            title="Run the deterministic detectors now. Free, and never spends autonomy budget"
          >
            <RefreshCw className={`h-3 w-3 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? 'Scanning' : 'Re-scan'}
          </button>
        </div>
      </div>

      {/* Groups */}
      <div className="px-3 pb-2 pt-2.5">
        {shown.length === 0 && autoHealed.length === 0 ? (
          <div className="flex items-center gap-2.5 px-2 py-6 text-[12.5px] text-zinc-500">
            <ShieldCheck className="h-4 w-4 text-emerald-400/80" />
            No open issues. Backenly keeps checking schema, APIs, auth and storage, and reports anything here first.
          </div>
        ) : (
          <div className="space-y-1.5">
            {/* Rows the loop just closed on its own — resolve in place, then leave. */}
            <AnimatePresence initial={false}>
              {autoHealed.map((f) => {
                const sev = severityLabel(f.severity)
                return (
                  <motion.div
                    key={`healed-${f.id}`}
                    initial={{ opacity: 1 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0, transition: { duration: 0.4 } }}
                    className="relative overflow-hidden rounded-lg border border-white/[0.12] bg-white/[0.04]"
                  >
                    <motion.div
                      initial={{ x: '-110%' }}
                      animate={{ x: '110%' }}
                      transition={{ duration: 1.15, ease: 'easeInOut' }}
                      className="pointer-events-none absolute inset-y-0 w-2/3 bg-[linear-gradient(to_right,transparent,rgba(167,139,250,0.16),transparent)]"
                    />
                    <div className="relative flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                      <SeverityChip sev={sev} />
                      <CategoryChip label={CATEGORY_LABEL[categoryOf(f)]} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-300">
                        {summariseFinding(f.type, f.details)}
                      </span>
                      <motion.span
                        initial={{ opacity: 0, x: 4 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.5, duration: 0.35 }}
                        className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-emerald-300"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Backenly fixed this
                      </motion.span>
                    </div>
                  </motion.div>
                )
              })}
            </AnimatePresence>

            {shown.map((g) => {
              const sev = severityLabel(g.severity)
              return (
                <div
                  key={g.key}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2.5"
                >
                  <SeverityChip sev={sev} />
                  <CategoryChip label={CATEGORY_LABEL[g.category]} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-200">{g.title}</span>
                  {g.members.length > 1 && (
                    <span
                      className="shrink-0 font-mono text-[10.5px] tabular-nums text-zinc-500"
                      title={g.subjects.join(', ')}
                    >
                      {g.members.length} affected
                    </span>
                  )}
                </div>
              )
            })}

            {(foldedGroups > 0 || truncated) && (
              <div className="px-3 pt-0.5 text-[11.5px] text-zinc-600">
                {foldedGroups > 0 && (
                  <>
                    +{foldedGroups} more {foldedGroups === 1 ? 'issue' : 'issues'}
                    {foldedFindings > foldedGroups && ` (${foldedFindings} findings)`}
                  </>
                )}
                {truncated && (
                  <>
                    {foldedGroups > 0 && ' · '}
                    showing the first {shownFindings} of {total}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Hand-off — Overview reports, Autonomy acts. */}
      {total > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/[0.06] px-4 py-2.5">
          <span className="text-[11.5px] text-zinc-500">
            <span className="font-mono tabular-nums text-zinc-300">{total}</span>{' '}
            {total === 1 ? 'finding' : 'findings'} across{' '}
            <span className="font-mono tabular-nums text-zinc-300">{groups.length}</span>
            {truncated ? '+' : ''}{' '}
            {groups.length === 1 ? 'issue' : 'issues'}
            {held > 0 && (
              <> · <span className="text-amber-300/90">{held} waiting on your approval</span></>
            )}
          </span>
          <button
            onClick={onReview}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-semibold text-violet-300 transition-colors hover:text-violet-200"
          >
            Review and fix in Autonomy
            <ArrowUpRight className="h-3 w-3" />
          </button>
        </div>
      )}
    </section>
  )
}

// ── Row chips ────────────────────────────────────────────────────────────────

function SeverityChip({ sev }: { sev: { label: string; dot: string; text: string } }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold tabular-nums ${sev.text}`}>
      <span className={`h-[6px] w-[6px] rounded-full ${sev.dot}`} />
      {sev.label}
    </span>
  )
}

function CategoryChip({ label }: { label: string }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-zinc-600">{label}</span>
  )
}

// ── Local relative-time (self-contained; no shared import) ───────────────────
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
