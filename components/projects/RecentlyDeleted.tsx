'use client'

/**
 * Recently deleted: the projects asked to be deleted and not removed yet
 * (lib/projects/deletion.ts), under the Projects grid, each with the day it is
 * removed for good and a Restore button for those who may delete projects.
 *
 *   Recently deleted  1
 *   shop-staging                                            [Restore]
 *   Removed for good on Nov 24
 *
 * Shown only while there is one. GET /api/projects?deleted=1 lists them;
 * POST /api/projects/[id]/undelete restores one, refused in the plan's words
 * when the plan has no room for it.
 */
import { useCallback, useEffect, useState } from 'react'
import { KitButton } from '@/components/inspector/kit'
import { Fact, Facts, Panel, Row, RowList, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { RefusedLine } from '@/components/console/states'
import { formatTime } from '@/components/console/format'

interface DeletedProject {
  id: string
  name: string
  deletedAt: string
  purgeAfter: string | null
}

export function RecentlyDeleted({
  orgId,
  canRestore,
  refreshKey,
  onRestored,
}: {
  orgId: string | null
  canRestore: boolean
  /** Changes when a project was deleted on this page, so the list is read again. */
  refreshKey: number
  onRestored: () => void
}) {
  const [deleted, setDeleted] = useState<DeletedProject[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ id: string; message: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const org = orgId ? `&orgId=${encodeURIComponent(orgId)}` : ''
      const res = await fetch(`/api/projects?deleted=1${org}`, { credentials: 'include', cache: 'no-store' })
      const body = await res.json().catch(() => null)
      if (res.ok && body?.success && Array.isArray(body.data)) setDeleted(body.data)
    } catch {
      // Nothing to show is the right answer when the list cannot be read: the
      // projects stay deleted, and restorable, until it can.
    }
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const restore = async (project: DeletedProject) => {
    setBusy(project.id)
    setRefusal(null)
    try {
      const res = await fetch(`/api/projects/${project.id}/undelete`, { method: 'POST', credentials: 'include' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body?.success) throw new Error(body?.error || 'Could not restore the project. Try again.')
      setDeleted((prev) => prev.filter((p) => p.id !== project.id))
      onRestored()
    } catch (err) {
      setRefusal({ id: project.id, message: err instanceof Error ? err.message : 'Could not restore the project. Try again.' })
    } finally {
      setBusy(null)
    }
  }

  if (deleted.length === 0) return null
  return (
    <div className="mt-[40px]">
      <Section
        id="recently-deleted"
        title="Recently deleted"
        count={deleted.length}
        description="Kept for 7 days after deleting, then removed for good."
      >
        <Panel>
          <RowList>
            {deleted.map((project) => (
              <Row
                key={project.id}
                lead="none"
                title={<p className={`min-w-0 [overflow-wrap:anywhere] ${ROW_TITLE}`}>{project.name}</p>}
                actions={
                  canRestore ? (
                    <KitButton size="sm" onClick={() => void restore(project)} loading={busy === project.id} disabled={busy !== null}>
                      Restore
                    </KitButton>
                  ) : undefined
                }
              >
                <Facts>
                  <Fact>
                    {project.purgeAfter ? `Removed for good on ${formatTime(project.purgeAfter, 'date')}` : 'Removed for good soon'}
                  </Fact>
                </Facts>
                {refusal?.id === project.id && <RefusedLine className="mt-[8px]">{refusal.message}</RefusedLine>}
              </Row>
            ))}
          </RowList>
        </Panel>
      </Section>
      {!canRestore && (
        <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">Only owners and admins can restore a project.</p>
      )}
    </div>
  )
}
