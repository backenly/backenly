'use client'

/**
 * What the Branches section reads, and the small rules it reads them by.
 *
 * Every fact comes from a route that already exists:
 *   GET    /branches              the list (active, merged), each active one with its preview endpoint
 *   GET    /branches/[id]         what changed, the statements a merge runs, conflicts with production
 *   GET    /api/monitoring/request-logs?branchId=   the requests the branch served (newest first, at most 100)
 *   GET    /agent-approvals       a merge the coding agent asked for (tool merge_branch), still waiting
 *   GET    /protection            protected production
 * Writes: POST /branches (create), POST /branches/[id] (merge, admins),
 * DELETE /branches/[id] (discard), POST /branches/[id]/keys (a preview key,
 * admins), PUT /protection (admins).
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** Active preview branches a project may hold at once (lib/branches). */
export const BRANCH_LIMIT = 5

/** The most requests the request-logs route returns in one read. */
export const REQUESTS_CAP = 100

export interface BranchPreview {
  baseUrl: string
  dataUrl: string
  v2Url: string
  environmentHeader: { name: string; value: string }
  openapiUrl: string
  curl: string
  sdk: string
  instructions: string
}

export interface Branch {
  id: string
  name: string
  status: 'active' | 'merged' | 'discarded'
  schemaName?: string
  createdAt: string
  mergedAt: string | null
  /** Present for an active branch: where to point an app at it. */
  preview?: BranchPreview
}

export interface ColumnDiff {
  name: string
  dataType: string
}

export interface TableAlteration {
  table: string
  addedColumns: ColumnDiff[]
  droppedColumns: string[]
  typeChanged: Array<{ column: string; from: string; to: string }>
  /** Read from the branch's statements: a renamed column keeps its values. */
  renamedColumns?: Array<{ from: string; to: string; readded: boolean }>
}

export interface SchemaDiff {
  addedTables: Array<{ tableName: string; columns?: unknown[] }>
  droppedTables: string[]
  altered: TableAlteration[]
  identical: boolean
}

/** GET /branches/[id]: what a merge would do. */
export interface BranchDetail {
  diff: SchemaDiff
  /** The statements a merge applies to production, in order. */
  migrations: string[]
  /** Tables production changed since the branch was cut that the statements touch: a merge is refused. */
  conflicts: string[]
}

export interface RequestRow {
  id: string
  method: string
  path: string
  status: number
  latency: number
  timestamp: string
}

/** POST /branches/[id] when it merged. */
export interface MergeOutcome {
  applied: string[]
  review: string[]
  fullyMerged: boolean
}

/** One line of "Changes": what the branch did to the schema. */
export interface ChangeLine {
  key: string
  sign: '+' | '−' | '~'
  kind: 'table' | 'column'
  name: string
  /** Faint detail at the right: "5 columns", "numeric", "integer to numeric". */
  detail?: string
  /** A drop: said in rose. */
  dropped?: boolean
}

