'use client'

/**
 * History: one place for every change to the backend, and the way back from
 * any of them (components/changes/ChangeHistory.tsx).
 *
 * The schema and the rest of the backend share one history (lib/changes): a
 * change that adds a table and a bucket is one row, restored as one. The tabs
 * narrow it to one part of the backend; published versions mark the full list.
 *
 * At /changes, not /history: that path is a permanent redirect to the Overview
 * (next.config.js, from the activity page deleted in July 2026), and browsers
 * keep a permanent redirect they have followed.
 */

import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { KitCard, KitTab, KitTabs, PageHeader } from '@/components/inspector/kit'
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
      <PageHeader
        className="!px-0"
        title="History"
        description="Every change to your backend, from your coding agents, from Backenly and from you. Each one is checked after it applies, and any of them can be restored from here."
        tabs={
          <KitTabs>
            <KitTab active={!resource} onClick={() => show(null)}>All</KitTab>
            {RESOURCES.map((r) => (
              <KitTab key={r.id} active={resource === r.id} onClick={() => show(r.id)}>{r.label}</KitTab>
            ))}
          </KitTabs>
        }
      />
      <KitCard className="mt-5 overflow-hidden">
        <ChangeHistory key={resource ?? 'all'} projectId={projectId} resource={resource} />
      </KitCard>
    </div>
  )
}
