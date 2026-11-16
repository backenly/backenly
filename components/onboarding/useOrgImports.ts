'use client'

/**
 * The organization's imports, for the Projects page (GET /api/import?orgId=):
 * which projects are being moved in right now, which import ended without
 * finishing in the last day, and whether importing is offered here at all.
 *
 * Read once when the page opens, then every few seconds only while one runs,
 * so a row says "Importing" until it is done; when one ends, `onEnded` asks
 * the page to read its list again, so the project shows what arrived. A
 * deployment without the import API answers 404, and then nothing on the
 * page offers importing. Owners and admins only: the API answers no one else.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ImportProgress } from '@/lib/import/contract'
import { isRunning, listImports } from '@/lib/import/client'

export interface OrgImports {
  /** Null until known; false when this deployment has no import API. */
  available: boolean | null
  /** The newest job for each project. */
  byProject: Map<string, ImportProgress>
}

const POLL_MS = 3000

export function useOrgImports(orgId: string | null, enabled: boolean, onEnded: () => void): OrgImports {
  const [state, setState] = useState<{ key: string; available: boolean | null; jobs: ImportProgress[] }>({
    key: '',
    available: null,
    jobs: [],
  })
  const ended = useRef(onEnded)
  useEffect(() => {
    ended.current = onEnded
  }, [onEnded])

  useEffect(() => {
    if (!enabled || !orgId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = new Set<string>()

    const schedule = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') read()
        else schedule(ms)
      }, ms)
    }

    const read = async () => {
      const result = await listImports(orgId)
      if (cancelled) return
      if (result.ok) {
        const jobs = result.data
        const now = new Set(jobs.filter(isRunning).map((job) => job.jobId))
        const finished = [...running].some((id) => !now.has(id))
        running = now
        setState({ key: orgId, available: true, jobs })
        if (finished) ended.current()
        if (now.size > 0) schedule(POLL_MS)
        return
      }
      // 404: this deployment has no import API. Anything else is a read that
      // failed: importing stays offered (the flow says what went wrong) and the
      // last answer stands.
      const missing = result.refusal.status === 404
      setState((s) => ({
        key: orgId,
        available: missing ? false : s.key === orgId ? (s.available ?? true) : true,
        jobs: s.key === orgId ? s.jobs : [],
      }))
      if (!missing && running.size > 0) schedule(POLL_MS * 2)
    }

    read()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [enabled, orgId])

  const current = state.key === orgId
  const byProject = useMemo(() => {
    const map = new Map<string, ImportProgress>()
    if (!current) return map
    // Newest first, as the server lists them; keep the first seen per project.
    const newest = [...state.jobs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    for (const job of newest) if (!map.has(job.projectId)) map.set(job.projectId, job)
    return map
  }, [current, state.jobs])

  return { available: current ? state.available : null, byProject }
}
