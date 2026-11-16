'use client'

/**
 * Read-only SQL.
 *
 * Reads are standard SQL because restricting them bought nothing: a project
 * can already be handed a SELECT-only Postgres login. Writes stay typed,
 * planned and reversible through the governed path, and the agent makes them.
 *
 * ── Read-only is not enforced here ──────────────────────────────────────────
 *
 * Nothing in this file is a security boundary. The statement runs server-side
 * as the project's own `bkn_ro_` role (USAGE on one schema plus SELECT),
 * inside `BEGIN READ ONLY`: three refusals, all PostgreSQL's.
 *
 * What this file owes the person is honesty about the result:
 *   - a refused write is shown with the suggestion the guard attached;
 *   - a truncated result says so, because a page of exactly N rows cannot be
 *     told apart from a complete one by looking;
 *   - withheld columns are named, because a withheld value and a NULL look
 *     the same and mean opposite things;
 *   - an error clears the previous rows, so they never read as this answer.
 *
 * One toolbar (Snippets, History, Run), the editor above the results with a
 * handle between them, at every width.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Clock, Copy, Play } from 'lucide-react'
import { Kbd, KIT, KitButton, Spinner } from '@/components/inspector/kit'
import { GRID_HEAD, RULE } from '@/components/console/tokens'
import { TextMenu, type TextMenuItem } from './Popover'
import { isMac } from './values'

interface QueryField {
  name: string
  dataType: string
}

interface QueryResult {
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  fields: QueryField[]
  redactedColumns: string[]
  ms: number
  limit: number
}

interface QueryFailure {
  error: string
  code?: string
  suggestion?: string
}

/** Starting points, not a library. Each is one statement, as the route requires. */
const SNIPPETS: Array<{ label: string; sql: (table: string) => string }> = [
  { label: 'Recent rows', sql: (t) => `SELECT *\nFROM ${t}\nORDER BY 1 DESC\nLIMIT 50` },
  { label: 'Count by a column', sql: (t) => `SELECT status, count(*) AS n\nFROM ${t}\nGROUP BY status\nORDER BY n DESC` },
  { label: 'Columns of a table', sql: (t) => `SELECT column_name, data_type, is_nullable\nFROM information_schema.columns\nWHERE table_name = '${t}'` },
  { label: 'Tables and row estimates', sql: () => 'SELECT relname AS table, n_live_tup AS approx_rows\nFROM pg_stat_user_tables\nORDER BY n_live_tup DESC' },
]

const HISTORY_LIMIT = 20
const EDITOR_MIN = 96
const EDITOR_DEFAULT = 168

function csvOf(result: QueryResult): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = result.fields.map((f) => cell(f.name)).join(',')
  const body = result.rows.map((r) => result.fields.map((f) => cell(r[f.name])).join(','))
  return [head, ...body].join('\n')
}

