'use client'

/**
 * Branches: preview copies of the schema, and the rule that sends agents to
 * them ("PRs for your backend").
 *
 *   Branches  Beta  1 of 5 active                                    [New branch]
 *   A branch is a copy of your schema. Merging applies its changes to production.
 *   Active
 *   ●  add-ratings-histogram                                         [Merge]  ⋯
 *      Created 3 h ago   2 statements   10 requests   Last request 38 min ago
 *   Merged
 *   ✓  add-follows                                                  Merged Nov 12
 *   Production
 *      Protected production                                                 [●]
 *      Agents change the schema only on a branch. You approve each merge.
 *
 * A branch opens as its own page (?branch=<id>, BranchPage). This component
 * owns what both views share: the reads, the dialogs and the writes, so
 * moving between the list and a branch keeps what was read.
 *
 * Merging replays the branch's logged statements onto production, in order,
 * as one governed change (lib/branches/engine.ts), after a person confirms
 * the exact statements. A merge the coding agent asked for is decided in one
 * place, Autonomy: the branch then shows "Your agent asked to merge" and a
 * Review link to that request instead of its own Merge.
 */

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { GitBranch, GitMerge, Plus, Trash2 } from 'lucide-react'
import { IconWell } from '@/components/console/IconWell'
import {
  KitButton,
  KitButtonLink,
  KitSwitch,
  OverflowMenu,
  PageHeader,
  StatusGlyph,
  Tag,
} from '@/components/inspector/kit'
import { Time } from '@/components/console/Time'
import { EmptyPanel, ErrorRow, RefusedLine } from '@/components/console/states'
import { RefreshButton } from '@/components/console/InstrumentBar'
import { Fact, Facts, Panel, ROW_TITLE, RowSkeleton, Section } from '@/components/autonomy/rows'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { BranchPage, type MergeState } from './BranchPage'
import { DiscardDialog, MergeDialog, NewBranchDialog } from './BranchDialogs'
import {
  BRANCH_LIMIT,
  refusal,
  requestCount,
  statements,
  useBranchFacts,
  useBranchList,
  useMergeAsks,
  useProtection,
  type Branch,
  type BranchFacts,
} from './data'

