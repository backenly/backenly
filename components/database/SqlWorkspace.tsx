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
import { AlertCircle, Loader2, Play, Clock, Trash2 } from 'lucide-react'

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
    <div className="flex h-full w-full min-h-0">
      {/* ── Editor and results ─────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[12.5px] font-semibold text-zinc-100">SQL</h2>
            <span className="font-mono text-[11px] text-zinc-500">read-only</span>
          </div>
          <button
            onClick={() => void run()}
            disabled={running || !sql.trim()}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-white px-3 text-[11.5px] font-semibold text-black transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Run
          </button>
        </div>

        {/* Quick snippets horizontal scroll strip for mobile / tablet */}
        <div className="flex lg:hidden items-center gap-2 overflow-x-auto border-b border-white/[0.06] bg-[#0c0d11] px-3 py-2 no-scrollbar">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600 flex-shrink-0">Snippets:</span>
          {SNIPPETS.map(s => (
            <button
              key={s.label}
              onClick={() => { setSql(s.sql); editorRef.current?.focus() }}
              className="flex-shrink-0 rounded-md bg-white/[0.05] hover:bg-white/[0.1] px-2.5 py-1 text-[11px] font-mono text-zinc-300 border border-white/[0.06] transition-colors"
            >
              {s.label}
            </button>
          ))}
        </div>

        <textarea
          ref={editorRef}
          value={sql}
          onChange={e => setSql(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          aria-label="SQL query"
          placeholder="SELECT * FROM your_table LIMIT 10"
          className="h-36 sm:h-40 flex-shrink-0 resize-none border-b border-white/[0.06] bg-[#0f1015] px-4 py-3 font-mono text-base sm:text-[12.5px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
        />

        <div className="min-h-0 flex-1 overflow-auto">
          {failure ? (
            <div className="p-4">
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.05] px-4 py-3">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-300" />
                  <div className="min-w-0">
                    <p className="font-mono text-[11.5px] text-rose-200">{failure.error}</p>
                    {failure.suggestion && (
                      // The guard turns a refused write into a pointer at the
                      // governed path. Showing it is the difference between a
                      // refusal and an answer.
                      <p className="mt-2 text-[11.5px] text-zinc-300">{failure.suggestion}</p>
                    )}
                    {failure.code && (
                      <p className="mt-1.5 font-mono text-[10.5px] text-zinc-600">{failure.code}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : running && !result ? (
            <div className="flex h-full items-center justify-center text-[12px] text-zinc-500">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Running
            </div>
          ) : !result ? (
            <div className="flex h-full items-center justify-center px-8 text-center">
              <div>
                <p className="text-[12.5px] text-zinc-400">Run a query to see results.</p>
                <p className="mt-1 text-[11px] text-zinc-600">
                  SELECT, WITH and EXPLAIN. Writes and DDL are refused by the database, not by this page.
                </p>
              </div>
            </div>
          ) : result.rows.length === 0 ? (
            <div className="flex h-full items-center justify-center px-8 text-center">
              <div>
                <p className="text-[12.5px] text-zinc-400">No rows.</p>
                <p className="mt-1 font-mono text-[11px] text-zinc-600">{result.ms}ms</p>
              </div>
            </div>
          ) : (
            <div className="min-w-full overflow-x-auto">
              <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-2">
                <span className="font-mono text-[10.5px] tabular-nums text-zinc-500">
                  {result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'} · {result.ms}ms
                </span>
                {result.truncated && (
                  // Not a cosmetic badge. Without it a capped page is
                  // indistinguishable from a complete answer.
                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10.5px] text-amber-300">
                    truncated at {result.limit}
                  </span>
                )}
                {result.redactedColumns.length > 0 && (
                  // A withheld value and a NULL look identical in a table cell
                  // and mean opposite things.
                  <span className="rounded bg-zinc-500/10 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-400">
                    redacted: {result.redactedColumns.join(', ')}
                  </span>
                )}
              </div>
              <table className="w-full min-w-[500px] border-collapse">
                <thead className="sticky top-0 z-10 bg-[#0e0f13]">
                  <tr>
                    {result.fields.map(f => (
                      <th
                        key={f.name}
                        className="border-b border-white/[0.06] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600"
                      >
                        {f.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-white/[0.02]">
                      {result.fields.map(f => (
                        <td
                          key={f.name}
                          className="border-b border-white/[0.04] px-3 py-[9px] font-mono text-[11px] text-zinc-300"
                        >
                          {row[f.name] === null || row[f.name] === undefined
                            ? <span className="text-zinc-600">null</span>
                            : typeof row[f.name] === 'object'
                              ? JSON.stringify(row[f.name])
                              : String(row[f.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Snippets and history (hidden on mobile, visible on desktop) ───────────────────────────── */}
      <aside className="hidden lg:flex w-56 flex-shrink-0 flex-col border-l border-white/[0.06]">
        <div className="flex h-10 flex-shrink-0 items-center border-b border-white/[0.06] px-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Snippets</span>
        </div>
        <div className="flex-shrink-0 border-b border-white/[0.06] p-2">
          {SNIPPETS.map(s => (
            <button
              key={s.label}
              onClick={() => { setSql(s.sql); editorRef.current?.focus() }}
              className="block w-full rounded px-2 py-1.5 text-left text-[11.5px] text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100 focus:outline-none"
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex h-9 flex-shrink-0 items-center justify-between border-b border-white/[0.06] px-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">History</span>
          {history.length > 0 && (
            <button
              onClick={clearHistory}
              aria-label="Clear query history"
              className="p-1 text-zinc-600 hover:text-zinc-300 focus:outline-none"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {history.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-zinc-600">Queries you run appear here.</p>
          ) : (
            history.map((h, i) => (
              <button
                key={`${i}-${h.slice(0, 24)}`}
                onClick={() => { setSql(h); editorRef.current?.focus() }}
                title={h}
                className="mb-0.5 flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left font-mono text-[10.5px] text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200 focus:outline-none"
              >
                <Clock className="mt-0.5 h-2.5 w-2.5 flex-shrink-0" />
                <span className="truncate">{h.replace(/\s+/g, ' ')}</span>
              </button>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}
