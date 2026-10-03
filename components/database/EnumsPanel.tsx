'use client'

/**
 * ENUM TYPES AND DOMAINS
 *
 * The last REAL_GAP in Postgres admin. A project could have a status enum
 * created out of band and the dashboard could neither see it nor make one.
 *
 * ── Dependents are shown BEFORE they matter ─────────────────────────────────
 *
 * Every type lists the columns using it. That is what turns "drop this type"
 * from a button into a decision, and it is why dropping is refused while
 * anything uses it rather than offered with CASCADE — CASCADE would drop those
 * columns, which is data.
 *
 * ── Removing an enum value is not offered, and the page says why ────────────
 *
 * PostgreSQL has no `ALTER TYPE ... DROP VALUE` at any version. Emulating it
 * means creating a replacement type, converting every dependent column and
 * dropping the old one — a data-rewriting migration, not a settings change.
 * Saying so is better than an absent control an operator has to guess about,
 * and much better than a button that quietly rewrites their data.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react'
import {
  KitButton, KitNote, KitModal, KitField, KitInput, KitConfirmDialog, Skeleton, Tag,
} from '@/components/inspector/kit'
import { EDGE, RULE, R_PANEL } from '@/components/console/tokens'

interface EnumType { name: string; values: string[]; usedBy: string[] }
interface DomainType {
  name: string
  baseType: string
  notNull: boolean
  default: string | null
  constraints: string[]
  usedBy: string[]
}

export function EnumsPanel({ projectId }: { projectId: string }) {
  const [enums, setEnums] = useState<EnumType[]>([])
  const [domains, setDomains] = useState<DomainType[]>([])
  const [baseTypes, setBaseTypes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'danger' | 'success' | 'warn'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [creatingEnum, setCreatingEnum] = useState(false)
  const [creatingDomain, setCreatingDomain] = useState(false)
  const [addingTo, setAddingTo] = useState<EnumType | null>(null)
  const [confirmDrop, setConfirmDrop] = useState<{ name: string; usedBy: string[] } | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/database/types`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Types could not be loaded.')
      setEnums(data.enums ?? [])
      setDomains(data.domains ?? [])
      setBaseTypes(data.baseTypes ?? [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Types could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  async function act(body: Record<string, unknown>, success: string): Promise<boolean> {
    setMessage(null)
    const res = await fetch(`/api/projects/${projectId}/database/types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      // PostgreSQL's own message where it refused, rather than a paraphrase.
      setMessage({ tone: 'danger', text: data.error ?? 'That did not work.' })
      return false
    }
    setEnums(data.enums ?? [])
    setDomains(data.domains ?? [])
    setMessage({ tone: 'success', text: success })
    return true
  }

  async function drop(name: string) {
    setBusy(name)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/database/types?name=${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      )
      const data = await res.json()
      if (!res.ok) {
        setMessage({ tone: 'danger', text: data.error ?? 'The type could not be dropped.' })
        return
      }
      setEnums(data.enums ?? [])
      setDomains(data.domains ?? [])
      setMessage({ tone: 'success', text: `${name} dropped.` })
    } finally {
      setBusy(null)
      setConfirmDrop(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b ${RULE} pl-4 pr-2 sm:pl-5`}>
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="text-[13px] font-medium text-zinc-100">Types</h2>
          {!loading && (
            <span className="text-[12px] tabular-nums text-zinc-500">
              {enums.length} {enums.length === 1 ? 'enum' : 'enums'} · {domains.length}{' '}
              {domains.length === 1 ? 'domain' : 'domains'}
            </span>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <KitButton size="sm" icon={Plus} onClick={() => setCreatingEnum(true)} disabled={loading}>
            New enum
          </KitButton>
          <KitButton size="sm" icon={Plus} onClick={() => setCreatingDomain(true)} disabled={loading}>
            New domain
          </KitButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full max-w-[860px] space-y-6 px-4 py-5 sm:px-5">
          <p className="max-w-[72ch] text-[13px] leading-[20px] text-zinc-400 [text-wrap:pretty]">
            Enums and domains in this project&rsquo;s own schema. Each one lists the columns using it, because that
            decides whether it can be changed.
          </p>

          {loadError && (
            <KitNote icon={AlertTriangle} tone="danger">
              {loadError}
            </KitNote>
          )}
          {message && (
            <KitNote icon={message.tone === 'success' ? CheckCircle2 : AlertTriangle} tone={message.tone}>
              {message.text}
            </KitNote>
          )}

          {loading ? (
            <div className={`overflow-hidden border ${EDGE} ${R_PANEL}`} aria-hidden>
              {[0, 1].map((i) => (
                <div key={i} className={`space-y-2 px-4 py-3.5 ${i > 0 ? `border-t ${RULE}` : ''}`}>
                  <Skeleton className="h-[12px] w-32" />
                  <Skeleton className="h-[18px] w-1/2" />
                </div>
              ))}
            </div>
          ) : (
            <>
              {/* ── Enums ─────────────────────────────────────────────── */}
              <section aria-labelledby="types-enums">
                <h3 id="types-enums" className="mb-2.5 text-[14px] font-semibold tracking-[-0.01em] text-zinc-100">
                  Enums
                </h3>
                {enums.length === 0 ? (
                  <p className={`border border-dashed ${EDGE} ${R_PANEL} px-4 py-4 text-[13px] text-zinc-500`}>
                    No enum types in this project yet. An enum fixes a column to a set of values, like an order
                    status.
                  </p>
                ) : (
                  <ul className={`overflow-hidden border ${EDGE} ${R_PANEL}`}>
                    {enums.map((t, i) => (
                      <li key={t.name} className={`flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start ${i > 0 ? `border-t ${RULE}` : ''}`}>
                        <div className="min-w-0 flex-1">
                          <p className="font-mono text-[12.5px] font-medium text-zinc-100">{t.name}</p>
                          <p className="mt-1.5 flex flex-wrap gap-1">
                            {t.values.map((v) => (
                              <Tag key={v} mono>
                                {v}
                              </Tag>
                            ))}
                          </p>
                          <UsedBy usedBy={t.usedBy} />
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <KitButton variant="ghost" size="sm" icon={Plus} disabled={busy !== null} onClick={() => setAddingTo(t)}>
                            Add value
                          </KitButton>
                          <KitButton
                            variant="ghost"
                            size="sm"
                            icon={Trash2}
                            loading={busy === t.name}
                            disabled={busy !== null && busy !== t.name}
                            onClick={() => setConfirmDrop({ name: t.name, usedBy: t.usedBy })}
                          >
                            Drop
                          </KitButton>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* ── Domains ───────────────────────────────────────────── */}
              <section aria-labelledby="types-domains">
                <h3 id="types-domains" className="mb-2.5 text-[14px] font-semibold tracking-[-0.01em] text-zinc-100">
                  Domains
                </h3>
                {domains.length === 0 ? (
                  <p className={`border border-dashed ${EDGE} ${R_PANEL} px-4 py-4 text-[13px] text-zinc-500`}>
                    No domains in this project yet. A domain is a base type with rules attached, like an email
                    address that must contain an @.
                  </p>
                ) : (
                  <ul className={`overflow-hidden border ${EDGE} ${R_PANEL}`}>
                    {domains.map((d, i) => (
                      <li key={d.name} className={`flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start ${i > 0 ? `border-t ${RULE}` : ''}`}>
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-[12.5px] font-medium text-zinc-100">{d.name}</span>
                            <span className="font-mono text-[12px] text-zinc-500">{d.baseType}</span>
                            {d.notNull && <Tag mono>not null</Tag>}
                          </p>
                          {d.constraints.length > 0 && (
                            <p className="mt-1 font-mono text-[12px] leading-[18px] text-zinc-400">{d.constraints.join(' ')}</p>
                          )}
                          <UsedBy usedBy={d.usedBy} />
                        </div>
                        <KitButton
                          variant="ghost"
                          size="sm"
                          icon={Trash2}
                          loading={busy === d.name}
                          disabled={busy !== null && busy !== d.name}
                          onClick={() => setConfirmDrop({ name: d.name, usedBy: d.usedBy })}
                        >
                          Drop
                        </KitButton>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <p className="max-w-[72ch] text-[12.5px] leading-[19px] text-zinc-500">
                There is no &ldquo;remove value&rdquo; for an enum. PostgreSQL has no{' '}
                <span className="font-mono text-zinc-400">ALTER TYPE &hellip; DROP VALUE</span> at any version. Removing
                one means creating a replacement type, converting every column that uses it and dropping the old one:
                a migration that rewrites data, not a settings change.
              </p>
            </>
          )}
        </div>
      </div>

      {creatingEnum && (
        <EnumForm
          onClose={() => setCreatingEnum(false)}
          onSubmit={async (name, values) => {
            if (await act({ action: 'create_enum', name, values }, `${name} created.`)) {
              setCreatingEnum(false)
            }
          }}
        />
      )}

      {addingTo && (
        <AddValueForm
          enumName={addingTo.name}
          existing={addingTo.values}
          onClose={() => setAddingTo(null)}
          onSubmit={async (value) => {
            if (await act({ action: 'add_enum_value', name: addingTo.name, value }, `${value} added to ${addingTo.name}.`)) {
              setAddingTo(null)
            }
          }}
        />
      )}

      {creatingDomain && (
        <DomainForm
          baseTypes={baseTypes}
          onClose={() => setCreatingDomain(false)}
          onSubmit={async (spec) => {
            if (await act({ action: 'create_domain', ...spec }, `${spec.name} created.`)) {
              setCreatingDomain(false)
            }
          }}
        />
      )}

      <KitConfirmDialog
        open={!!confirmDrop}
        danger
        busy={busy !== null}
        title={confirmDrop ? `Drop ${confirmDrop.name}?` : 'Drop type'}
        description={
          !confirmDrop
            ? undefined
            : confirmDrop.usedBy.length > 0
            ? `${confirmDrop.name} is still used by ${confirmDrop.usedBy.join(', ')}. ` +
              `Dropping it will be refused: the columns would have to go with it, and that is ` +
              `data. Change those columns first.`
            : `Nothing uses ${confirmDrop.name}, so dropping it affects no data. This cannot be undone.`
        }
        confirmLabel="Drop"
        onConfirm={() => confirmDrop && drop(confirmDrop.name)}
        onCancel={() => {
          if (busy === null) setConfirmDrop(null)
        }}
      />
    </div>
  )
}

/** The dependents of a type, which is what makes a change safe or not. */
function UsedBy({ usedBy }: { usedBy: string[] }) {
  if (usedBy.length === 0) {
    return <p className="mt-1.5 text-[12px] text-zinc-600">Not used by any column.</p>
  }
  return (
    <p className="mt-1.5 text-[12px] text-zinc-500">
      Used by <span className="font-mono text-zinc-400">{usedBy.join(', ')}</span>
    </p>
  )
}

function EnumForm({
  onClose, onSubmit,
}: { onClose: () => void; onSubmit: (name: string, values: string[]) => Promise<void> }) {
  const [name, setName] = useState('')
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)

  const values = raw.split('\n').map(v => v.trim()).filter(Boolean)

  return (
    <KitModal
      open
      title="New enum"
      description="A fixed set of values a column may hold."
      onClose={onClose}
      footer={
        <>
          <KitButton variant="ghost" size="sm" onClick={onClose}>Cancel</KitButton>
          <KitButton
            variant="primary"
            size="sm"
            loading={!!busy}
            disabled={busy || !name.trim() || values.length === 0}
            onClick={async () => { setBusy(true); try { await onSubmit(name.trim(), values) } finally { setBusy(false) } }}
          >
            Create
          </KitButton>
        </>
      }
    >
      <div className="space-y-4">
        <KitField label="Name" hint="Lower case, letters, digits and underscores.">
          <KitInput value={name} onChange={e => setName(e.target.value)} placeholder="order_status" autoFocus />
        </KitField>
        <KitField label="Values" hint="One per line. Order is the sort order PostgreSQL will use.">
          <textarea
            value={raw}
            onChange={e => setRaw(e.target.value)}
            rows={6}
            placeholder={'draft\npublished\narchived'}
            className="w-full rounded-md border border-white/10 bg-[#08090a] px-3 py-2 font-mono text-[12px] text-zinc-50 placeholder:text-zinc-600 focus:border-violet-400/40 focus:outline-none focus:ring-2 focus:ring-violet-400/15"
          />
        </KitField>
      </div>
    </KitModal>
  )
}

function AddValueForm({
  enumName, existing, onClose, onSubmit,
}: { enumName: string; existing: string[]; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <KitModal
      open
      title={`Add a value to ${enumName}`}
      // The safe change, and worth saying so: appending does not touch rows.
      description="Appended to the end. Existing rows are untouched."
      onClose={onClose}
      footer={
        <>
          <KitButton variant="ghost" size="sm" onClick={onClose}>Cancel</KitButton>
          <KitButton
            variant="primary"
            size="sm"
            loading={!!busy}
            disabled={busy || !value.trim()}
            onClick={async () => { setBusy(true); try { await onSubmit(value.trim()) } finally { setBusy(false) } }}
          >
            Add
          </KitButton>
        </>
      }
    >
      <KitField label="Value" hint={`Current: ${existing.join(', ')}`}>
        <KitInput value={value} onChange={e => setValue(e.target.value)} autoFocus />
      </KitField>
    </KitModal>
  )
}

function DomainForm({
  baseTypes, onClose, onSubmit,
}: {
  baseTypes: string[]
  onClose: () => void
  onSubmit: (spec: { name: string; baseType: string; notNull: boolean; check: string | null }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [baseType, setBaseType] = useState(baseTypes[0] ?? 'text')
  const [notNull, setNotNull] = useState(false)
  const [check, setCheck] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <KitModal
      open
      title="New domain"
      description="A base type with a constraint attached, reusable across columns."
      onClose={onClose}
      footer={
        <>
          <KitButton variant="ghost" size="sm" onClick={onClose}>Cancel</KitButton>
          <KitButton
            variant="primary"
            size="sm"
            loading={!!busy}
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true)
              try { await onSubmit({ name: name.trim(), baseType, notNull, check: check.trim() || null }) }
              finally { setBusy(false) }
            }}
          >
            Create
          </KitButton>
        </>
      }
    >
      <div className="space-y-4">
        <KitField label="Name">
          <KitInput value={name} onChange={e => setName(e.target.value)} placeholder="email_address" autoFocus />
        </KitField>
        <KitField label="Base type">
          <select
            value={baseType}
            onChange={e => setBaseType(e.target.value)}
            className="h-8 w-full rounded-md border border-white/10 bg-[#08090a] px-2 text-[12.5px] text-zinc-50 focus:border-violet-400/40 focus:outline-none"
          >
            {baseTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </KitField>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-zinc-300">
          <input type="checkbox" checked={notNull} onChange={e => setNotNull(e.target.checked)} className="accent-violet-400" />
          NOT NULL
        </label>
        <KitField
          label="Check"
          hint={<>Must refer to <span className="font-mono text-zinc-300">VALUE</span>, which is the column being checked.</>}
        >
          <KitInput value={check} onChange={e => setCheck(e.target.value)} placeholder="VALUE ~ '^[^@]+@[^@]+$'" />
        </KitField>
      </div>
    </KitModal>
  )
}
