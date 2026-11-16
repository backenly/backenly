'use client'

/**
 * One row of a table, opened beside the grid you keep scanning (project
 * decision 6), and the same drawer for a new row. Each column is a field typed
 * to the column; the key and Backenly's managed columns are read-only, and a
 * column the route withholds (a password hash) says Hidden and is never sent.
 *
 * Deleting a row asks in place, because a row's delete is final: row writes do
 * not go through the change history (decision 8).
 */

import { useState, type ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { CopyField, KitButton, KitInput, KitTextarea, Segmented } from '@/components/inspector/kit'
import { RecordDrawer } from '@/components/console/RecordDrawer'
import { RefusedLine } from '@/components/console/states'
import { undoSentence } from '@/components/console/undo'
import {
  fillsItself,
  formText,
  isBoolType,
  isDateType,
  isJsonType,
  isNumericType,
  isReservedColumn,
  rowKey,
  toColumnValue,
  type Column,
  type Row,
} from './values'

export interface RowDrawerProps {
  mode: 'edit' | 'insert' | null
  table: string
  columns: readonly Column[]
  /** The row being read or changed (edit). */
  row: Row | null
  keyName: string
  /** Columns the route withholds (redactedColumns). */
  redacted: readonly string[]
  canWrite: boolean
  onClose: () => void
  onPrev?: (() => void) | null
  onNext?: (() => void) | null
  position?: { index: number; total: number }
  /** Saves the changed fields; throws an Error in the server's words. */
  onSave: (changes: Record<string, unknown>) => Promise<void>
  onInsert: (values: Record<string, unknown>) => Promise<void>
  onDelete: () => Promise<void>
  /** Bumped after a save, so the form reads the saved row again. */
  revision?: number
}

export function RowDrawer({
  mode,
  table,
  columns,
  row,
  keyName,
  redacted,
  canWrite,
  onClose,
  onPrev,
  onNext,
  position,
  onSave,
  onInsert,
  onDelete,
  revision = 0,
}: RowDrawerProps) {
  const id = row ? rowKey(row, keyName) : ''
  const formFor = mode === 'insert' ? '\u0000insert' : mode === 'edit' ? `edit:${id}:${revision}` : ''
  const initial = () => {
    const v: Record<string, string> = {}
    if (mode === 'edit' && row) for (const c of columns) v[c.name] = formText(row[c.name])
    return v
  }
  const [values, setValues] = useState<Record<string, string>>(initial)
  const [seen, setSeen] = useState(formFor)
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  // Another row (or a new one): its own values, no leftover error or question.
  if (seen !== formFor) {
    setSeen(formFor)
    setValues(initial())
    setError(null)
    setConfirming(false)
  }

  const open = mode === 'insert' || (mode === 'edit' && !!row)
  const withheld = new Set(redacted)
  const readOnly = (c: Column) => !canWrite || !!c.primary || isReservedColumn(c.name) || withheld.has(c.name)
  const fields = mode === 'insert' ? columns.filter((c) => !fillsItself(c) && !withheld.has(c.name)) : columns

  const changes = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    if (!row) return out
    for (const c of columns) {
      if (readOnly(c)) continue
      const now = values[c.name] ?? ''
      if (now === formText(row[c.name])) continue
      const v = toColumnValue(c, now)
      if (v !== undefined) out[c.name] = v
    }
    return out
  }
  const dirty = mode === 'edit' && Object.keys(changes()).length > 0

  const run = async (kind: 'save' | 'delete', fn: () => Promise<void>) => {
    setBusy(kind)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : kind === 'delete' ? 'The row was not deleted.' : 'The row was not saved.')
      setConfirming(false)
    } finally {
      setBusy(null)
    }
  }

  const save = () =>
    run('save', async () => {
      if (mode === 'insert') {
        const out: Record<string, unknown> = {}
        for (const c of fields) {
          const raw = values[c.name] ?? ''
          if (raw === '') continue // the database's default, or its refusal in its own words
          const v = toColumnValue(c, raw)
          if (v !== undefined) out[c.name] = v
        }
        await onInsert(out)
        return
      }
      const out = changes()
      if (Object.keys(out).length === 0) return onClose()
      await onSave(out)
    })

  const footer =
    !canWrite || !open ? null : confirming ? (
      <>
        <p className="mr-auto min-w-0 text-[13px] leading-[20px] text-zinc-200">
          Delete this row? <span className="text-zinc-400">{undoSentence(false)}</span>
        </p>
        <KitButton variant="ghost" onClick={() => setConfirming(false)} disabled={busy !== null}>
          Keep
        </KitButton>
        <KitButton variant="danger" onClick={() => void run('delete', onDelete)} loading={busy === 'delete'}>
          Delete
        </KitButton>
      </>
    ) : (
      <>
        {mode === 'edit' && (
          <KitButton variant="ghost" icon={Trash2} onClick={() => setConfirming(true)} disabled={busy !== null} className="mr-auto hover:!text-rose-200">
            Delete row
          </KitButton>
        )}
        <KitButton variant="ghost" onClick={onClose} disabled={busy !== null}>
          Cancel
        </KitButton>
        <KitButton variant="primary" icon={mode === 'insert' ? Plus : undefined} onClick={() => void save()} loading={busy === 'save'} disabled={mode === 'edit' && !dirty}>
          {mode === 'insert' ? 'Insert row' : 'Save'}
        </KitButton>
      </>
    )

  return (
    <RecordDrawer
      open={open}
      onClose={onClose}
      title={mode === 'insert' ? 'New row' : <span className="font-mono text-[14px]">{id || 'Row'}</span>}
      label={mode === 'insert' ? `New row in ${table}` : `Row ${id}`}
      subtitle={<span className="font-mono text-[12px]">{table}</span>}
      onPrev={mode === 'edit' ? onPrev : undefined}
      onNext={mode === 'edit' ? onNext : undefined}
      position={mode === 'edit' ? position : undefined}
      footer={footer}
    >
      <div className="space-y-[16px]">
        {error && <RefusedLine>{error}</RefusedLine>}
        {fields.map((c) => (
          <Field
            key={c.name}
            column={c}
            hidden={withheld.has(c.name)}
            readOnly={readOnly(c)}
            managed={!!c.primary || isReservedColumn(c.name)}
            insert={mode === 'insert'}
            current={withheld.has(c.name) ? null : formText(row?.[c.name])}
            render={(fieldId) => (
              <Input
                id={fieldId}
                column={c}
                value={values[c.name] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [c.name]: v }))}
                insert={mode === 'insert'}
              />
            )}
          />
        ))}
        {mode === 'insert' && fields.length < columns.length && (
          <p className="text-[12.5px] leading-[18px] text-faint">
            {columns
              .filter((c) => fillsItself(c))
              .map((c) => c.name)
              .join(', ')}{' '}
            {columns.filter((c) => fillsItself(c)).length === 1 ? 'is' : 'are'} filled in by the database.
          </p>
        )}
      </div>
    </RecordDrawer>
  )
}