const json = async (res: Response) => {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** What the server said when it refused, in its own words, or a plain fallback. */
export function refusal(body: unknown, fallback: string): string {
  const b = body as { error?: unknown; message?: unknown } | null
  if (b && typeof b.error === 'string' && b.error.trim()) return b.error
  if (b && typeof b.message === 'string' && b.message.trim()) return b.message
  return fallback
}

/**
 * The branch a waiting merge request names. A merge parked over MCP or from
 * backend_chat says `Merge preview branch "name" into production`
 * (lib/branches/merge-request.ts); an older one `merge of preview branch
 * \`name\` into production (2 statements …)` (lib/mcp/approval-describe.ts).
 */
export function askedBranchName(target: string | null | undefined): string | null {
  if (!target) return null
  const m = /preview branch\s+["“`']([a-z0-9][a-z0-9_-]*)["”`']/i.exec(target)
  return m ? m[1] : null
}

/** "Changes" in lines, in the order a person reads a migration: new tables, then each table's columns, then drops. */
export function changeLines(diff: SchemaDiff | null | undefined): ChangeLine[] {
  if (!diff) return []
  const lines: ChangeLine[] = []
  for (const t of diff.addedTables) {
    const n = Array.isArray(t.columns) ? t.columns.length : null
    lines.push({ key: `t+${t.tableName}`, sign: '+', kind: 'table', name: t.tableName, detail: n === null ? undefined : `${n} ${n === 1 ? 'column' : 'columns'}` })
  }
  for (const a of diff.altered) {
    for (const r of a.renamedColumns ?? []) {
      lines.push({ key: `r${a.table}.${r.from}`, sign: '~', kind: 'column', name: `${a.table}.${r.from}`, detail: `renamed ${r.to}` })
    }
    for (const c of a.addedColumns) {
      lines.push({ key: `c+${a.table}.${c.name}`, sign: '+', kind: 'column', name: `${a.table}.${c.name}`, detail: c.dataType })
    }
    for (const t of a.typeChanged) {
      lines.push({ key: `c~${a.table}.${t.column}`, sign: '~', kind: 'column', name: `${a.table}.${t.column}`, detail: `${t.from} to ${t.to}` })
    }
    for (const c of a.droppedColumns) {
      lines.push({ key: `c-${a.table}.${c}`, sign: '−', kind: 'column', name: `${a.table}.${c}`, dropped: true })
    }
  }
  for (const t of diff.droppedTables) {
    lines.push({ key: `t-${t}`, sign: '−', kind: 'table', name: t, dropped: true })
  }
  return lines
}

/** "2 statements", "1 statement". */
export function statements(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'statement' : 'statements'}`
}

/** "10 requests", "1 request", and "100+ requests" when the read hit the route's cap. */
export function requestCount(n: number): string {
  if (n >= REQUESTS_CAP) return `${REQUESTS_CAP}+ requests`
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'request' : 'requests'}`
}

// ─── Reads ───────────────────────────────────────────────────────────────────

async function readBranches(projectId: string): Promise<Branch[]> {
  const res = await fetch(`/api/projects/${projectId}/branches`, { credentials: 'include' })
  const j = await json(res)
  if (!res.ok || !j?.success || !Array.isArray(j.branches)) throw new Error('read failed')
  return j.branches as Branch[]
}

async function readProtection(projectId: string): Promise<boolean> {
  const res = await fetch(`/api/projects/${projectId}/protection`, { credentials: 'include' })
  const j = await json(res)
  if (!res.ok || !j?.success) throw new Error('read failed')
  return !!j.protectedProduction
}

async function readMergeAsks(projectId: string): Promise<Map<string, string>> {
  const res = await fetch(`/api/projects/${projectId}/agent-approvals`, { credentials: 'include' })
  const j = await json(res)
  if (!res.ok || !Array.isArray(j?.approvals)) throw new Error('read failed')
  const asks = new Map<string, string>()
  for (const a of j.approvals as Array<{ id?: string; status?: string; tool?: string; target?: string }>) {
    if (a?.status !== 'pending' || a.tool !== 'merge_branch' || typeof a.id !== 'string') continue
    const name = askedBranchName(a.target)
    if (name && !asks.has(name)) asks.set(name, a.id)
  }
  return asks
}

/** The project's branches, active and merged. A failed refresh keeps the last list. */
export function useBranchList(projectId: string) {
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  const [readAt, setReadAt] = useState<number | null>(null)

  const take = useCallback(
    (read: Promise<Branch[]>) =>
      read
        .then(
          (list) => {
            setBranches(list)
            setReadAt(Date.now())
            setError(false)
          },
          () => setError(true),
        )
        .finally(() => {
          setLoading(false)
          setRefreshing(false)
        }),
    [],
  )

  useEffect(() => {
    void take(readBranches(projectId))
  }, [projectId, take])

  const reload = useCallback(() => {
    setRefreshing(true)
    return take(readBranches(projectId))
  }, [projectId, take])

  return { branches, loading, refreshing, error, readAt, reload }
}

/** Protected production: null until read. */
export function useProtection(projectId: string) {
  const [value, setValue] = useState<boolean | null>(null)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  const take = useCallback(
    (read: Promise<boolean>) =>
      read.then(
        (on) => {
          setValue(on)
          setError(false)
        },
        () => setError(true),
      ),
    [],
  )

  useEffect(() => {
    void take(readProtection(projectId))
  }, [projectId, take])

  const reload = useCallback(() => take(readProtection(projectId)), [projectId, take])

  const save = useCallback(
    async (next: boolean) => {
      setSaving(true)
      setRefused(null)
      try {
        const res = await fetch(`/api/projects/${projectId}/protection`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ protectedProduction: next }),
        })
        const j = await json(res)
        if (!res.ok || !j?.success) {
          setRefused(refusal(j, 'Production protection was not changed.'))
          return
        }
        setValue(!!j.protectedProduction)
      } catch {
        setRefused('Production protection was not changed. The server did not answer.')
      } finally {
        setSaving(false)
      }
    },
    [projectId],
  )

  return { value, error, saving, refused, save, reload }
}

/**
 * Merges the coding agent asked for and a person has not decided yet, by
 * branch name: the approval to review in Autonomy. A failed read changes
 * nothing (the request still waits in Autonomy, and the server refuses a
 * merge that would make it stale).
 */
export function useMergeAsks(projectId: string) {
  const [asks, setAsks] = useState<Map<string, string>>(() => new Map())
  const take = useCallback((read: Promise<Map<string, string>>) => read.then(setAsks, () => {}), [])
  useEffect(() => {
    void take(readMergeAsks(projectId))
  }, [projectId, take])
  const reload = useCallback(() => take(readMergeAsks(projectId)), [projectId, take])
  return { asks, reload }
}

export interface BranchFacts {
  detail: BranchDetail | null
  detailError: boolean
  requests: RequestRow[] | null
  requestsError: boolean
  /** When the requests were last read, for "Could not refresh. Showing requests from 2:14 PM." */
  requestsReadAt: number | null
}

export const EMPTY_FACTS: BranchFacts = { detail: null, detailError: false, requests: null, requestsError: false, requestsReadAt: null }

async function readDetail(projectId: string, branchId: string): Promise<BranchDetail> {
  const res = await fetch(`/api/projects/${projectId}/branches/${branchId}`, { credentials: 'include' })
  const j = await json(res)
  if (!res.ok || !j?.success || !j.diff) throw new Error(refusal(j, 'Could not read the branch.'))
  return { diff: j.diff as SchemaDiff, migrations: Array.isArray(j.migrations) ? j.migrations : [], conflicts: Array.isArray(j.conflicts) ? j.conflicts : [] }
}

async function readRequests(projectId: string, branchId: string): Promise<RequestRow[]> {
  const q = new URLSearchParams({ projectId, branchId, limit: String(REQUESTS_CAP) })
  const res = await fetch(`/api/monitoring/request-logs?${q}`, { credentials: 'include' })
  const j = await json(res)
  if (!res.ok || !j?.success || !Array.isArray(j.requestLogs)) throw new Error('read failed')
  return j.requestLogs as RequestRow[]
}

/**
 * What each active branch did and served: its statements and conflicts
 * (GET /branches/[id]) and its requests. At most five branches, so at most
 * ten reads, made after the list is on screen.
 */
export function useBranchFacts(projectId: string, ids: readonly string[]) {
  const [facts, setFacts] = useState<Record<string, BranchFacts>>({})
  const key = ids.join(',')
  const generation = useRef(0)

  const latest = useRef<Record<string, BranchFacts>>({})

  /** Reads one branch again ('requests': only what it served) and answers with what it now knows. */
  const loadOne = useCallback(
    async (id: string, part: 'all' | 'requests' = 'all'): Promise<BranchFacts> => {
      const gen = generation.current
      const [detail, requests] = await Promise.allSettled([
        part === 'all' ? readDetail(projectId, id) : Promise.resolve(null),
        readRequests(projectId, id),
      ])
      const was = latest.current[id] ?? EMPTY_FACTS
      const next: BranchFacts = {
        detail: part === 'all' ? (detail.status === 'fulfilled' ? detail.value : null) : was.detail,
        detailError: part === 'all' ? detail.status === 'rejected' : was.detailError,
        // A failed refresh keeps the requests already read.
        requests: requests.status === 'fulfilled' ? requests.value : was.requests,
        requestsError: requests.status === 'rejected',
        requestsReadAt: requests.status === 'fulfilled' ? Date.now() : was.requestsReadAt,
      }
      if (gen !== generation.current) return next
      latest.current = { ...latest.current, [id]: next }
      setFacts(latest.current)
      return next
    },
    [projectId],
  )

  const loadAll = useCallback(() => {
    generation.current += 1
    const list = key ? key.split(',') : []
    return Promise.all(list.map((id) => loadOne(id)))
  }, [key, loadOne])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  return { facts, reload: loadAll, reloadOne: loadOne }
}
