'use client'

/**
 * One table, as an instrument pane (project decision 2): one toolbar (the
 * table and its row count, ⋯, search, filter, Data | Structure, Insert row,
 * refresh), the filters and sort when any are applied, a one-line grid
 * header, 36px rows, and the pages under it. A row opens in the drawer beside
 * the grid (decision 6), and the open row is in the URL (?row=<key>), which
 * is where Realtime's "Open the row in Database" lands.
 *
 * Search, sort, filters and pages are all the server's (app/api/database/rows):
 * nothing is filtered in the browser, so what the grid says it found is what
 * the table holds.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowDown, ArrowUp, ChevronLeft, Copy, KeyRound, Link2, ListFilter, Network, Plus, Trash2, Users } from 'lucide-react'
import { ChipStrip, GridFooter, PaneToolbar, type Chip, type MenuItems } from '@/components/console/InstrumentBar'
import { ErrorRow } from '@/components/console/states'
import { FOCUS, FOCUS_INSET, GRID_HEAD, RULE } from '@/components/console/tokens'
import { KIT, KitButton, KitField, KitInput, KitSelect, Skeleton } from '@/components/inspector/kit'
import {
  deleteRow,
  getIndexes,
  getRelationships,
  getRows,
  getStructure,
  insertRow,
  updateRow,
  type IndexInfo,
  type RelationshipInfo,
  type TableInfo,
} from '@/lib/api/database'
import { PopoverButton } from './Popover'
import { RowDrawer } from './RowDrawer'
import { TableStructure } from './TableStructure'
import { recordNav } from '@/components/console/RecordDrawer'
import {
  PAGE_SIZE,
  REDACTED,
  cellText,
  gridOrder,
  isFilterable,
  isNumericType,
  isUuidType,
  keyColumn,
  rowKey,
  rowsWord,
  sortWords,
  type Column,
  type Row,
} from './values'

type Sort = { column: string; dir: 'asc' | 'desc' } | null
type Filter = { column: string; value: string }

export interface TablePaneProps {
  projectId: string
  schema: string
  table: TableInfo
  tables: readonly TableInfo[]
  canWrite: boolean
  rowParam: string | null
  openRow: (id: string) => void
  closeRow: () => void
  /** Phone: back to the tables list. */
  onBack: () => void
  onDeleteTable: () => void
  onOpenSchema: () => void
  /** Read the tables list again (counts, an agent's new table). */
  onRefreshTables: () => Promise<void> | void
  /**
   * The project's REST API base ({origin}/api/v2/{id}), for Copy API URL. /db
   * on the v1 base is deprecated, kept for existing apps (lib/api/v1/deprecation.ts).
   */
  restBaseUrl: string | null
  /** How long History keeps an undoable change. */
  windowDays: number | null
}