export function BranchesPanel({ projectId, branchId = null }: { projectId: string; branchId?: string | null }) {
  const router = useRouter()
  const role = useProjectRole(projectId)
  const list = useBranchList(projectId)
  const protection = useProtection(projectId)
  const { asks, reload: reloadAsks } = useMergeAsks(projectId)
  const all = list.branches ?? []
  const active = all.filter((b) => b.status === 'active')
  const merged = all.filter((b) => b.status === 'merged')
  const { facts, reload: reloadFacts, reloadOne } = useBranchFacts(
    projectId,
    active.map((b) => b.id),
  )

  const [newOpen, setNewOpen] = useState(false)
  const [preparing, setPreparing] = useState<string | null>(null)
  const [mergeFor, setMergeFor] = useState<Branch | null>(null)
  const [merging, setMerging] = useState(false)
  const [merges, setMerges] = useState<Record<string, MergeState>>({})
  const [discardFor, setDiscardFor] = useState<Branch | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [discardRefused, setDiscardRefused] = useState<Record<string, string>>({})

  const listHref = `/app/projects/${projectId}/branches`
  const atLimit = active.length >= BRANCH_LIMIT

  const refreshAll = () => {
    void list.reload()
    void reloadFacts()
    void reloadAsks()
  }

  // The confirm lists the statements a merge runs, so they are read again first: the agent may have added one.
  const askMerge = async (b: Branch) => {
    setPreparing(b.id)
    setMerges((m) => ({ ...m, [b.id]: {} }))
    const f = await reloadOne(b.id)
    setPreparing(null)
    if (!f.detail) {
      setMerges((m) => ({ ...m, [b.id]: { refused: "Could not read the branch's statements, so nothing was merged. Try again." } }))
      return
    }
    if (f.detail.conflicts.length > 0) return
    setMergeFor(b)
  }

  const merge = async () => {
    const b = mergeFor
    if (!b) return
    setMerging(true)
    let next: MergeState
    try {
      const res = await fetch(`/api/projects/${projectId}/branches/${b.id}`, { method: 'POST', credentials: 'include' })
      let j: { success?: boolean; applied?: unknown; review?: unknown; fullyMerged?: unknown; error?: string } | null = null
      try {
        j = await res.json()
      } catch {
        j = null
      }
      next =
        res.ok && j?.success
          ? {
              outcome: {
                applied: Array.isArray(j.applied) ? (j.applied as string[]) : [],
                review: Array.isArray(j.review) ? (j.review as string[]) : [],
                fullyMerged: j.fullyMerged !== false,
              },
            }
          : { refused: refusal(j, 'The merge did not run.') }
    } catch {
      next = { refused: 'The merge did not run. The server did not answer.' }
    }
    setMerges((m) => ({ ...m, [b.id]: next }))
    setMerging(false)
    setMergeFor(null)
    void list.reload()
    void reloadAsks()
    if (next.refused) void reloadOne(b.id)
  }

  const discard = async () => {
    const b = discardFor
    if (!b) return
    setDiscarding(true)
    setDiscardRefused((r) => ({ ...r, [b.id]: '' }))
    let ok = false
    try {
      const res = await fetch(`/api/projects/${projectId}/branches/${b.id}`, { method: 'DELETE', credentials: 'include' })
      let j: { success?: boolean; error?: string } | null = null
      try {
        j = await res.json()
      } catch {
        j = null
      }
      ok = res.ok && !!j?.success
      if (!ok) setDiscardRefused((r) => ({ ...r, [b.id]: refusal(j, 'The branch was not discarded.') }))
    } catch {
      setDiscardRefused((r) => ({ ...r, [b.id]: 'The branch was not discarded. The server did not answer.' }))
    }
    setDiscarding(false)
    setDiscardFor(null)
    if (ok && branchId === b.id) router.push(listHref)
    void list.reload()
  }

  const dialogs = (
    <>
      <NewBranchDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        projectId={projectId}
        atLimit={atLimit}
        onCreated={() => {
          setNewOpen(false)
          void list.reload()
        }}
      />
      <MergeDialog
        branchName={mergeFor?.name ?? null}
        migrations={(mergeFor && facts[mergeFor.id]?.detail?.migrations) || []}
        busy={merging}
        onCancel={() => {
          if (!merging) setMergeFor(null)
        }}
        onConfirm={() => void merge()}
      />
      <DiscardDialog
        branchName={discardFor?.name ?? null}
        busy={discarding}
        onCancel={() => {
          if (!discarding) setDiscardFor(null)
        }}
        onConfirm={() => void discard()}
      />
    </>
  )

  if (branchId) {
    const branch = all.find((b) => b.id === branchId) ?? null
    return (
      <>
        <BranchPage
          projectId={projectId}
          branchId={branchId}
          branch={branch}
          loading={list.loading}
          listError={list.error}
          onRetryList={() => void list.reload()}
          retrying={list.refreshing}
          facts={facts[branchId]}
          askId={branch ? asks.get(branch.name) : undefined}
          canMerge={role.canAdminister}
          canDiscard={role.canWrite}
          roleLoading={role.loading}
          preparing={preparing === branchId}
          merge={merges[branchId]}
          discardRefused={discardRefused[branchId] || undefined}
          onMerge={() => branch && void askMerge(branch)}
          onDiscard={() => branch && setDiscardFor(branch)}
          onRefreshRequests={() => void reloadOne(branchId, 'requests')}
          onRetryDetail={() => void reloadOne(branchId)}
        />
        {dialogs}
      </>
    )
  }

  const firstLoad = list.loading && !list.branches
  const failed = list.error && !list.branches

  return (
    <div>
      <PageHeader
        flush
        title="Branches"
        meta={
          <>
            <Tag>Beta</Tag>
            {list.branches && (
              <span className="text-[13px] tabular-nums text-faint">
                {active.length} of {BRANCH_LIMIT} active
              </span>
            )}
          </>
        }
        description="A branch is a copy of your schema. Merging applies its changes to production."
        actions={
          role.canWrite && !failed ? (
            <KitButton variant="primary" size="lg" icon={Plus} onClick={() => setNewOpen(true)}>
              New branch
            </KitButton>
          ) : undefined
        }
      />

      <div className="space-y-8">
        <Section
          id="branches-active"
          title="Active"
          count={active.length}
          aside={!firstLoad && !failed ? <RefreshButton onRefresh={refreshAll} refreshing={list.refreshing} label="Refresh branches" /> : undefined}
        >
          <Panel>
            {list.error && list.branches && (
              <ErrorRow things="branches" staleAt={list.readAt} onRetry={() => void list.reload()} retrying={list.refreshing} />
            )}
            {firstLoad ? (
              <RowSkeleton rows={2} />
            ) : failed ? (
              <ErrorRow things="branches" onRetry={() => void list.reload()} retrying={list.refreshing} />
            ) : active.length === 0 ? (
              <EmptyPanel
                title="No branches yet"
                sentence={
                  role.canWrite
                    ? 'Ask your agent to build on one, or create one here.'
                    : 'Branches your agent or a developer creates show here.'
                }
                docs={{ label: 'Branches docs', slug: 'branches' }}
              />
            ) : (
              <ul className="divide-y divide-white/[0.06]">
                {active.map((b) => (
                  <ActiveRow
                    key={b.id}
                    projectId={projectId}
                    branch={b}
                    facts={facts[b.id]}
                    askId={asks.get(b.name)}
                    canMerge={role.canAdminister}
                    canDiscard={role.canWrite}
                    preparing={preparing === b.id}
                    merge={merges[b.id]}
                    discardRefused={discardRefused[b.id] || undefined}
                    onMerge={() => void askMerge(b)}
                    onDiscard={() => setDiscardFor(b)}
                  />
                ))}
              </ul>
            )}
          </Panel>
          {!role.loading && !failed && active.length > 0 && !role.canAdminister && (
            <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">
              {role.canWrite ? 'Only admins can merge.' : 'Only developers and admins can change branches.'}
            </p>
          )}
        </Section>

        {merged.length > 0 && (
          <Section id="branches-merged" title="Merged" count={merged.length}>
            <Panel>
              <ul className="divide-y divide-white/[0.06]">
                {merged.map((b) => (
                  <MergedRow key={b.id} branch={b} merge={merges[b.id]} />
                ))}
              </ul>
            </Panel>
          </Section>
        )}

        <Section id="branches-production" title="Production">
          <Panel>
            {protection.value === null && protection.error ? (
              <ErrorRow things="production protection" onRetry={() => void protection.reload()} />
            ) : protection.value === null ? (
              <RowSkeleton rows={1} lead="none" />
            ) : (
              <div className="flex items-start gap-x-[24px] px-[16px] py-[14px] sm:px-[20px]">
                <div className="min-w-0 flex-1">
                  <h3 className={ROW_TITLE}>Protected production</h3>
                  <p className="mt-[2px] text-[13px] leading-[20px] text-zinc-400">
                    {protection.value
                      ? 'Agents change the schema only on a branch. You approve each merge.'
                      : "Agents can change production's schema directly."}
                  </p>
                  {protection.refused && <RefusedLine className="mt-[8px]">{protection.refused}</RefusedLine>}
                </div>
                {role.loading ? null : role.canAdminister ? (
                  <KitSwitch
                    checked={protection.value}
                    onChange={(next) => void protection.save(next)}
                    disabled={protection.saving}
                    label="Protected production"
                    className="mt-[1px]"
                  />
                ) : (
                  <span className="pt-[1px] text-[13px] leading-[20px] text-zinc-300">{protection.value ? 'On' : 'Off'}</span>
                )}
              </div>
            )}
          </Panel>
        </Section>
      </div>

      {dialogs}
    </div>
  )
}

