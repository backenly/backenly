'use client'

/**
 * History: one place for every change to the backend, and the way back from
 * any of them (components/changes/ChangeHistory.tsx, which draws the header,
 * the filter and the ledger).
 *
 * The schema and the rest of the backend share one history (lib/changes): a
 * change that adds a table and a bucket is one row, undone as one. One quiet
 * filter narrows it to a part of the backend (?part=, kept from the old tabs;
 * a change opens in a drawer at ?change=).
 *
 * At /changes, not /history: that path is a permanent redirect to the Overview
 * (next.config.js, from the activity page deleted in July 2026), and browsers
 * keep a permanent redirect they have followed.
 */

import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { ChangeHistory } from '@/components/changes/ChangeHistory'
import { RESOURCES } from '@/components/changes/present'

export default function HistoryPage() {
  const params = useParams()
  const router = useRouter()
  const search = useSearchParams()
  const projectId = params.id as string
  const resource = RESOURCES.some((r) => r.id === search?.get('part')) ? search!.get('part') : null

  const show = (part: string | null) => {
    const q = new URLSearchParams(search?.toString() ?? '')
    q.delete('change')
    if (part) q.set('part', part)
    else q.delete('part')
    router.replace(`/app/projects/${projectId}/changes${q.size ? `?${q}` : ''}`, { scroll: false })
  }

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
      <ChangeHistory key={resource ?? 'all'} projectId={projectId} resource={resource} onResource={show} />
    </div>
  )
}