export function TablePane({
  projectId,
  schema,
  table: tableInfo,
  tables,
  canWrite,
  rowParam,
  openRow,
  closeRow,
  onBack,
  onDeleteTable,
  onOpenSchema,
  onRefreshTables,
  restBaseUrl,
  windowDays,
}: TablePaneProps) {
  const table = tableInfo.name
  const router = useRouter()
  const [view, setView] = useState<'data' | 'structure'>('data')

  // ── Structure: the columns the grid and the drawer are built from ──────────
  const [columns, setColumns] = useState<Column[]>([])
  const [indexes, setIndexes] = useState<IndexInfo[]>([])
  const [relationships, setRelationships] = useState<RelationshipInfo[]>([])
  const [structure, setStructure] = useState<'loading' | 'ready' | 'failed'>('loading')

  const loadStructure = useCallback(async () => {
    try {
      const cols = await getStructure('postgresql', table, schema, { projectId, view: 'workspace' })
      setColumns(cols)
      setStructure('ready')
      getIndexes(schema, table, { projectId }).then(setIndexes, () => setIndexes([]))
      getRelationships(schema, table, { projectId }).then(setRelationships, () => setRelationships([]))
    } catch {
      setStructure((s) => (s === 'ready' ? s : 'failed'))
    }
  }, [projectId, schema, table])

  useEffect(() => {
    void loadStructure()
  }, [loadStructure])

  // ── Rows: this page, this search, this sort, these filters ─────────────────
  const [search, setSearch] = useState('')
  const [committedSearch, setCommittedSearch] = useState('')
  const [sort, setSort] = useState<Sort>(null)
  const [filters, setFilters] = useState<Filter[]>([])
  const [page, setPage] = useState(1)

  const [rows, setRows] = useState<Row[] | null>(null)
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [redacted, setRedacted] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [staleAt, setStaleAt] = useState<number | null>(null)
  const readAt = useRef<number | null>(null)
  const seq = useRef(0)

  const loadRows = useCallback(
    async (q: { page: number; search: string; sort: Sort; filters: Filter[] }, refresh = false) => {
      const mine = ++seq.current
      setLoading(true)
      try {
        const res = await getRows('postgresql', table, {
          schema,
          projectId,
          view: 'workspace',
          limit: PAGE_SIZE,
          page: q.page,
          sortBy: q.sort?.column,
          sortOrder: q.sort?.dir,
          search: q.search || undefined,
          filters: Object.fromEntries(q.filters.map((f) => [f.column, f.value])),
        })
        if (mine !== seq.current) return
        setRows(res.data ?? [])
        setTotal(res.pagination?.total ?? res.data?.length ?? 0)
        setPages(Math.max(1, res.pagination?.totalPages ?? 1))
        setRedacted(res.redactedColumns ?? [])
        setFailed(false)
        setStaleAt(null)
        readAt.current = Date.now()
      } catch {
        if (mine !== seq.current) return
        if (refresh && readAt.current !== null) {
          // A failed refresh keeps what is on screen and says how old it is.
          setStaleAt(readAt.current)
        } else {
          // A failed first read clears the grid: old rows must not read as this answer.
          setRows(null)
          setFailed(true)
        }
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    },
    [projectId, schema, table],
  )

  useEffect(() => {
    void loadRows({ page, search: committedSearch, sort, filters })
  }, [loadRows, page, committedSearch, sort, filters])

  // Search is the server's, a moment after typing stops.
  const committedRef = useRef('')
  useEffect(() => {
    const term = search.trim()
    const t = setTimeout(() => {
      if (term === committedRef.current) return
      committedRef.current = term
      setCommittedSearch(term)
      setPage(1)
    }, term ? 350 : 0)
    return () => clearTimeout(t)
  }, [search])

  const reloadRows = useCallback(
    () => loadRows({ page, search: committedSearch, sort, filters }, true),
    [loadRows, page, committedSearch, sort, filters],
  )

  // Refresh reads the table list too: agents change tables over MCP, which fires no event here.
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    await Promise.all([loadStructure(), reloadRows(), Promise.resolve(onRefreshTables())])
    setRefreshing(false)
  }

  const toggleSort = (column: string) => {
    setSort((s) => (!s || s.column !== column ? { column, dir: 'asc' } : s.dir === 'asc' ? { column, dir: 'desc' } : null))
    setPage(1)
  }

  // ── The drawer ─────────────────────────────────────────────────────────────
  const keyName = keyColumn(columns)
  const nav = recordNav(rows ?? [], (r) => rowKey(r, keyName), rowParam, openRow)
  const [linked, setLinked] = useState<{ id: string; row: Row } | null>(null)
  // A link to a row on another page (Realtime's "Open the row"): read it by its key.
  useEffect(() => {
    if (!rowParam || !rows || structure !== 'ready' || nav.item) return
    if (linked?.id === rowParam) return
    let cancelled = false
    getRows('postgresql', table, { schema, projectId, view: 'workspace', limit: 1, page: 1, filters: { [keyName]: rowParam } })
      .then((res) => {
        const row = (res.data ?? []).find((r: Row) => rowKey(r, keyName) === rowParam)
        if (!cancelled && row) setLinked({ id: rowParam, row })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [rowParam, rows, structure, nav.item, linked, keyName, projectId, schema, table])

  const [inserting, setInserting] = useState(false)
  const [revision, setRevision] = useState(0)
  const drawerRow = nav.item ?? (linked && linked.id === rowParam ? linked.row : null)
  const drawerMode = inserting ? 'insert' : drawerRow ? 'edit' : null

  const startInsert = () => {
    closeRow()
    setInserting(true)
  }

  const save = async (changes: Record<string, unknown>) => {
    if (!drawerRow) return
    await updateRow('postgresql', table, rowKey(drawerRow, keyName), changes, schema, projectId)
    if (linked && linked.id === rowParam) setLinked(null)
    await reloadRows()
    setRevision((r) => r + 1)
  }

  const remove = async () => {
    if (!drawerRow) return
    await deleteRow('postgresql', table, rowKey(drawerRow, keyName), schema, projectId)
    closeRow()
    setLinked(null)
    // The last row of the last page: step back a page rather than land on an empty one.
    const lastPage = Math.max(1, Math.ceil(Math.max(0, total - 1) / PAGE_SIZE))
    if (page > lastPage) setPage(lastPage)
    else await reloadRows()
    void onRefreshTables()
  }

  const insert = async (values: Record<string, unknown>) => {
    await insertRow('postgresql', table, values, schema, projectId)
    setInserting(false)
    await reloadRows()
    void onRefreshTables()
  }

  // ── Filters ────────────────────────────────────────────────────────────────
  const [filterOpen, setFilterOpen] = useState(false)
  const filterable = columns.filter((c) => isFilterable(c.name) && !redacted.includes(c.name))
  const [fColumn, setFColumn] = useState('')
  const [fValue, setFValue] = useState('')
  const applyFilter = () => {
    const column = fColumn || filterable[0]?.name
    if (!column) return
    setFilters((list) => [...list.filter((f) => f.column !== column), { column, value: fValue }])
    setPage(1)
    setFilterOpen(false)
    setFValue('')
  }

  const chips: Chip[] = [
    ...filters.map((f) => ({
      id: `f:${f.column}`,
      label: (
        <>
          <span className="font-mono">{f.column}</span> = {f.value}
        </>
      ),
      name: `${f.column} equals ${f.value}`,
      onRemove: () => {
        setFilters((list) => list.filter((x) => x.column !== f.column))
        setPage(1)
      },
    })),
    ...(sort
      ? [
          {
            id: 'sort',
            label: (
              <>
                Sorted by <span className="font-mono">{sort.column}</span>, {sortWords(columns.find((c) => c.name === sort.column), sort.dir)}
              </>
            ),
            name: `the sort by ${sort.column}`,
            onRemove: () => {
              setSort(null)
              setPage(1)
            },
          },
        ]
      : []),
  ]

  // ── The table's own actions ────────────────────────────────────────────────
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {})
  const menu: MenuItems = [
    { label: 'Copy name', icon: Copy, onClick: () => copy(table) },
    ...(restBaseUrl ? [{ label: 'Copy API URL', icon: Copy, onClick: () => copy(`${restBaseUrl}/${encodeURIComponent(table)}`) }] : []),
    { label: 'Open in Schema', icon: Network, onClick: onOpenSchema },
    // The end-user table: its sign-ins, blocks and providers are managed in Auth & Users.
    ...(table.toLowerCase() === 'users' ? [{ label: 'Open in Auth & Users', icon: Users, onClick: () => router.push(`/app/projects/${projectId}/auth`) }] : []),
    ...(canWrite ? [{ separator: true } as const, { label: 'Delete table…', icon: Trash2, danger: true, onClick: onDeleteTable }] : []),
  ]

  const ordered = gridOrder(columns)
  const searching = committedSearch !== '' || filters.length > 0

  return (
    <>
      {/* Phone: the tables list is the first screen; this is the way back to it. */}
      <div className={`flex h-[40px] flex-shrink-0 items-center border-b ${RULE} px-[8px] md:hidden`}>
        <button
          type="button"
          onClick={onBack}
          className={`inline-flex h-[30px] items-center gap-[4px] rounded-[7px] px-[8px] text-[13px] font-medium text-zinc-300 transition-colors duration-150 hover:bg-white/[0.05] hover:text-zinc-100 ${FOCUS}`}
        >
          <ChevronLeft aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.75} />
          Tables
        </button>
      </div>

      <PaneToolbar
        title={table}
        mono
        count={
          <>
            {!rows
              ? rowsWord(tableInfo.rows ?? 0)
              : searching
                ? `${total.toLocaleString('en-US')} of ${rowsWord(Math.max(total, tableInfo.rows ?? 0))}`
                : rowsWord(total)}
          </>
        }
        menu={menu}
        menuLabel={`Actions for table ${table}`}
        search={view === 'data' ? { value: search, onChange: setSearch, placeholder: 'Search rows' } : undefined}
        filter={
          view === 'data' && filterable.length > 0 ? (
            <PopoverButton label="Filter" icon={ListFilter} open={filterOpen} onOpenChange={setFilterOpen} pressed={filters.length > 0}>
              <form
                className="space-y-[12px] p-[14px]"
                onSubmit={(e) => {
                  e.preventDefault()
                  applyFilter()
                }}
              >
                <KitField label="Column">
                  <KitSelect value={fColumn || filterable[0]?.name || ''} onChange={(e) => setFColumn(e.target.value)}>
                    {filterable.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </KitSelect>
                </KitField>
                <KitField label="Equals" hint="Compared as text. Filters add up.">
                  <KitInput value={fValue} onChange={(e) => setFValue(e.target.value)} spellCheck={false} autoComplete="off" className="font-mono" />
                </KitField>
                <div className="flex justify-end gap-[8px] pt-[2px]">
                  <KitButton size="sm" variant="ghost" onClick={() => setFilterOpen(false)}>
                    Cancel
                  </KitButton>
                  <KitButton size="sm" variant="primary" type="submit" disabled={fValue === ''}>
                    Apply
                  </KitButton>
                </div>
              </form>
            </PopoverButton>
          ) : undefined
        }
        view={{
          value: view,
          onChange: (v) => setView(v),
          label: 'Table view',
          options: [
            { value: 'data', label: 'Data' },
            { value: 'structure', label: 'Structure' },
          ],
        }}
        action={
          canWrite && view === 'data' ? (
            <KitButton size="sm" icon={Plus} onClick={startInsert} disabled={structure !== 'ready'}>
              Insert row
            </KitButton>
          ) : undefined
        }
        onRefresh={() => void refresh()}
        refreshing={refreshing}
      />

      {view === 'structure' ? (
        <TableStructure
          projectId={projectId}
          table={table}
          columns={columns}
          indexes={indexes}
          relationships={relationships}
          tables={tables}
          loading={structure === 'loading'}
          failed={structure === 'failed'}
          onRetry={() => void loadStructure()}
          canWrite={canWrite}
          windowDays={windowDays}
          onChanged={async () => {
            await Promise.all([loadStructure(), reloadRows()])
          }}
        />
      ) : (
        <>
          <ChipStrip
            chips={chips}
            onClearAll={() => {
              setFilters([])
              setSort(null)
              setPage(1)
            }}
          />
          {staleAt !== null && rows && <ErrorRow things="rows" staleAt={staleAt} onRetry={() => void reloadRows()} retrying={loading} />}

          <div className="min-h-0 flex-1 overflow-auto">
            {structure === 'failed' ? (
              <ErrorRow things={`the columns of ${table}`} stillWorks="The SQL tab still works." onRetry={() => void loadStructure()} />
            ) : rows === null ? (
              failed ? (
                <ErrorRow things={`the rows of ${table}`} onRetry={() => void loadRows({ page, search: committedSearch, sort, filters })} retrying={loading} />
              ) : (
                <GridSkeleton />
              )
            ) : rows.length === 0 ? (
              searching ? (
                <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] px-[16px] py-[14px] sm:px-[20px]">
                  <p className="text-[13px] leading-[20px] text-zinc-400">
                    {committedSearch ? `No rows match “${committedSearch}”.` : 'No rows match these filters.'}
                  </p>
                  <KitButton
                    size="sm"
                    onClick={() => {
                      setSearch('')
                      setFilters([])
                      setPage(1)
                    }}
                  >
                    {committedSearch && filters.length === 0 ? 'Clear search' : 'Clear filters'}
                  </KitButton>
                </div>
              ) : (
                <p className="px-[16px] py-[14px] text-[13px] leading-[20px] text-zinc-400 sm:px-[20px]">
                  No rows yet. Your app, your agent or a function writes them here.
                </p>
              )
            ) : (
              <table className={`w-max min-w-full border-separate border-spacing-0 transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}>
                <thead className="sticky top-0 z-20">
                  <tr>
                    <th
                      scope="col"
                      className={`sticky left-0 z-30 h-[36px] w-[52px] border-b border-r ${RULE} ${GRID_HEAD} px-[12px] text-right text-[12px] font-normal text-faint`}
                    >
                      <span className="sr-only">Row</span>#
                    </th>
                    {ordered.map((col) => {
                      const sorted = sort?.column === col.name ? sort.dir : null
                      const numeric = isNumericType(col.type)
                      return (
                        <th
                          key={col.name}
                          scope="col"
                          aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                          className={`h-[36px] border-b ${RULE} ${GRID_HEAD} p-0 text-left font-normal ${
                            isUuidType(col.type) ? 'w-[176px] min-w-[176px] max-w-[176px]' : 'min-w-[120px] max-w-[320px]'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => toggleSort(col.name)}
                            title={sorted === 'asc' ? 'Sorted ascending. Sort descending' : sorted === 'desc' ? 'Sorted descending. Clear the sort' : `Sort by ${col.name}`}
                            className={`flex h-[36px] w-full min-w-0 items-center gap-[6px] px-[12px] transition-colors duration-150 hover:bg-white/[0.03] ${FOCUS_INSET} ${
                              numeric ? 'justify-end' : ''
                            }`}
                          >
                            {col.primary ? (
                              <KeyRound aria-label="Primary key" className="h-[12px] w-[12px] flex-shrink-0 text-zinc-400" strokeWidth={2} />
                            ) : col.foreign ? (
                              <Link2 aria-label="Foreign key" className="h-[12px] w-[12px] flex-shrink-0 text-zinc-400" strokeWidth={2} />
                            ) : null}
                            <span className={`truncate font-mono text-[12px] font-medium ${sorted ? 'text-white' : 'text-zinc-200'}`}>{col.name}</span>
                            <span className="flex-shrink-0 font-mono text-[11px] text-faint">{col.type}</span>
                            {sorted === 'asc' ? (
                              <ArrowUp aria-hidden className="h-[12px] w-[12px] flex-shrink-0 text-zinc-200" />
                            ) : sorted === 'desc' ? (
                              <ArrowDown aria-hidden className="h-[12px] w-[12px] flex-shrink-0 text-zinc-200" />
                            ) : null}
                          </button>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const id = rowKey(row, keyName)
                    const isOpen = !inserting && drawerMode === 'edit' && id === rowParam
                    const n = (page - 1) * PAGE_SIZE + i + 1
                    return (
                      <tr
                        key={id || `i${i}`}
                        tabIndex={0}
                        aria-current={isOpen || undefined}
                        aria-label={`Row ${n}`}
                        onClick={() => {
                          setInserting(false)
                          openRow(id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setInserting(false)
                            openRow(id)
                          }
                        }}
                        className={`group/row cursor-pointer transition-colors duration-150 ${FOCUS_INSET} ${isOpen ? 'bg-white/[0.05]' : KIT.rowHoverOn}`}
                      >
                        <td
                          className={`sticky left-0 z-10 h-[36px] border-b border-r border-white/[0.04] px-[12px] text-right text-[12px] tabular-nums transition-colors duration-150 ${
                            isOpen ? 'bg-[#141518] text-zinc-300' : `${KIT.bg} ${KIT.rowHoverGroup} text-faint`
                          }`}
                        >
                          {n}
                        </td>
                        {ordered.map((col) => {
                          const value = row[col.name]
                          const hidden = redacted.includes(col.name) && value === REDACTED
                          const isNull = value === null || value === undefined
                          const text = cellText(value)
                          const numeric = isNumericType(col.type)
                          return (
                            <td
                              key={col.name}
                              className={`h-[36px] border-b border-white/[0.04] px-[12px] ${numeric ? 'text-right' : ''} ${
                                isUuidType(col.type) ? 'max-w-[176px]' : 'max-w-[320px]'
                              }`}
                            >
                              <span
                                title={hidden ? 'Withheld, as in SQL' : text}
                                className={`block truncate text-[12px] ${hidden ? 'italic text-faint' : isNull ? 'font-mono italic text-faint' : numeric ? 'font-mono tabular-nums text-zinc-200' : 'font-mono text-zinc-300'}`}
                              >
                                {hidden ? 'Hidden' : text}
                              </span>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {rows && rows.length > 0 && (
            <GridFooter
              mode="pages"
              from={(page - 1) * PAGE_SIZE + 1}
              to={Math.min(page * PAGE_SIZE, total)}
              total={total}
              page={page}
              pages={pages}
              onPrev={() => setPage((p) => Math.max(1, p - 1))}
              onNext={() => setPage((p) => Math.min(pages, p + 1))}
              busy={loading}
            />
          )}
        </>
      )}

      <RowDrawer
        mode={drawerMode}
        table={table}
        columns={columns}
        row={drawerRow}
        keyName={keyName}
        redacted={redacted}
        canWrite={canWrite}
        onClose={() => (inserting ? setInserting(false) : closeRow())}
        onPrev={nav.onPrev}
        onNext={nav.onNext}
        position={nav.position}
        onSave={save}
        onInsert={insert}
        onDelete={remove}
        revision={revision}
      />
    </>
  )
}

/** Row-shaped placeholders under a real header, drawn once. */
function GridSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading rows">
      <div className={`h-[36px] border-b ${RULE} ${GRID_HEAD}`} />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} aria-hidden className="flex h-[36px] items-center gap-[24px] border-b border-white/[0.04] px-[20px]">
          <Skeleton className="h-[11px] w-[18px]" />
          <Skeleton className="h-[11px] w-[140px]" />
          <Skeleton className={`h-[11px] ${i % 2 ? 'w-[180px]' : 'w-[120px]'}`} />
          <Skeleton className="hidden h-[11px] w-[90px] md:block" />
        </div>
      ))}
    </div>
  )
}