/**
 * An active branch. Its name opens its page; Merge (or the agent's request)
 * and ⋯ sit at the right. On a phone: name and ⋯ on the first line, facts on
 * the second, Merge on the third.
 */
function ActiveRow({
  projectId,
  branch,
  facts,
  askId,
  canMerge,
  canDiscard,
  preparing,
  merge,
  discardRefused,
  onMerge,
  onDiscard,
}: {
  projectId: string
  branch: Branch
  facts: BranchFacts | undefined
  askId?: string
  canMerge: boolean
  canDiscard: boolean
  preparing: boolean
  merge?: MergeState
  discardRefused?: string
  onMerge: () => void
  onDiscard: () => void
}) {
  const detail = facts?.detail ?? null
  const requests = facts?.requests ?? null
  const conflicts = detail?.conflicts ?? []
  const href = `/app/projects/${projectId}/branches?branch=${branch.id}`

  const act = askId ? (
    <span className="flex flex-wrap items-center gap-[10px]">
      <StatusGlyph state="waiting" label="Your agent asked to merge" showLabel />
      {canMerge && (
        <KitButtonLink href={`/app/projects/${projectId}/autonomy#approval-${askId}`} size="sm">
          Review
        </KitButtonLink>
      )}
    </span>
  ) : canMerge && conflicts.length === 0 ? (
    <KitButton size="sm" onClick={onMerge} loading={preparing}>
      Merge
    </KitButton>
  ) : null

  return (
    <li className="relative transition-colors duration-150 hover:bg-[#121316]">
      <div className="flex items-start gap-[12px] px-[16px] py-[14px] sm:px-[20px]">
        <IconWell icon={GitBranch} className="-mt-[3.5px]" />
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-[16px] gap-y-[10px]">
          <div className="min-w-0 flex-1">
            <Link
              href={href}
              className="block font-mono text-[13px] font-medium leading-[21px] text-zinc-50 [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-white/70"
            >
              {branch.name}
            </Link>
            <Facts>
              <Fact>
                <Time iso={branch.createdAt} prefix="Created" />
              </Fact>
              {detail && <Fact>{detail.migrations.length > 0 ? statements(detail.migrations.length) : 'No schema changes'}</Fact>}
              {requests && <Fact>{requests.length > 0 ? requestCount(requests.length) : 'No requests yet'}</Fact>}
              {requests && requests[0] && (
                <Fact>
                  <Time iso={requests[0].timestamp} prefix="Last request" />
                </Fact>
              )}
              {conflicts.length > 0 && <span className="font-medium text-zinc-50">Production changed since this branch was cut</span>}
            </Facts>
            {merge?.refused && <RefusedLine className="mt-[8px]">{merge.refused}</RefusedLine>}
            {discardRefused && <RefusedLine className="mt-[8px]">{discardRefused}</RefusedLine>}
          </div>
          {act && <div className="relative z-[1] order-3 flex w-full items-center sm:order-2 sm:w-auto">{act}</div>}
          {canDiscard && (
            <div className="relative z-[1] order-2 -mr-[4px] sm:order-3">
              <OverflowMenu
                label={`More actions for ${branch.name}`}
                items={[{ label: 'Discard branch', icon: Trash2, danger: true, onClick: onDiscard }]}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

/** A merged branch: it happened, so it stays listed; its schema and keys are gone. */
function MergedRow({ branch, merge }: { branch: Branch; merge?: MergeState }) {
  const outcome = merge?.outcome
  return (
    <li className="flex items-start gap-[12px] px-[16px] py-[14px] sm:px-[20px]">
      <IconWell icon={GitMerge} quiet className="-mt-[3.5px]" />
      <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-[16px] gap-y-[2px]">
        <div className="min-w-0">
          <p className="font-mono text-[13px] leading-[21px] text-zinc-300 [overflow-wrap:anywhere]">{branch.name}</p>
          {outcome && (
            <Facts>
              <span className="text-zinc-300">
                {outcome.applied.length > 0 ? `${statements(outcome.applied.length)} applied to production` : 'Production did not change'}
              </span>
            </Facts>
          )}
          {outcome?.review.map((r, i) => (
            <p key={i} className="mt-[6px] flex items-start gap-[8px] text-[12.5px] leading-[18px] text-zinc-50">
              <StatusGlyph state="waiting" label="Needs a review" className="mt-[3px]" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{r}</span>
            </p>
          ))}
        </div>
        {branch.mergedAt && (
          <span className="pt-[2px] text-[12.5px] leading-[18px] text-faint">
            <Time iso={branch.mergedAt} mode="date" prefix="Merged" />
          </span>
        )}
      </div>
    </li>
  )
}
