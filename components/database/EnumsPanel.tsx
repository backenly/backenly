'use client'

/**
 * ENUM TYPES AND DOMAINS
 *
 * Every type lists the columns using it. That turns "drop this type" from a
 * button into a decision, and it is why dropping is refused while anything
 * uses it rather than offered with CASCADE: CASCADE would drop those columns,
 * which is data.
 *
 * PostgreSQL has no `ALTER TYPE … DROP VALUE` at any version, so removing an
 * enum value is not offered; the Add value dialog says so where it matters.
 *
 * Sections above one panel each, rows inside (the console's document rule).
 * A failed read is an error row, never "no enums yet".
 */

import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { KitButton, KitCheckbox, KitConfirmDialog, KitField, KitInput, KitModal, KitSelect, KitTextarea, OverflowMenu } from '@/components/inspector/kit'
import { EmptyLine, Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'

interface EnumType {
  name: string
  values: string[]
  usedBy: string[]
}
interface DomainType {
  name: string
  baseType: string
  notNull: boolean
  default: string | null
  constraints: string[]
  usedBy: string[]
}

export function EnumsPanel({ projectId, canWrite = false, canAdminister = false }: { projectId: string; canWrite?: boolean; canAdminister?: boolean }) {
  const [enums, setEnums] = useState<EnumType[]>([])
  const [domains, setDomains] = useState<DomainType[]>([])
  const [baseTypes, setBaseTypes] = useState<string[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [notice, setNotice] = useState<{ tone: 'done' | 'refused'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [creatingEnum, setCreatingEnum] = useState(false)
  const [creatingDomain, setCreatingDomain] = useState(false)
  const [addingTo, setAddingTo] = useState<EnumType | null>(null)
  const [toDrop, setToDrop] = useState<{ name: string; usedBy: string[] } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/database/types`, { credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error)
      setEnums(data.enums ?? [])
      setDomains(data.domains ?? [])
      setBaseTypes(data.baseTypes ?? [])
      setState('ready')
    } catch {
      setState('failed')
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  /** Runs one change; the server's words when it refuses. True when it applied. */
  async function act(body: Record<string, unknown>, done: string): Promise<boolean> {
    setNotice(null)
    const res = await fetch(`/api/projects/${projectId}/database/types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? 'That change was refused.')
    setEnums(data.enums ?? enums)
    setDomains(data.domains ?? domains)
    setNotice({ tone: 'done', text: done })
    return true
  }

  async function drop(name: string) {
    setBusy(name)
    setNotice(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/database/types?name=${encodeURIComponent(name)}`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'The type was not dropped.')
      setEnums(data.enums ?? [])
      setDomains(data.domains ?? [])
      setNotice({ tone: 'done', text: `${name} dropped.` })
    } catch (err) {
      setNotice({ tone: 'refused', text: err instanceof Error ? err.message : 'The type was not dropped.' })
    } finally {
      setBusy(null)
      setToDrop(null)
    }
  }

  const usedBy = (list: string[]) =>
    list.length === 0 ? (
      <Fact>Not used</Fact>
    ) : (
      <Fact>
        Used by <code className="font-mono text-[11.5px] text-zinc-400">{list.join(', ')}</code>
      </Fact>
    )
  const dropItem = (name: string, users: string[]) =>
    canAdminister ? <OverflowMenu label={`Actions for ${name}`} items={[{ label: 'Drop…', icon: Trash2, danger: true, onClick: () => setToDrop({ name, usedBy: users }) }]} /> : null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-[880px] space-y-[32px] px-[16px] py-[24px] sm:px-[24px]">
        {notice &&
          (notice.tone === 'refused' ? (
            <RefusedLine>{notice.text}</RefusedLine>
          ) : (
            <p role="status" className="text-[12.5px] leading-[18px] text-zinc-300">
              {notice.text}
            </p>
          ))}

        {state === 'failed' ? (
          <Section id="types-error" title="Types">
            <Panel>
              <ErrorRow things="types" onRetry={() => void load()} />
            </Panel>
          </Section>
        ) : (
          <>
            <Section
              id="types-enums"
              title="Enums"
              count={enums.length}
              aside={canWrite ? <KitButton size="sm" icon={Plus} onClick={() => setCreatingEnum(true)} disabled={state !== 'ready'}>New enum</KitButton> : undefined}
            >
              <Panel>
                {state === 'loading' ? (
                  <RowSkeleton rows={2} lead="none" />
                ) : enums.length === 0 ? (
                  <EmptyLine>No enums yet. An enum fixes a column to a set of values, like an order status.</EmptyLine>
                ) : (
                  <RowList>
                    {enums.map((t) => (
                      <Row
                        key={t.name}
                        lead="none"
                        title={<span className={`${ROW_TITLE} font-mono !text-[12.5px]`}>{t.name}</span>}
                        actions={
                          canWrite || canAdminister ? (
                            <>
                              {canWrite && (
                                <KitButton size="sm" variant="ghost" icon={Plus} disabled={busy !== null} onClick={() => setAddingTo(t)}>
                                  Add value
                                </KitButton>
                              )}
                              {dropItem(t.name, t.usedBy)}
                            </>
                          ) : undefined
                        }
                      >
                        <p className="mt-[4px] font-mono text-[12px] leading-[18px] text-zinc-300 [overflow-wrap:anywhere]">{t.values.join(', ')}</p>
                        <Facts className="!mt-[6px]">{usedBy(t.usedBy)}</Facts>
                      </Row>
                    ))}
                  </RowList>
                )}
              </Panel>
            </Section>

            <Section
              id="types-domains"
              title="Domains"
              count={domains.length}
              aside={canWrite ? <KitButton size="sm" icon={Plus} onClick={() => setCreatingDomain(true)} disabled={state !== 'ready'}>New domain</KitButton> : undefined}
            >
              <Panel>
                {state === 'loading' ? (
                  <RowSkeleton rows={1} lead="none" />
                ) : domains.length === 0 ? (
                  <EmptyLine>No domains yet. A domain is a base type with a rule, like an email that must contain an @.</EmptyLine>
                ) : (
                  <RowList>
                    {domains.map((d) => (
                      <Row
                        key={d.name}
                        lead="none"
                        title={
                          <span className="flex flex-wrap items-baseline gap-x-[10px]">
                            <span className={`${ROW_TITLE} font-mono !text-[12.5px]`}>{d.name}</span>
                            <span className="font-mono text-[12px] text-zinc-400">{d.baseType}</span>
                          </span>
                        }
                        actions={dropItem(d.name, d.usedBy) ?? undefined}
                      >
                        {d.constraints.length > 0 && <p className="mt-[4px] font-mono text-[12px] leading-[18px] text-zinc-300 [overflow-wrap:anywhere]">{d.constraints.join(' ')}</p>}
                        <Facts className="!mt-[6px]">
                          {d.notNull && <Fact>Required</Fact>}
                          {usedBy(d.usedBy)}
                        </Facts>
                      </Row>
                    ))}
                  </RowList>
                )}
              </Panel>
            </Section>
          </>
        )}
      </div>

      {creatingEnum && (
        <EnumForm
          onClose={() => setCreatingEnum(false)}
          onSubmit={async (name, values) => {
            if (await act({ action: 'create_enum', name, values }, `${name} created.`)) setCreatingEnum(false)
          }}
        />
      )}
      {addingTo && (
        <AddValueForm
          enumName={addingTo.name}
          existing={addingTo.values}
          onClose={() => setAddingTo(null)}
          onSubmit={async (value) => {
            if (await act({ action: 'add_enum_value', name: addingTo.name, value }, `${value} added to ${addingTo.name}.`)) setAddingTo(null)
          }}
        />
      )}
      {creatingDomain && (
        <DomainForm
          baseTypes={baseTypes}
          onClose={() => setCreatingDomain(false)}
          onSubmit={async (spec) => {
            if (await act({ action: 'create_domain', ...spec }, `${spec.name} created.`)) setCreatingDomain(false)
          }}
        />
      )}

      <KitConfirmDialog
        open={!!toDrop}
        danger
        busy={busy !== null}
        title={
          <>
            Drop <span className="font-mono text-[14px]">{toDrop?.name}</span>?
          </>
        }
        description={
          !toDrop
            ? undefined
            : toDrop.usedBy.length > 0
              ? `${toDrop.usedBy.join(', ')} still ${toDrop.usedBy.length === 1 ? 'uses' : 'use'} it, so dropping it is refused: those columns would go with it. Change them first.`
              : 'Nothing uses it, so no data changes.'
        }
        undoable={toDrop && toDrop.usedBy.length === 0 ? false : undefined}
        confirmLabel="Drop"
        onConfirm={() => toDrop && void drop(toDrop.name)}
        onCancel={() => busy === null && setToDrop(null)}
      />
    </div>
  )
}

/** A dialog that shows the server's refusal under its fields and stays open. */
function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change was refused.')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, submit }
}

function Footer({ onClose, onSubmit, busy, disabled, label }: { onClose: () => void; onSubmit: () => void; busy: boolean; disabled: boolean; label: string }) {
  return (
    <>
      <KitButton variant="ghost" onClick={onClose} disabled={busy}>
        Cancel
      </KitButton>
      <KitButton variant="primary" loading={busy} disabled={disabled} onClick={onSubmit}>
        {label}
      </KitButton>
    </>
  )
}

function EnumForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (name: string, values: string[]) => Promise<void> }) {
  const [name, setName] = useState('')
  const [raw, setRaw] = useState('')
  const { busy, error, submit } = useSubmit()
  const values = raw.split('\n').map((v) => v.trim()).filter(Boolean)
  return (
    <KitModal
      open
      title="New enum"
      description="A fixed set of values a column may hold."
      onClose={onClose}
      footer={<Footer onClose={onClose} busy={busy} disabled={!name.trim() || values.length === 0} label="Create" onSubmit={() => void submit(() => onSubmit(name.trim(), values))} />}
    >
      <div className="space-y-[16px]">
        <KitField label="Name" hint="Lower case letters, digits and underscores.">
          <KitInput value={name} onChange={(e) => setName(e.target.value)} placeholder="order_status" spellCheck={false} className="font-mono" />
        </KitField>
        <KitField label="Values" hint="One per line, in the order PostgreSQL sorts them.">
          <KitTextarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={5} placeholder={'draft\npublished\narchived'} spellCheck={false} className="font-mono sm:text-[12.5px]" />
        </KitField>
        {error && <RefusedLine>{error}</RefusedLine>}
      </div>
    </KitModal>
  )
}

function AddValueForm({ enumName, existing, onClose, onSubmit }: { enumName: string; existing: string[]; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
  const [value, setValue] = useState('')
  const { busy, error, submit } = useSubmit()
  return (
    <KitModal
      open
      title={
        <>
          Add a value to <span className="font-mono text-[14px]">{enumName}</span>
        </>
      }
      // The safe change, and the rule an operator must know: values can be added, never removed.
      description="It goes at the end and no row changes. A value can't be removed later: PostgreSQL has no way to drop one."
      onClose={onClose}
      footer={<Footer onClose={onClose} busy={busy} disabled={!value.trim()} label="Add" onSubmit={() => void submit(() => onSubmit(value.trim()))} />}
    >
      <div className="space-y-[16px]">
        <KitField label="Value" hint={`Now: ${existing.join(', ')}`}>
          <KitInput value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} className="font-mono" />
        </KitField>
        {error && <RefusedLine>{error}</RefusedLine>}
      </div>
    </KitModal>
  )
}

function DomainForm({
  baseTypes,
  onClose,
  onSubmit,
}: {
  baseTypes: string[]
  onClose: () => void
  onSubmit: (spec: { name: string; baseType: string; notNull: boolean; check: string | null }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [baseType, setBaseType] = useState(baseTypes[0] ?? 'text')
  const [notNull, setNotNull] = useState(false)
  const [check, setCheck] = useState('')
  const { busy, error, submit } = useSubmit()
  return (
    <KitModal
      open
      title="New domain"
      description="A base type with a rule, reusable across columns."
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          busy={busy}
          disabled={!name.trim()}
          label="Create"
          onSubmit={() => void submit(() => onSubmit({ name: name.trim(), baseType, notNull, check: check.trim() || null }))}
        />
      }
    >
      <div className="space-y-[16px]">
        <KitField label="Name">
          <KitInput value={name} onChange={(e) => setName(e.target.value)} placeholder="email_address" spellCheck={false} className="font-mono" />
        </KitField>
        <KitField label="Base type">
          <KitSelect value={baseType} onChange={(e) => setBaseType(e.target.value)}>
            {(baseTypes.length ? baseTypes : ['text']).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </KitSelect>
        </KitField>
        <KitCheckbox checked={notNull} onChange={setNotNull} label="Required" description="NOT NULL: a column of this type may not be empty." />
        <KitField label="Check" hint="Refers to VALUE, the value being checked.">
          <KitInput value={check} onChange={(e) => setCheck(e.target.value)} placeholder="VALUE ~ '^[^@]+@[^@]+$'" spellCheck={false} className="font-mono" />
        </KitField>
        {error && <RefusedLine>{error}</RefusedLine>}
      </div>
    </KitModal>
  )
}