/** One column: its name and type, then the value or the field that edits it. */
function Field({
  column,
  hidden,
  readOnly,
  managed,
  insert,
  current,
  render,
}: {
  column: Column
  hidden: boolean
  readOnly: boolean
  managed: boolean
  insert: boolean
  /** The value as stored, as text; null when withheld. */
  current: string | null
  render: (id: string) => ReactNode
}) {
  const fieldId = `row-field-${column.name}`
  const editable = insert ? !hidden : !readOnly
  return (
    <div>
      <div className="mb-[6px] flex flex-wrap items-baseline gap-x-[8px] gap-y-[2px]">
        <label htmlFor={editable ? fieldId : undefined} className="font-mono text-[12.5px] font-medium text-zinc-200">
          {column.name}
        </label>
        <span className="font-mono text-[11.5px] text-faint">{column.type}</span>
        {!insert && managed && <span className="text-[12px] text-faint">Managed</span>}
        {!insert && hidden && <span className="text-[12px] text-faint">Withheld, as in SQL</span>}
        {insert && !column.nullable && !column.default && <span className="text-[12px] text-faint">Required</span>}
      </div>
      {editable ? (
        render(fieldId)
      ) : hidden ? (
        <p className="text-[13px] italic leading-[20px] text-faint">Hidden</p>
      ) : current === null || current === '' ? (
        <p className="font-mono text-[12px] italic leading-[20px] text-faint">NULL</p>
      ) : managed ? (
        <CopyField value={current} label={`Copy ${column.name}`} />
      ) : (
        <p className="whitespace-pre-wrap font-mono text-[12px] leading-[19px] text-zinc-300 [overflow-wrap:anywhere]">{current}</p>
      )}
    </div>
  )
}

/** The field for one column, typed to it. */
function Input({ id, column, value, onChange, insert }: { id: string; column: Column; value: string; onChange: (v: string) => void; insert: boolean }) {
  const placeholder = column.default ? `Default: ${column.default}` : column.nullable ? 'NULL' : ''
  if (isBoolType(column.type)) {
    const options = [
      { value: 'true', label: 'true' },
      { value: 'false', label: 'false' },
      ...(column.nullable || insert ? [{ value: '', label: insert && !column.nullable ? 'Default' : 'NULL' }] : []),
    ]
    return <Segmented size="sm" label={column.name} value={value} onChange={onChange} options={options} />
  }
  if (isJsonType(column.type) || value.length > 80 || value.includes('\n')) {
    return (
      <KitTextarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={isJsonType(column.type) ? 5 : 3}
        placeholder={placeholder}
        spellCheck={false}
        className="font-mono sm:text-[12.5px]"
      />
    )
  }
  return (
    <KitInput
      id={id}
      type={isNumericType(column.type) ? 'number' : isDateType(column.type) && insert ? 'datetime-local' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className="font-mono sm:text-[12.5px]"
    />
  )
}
