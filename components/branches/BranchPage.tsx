'use client'

/**
 * One branch on its own page (?branch=<id>, decision 6): what it changed, the
 * statements a merge runs, where to point an app at it, and the requests it
 * served. Merge and Discard sit in its header; the dialogs and the writes are
 * BranchesPanel's, so the list and this page share them.
 *
 *   Branches / add-ratings-histogram
 *   add-ratings-histogram                                   [Merge]  ⋯
 *   Created 3 h ago   2 statements   10 requests   Last request 38 min ago
 *   Changes        + table rating_histograms   5 columns
 *   A merge runs   1  CREATE TABLE rating_histograms (…)
 *   Preview        Base URL, Header, Schema, Key, snippets, OpenAPI spec
 *   Requests       2:23:41 AM  GET /db/rating_histograms  200  23 ms
 */

import Link from 'next/link'
import { Trash2 } from 'lucide-react'
import {
  Breadcrumbs,
  CopyButton,
  KitButton,
  KitButtonLink,
  OverflowMenu,
  PageHeader,
  Skeleton,
  StatusGlyph,
} from '@/components/inspector/kit'
import { Time } from '@/components/console/Time'
import { duration, groupByDay } from '@/components/console/format'
import { DayGroup, DayGroupList, EventRow, EventRowSkeleton } from '@/components/console/EventRow'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { RefreshButton } from '@/components/console/InstrumentBar'
import { FOCUS, RULE } from '@/components/console/tokens'
import { EmptyLine, Panel, RowSkeleton, Section } from '@/components/autonomy/rows'
import { BranchPreview } from './BranchPreview'
import {
  REQUESTS_CAP,
  changeLines,
  requestCount,
  statements,
  type Branch,
  type BranchFacts,
  type MergeOutcome,
} from './data'

/** A merge asked for here: how it ended, or the server's refusal. */
export interface MergeState {
  outcome?: MergeOutcome
  refused?: string
}

const LINK = `rounded-[3px] text-zinc-200 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/60 ${FOCUS}`

