'use client'

/**
 * A table's Structure: its columns as rows (name, type, whether it may be
 * empty, its default, its constraints in words), its indexes, and what runs
 * when its rows change. Each column's actions sit behind its ⋯, never in
 * icons that appear on hover, so a phone can reach them.
 *
 * Every change here goes through the same governed path the agent's do
 * (lib/services/tableLifecycle via /api/database/schema/*), so dropping a
 * column is a change History can undo, rows included (decision 8).
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, ChevronDown, ChevronRight, Code2, Copy, Pencil, Plus, Trash2, X } from 'lucide-react'
import { IconButton, KitButton, KitCheckbox, KitConfirmDialog, KitField, KitInput, KitModal, KitNote, KitSelect, OverflowMenu } from '@/components/inspector/kit'
import { EmptyLine, Fact, Facts, Panel, Row as ListRow, RowList, RowSkeleton, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { FOCUS } from '@/components/console/tokens'
import { addColumn, addConstraint, dropColumn, renameColumn, type IndexInfo, type RelationshipInfo, type TableInfo } from '@/lib/api/database'
import { isForeignKeyShaped, suggestForeignKeyColumn } from '@/lib/db/fk-shape'
import { isReservedColumn, type Column } from './values'

const TYPES: Array<{ value: string; label: string }> = [
  { value: 'text', label: 'text: words' },
  { value: 'int', label: 'int: a whole number' },
  { value: 'bigint', label: 'bigint: a large whole number' },
  { value: 'numeric', label: 'numeric: a decimal' },
  { value: 'boolean', label: 'boolean: true or false' },
  { value: 'timestamp', label: 'timestamp: a date and time' },
  { value: 'uuid', label: 'uuid: an identifier' },
  { value: 'jsonb', label: 'jsonb: structured JSON' },
]

export function TableStructure({
  projectId,
  table,
  columns,
  indexes,
  relationships,
  tables,
  loading,
  failed,
  onRetry,
  canWrite,
  windowDays,
  onChanged,
}: {
  projectId: string
  table: string
  columns: readonly Column[]
  indexes: readonly IndexInfo[]
  relationships: readonly RelationshipInfo[]
  tables: readonly TableInfo[]
  loading: boolean
  failed: boolean
  onRetry: () => void
  canWrite: boolean
  /** How long History keeps a change it can undo; null while unknown. */
  windowDays: number | null
  /** The table changed: read its structure and rows again. */
  onChanged: () => Promise<void> | void
}) {
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [toDrop, setToDrop] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ column: string; text: string } | null>(null)

  // "references movies.id": what a foreign key points at, from the catalog.
  const references = (col: string) => {
    const rel = relationships.find((r) => r.to.table === table && r.to.column === col)
    return rel ? `${rel.from.table}.${rel.from.column}` : null
  }

  const rename = async () => {
    const from = renaming
    const to = newName.trim()
    if (!from || !to || to === from) {
      setRenaming(null)
      return
    }
    setBusy(`rename:${from}`)
    setRefused(null)
    try {
      await renameColumn(projectId, table, from, to)
      setRenaming(null)
      await onChanged()
    } catch (err) {
      setRefused({ column: from, text: err instanceof Error ? err.message : 'The column was not renamed.' })
    } finally {
      setBusy(null)
    }
  }

  const drop = async () => {
    if (!toDrop) return
    const col = toDrop
    setBusy(`drop:${col}`)
    setRefused(null)
    try {
      await dropColumn(projectId, table, col)
      setToDrop(null)
      await onChanged()
    } catch (err) {
      setToDrop(null)
      setRefused({ column: col, text: err instanceof Error ? err.message : 'The column was not dropped.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-[880px] space-y-[32px] px-[16px] py-[24px] sm:px-[24px]">
        <Section
          id="structure-columns"
          title="Columns"
          count={columns.length}
          aside={
            canWrite && !failed ? (
              <KitButton size="sm" icon={Plus} onClick={() => setAdding(true)}>
                Add column
              </KitButton>
            ) : undefined
          }
        >
          <Panel>
            {failed ? (
              <ErrorRow things="the columns" onRetry={onRetry} />
            ) : loading && columns.length === 0 ? (
              <RowSkeleton rows={4} lead="none" />
            ) : columns.length === 0 ? (
              <EmptyLine>This table has no columns.</EmptyLine>
            ) : (
              <RowList>
                {columns.map((c) => {
                  const managed = isReservedColumn(c.name)
                  const ref = references(c.name)
                  const words = [c.primary ? 'primary key' : null, c.unique && !c.primary ? 'unique' : null, ref ? `references ${ref}` : c.foreign ? 'foreign key' : null, c.indexed && !c.primary ? 'indexed' : null].filter(Boolean) as string[]
                  return (
                    <ListRow
                      key={c.name}
                      lead="none"
                      className="!py-[11px]"
                      title={
                        renaming === c.name ? (
                          <span className="flex items-center gap-[6px]">
                            <KitInput
                              autoFocus
                              aria-label={`New name for ${c.name}`}
                              value={newName}
                              onChange={(e) => setNewName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void rename()
                                if (e.key === 'Escape') {
                                  e.stopPropagation()
                                  setRenaming(null)
                                }
                              }}
                              disabled={busy !== null}
                              className="!h-[30px] w-[220px] max-w-full font-mono sm:!text-[12.5px]"
                            />
                            <IconButton icon={Check} label="Save the new name" onClick={() => void rename()} disabled={busy !== null || !newName.trim()} />
                            <IconButton icon={X} label="Keep the old name" onClick={() => setRenaming(null)} disabled={busy !== null} />
                          </span>
                        ) : (
                          <span className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[2px]">
                            <span className={`${ROW_TITLE} font-mono !text-[12.5px]`}>{c.name}</span>
                            <span className="font-mono text-[12px] text-zinc-400">{c.type}</span>
                          </span>
                        )
                      }
                      actions={
                        managed ? (
                          <span className="text-[12px] text-faint" title="Managed by Backenly. It cannot be renamed or dropped.">
                            Managed
                          </span>
                        ) : canWrite && renaming !== c.name ? (
                          <OverflowMenu
                            label={`Actions for column ${c.name}`}
                            items={[
                              {
                                label: 'Rename',
                                icon: Pencil,
                                onClick: () => {
                                  setRefused(null)
                                  setNewName(c.name)
                                  setRenaming(c.name)
                                },
                              },
                              { separator: true },
                              { label: 'Drop column…', icon: Trash2, danger: true, onClick: () => setToDrop(c.name) },
                            ]}
                          />
                        ) : undefined
                      }
                    >
                      <Facts className="!mt-[4px]">
                        <Fact>{c.nullable ? 'Nullable' : 'Required'}</Fact>
                        {c.default && (
                          <Fact>
                            Default <code className="font-mono text-[11.5px] text-zinc-400">{c.default}</code>
                          </Fact>
                        )}
                        {words.map((w) => (
                          <Fact key={w}>{w}</Fact>
                        ))}
                      </Facts>
                      {refused?.column === c.name && <RefusedLine className="mt-[6px]">{refused.text}</RefusedLine>}
                    </ListRow>
                  )
                })}
              </RowList>
            )}
          </Panel>
        </Section>

        {indexes.length > 0 && (
          <Section id="structure-indexes" title="Indexes" count={indexes.length}>
            <Panel>
              <RowList>
                {indexes.map((ix) => (
                  <ListRow
                    key={ix.name}
                    lead="none"
                    className="!py-[11px]"
                    title={<span className={`${ROW_TITLE} font-mono !text-[12.5px]`}>{ix.name}</span>}
                  >
                    <Facts className="!mt-[4px]">
                      <Fact>
                        <code className="font-mono text-[11.5px] text-zinc-400">{ix.columns.join(', ')}</code>
                      </Fact>
                      <Fact>{ix.unique ? 'Unique' : 'Index'}</Fact>
                    </Facts>
                  </ListRow>
                ))}
              </RowList>
            </Panel>
          </Section>
        )}

        <WhenRowsChange projectId={projectId} table={table} />

        <TableEndpointsSection projectId={projectId} table={table} columns={columns} />
      </div>

      {adding && (
        <AddColumnDialog
          projectId={projectId}
          table={table}
          tables={tables}
          onClose={() => setAdding(false)}
          onAdded={async () => {
            await onChanged()
          }}
        />
      )}

      <KitConfirmDialog
        open={!!toDrop}
        onCancel={() => busy === null && setToDrop(null)}
        onConfirm={() => void drop()}
        title={
          <>
            Drop column <span className="font-mono text-[14px]">{toDrop}</span>?
          </>
        }
        description={
          <>
            Its values go from <span className="font-mono text-zinc-200">{table}</span>, and the REST API stops returning it.
          </>
        }
        undoable={{ days: windowDays, detail: 'rows included' }}
        confirmLabel="Drop column"
        danger
        busy={busy?.startsWith('drop:')}
      />
    </div>
  )
}

// ─── When rows change ────────────────────────────────────────────────────────

interface Wired {
  functions: Array<{ name: string; trigger: string }>
  endpoints: Array<{ id: string; event: string; host: string }>
  realtime: boolean
}

const EVENT_WORDS: Record<string, string> = {
  on_db_insert: 'On insert',
  on_db_update: 'On update',
  on_db_delete: 'On delete',
  'row.inserted': 'On insert',
  'row.updated': 'On update',
  'row.deleted': 'On delete',
}

/**
 * What runs when this table's rows change: functions triggered by it, webhook
 * endpoints that receive its row events, and whether Realtime streams it.
 * Read-only, with links to where each is changed; hidden when nothing is wired.
 */
function WhenRowsChange({ projectId, table }: { projectId: string; table: string }) {
  const [wired, setWired] = useState<Wired | null>(null)
  useEffect(() => {
    let cancelled = false
    const read = async (path: string) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/${path}`, { credentials: 'include' })
        return res.ok ? await res.json() : null
      } catch {
        return null
      }
    }
    void Promise.all([read('ai-functions'), read('webhooks'), read('realtime-status')]).then(([fns, hooks, rt]) => {
      if (cancelled) return
      const functions = ((fns?.functions ?? []) as Array<{ name?: string; triggerType?: string; triggerTable?: string | null; status?: string }>)
        .filter((f) => f.name && f.triggerTable === table && /^on_db_/.test(f.triggerType ?? '') && f.status !== 'inactive')
        .map((f) => ({ name: f.name as string, trigger: f.triggerType as string }))
      const endpoints = ((hooks?.webhooks ?? []) as Array<{ id: string; eventType: string; targetUrl: string; active?: boolean; tables?: string[] }>)
        .filter((w) => w.active !== false && /^row\./.test(w.eventType) && (!w.tables || w.tables.length === 0 || w.tables.includes(table)))
        .map((w) => {
          let host = w.targetUrl
          try {
            host = new URL(w.targetUrl).host
          } catch {
            /* the address as stored */
          }
          return { id: w.id, event: w.eventType, host }
        })
      const realtime = Array.isArray(rt?.triggeredTables) && rt.triggeredTables.includes(table)
      setWired({ functions, endpoints, realtime })
    })
    return () => {
      cancelled = true
    }
  }, [projectId, table])

  if (!wired || (wired.functions.length === 0 && wired.endpoints.length === 0 && !wired.realtime)) return null
  const base = `/app/projects/${projectId}`
  const link = `rounded-[3px] text-zinc-100 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:decoration-white/60 ${FOCUS}`
  return (
    <Section id="structure-wired" title="When rows change">
      <Panel>
        <RowList>
          {wired.functions.map((f) => (
            <ListRow
              key={`fn-${f.name}`}
              lead="none"
              className="!py-[11px]"
              title={
                <Link href={`${base}/functions?fn=${encodeURIComponent(f.name)}`} className={`${link} font-mono text-[12.5px]`}>
                  {f.name}
                </Link>
              }
            >
              <Facts className="!mt-[4px]">
                <Fact>Function</Fact>
                <Fact>{EVENT_WORDS[f.trigger] ?? f.trigger}</Fact>
              </Facts>
            </ListRow>
          ))}
          {wired.endpoints.map((w) => (
            <ListRow
              key={`wh-${w.id}`}
              lead="none"
              className="!py-[11px]"
              title={
                <Link href={`${base}/webhooks?endpoint=${encodeURIComponent(w.id)}`} className={`${link} text-[13px]`}>
                  {w.host}
                </Link>
              }
            >
              <Facts className="!mt-[4px]">
                <Fact>Webhook</Fact>
                <Fact>{EVENT_WORDS[w.event] ?? w.event}</Fact>
              </Facts>
            </ListRow>
          ))}
          {wired.realtime && (
            <ListRow
              lead="none"
              className="!py-[11px]"
              title={
                <Link href={`${base}/realtime`} className={`${link} text-[13px]`}>
                  Realtime
                </Link>
              }
            >
              <Facts className="!mt-[4px]">
                <Fact>Streams every insert, update and delete</Fact>
              </Facts>
            </ListRow>
          )}
        </RowList>
      </Panel>
    </Section>
  )
}

// ─── Add column ──────────────────────────────────────────────────────────────

function AddColumnDialog({
  projectId,
  table,
  tables,
  onClose,
  onAdded,
}: {
  projectId: string
  table: string
  tables: readonly TableInfo[]
  onClose: () => void
  onAdded: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState('text')
  const [nullable, setNullable] = useState(true)
  const [unique, setUnique] = useState(false)
  const [references, setReferences] = useState('')
  const [check, setCheck] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Which constraints applied: the column can be added while a constraint
  // fails (a foreign key over rows that do not match), and "added" alone would
  // leave the schema weaker than the person believes.
  const [outcome, setOutcome] = useState<string[] | null>(null)
  const fkBlocked = !!references && !isForeignKeyShaped(name)

  const submit = async () => {
    const column = name.trim()
    if (!column) return
    setBusy(true)
    setError(null)
    setOutcome(null)
    try {
      await addColumn(projectId, table, { name: column, type, nullable })
      const asked: Array<{ label: string; run: () => Promise<void> }> = []
      if (unique) asked.push({ label: 'unique', run: () => addConstraint(projectId, table, column, 'unique') })
      // The table is passed as referencedTable, never inferred from the name.
      if (references) asked.push({ label: `foreign key to ${references}`, run: () => addConstraint(projectId, table, column, 'foreign_key', undefined, references) })
      if (check.trim()) asked.push({ label: 'check', run: () => addConstraint(projectId, table, column, 'check', check.trim()) })
      const failures: string[] = []
      for (const c of asked) {
        try {
          await c.run()
        } catch (err) {
          failures.push(`${c.label}: ${err instanceof Error ? err.message : 'failed'}`)
        }
      }
      await onAdded()
      if (failures.length > 0) {
        setOutcome([`${column} was added, but ${failures.length} of ${asked.length} constraints did not apply.`, ...failures])
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The column was not added.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KitModal
      open
      onClose={() => !busy && onClose()}
      title="Add column"
      description={<span className="font-mono text-[12.5px]">{table}</span>}
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose} disabled={busy}>
            {outcome ? 'Close' : 'Cancel'}
          </KitButton>
          {!outcome && (
            <KitButton variant="primary" onClick={() => void submit()} loading={busy} disabled={!name.trim() || fkBlocked}>
              Add column
            </KitButton>
          )}
        </>
      }
    >
      <div className="space-y-[16px]">
        <KitField label="Name" hint="Letters, numbers and underscores, starting with a letter or an underscore.">
          <KitInput value={name} onChange={(e) => setName(e.target.value)} placeholder="price_cents" disabled={busy} spellCheck={false} className="font-mono" />
        </KitField>
        <KitField label="Type">
          <KitSelect value={type} onChange={(e) => setType(e.target.value)} disabled={busy}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </KitSelect>
        </KitField>
        <KitCheckbox checked={nullable} onChange={setNullable} label="Nullable" description="Rows may leave it empty." disabled={busy} />
        <KitCheckbox checked={unique} onChange={setUnique} label="Unique" description="No two rows may hold the same value." disabled={busy} />
        <div>
          <KitField label="References" hint="Points this column at another table's key.">
            <KitSelect value={references} onChange={(e) => setReferences(e.target.value)} disabled={busy}>
              <option value="">No foreign key</option>
              {tables
                .filter((t) => t.name !== table)
                .map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
            </KitSelect>
          </KitField>
          {fkBlocked && (
            <p className="mt-[6px] text-[12.5px] leading-[18px] text-zinc-50">
              A foreign key needs a column named like <span className="font-mono">{suggestForeignKeyColumn(references)}</span>, or it is refused.
            </p>
          )}
        </div>
        <KitField label="Check" hint="A condition every row must meet. The server checks it.">
          <KitInput value={check} onChange={(e) => setCheck(e.target.value)} placeholder="price_cents > 0" disabled={busy} spellCheck={false} className="font-mono" />
        </KitField>
        {outcome && (
          <KitNote tone="warn" title={outcome[0]}>
            <ul className="space-y-[2px]">
              {outcome.slice(1).map((line) => (
                <li key={line} className="font-mono text-[12px]">
                  {line}
                </li>
              ))}
            </ul>
          </KitNote>
        )}
        {error && <RefusedLine>{error}</RefusedLine>}
      </div>
    </KitModal>
  )
}

// ─── REST Endpoints & Schema Models ──────────────────────────────────────────

function mapColumnToTsType(col: Column): string {
  const t = col.type.toLowerCase()
  if (t.includes('int') || t.includes('numeric') || t.includes('float') || t.includes('double') || t.includes('decimal')) return 'number'
  if (t.includes('bool')) return 'boolean'
  if (t.includes('json')) return 'Record<string, unknown>'
  if (t.includes('time') || t.includes('date')) return 'string /* ISO 8601 */'
  if (t.includes('uuid')) return 'string /* UUID */'
  return 'string'
}

function generateTsInterface(name: string, columns: readonly Column[], forInput = false): string {
  const filtered = forInput ? columns.filter((c) => !isReservedColumn(c.name) && c.name !== 'id') : columns
  const fields = filtered.map((c) => {
    const tsType = mapColumnToTsType(c)
    const optional = forInput && (c.nullable || c.default !== null) ? '?' : ''
    return `  ${c.name}${optional}: ${tsType}`
  })
  return `interface ${name} {\n${fields.join('\n')}\n}`
}

function TableEndpointsSection({ projectId, table, columns }: { projectId: string; table: string; columns: readonly Column[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const base = `/api/v1/${projectId}/db/${encodeURIComponent(table)}`
  const modelName = table.charAt(0).toUpperCase() + table.slice(1).replace(/s$/, '')

  const endpoints = [
    {
      id: 'list',
      method: 'GET',
      badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      path: base,
      title: 'List records',
      desc: 'Filter with ?field=eq.value, sort with ?order=field.desc, paginate with ?limit=N&offset=N',
      reqModel: null,
      resModel: `{\n  "data": Array<${modelName}>,\n  "count": number\n}`,
      curl: `curl -X GET "https://backenly.com${base}?limit=20" \\\n  -H "apikey: <PROJECT_API_KEY>"`,
    },
    {
      id: 'create',
      method: 'POST',
      badgeClass: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
      path: base,
      title: 'Create record',
      desc: 'Insert a new record into the table and return the created row',
      reqModel: generateTsInterface(`${modelName}Input`, columns, true),
      resModel: `{\n  "data": ${modelName}\n}`,
      curl: `curl -X POST "https://backenly.com${base}" \\\n  -H "apikey: <PROJECT_API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"..."}'`,
    },
    {
      id: 'read',
      method: 'GET',
      badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      path: `${base}/:id`,
      title: 'Get single record',
      desc: 'Retrieve a single record by its primary key',
      reqModel: null,
      resModel: `{\n  "data": ${modelName}\n}`,
      curl: `curl -X GET "https://backenly.com${base}/<ROW_ID>" \\\n  -H "apikey: <PROJECT_API_KEY>"`,
    },
    {
      id: 'update',
      method: 'PATCH',
      badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      path: `${base}/:id`,
      title: 'Update record',
      desc: 'Partially update columns on an existing record',
      reqModel: `Partial<${modelName}Input>`,
      resModel: `{\n  "data": ${modelName}\n}`,
      curl: `curl -X PATCH "https://backenly.com${base}/<ROW_ID>" \\\n  -H "apikey: <PROJECT_API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"..."}'`,
    },
    {
      id: 'delete',
      method: 'DELETE',
      badgeClass: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
      path: `${base}/:id`,
      title: 'Delete record',
      desc: 'Permanently remove a record from the table',
      reqModel: null,
      resModel: `{\n  "success": true\n}`,
      curl: `curl -X DELETE "https://backenly.com${base}/<ROW_ID>" \\\n  -H "apikey: <PROJECT_API_KEY>"`,
    },
  ]

  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {})

  return (
    <Section id="structure-endpoints" title="REST Endpoints & Models" count={endpoints.length}>
      <Panel>
        <div className="divide-y divide-white/[0.06]">
          {endpoints.map((ep) => {
            const isOpen = expanded === ep.id
            return (
              <div key={ep.id} className="p-[14px] sm:p-[16px]">
                <div className="flex flex-wrap items-center justify-between gap-[10px]">
                  <div className="flex items-center gap-[10px]">
                    <span className={`inline-flex items-center justify-center rounded px-[6px] py-[2px] font-mono text-[11px] font-bold border ${ep.badgeClass}`}>
                      {ep.method}
                    </span>
                    <span className="font-mono text-[12.5px] text-zinc-200">{ep.path}</span>
                  </div>
                  <div className="flex items-center gap-[8px]">
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : ep.id)}
                      className={`inline-flex items-center gap-[5px] text-[12px] text-zinc-400 hover:text-zinc-200 ${FOCUS}`}
                    >
                      <Code2 className="h-[13px] w-[13px]" />
                      <span>{isOpen ? 'Hide Models' : 'Models & Schema'}</span>
                      {isOpen ? <ChevronDown className="h-[13px] w-[13px]" /> : <ChevronRight className="h-[13px] w-[13px]" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => copy(ep.curl)}
                      title="Copy curl command"
                      className={`inline-flex items-center gap-[4px] rounded px-[6px] py-[3px] text-[11.5px] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200 ${FOCUS}`}
                    >
                      <Copy className="h-[12px] w-[12px]" />
                      <span>cURL</span>
                    </button>
                  </div>
                </div>
                <p className="mt-[4px] text-[12px] text-zinc-400">{ep.desc}</p>
                {isOpen && (
                  <div className="mt-[12px] grid grid-cols-1 gap-[12px] sm:grid-cols-2">
                    {ep.reqModel && (
                      <div className="rounded-[4px] border border-white/[0.08] bg-black/40 p-[10px]">
                        <p className="mb-[6px] text-[11px] font-medium uppercase tracking-wider text-zinc-400">Request Body Schema</p>
                        <pre className="font-mono text-[11.5px] leading-[17px] text-zinc-300 overflow-x-auto">{ep.reqModel}</pre>
                      </div>
                    )}
                    <div className="rounded-[4px] border border-white/[0.08] bg-black/40 p-[10px]">
                      <p className="mb-[6px] text-[11px] font-medium uppercase tracking-wider text-zinc-400">Response Envelope</p>
                      <pre className="font-mono text-[11.5px] leading-[17px] text-zinc-300 overflow-x-auto">{ep.resModel}</pre>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </Panel>
    </Section>
  )
}