export function SqlWorkspace({ projectId, table = null }: { projectId: string; table?: string | null }) {
  const [sql, setSql] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [failure, setFailure] = useState<QueryFailure | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  const [editorHeight, setEditorHeight] = useState(EDITOR_DEFAULT)
  const [mac, setMac] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const splitRef = useRef<HTMLDivElement>(null)

  // A personal scratchpad, kept in this browser for this project only: one
  // person's exploration is not another's history.
  const historyKey = `backenly.sql-history.${projectId}`
  useEffect(() => {
    setMac(isMac())
    try {
      const raw = window.localStorage.getItem(historyKey)
      if (raw) setHistory(JSON.parse(raw))
    } catch {
      // Private windows and blocked site data: no history, and that is fine.
    }
  }, [historyKey])

  const remember = useCallback(
    (statement: string) => {
      setHistory((prev) => {
        const next = [statement, ...prev.filter((s) => s !== statement)].slice(0, HISTORY_LIMIT)
        try {
          window.localStorage.setItem(historyKey, JSON.stringify(next))
        } catch {
          // Losing the history is acceptable; failing the query over it is not.
        }
        return next
      })
    },
    [historyKey],
  )

  const clearHistory = () => {
    setHistory([])
    try {
      window.localStorage.removeItem(historyKey)
    } catch {
      /* see above */
    }
  }

  const run = useCallback(async () => {
    const statement = sql.trim()
    if (!statement || running) return
    setRunning(true)
    setFailure(null)
    try {
      const res = await fetch(`/api/database/query?projectId=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sql: statement }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResult(null)
        setFailure({ error: body.error || `The query was refused (${res.status}).`, code: body.code, suggestion: body.suggestion })
        return
      }
      setResult(body as QueryResult)
      remember(statement)
    } catch (err) {
      setResult(null)
      setFailure({ error: err instanceof Error && err.message ? err.message : 'Could not reach the server.' })
    } finally {
      setRunning(false)
    }
  }, [sql, running, projectId, remember])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void run()
    }
  }

  const applyText = (text: string) => {
    setSql(text)
    requestAnimationFrame(() => editorRef.current?.focus())
  }

  // ── The handle between the editor and the results ──────────────────────────
  const maxHeight = () => Math.max(EDITOR_MIN, (splitRef.current?.clientHeight ?? 600) - 120)
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const start = editorHeight
    const move = (ev: PointerEvent) => setEditorHeight(Math.min(maxHeight(), Math.max(EDITOR_MIN, start + ev.clientY - startY)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const onHandleKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowDown') setEditorHeight((h) => Math.min(maxHeight(), h + step))
    else if (e.key === 'ArrowUp') setEditorHeight((h) => Math.max(EDITOR_MIN, h - step))
    else return
    e.preventDefault()
  }

  const target = table ?? 'your_table'
  const snippetItems: TextMenuItem[] = SNIPPETS.map((s) => ({ label: s.label, onClick: () => applyText(s.sql(target)) }))
  const historyItems: TextMenuItem[] =
    history.length === 0
      ? []
      : [
          ...history.map((h) => ({ label: h.replace(/\s+/g, ' '), title: h, mono: true, onClick: () => applyText(h) })),
          { separator: true as const },
          { label: 'Clear history', danger: true, onClick: clearHistory },
        ]

  const copyCsv = () => {
    if (!result) return
    void navigator.clipboard?.writeText(csvOf(result)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={`flex min-h-[44px] flex-shrink-0 flex-wrap items-center gap-x-[12px] gap-y-[6px] border-b ${RULE} px-[16px] py-[6px] sm:px-[20px]`}>
        <div className="flex min-w-0 flex-1 items-center gap-[10px]">
          <h2 className="text-[13px] font-medium leading-[20px] text-zinc-100">SQL</h2>
          <span className="text-[12.5px] text-faint">Read-only</span>
        </div>
        <div className="flex items-center gap-[4px]">
          <TextMenu label="Snippets" items={snippetItems} width="w-[260px]" />
          <TextMenu label="History" icon={Clock} items={historyItems} width="w-[340px]" empty="Queries you run appear here." />
          <KitButton size="sm" variant="primary" icon={Play} onClick={() => void run()} loading={running} disabled={!sql.trim()} className="ml-[4px]">
            Run
            <span aria-hidden className="ml-[2px] hidden items-center gap-[2px] sm:inline-flex">
              <Kbd className="!border-zinc-950/15 !bg-zinc-950/[0.06] !text-zinc-700">{mac ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd className="!border-zinc-950/15 !bg-zinc-950/[0.06] !text-zinc-700">↵</Kbd>
            </span>
          </KitButton>
        </div>
      </div>

      <div ref={splitRef} className="flex min-h-0 flex-1 flex-col">
        <textarea
          ref={editorRef}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          aria-label="SQL query"
          placeholder={`SELECT * FROM ${target} LIMIT 10`}
          style={{ height: editorHeight }}
          className={`flex-shrink-0 resize-none ${KIT.well} px-[16px] py-[12px] font-mono text-[16px] leading-[22px] text-zinc-100 placeholder:text-faint focus:outline-none sm:px-[20px] sm:text-[12.5px] sm:leading-[20px]`}
        />
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the editor"
          aria-valuenow={editorHeight}
          aria-valuemin={EDITOR_MIN}
          tabIndex={0}
          onPointerDown={onHandleDown}
          onKeyDown={onHandleKey}
          className={`group relative flex h-[9px] flex-shrink-0 cursor-row-resize items-center justify-center border-y ${RULE} bg-white/[0.015] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70`}
        >
          <span aria-hidden className="h-[3px] w-[32px] rounded-full bg-white/[0.14] transition-colors duration-150 group-hover:bg-white/[0.3]" />
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {failure ? (
            <div role="alert" className="flex items-start gap-[10px] px-[16px] py-[14px] sm:px-[20px]">
              <span aria-hidden className="mt-[3px] text-[13px] leading-none text-zinc-50">✕</span>
              <div className="min-w-0 max-w-[860px]">
                <p className="break-words font-mono text-[12.5px] leading-[19px] text-rose-200">{failure.error}</p>
                {failure.suggestion && <p className="mt-[6px] text-[13px] leading-[20px] text-zinc-300">{failure.suggestion}</p>}
                {failure.code && <p className="mt-[4px] font-mono text-[12px] text-faint">{failure.code}</p>}
              </div>
            </div>
          ) : running && !result ? (
            <p className="flex items-center gap-[8px] px-[16px] py-[14px] text-[12.5px] text-faint sm:px-[20px]">
              <Spinner className="h-3.5 w-3.5" /> Running
            </p>
          ) : !result ? (
            <p className="px-[16px] py-[14px] text-[12.5px] leading-[18px] text-faint sm:px-[20px]">Reads only. Writes are refused by the database, not by this page. Ask your agent to make changes.</p>
          ) : (
            <>
              <div className={`flex min-h-[38px] flex-wrap items-center gap-x-[14px] gap-y-[4px] border-b ${RULE} px-[16px] py-[6px] text-[12.5px] tabular-nums text-faint sm:px-[20px]`}>
                <span>
                  {result.rowCount.toLocaleString('en-US')} {result.rowCount === 1 ? 'row' : 'rows'}
                </span>
                <span>{result.ms} ms</span>
                {result.truncated && <span className="text-zinc-50">Showing the first {result.limit.toLocaleString('en-US')} rows</span>}
                {result.redactedColumns.length > 0 && <span>{result.redactedColumns.join(', ')} hidden</span>}
                {result.rows.length > 0 && (
                  <KitButton size="sm" variant="ghost" icon={Copy} onClick={copyCsv} className="ml-auto">
                    {copied ? 'Copied' : 'Copy as CSV'}
                  </KitButton>
                )}
              </div>
              {result.rows.length === 0 ? (
                <p className="px-[16px] py-[14px] text-[13px] text-zinc-400 sm:px-[20px]">No rows.</p>
              ) : (
                <table className="w-max min-w-full border-separate border-spacing-0">
                  <thead className="sticky top-0 z-10">
                    <tr>
                      {result.fields.map((f) => (
                        <th
                          key={f.name}
                          scope="col"
                          className={`h-[36px] border-b ${RULE} ${GRID_HEAD} px-[12px] text-left font-mono text-[12px] font-medium text-zinc-200 first:pl-[16px] sm:first:pl-[20px]`}
                        >
                          {f.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className={KIT.rowHoverOn}>
                        {result.fields.map((f) => {
                          const v = row[f.name]
                          const hidden = result.redactedColumns.includes(f.name) && v === '[redacted]'
                          return (
                            <td
                              key={f.name}
                              className="h-[36px] max-w-[360px] truncate border-b border-white/[0.04] px-[12px] font-mono text-[12px] text-zinc-300 first:pl-[16px] sm:first:pl-[20px]"
                            >
                              {hidden ? (
                                <span className="font-sans italic text-faint">Hidden</span>
                              ) : v === null || v === undefined ? (
                                <span className="italic text-faint">NULL</span>
                              ) : typeof v === 'object' ? (
                                JSON.stringify(v)
                              ) : (
                                String(v)
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