export function BranchPage({
  projectId,
  branchId,
  branch,
  loading,
  listError,
  onRetryList,
  retrying,
  facts,
  askId,
  canMerge,
  canDiscard,
  roleLoading,
  preparing,
  merge,
  discardRefused,
  onMerge,
  onDiscard,
  onRefreshRequests,
  onRetryDetail,
}: {
  projectId: string
  branchId: string
  /** Null when the list has no branch with this id. */
  branch: Branch | null
  loading: boolean
  listError: boolean
  onRetryList: () => void
  retrying: boolean
  facts: BranchFacts | undefined
  /** A merge the agent asked for: the approval to review in Autonomy. */
  askId?: string
  canMerge: boolean
  canDiscard: boolean
  /** The person's role is not known yet: no action and no permission line. */
  roleLoading: boolean
  /** The statements are being read again before the merge is confirmed. */
  preparing: boolean
  merge?: MergeState
  discardRefused?: string
  onMerge: () => void
  onDiscard: () => void
  onRefreshRequests: () => void
  onRetryDetail: () => void
}) {
  const listHref = `/app/projects/${projectId}/branches`
  const crumbs = (name: React.ReactNode) => <Breadcrumbs items={[{ label: 'Branches', href: listHref }, { label: name }]} />

  if (loading && !branch) {
    return (
      <div aria-busy="true">
        <PageHeader flush breadcrumb={crumbs(<Skeleton className="h-[12px] w-[140px]" />)} title={<Skeleton className="my-[6px] h-[22px] w-[260px]" />} />
        <Panel>
          <RowSkeleton rows={3} lead="none" />
        </Panel>
      </div>
    )
  }

  if (!branch) {
    return (
      <div>
        <PageHeader flush breadcrumb={crumbs('Branch')} title="Branch" />
        <Panel>
          {listError ? (
            <ErrorRow things="branches" onRetry={onRetryList} retrying={retrying} />
          ) : (
            <p className="px-[20px] py-[14px] text-[13px] leading-[20px] text-zinc-400">
              No branch here. It may have been discarded.{' '}
              <Link href={listHref} className={LINK}>
                All branches
              </Link>
            </p>
          )}
        </Panel>
      </div>
    )
  }

  const title = (
    <span className="font-mono text-[24px] leading-[32px] tracking-[-0.02em] [overflow-wrap:anywhere]">{branch.name}</span>
  )

  // ── Merged (or merged a moment ago, here) ──────────────────────────────────
  if (branch.status !== 'active' || merge?.outcome) {
    const outcome = merge?.outcome
    const applied = outcome?.applied.length ?? 0
    return (
      <div>
        <PageHeader
          flush
          breadcrumb={crumbs(<span className="font-mono">{branch.name}</span>)}
          title={title}
          description={
            <span className="inline-flex items-center gap-[8px] text-[13px] leading-[20px] text-zinc-300">
              <StatusGlyph state="done" label="Merged" />
              {branch.mergedAt ? <Time iso={branch.mergedAt} mode="dateTime" prefix="Merged" /> : 'Merged'}
            </span>
          }
        />
        <Panel>
          <div className="space-y-[6px] px-[20px] py-[14px] text-[13px] leading-[20px] text-zinc-400">
            {outcome && (
              <p className="text-zinc-200">
                {applied > 0 ? `${statements(applied)} applied to production.` : 'Merged. Production did not change.'}
              </p>
            )}
            {outcome?.review.map((r, i) => (
              <p key={i} className="flex items-start gap-[8px] text-zinc-50">
                <StatusGlyph state="waiting" label="Needs a review" className="mt-[4px]" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{r}</span>
              </p>
            ))}
            <p>Its changes are in production. Its copy of the schema and its keys are gone.</p>
            <p className="flex flex-wrap gap-x-[16px] pt-[4px]">
              <Link href={`/app/projects/${projectId}/changes`} className={LINK}>
                History
              </Link>
              <Link href={listHref} className={LINK}>
                All branches
              </Link>
            </p>
          </div>
        </Panel>
      </div>
    )
  }

  // ── Active ─────────────────────────────────────────────────────────────────
  const detail = facts?.detail ?? null
  const requests = facts?.requests ?? null
  const migrations = detail?.migrations ?? []
  const conflicts = detail?.conflicts ?? []
  const lines = changeLines(detail?.diff)
  const copyAll = migrations.map((m) => `${m.replace(/;\s*$/, '')};`).join('\n\n')

  const factLine = (
    <span className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] text-[12.5px] leading-[18px] text-faint">
      <Time iso={branch.createdAt} prefix="Created" />
      {detail && <span>{migrations.length > 0 ? statements(migrations.length) : 'No schema changes'}</span>}
      {requests && <span>{requests.length > 0 ? requestCount(requests.length) : 'No requests yet'}</span>}
      {requests && requests[0] && <Time iso={requests[0].timestamp} prefix="Last request" />}
      {conflicts.length > 0 && <span className="font-medium text-zinc-50">Production changed since this branch was cut</span>}
    </span>
  )

  const menu = canDiscard ? (
    <OverflowMenu
      label={`More actions for ${branch.name}`}
      items={[{ label: 'Discard branch', icon: Trash2, danger: true, onClick: onDiscard }]}
    />
  ) : null

  let primary: React.ReactNode = null
  if (askId) {
    primary = (
      <>
        <StatusGlyph state="waiting" label="Your agent asked to merge" showLabel />
        {canMerge && (
          <KitButtonLink href={`/app/projects/${projectId}/autonomy#approval-${askId}`} variant="primary" size="lg">
            Review
          </KitButtonLink>
        )}
      </>
    )
  } else if (canMerge) {
    // A merge production has moved under is refused by the server; the reason is under "A merge runs".
    primary =
      conflicts.length > 0 ? null : (
        <KitButton variant="primary" size="lg" onClick={onMerge} loading={preparing}>
          Merge
        </KitButton>
      )
  } else if (canDiscard) {
    primary = <span className="text-[13px] leading-[20px] text-faint">Only admins can merge.</span>
  }

  return (
    <div>
      <PageHeader
        flush
        breadcrumb={crumbs(<span className="font-mono">{branch.name}</span>)}
        title={title}
        description={factLine}
        actions={
          primary || menu ? (
            <div className="flex flex-wrap items-center gap-[10px]">
              {primary}
              {menu}
            </div>
          ) : undefined
        }
      />
      {(merge?.refused || discardRefused) && (
        <div className="-mt-[8px] mb-[20px] space-y-[4px]">
          {merge?.refused && <RefusedLine>{merge.refused}</RefusedLine>}
          {discardRefused && <RefusedLine>{discardRefused}</RefusedLine>}
        </div>
      )}
      {!roleLoading && !canMerge && !canDiscard && (
        <p className="-mt-[8px] mb-[20px] text-[13px] leading-[20px] text-faint">Only admins can merge.</p>
      )}

      <div className="space-y-8">
        <Section id="branch-changes" title="Changes" count={lines.length}>
          <Panel>
            {!detail && !facts?.detailError ? (
              <RowSkeleton rows={2} lead="none" />
            ) : !detail ? (
              <ErrorRow things="this branch's changes" onRetry={onRetryDetail} />
            ) : lines.length === 0 ? (
              <EmptyLine>No schema changes on this branch yet.</EmptyLine>
            ) : (
              <ul className="divide-y divide-white/[0.06]">
                {lines.map((l) => (
                  <li key={l.key} className="flex flex-wrap items-baseline gap-x-[12px] gap-y-[2px] px-[16px] py-[10px] sm:px-[20px]">
                    <span aria-hidden className="w-[10px] flex-shrink-0 font-mono text-[13px] leading-[20px] text-zinc-400">
                      {l.sign}
                    </span>
                    <span className="sr-only">{l.sign === '+' ? 'Added' : l.sign === '−' ? 'Dropped' : 'Changed'}</span>
                    <span className="w-[48px] flex-shrink-0 text-[12.5px] leading-[20px] text-faint">{l.kind}</span>
                    <code className="min-w-0 font-mono text-[12.5px] leading-[20px] text-zinc-100 [overflow-wrap:anywhere]">{l.name}</code>
                    {l.detail && <span className="font-mono text-[12px] leading-[20px] text-faint">{l.detail}</span>}
                    {l.dropped && <span className="text-[12.5px] font-medium leading-[20px] text-rose-300">Dropped</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </Section>

        <Section
          id="branch-merge"
          title="A merge runs"
          count={migrations.length}
          aside={migrations.length > 0 ? <CopyButton value={copyAll} label="Copy statements" showLabel /> : undefined}
        >
          <Panel>
            {conflicts.length > 0 && (
              <div role="alert" className={`flex items-start gap-[10px] border-b ${RULE} px-[16px] py-[12px] sm:px-[20px]`}>
                <StatusGlyph state="failed" label="Refused" className="mt-[4px]" />
                <p className="min-w-0 text-[13px] leading-[20px] text-rose-200 [overflow-wrap:anywhere]">
                  Production has changed <span className="font-mono text-[12.5px]">{conflicts.join(', ')}</span> since this branch was cut, so a merge is
                  refused. Create a new branch from production and apply the change there.
                </p>
              </div>
            )}
            {!detail && !facts?.detailError ? (
              <RowSkeleton rows={2} lead="none" />
            ) : !detail ? (
              <ErrorRow things="the statements" onRetry={onRetryDetail} />
            ) : migrations.length === 0 ? (
              <EmptyLine>No statements. A merge only closes the branch.</EmptyLine>
            ) : (
              <ol className="divide-y divide-white/[0.06]">
                {migrations.map((m, i) => (
                  <li key={i} className="flex gap-[12px] px-[16px] py-[10px] font-mono text-[12px] leading-[19px] sm:px-[20px]">
                    <span className="w-[14px] flex-shrink-0 text-right tabular-nums text-faint">{i + 1}</span>
                    <span className="min-w-0 text-zinc-300 [overflow-wrap:anywhere]">{m}</span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </Section>

        {branch.preview && (
          <Section id="branch-preview" title="Preview">
            <BranchPreview
              projectId={projectId}
              branch={{ id: branch.id, name: branch.name, schemaName: branch.schemaName, preview: branch.preview }}
              canIssueKeys={canMerge}
            />
          </Section>
        )}

        <Section
          id="branch-requests"
          title="Requests"
          count={requests?.length ?? null}
          aside={<RefreshButton onRefresh={onRefreshRequests} label="Refresh requests" />}
        >
          <Panel>
            {facts?.requestsError && requests && (
              <ErrorRow things="requests" staleAt={facts.requestsReadAt} onRetry={onRefreshRequests} />
            )}
            {!requests && !facts?.requestsError ? (
              <EventRowSkeleton rows={4} glyph={false} />
            ) : !requests ? (
              <ErrorRow things="requests" onRetry={onRefreshRequests} />
            ) : requests.length === 0 ? (
              <EmptyLine>None yet. Requests made with this branch&apos;s keys show here, never in production monitoring.</EmptyLine>
            ) : (
              <DayGroupList>
                {groupByDay(requests, (r) => r.timestamp).map((g) => (
                  <DayGroup key={g.key} label={g.label}>
                    {g.items.map((r) => (
                      <EventRow
                        key={r.id}
                        time={r.timestamp}
                        mono
                        what={
                          <>
                            <span className="text-faint">{r.method}</span> {r.path}
                          </>
                        }
                        result={<StatusCode status={r.status} />}
                        line={duration(r.latency)}
                        columns={{ what: 300, result: 40 }}
                      />
                    ))}
                  </DayGroup>
                ))}
              </DayGroupList>
            )}
          </Panel>
          {requests && requests.length >= REQUESTS_CAP && (
            <p className="mt-[8px] text-[12.5px] leading-[18px] text-faint">The last {REQUESTS_CAP} requests.</p>
          )}
        </Section>
      </div>
    </div>
  )
}

/** An HTTP status: white for a server error, light grey for a refusal, grey otherwise. The number says it either way. */
function StatusCode({ status }: { status: number }) {
  const tone = status >= 500 ? 'font-medium text-zinc-50' : status >= 400 ? 'text-zinc-200' : 'text-zinc-400'
  return <span className={`font-mono text-[12px] ${tone}`}>{status}</span>
}
