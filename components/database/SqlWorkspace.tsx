'use client'

/**
 * Read-only SQL workspace.
 *
 * The governed answer to Studio's SQL editor. Reads move onto standard SQL
 * because restricting them bought nothing — a project can already be handed a
 * SELECT-only psql credential — while writes stay typed, planned and
 * reversible through the governance kernel.
 *
 * ── Read-only is not enforced here ──────────────────────────────────────────
 *
 * Nothing in this file is a security boundary, and it must never be treated as
 * one. The statement runs server-side as the project's own `bkn_ro_` role,
 * whose grants are USAGE on one schema plus SELECT, inside `BEGIN READ ONLY`,
 * with `default_transaction_read_only` set on the role. Three refusals, all
 * PostgreSQL's. A cross-tenant read fails on a missing grant rather than on
 * anybody recognising a schema name.
 *
 * What this file owes the operator is honesty about the result:
 *
 *   - a refused WRITE is shown with the suggestion the guard attached, so the
 *     answer is "here is the governed path", not "denied"
 *   - a TRUNCATED result says so, because a page of exactly N rows cannot be
 *     told apart from a complete one by looking
 *   - REDACTED columns are named, because a withheld value and a NULL value
 *     look identical and mean opposite things
 *   - an ERROR clears the previous rows, since stale rows under an error
 *     banner read as the current answer
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Clock, Play, Terminal, Trash2 } from 'lucide-react'
import { IconButton, KIT, Kbd, KitButton, Spinner, Tag } from '@/components/inspector/kit'
import { EDGE, FOCUS, FOCUS_INSET, RULE, R_CONTROL } from '@/components/console/tokens'

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
const SNIPPETS: Array<{ label: string; sql: string }> = [
  { label: 'Tables and row estimates', sql: "SELECT relname AS table, n_live_tup AS approx_rows\nFROM pg_stat_user_tables\nORDER BY n_live_tup DESC" },
  { label: 'Columns of a table', sql: "SELECT column_name, data_type, is_nullable\nFROM information_schema.columns\nWHERE table_name = 'your_table'" },
  { label: 'Recent rows', sql: 'SELECT *\nFROM your_table\nORDER BY created_at DESC' },
  { label: 'Count by a column', sql: 'SELECT status, count(*) AS n\nFROM your_table\nGROUP BY status\nORDER BY n DESC' },
]

const HISTORY_LIMIT = 20

export function SqlWorkspace({ projectId }: { projectId: string }) {
  const [sql, setSql] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [failure, setFailure] = useState<QueryFailure | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const editorRef = useRef<HTMLTextAreaElement>(null)

  // Per-viewer convenience, scoped to this project. Deliberately local: a query
  // history is a personal scratchpad, not deployment state, and storing it
  // server-side would make one operator's exploration visible to another.
  const historyKey = `backenly.sql-history.${projectId}`

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(historyKey)
      if (raw) setHistory(JSON.parse(raw))
    } catch {
      // Private windows, blocked site data, and thumbnail capture all throw or
      // return nothing here. A missing history is not an error worth showing.
    }
  }, [historyKey])

  const remember = useCallback((statement: string) => {
    setHistory(prev => {
      const next = [statement, ...prev.filter(s => s !== statement)].slice(0, HISTORY_LIMIT)
      try {
        window.localStorage.setItem(historyKey, JSON.stringify(next))
      } catch {
        // Losing the history is acceptable; failing the query over it is not.
      }
      return next
    })
  }, [historyKey])

  const clearHistory = () => {
    setHistory([])
    try { window.localStorage.removeItem(historyKey) } catch { /* see above */ }
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
        // Rows are cleared, not left behind. A previous result sitting under an
        // error banner reads as the answer to the query just run.
        setResult(null)
        setFailure({ error: body.error || `Request failed with ${res.status}`, code: body.code, suggestion: body.suggestion })
        return
      }

      setResult(body as QueryResult)
      remember(statement)
    } catch (err: any) {
      setResult(null)
      setFailure({ error: err?.message || 'Could not reach the server' })
    } finally {
      setRunning(false)
    }
  }, [sql, running, projectId, remember])

  // Ctrl/Cmd+Enter runs, which is what every SQL console does.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void run()
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* ── Editor and results ─────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={`flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b ${RULE} pl-4 pr-2 sm:pl-5`}>
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13px] font-medium text-zinc-100">SQL</h2>
            <Tag>read-only</Tag>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1 sm:inline-flex" aria-hidden>
              <Kbd>Ctrl</Kbd>
              <Kbd>Enter</Kbd>
            </span>
            <KitButton
              variant="primary"
              size="sm"
              icon={Play}
              onClick={() => void run()}
              loading={running}
              disabled={!sql.trim()}
              title="Run (Ctrl or Cmd + Enter)"
            >
              Run
            </KitButton>
          </div>
        </div>

        {/* Snippets as a scroll strip on phones and tablets */}
        <div className={`no-scrollbar flex items-center gap-1.5 overflow-x-auto border-b ${RULE} ${KIT.rail} px-3 py-2 lg:hidden`}>
          {SNIPPETS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                setSql(s.sql)
                editorRef.current?.focus()
              }}
              className={`h-[26px] flex-shrink-0 rounded-[6px] border ${EDGE} bg-white/[0.03] px-2.5 text-[12px] text-zinc-300 transition-colors hover:bg-white/[0.07] ${FOCUS}`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <textarea
          ref={editorRef}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          aria-label="SQL query"
          placeholder="SELECT * FROM your_table LIMIT 10"
          className={`h-[156px] flex-shrink-0 resize-none border-b ${RULE} ${KIT.well} px-4 py-3 font-mono text-[16px] leading-[22px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none sm:px-5 sm:text-[12.5px] sm:leading-[20px]`}
        />

        <div className="min-h-0 flex-1 overflow-auto">
          {failure ? (
            <div className="p-4 sm:p-5">
              <div role="alert" className={`max-w-[860px] ${R_CONTROL} border border-rose-400/25 bg-rose-500/[0.06] px-4 py-3`}>
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-300" strokeWidth={1.75} />
                  <div className="min-w-0">
                    <p className="break-words font-mono text-[12.5px] leading-[19px] text-rose-200">{failure.error}</p>
                    {failure.suggestion && (
                      // The guard turns a refused write into a pointer at the
                      // governed path. Showing it is the difference between a
                      // refusal and an answer.
                      <p className="mt-2 text-[13px] leading-[20px] text-zinc-300">{failure.suggestion}</p>
                    )}
                    {failure.code && <p className="mt-1.5 font-mono text-[12px] text-zinc-500">{failure.code}</p>}
                  </div>
                </div>
              </div>
            </div>
          ) : running && !result ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-zinc-500">
              <Spinner className="h-3.5 w-3.5" /> Running
            </div>
          ) : !result ? (
            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
              <Terminal className="mb-3 h-[18px] w-[18px] text-zinc-600" strokeWidth={1.75} aria-hidden />
              <p className="text-[13px] font-medium text-zinc-300">Run a query to see results.</p>
              <p className="mt-1 max-w-[52ch] text-[12.5px] leading-[19px] text-zinc-500">
                SELECT, WITH and EXPLAIN. Writes and DDL are refused by the database, not by this page.
              </p>
            </div>
          ) : result.rows.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
              <p className="text-[13px] font-medium text-zinc-300">No rows.</p>
              <p className="mt-1 text-[12px] tabular-nums text-zinc-500">{result.ms}ms</p>
            </div>
          ) : (
            <div className="min-w-full">
              <div className={`flex min-h-[36px] flex-wrap items-center gap-2 border-b ${RULE} px-4 py-1.5 sm:px-5`}>
                <span className="text-[12px] tabular-nums text-zinc-500">
                  {result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'} · {result.ms}ms
                </span>
                {result.truncated && (
                  // Not cosmetic. Without it a capped page is indistinguishable
                  // from a complete answer.
                  <Tag tone="warn" mono>
                    truncated at {result.limit}
                  </Tag>
                )}
                {result.redactedColumns.length > 0 && (
                  // A withheld value and a NULL look identical in a table cell
                  // and mean opposite things.
                  <Tag mono>redacted: {result.redactedColumns.join(', ')}</Tag>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[500px] border-separate border-spacing-0">
                  <thead className={`sticky top-0 z-10 ${KIT.gridHead}`}>
                    <tr>
                      {result.fields.map((f) => (
                        <th
                          key={f.name}
                          scope="col"
                          className={`border-b ${RULE} px-4 py-2 text-left font-mono text-[12px] font-medium text-zinc-300`}
                        >
                          {f.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className={KIT.rowHoverOn}>
                        {result.fields.map((f) => (
                          <td key={f.name} className="border-b border-white/[0.04] px-4 py-[9px] font-mono text-[12px] text-zinc-300">
                            {row[f.name] === null || row[f.name] === undefined ? (
                              <span className="italic text-zinc-600">null</span>
                            ) : typeof row[f.name] === 'object' ? (
                              JSON.stringify(row[f.name])
                            ) : (
                              String(row[f.name])
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Snippets and history (desktop) ─────────────────── */}
      <aside className={`hidden w-[240px] flex-shrink-0 flex-col border-l ${RULE} ${KIT.rail} lg:flex`}>
        <div className={`flex h-[44px] flex-shrink-0 items-center border-b ${RULE} px-4`}>
          <span className="text-[13px] font-medium text-zinc-200">Snippets</span>
        </div>
        <div className={`flex-shrink-0 border-b ${RULE} p-2`}>
          {SNIPPETS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                setSql(s.sql)
                editorRef.current?.focus()
              }}
              className={`block w-full rounded-[6px] px-2.5 py-[7px] text-left text-[13px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100 ${FOCUS_INSET}`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className={`flex h-[44px] flex-shrink-0 items-center justify-between border-b ${RULE} pl-4 pr-2`}>
          <span className="text-[13px] font-medium text-zinc-200">History</span>
          {history.length > 0 && <IconButton icon={Trash2} label="Clear query history" onClick={clearHistory} />}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {history.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[12.5px] leading-[19px] text-zinc-500">Queries you run appear here.</p>
          ) : (
            history.map((h, i) => (
              <button
                key={`${i}-${h.slice(0, 24)}`}
                type="button"
                onClick={() => {
                  setSql(h)
                  editorRef.current?.focus()
                }}
                title={h}
                className={`mb-0.5 flex w-full items-start gap-2 rounded-[6px] px-2.5 py-[7px] text-left font-mono text-[12px] text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200 ${FOCUS_INSET}`}
              >
                <Clock className="mt-[3px] h-3 w-3 flex-shrink-0" strokeWidth={1.75} />
                <span className="truncate">{h.replace(/\s+/g, ' ')}</span>
              </button>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}
