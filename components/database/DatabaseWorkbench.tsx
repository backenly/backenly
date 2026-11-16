'use client'

/**
 * Database: the project's tables, as an instrument (project decision 2).
 *
 *   Database  8 tables   Tables  SQL  Schema  Types  Extensions  Snapshots           [+ New table]
 *   users      37 │ movies  1,284 rows  ⋯   [Search rows] [Filter] [Data|Structure] [Insert row] ⟳
 *   movies  1,284 │ #  id uuid          title text           release_year integer   genre_id uuid
 *   reviews 9,431 │ 1  m0000001-4c1e…   Past Lives                           2024   g0000001-4c1e…
 *
 * One bar: the title, one fact, the tabs and the one create button (secondary
 * until the first table exists). Each pane has its own toolbar. Where you are
 * is in the URL: ?tab=, ?table= and ?row=, so a link opens the same view.
 *
 * What a person may do follows their role (decision 9): viewers read
 * everything and run SQL, and nothing that would be refused is offered.
 *
 * The inner layer is absolutely positioned: without it a wide grid's intrinsic
 * width propagates up through the app shell's flex chain and scrolls the
 * whole page sideways.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { InstrumentBar, type BarFact } from '@/components/console/InstrumentBar'
import { useRecordParam } from '@/components/console/RecordDrawer'
import { EmptyPanel, ErrorRow, RefusedLine } from '@/components/console/states'
import { KIT, KitButton, KitConfirmDialog, KitField, KitInput, KitModal } from '@/components/inspector/kit'
import { getTables, type TableInfo } from '@/lib/api/database'
import { getProject } from '@/lib/api/projects'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { DatabaseSnapshots } from './DatabaseSnapshots'
import { EnumsPanel } from './EnumsPanel'
import { ExtensionsPanel } from './ExtensionsPanel'
import { SchemaDiagram } from './SchemaDiagram'
import { SqlWorkspace } from './SqlWorkspace'
import { TablePane } from './TablePane'
import { TablesRail } from './TablesRail'
import { tablesWord } from './values'

const TABS = [
  { id: 'tables', label: 'Tables' },
  { id: 'sql', label: 'SQL' },
  { id: 'schema', label: 'Schema' },
  { id: 'types', label: 'Types' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'snapshots', label: 'Snapshots' },
] as const
type Tab = (typeof TABS)[number]['id']

const readTab = (param: string | null): Tab =>
  param === 'visualization' ? 'schema' : TABS.some((t) => t.id === param) ? (param as Tab) : 'tables'

export function DatabaseWorkbench({ projectId }: { projectId: string }) {
  const router = useRouter()
  const search = useSearchParams()
  // Changes moved to History: an old link (?view=changes, ?change=<id> from
  // approvals and the Autonomy feed) still lands on the change it is about.
  useEffect(() => {
    if (search?.get('view') !== 'changes') return
    const change = search.get('change')
    router.replace(`/app/projects/${projectId}/changes${change ? `?change=${encodeURIComponent(change)}` : ''}`)
  }, [search, router, projectId])

  const role = useProjectRole(projectId)
  const agent = useAgentConnection(projectId)
  const schema = `workspace_${projectId}`
  const panelId = useId()

  const [tabParam, openTabParam, closeTabParam] = useRecordParam('tab')
  const [tableParam, openTableParam, closeTableParam] = useRecordParam('table')
  const [rowParam, openRow, closeRow] = useRecordParam('row')
  const tab = readTab(tabParam)
  const setTab = (id: string) => (id === 'tables' ? closeTabParam() : openTabParam(id))

  // ── The tables ─────────────────────────────────────────────────────────────
  const [tables, setTables] = useState<TableInfo[] | null>(null)
  const [tablesFailed, setTablesFailed] = useState(false)
  const [staleAt, setStaleAt] = useState<number | null>(null)
  const readAt = useRef<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const loadTables = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true)
      try {
        const list = await getTables('postgresql', schema, { projectId, view: 'workspace' })
        // Backenly seeds an empty `users` table for end-user sign-in. Standing
        // alone and empty it is scaffolding nobody built, so a new project reads
        // as empty; with rows, or beside any real table, it shows.
        const real = list.filter((t) => t.name.toLowerCase() !== 'users')
        const users = list.find((t) => t.name.toLowerCase() === 'users')
        const scaffold = !!users && (users.rows ?? 0) === 0 && real.length === 0
        setTables(scaffold ? real : list)
        setTablesFailed(false)
        setStaleAt(null)
        readAt.current = Date.now()
      } catch {
        if (refresh && readAt.current !== null) setStaleAt(readAt.current)
        else {
          setTables(null)
          setTablesFailed(true)
        }
      } finally {
        if (refresh) setRefreshing(false)
      }
    },
    [projectId, schema],
  )

  useEffect(() => {
    void loadTables()
  }, [loadTables])

  // The in-console assistant announces the database changes it makes.
  useEffect(() => {
    const onChanged = () => void loadTables(true)
    window.addEventListener('backenly:database-changed', onChanged)
    return () => window.removeEventListener('backenly:database-changed', onChanged)
  }, [loadTables])

  const selected = tables ? tables.find((t) => t.name === tableParam) ?? tables[0] ?? null : null
  // A ?table= the project no longer has (dropped by its agent): the first table instead.
  useEffect(() => {
    if (tables && tableParam && !tables.some((t) => t.name === tableParam)) {
      closeTableParam()
      closeRow()
    }
  }, [tables, tableParam, closeTableParam, closeRow])

  // Phones show one pane at a time: the tables first, unless a link named one.
  const [pane, setPane] = useState<'list' | 'table'>(() => (tableParam ? 'table' : 'list'))
  const selectTable = (name: string) => {
    if (name !== selected?.name) closeRow()
    openTableParam(name)
    setPane('table')
  }

  // ── What the panes need from the project ───────────────────────────────────
  const [apiBaseUrl, setApiBaseUrl] = useState<string | null>(null)
  const [windowDays, setWindowDays] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    getProject(projectId)
      .then((p) => !cancelled && setApiBaseUrl(p.apiBaseUrl ?? null))
      .catch(() => {})
    // How long History can undo a dropped table or column, from History itself.
    fetch(`/api/projects/${projectId}/changes?limit=1`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && typeof d?.windowDays === 'number') setWindowDays(d.windowDays)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId])

  // ── New table, delete table ────────────────────────────────────────────────
  const [creating, setCreating] = useState(false)
  const [toDelete, setToDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const deleteTable = async () => {
    if (!toDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch('/api/database/delete-table', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tableName: toDelete, schema, databaseType: 'postgresql', projectId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || body.message || 'The table was not deleted.')
      if (selected?.name === toDelete) {
        closeTableParam()
        closeRow()
      }
      setToDelete(null)
      await loadTables(true)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'The table was not deleted.')
    } finally {
      setDeleting(false)
    }
  }

  // ── The bar ────────────────────────────────────────────────────────────────
  const facts: Array<BarFact | null> = [
    tables && tables.length > 0 ? { text: tablesWord(tables.length) } : null,
    role.role !== null && !role.canWrite ? { text: 'Read only' } : null,
  ]
  const hasTables = !!tables && tables.length > 0

  const tablesBody = tablesFailed ? (
    <div className="min-w-0 flex-1">
      <ErrorRow things="tables" stillWorks="The SQL tab still works." onRetry={() => void loadTables()} />
    </div>
  ) : tables && tables.length === 0 ? (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <EmptyPanel
        title="No tables yet"
        sentence="Your coding agent creates tables as it builds."
        requests={['Add a products table with a name, a price in cents and a stock count. Anyone can read it; only admins can write.']}
        agent={role.loading ? null : { status: agent.status, client: agent.client }}
        canConnect={role.canAdminister}
        docs={{ label: 'Database docs', slug: 'database' }}
        headingLevel={2}
      />
    </div>
  ) : (
    <>
      <TablesRail
        tables={tables}
        selected={selected?.name ?? null}
        onSelect={selectTable}
        className={`w-full flex-shrink-0 md:w-[232px] ${KIT.rail} ${pane === 'table' ? 'hidden md:flex' : 'flex'}`}
      />
      <section aria-label={selected ? `Table ${selected.name}` : 'Table'} className={`min-w-0 flex-1 flex-col overflow-hidden ${pane === 'list' ? 'hidden md:flex' : 'flex'}`}>
        {staleAt !== null && <ErrorRow things="tables" staleAt={staleAt} onRetry={() => void loadTables(true)} retrying={refreshing} />}
        {selected ? (
          <TablePane
            key={selected.name}
            projectId={projectId}
            schema={schema}
            table={selected}
            tables={tables ?? []}
            canWrite={role.canWrite}
            rowParam={rowParam}
            openRow={openRow}
            closeRow={closeRow}
            onBack={() => setPane('list')}
            onDeleteTable={() => {
              setDeleteError(null)
              setToDelete(selected.name)
            }}
            onOpenSchema={() => setTab('schema')}
            onRefreshTables={() => loadTables(true)}
            apiBaseUrl={apiBaseUrl}
            windowDays={windowDays}
          />
        ) : (
          <div aria-busy="true" aria-label="Loading" className="flex-1" />
        )}
      </section>
    </>
  )

  return (
    <div className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`}>
      <InstrumentBar
        title="Database"
        loading={tables === null && !tablesFailed}
        facts={facts}
        tabs={TABS}
        activeTab={tab}
        onTab={setTab}
        panelId={panelId}
        create={role.canWrite ? { label: 'New table', primary: hasTables, onClick: () => setCreating(true) } : undefined}
      />

      <div id={panelId} role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">
          {tab === 'tables' ? (
            tablesBody
          ) : tab === 'sql' ? (
            <SqlWorkspace projectId={projectId} table={selected?.name ?? null} />
          ) : tab === 'schema' ? (
            <SchemaDiagram
              projectId={projectId}
              activeSchema={schema}
              activeTable={selected?.name ?? null}
              onOpenTableData={(name) => {
                closeTabParam()
                selectTable(name)
              }}
            />
          ) : tab === 'types' ? (
            <EnumsPanel projectId={projectId} canWrite={role.canWrite} canAdminister={role.canAdminister} />
          ) : tab === 'extensions' ? (
            <ExtensionsPanel projectId={projectId} canAdminister={role.canAdminister} />
          ) : (
            <DatabaseSnapshots projectId={projectId} canWrite={role.canWrite} canAdminister={role.canAdminister} />
          )}
        </div>
      </div>

      {creating && (
        <NewTableDialog
          projectId={projectId}
          schema={schema}
          onClose={() => setCreating(false)}
          onCreated={async (name) => {
            setCreating(false)
            await loadTables(true)
            closeTabParam()
            selectTable(name)
          }}
        />
      )}

      <KitConfirmDialog
        open={!!toDelete}
        onCancel={() => !deleting && setToDelete(null)}
        onConfirm={() => void deleteTable()}
        title={
          <>
            Delete table <span className="font-mono text-[14px]">{toDelete}</span>?
          </>
        }
        description="Its rows and its REST endpoints go with it."
        undoable={{ days: windowDays, detail: 'rows included' }}
        confirmLabel="Delete table"
        danger
        busy={deleting}
      >
        {deleteError && <RefusedLine>{deleteError}</RefusedLine>}
      </KitConfirmDialog>
    </div>
  )
}

/** A table by hand: a name and, if wanted, what it is for. Backenly adds the key and the timestamps. */
function NewTableDialog({
  projectId,
  schema,
  onClose,
  onCreated,
}: {
  projectId: string
  schema: string
  onClose: () => void
  onCreated: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    const tableName = name.trim()
    if (!tableName || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/database/create-table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tableName, description, schema, databaseType: 'postgresql', projectId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || body.message || 'The table was not created.')
      await onCreated(tableName)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The table was not created.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <KitModal
      open
      onClose={() => !busy && onClose()}
      title="New table"
      description="Backenly adds id, createdAt and updatedAt, and its REST endpoints."
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </KitButton>
          <KitButton variant="primary" onClick={() => void create()} loading={busy} disabled={!name.trim()}>
            Create table
          </KitButton>
        </>
      }
    >
      <div className="space-y-[16px]">
        <KitField label="Name">
          <KitInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
            placeholder="orders"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            className="font-mono"
          />
        </KitField>
        <KitField label={<>Description <span className="font-normal text-faint">Optional</span></>}>
          <KitInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this table stores" disabled={busy} />
        </KitField>
        {error && <RefusedLine>{error}</RefusedLine>}
      </div>
    </KitModal>
  )
}
