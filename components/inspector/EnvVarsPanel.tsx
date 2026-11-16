'use client'

/**
 * Secrets: the values a project's functions read as ctx.env.NAME.
 *
 * They lived on Deploy, but only the function runtimes read them
 * (lib/services/ai-functions/executor.ts, route-module-runner.ts), so they
 * live in Functions now (project decision 3, `?view=secrets`); Deploy links
 * here. Three names, three places: API keys (Connect), provider keys
 * (Integrations), secrets (here). A provider's key saved as a secret is the
 * trap the names exist to prevent: ctx.integrations is built only from the
 * key vault, so a RESEND_API_KEY secret leaves Resend "Not connected". Such a
 * row says so and links to the provider.
 *
 * A value is never shown again once saved: the list has its first four
 * characters, and Replace value writes a new one over it (POST upserts).
 * Deleting needs an admin (env-vars route), and History does not keep the
 * value (lib/changes/resources/env.ts), so the confirm says it can't be undone.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import Link from 'next/link'
import { Eye, EyeOff, Plus } from 'lucide-react'
import { KitButton, KitConfirmDialog, KitField, KitInput, KitModal, OverflowMenu } from '@/components/inspector/kit'
import { PaneToolbar, count } from '@/components/console/InstrumentBar'
import { EmptyPanel, ErrorRow, RefusedLine } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { FOCUS, R_CONTROL, RULE } from '@/components/console/tokens'
import { RowSkeleton } from '@/components/autonomy/rows'
import { integrationCatalog } from '@/components/hub/integration-catalog'

export interface EnvVarSummary {
  id: string
  key: string
  /** The value's first four characters and a run of dots (projectEnvCrypto.previewValue). */
  preview: string
  description: string | null
  createdAt: string
  updatedAt: string
}

export type SecretsRead =
  | { status: 'loading' }
  | { status: 'error'; vars: EnvVarSummary[] | null; at: number | null }
  | { status: 'ready'; vars: EnvVarSummary[]; at: number }

/** The project's secrets, read once and shared by the Secrets view and a function's Code view. */
export function useSecrets(projectId: string): { read: SecretsRead; reload: () => Promise<void>; names: string[] | null } {
  const [read, setRead] = useState<SecretsRead>({ status: 'loading' })
  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/env-vars`, { credentials: 'include' })
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json()
      setRead({ status: 'ready', vars: Array.isArray(data?.vars) ? data.vars : [], at: Date.now() })
    } catch {
      setRead((prev) => (prev.status === 'loading' ? { status: 'error', vars: null, at: null } : { status: 'error', vars: prev.vars, at: prev.at }))
    }
  }, [projectId])
  useEffect(() => {
    void reload()
  }, [reload])
  const names = read.status === 'ready' ? read.vars.map((v) => v.key) : null
  return { read, reload, names }
}

const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

/** "Resend" when the name is a provider's key, by the names the Integrations page stores them under. */
function providerFor(key: string): { id: string; name: string } | null {
  for (const category of integrationCatalog()) {
    for (const p of category.providers) {
      if (p.envVar === key || p.webhookKey?.envVar === key) return { id: p.id, name: p.name }
    }
  }
  return null
}

const LINK = `rounded-[3px] text-zinc-300 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/60 ${FOCUS}`

export function EnvVarsPanel({
  projectId,
  secrets,
  canWrite = true,
  canAdminister = true,
  readers,
  headingLevel = 2,
}: {
  projectId: string
  /** The read, when the page shares it; the panel reads on its own otherwise. */
  secrets?: ReturnType<typeof useSecrets>
  canWrite?: boolean
  canAdminister?: boolean
  /** The functions whose code reads each secret, found in code. */
  readers?: ReadonlyMap<string, readonly string[]>
  headingLevel?: 2 | 3
}) {
  const own = useSecrets(projectId)
  const { read, reload } = secrets ?? own
  const [editing, setEditing] = useState<{ mode: 'add' } | { mode: 'replace'; key: string } | null>(null)
  const [toDelete, setToDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [refused, setRefused] = useState<{ key: string; message: string } | null>(null)

  const vars = read.status === 'loading' ? null : read.vars

  const remove = async (key: string) => {
    setDeleting(true)
    setRefused(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/env-vars?key=${encodeURIComponent(key)}`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json().catch(() => null)
      if (!res.ok || data?.success === false) {
        setRefused({ key, message: data?.error ?? `Could not delete ${key} (${res.status}).` })
      } else {
        await reload()
      }
    } catch {
      setRefused({ key, message: `Could not reach Backenly. ${key} is unchanged.` })
    } finally {
      setDeleting(false)
      setToDelete(null)
    }
  }

  const n = vars?.length ?? 0
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneToolbar
        title="Secrets"
        headingLevel={headingLevel}
        count={vars && n > 0 ? `${count(n)} ${n === 1 ? 'secret' : 'secrets'}` : undefined}
        action={
          canWrite ? (
            <KitButton size="sm" icon={Plus} onClick={() => setEditing({ mode: 'add' })}>
              Add secret
            </KitButton>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {read.status === 'loading' ? (
          <RowSkeleton rows={3} lead="none" />
        ) : read.status === 'error' && !read.vars ? (
          <ErrorRow things="secrets" onRetry={() => void reload()} />
        ) : (
          <>
            {read.status === 'error' && read.at !== null && <ErrorRow things="secrets" staleAt={read.at} onRetry={() => void reload()} />}
            {n === 0 ? (
              <EmptyPanel
                title="No secrets yet"
                sentence="API keys and settings your functions read as ctx.env.NAME, stored encrypted."
                headingLevel={3}
              />
            ) : (
              <>
                <p className={`border-b ${RULE} px-[16px] py-[10px] text-[12.5px] leading-[18px] text-faint sm:px-[20px]`}>
                  Functions read them as <code className="font-mono text-[12px] text-zinc-300">ctx.env.NAME</code>.
                  {!canWrite && ' Only developers and admins can change secrets.'}
                </p>
                <ul className="divide-y divide-white/[0.06]">
                  {vars!.map((v) => {
                    const provider = providerFor(v.key)
                    const by = readers?.get(v.key) ?? []
                    const menu = [
                      ...(canWrite ? [{ label: 'Replace value', onClick: () => setEditing({ mode: 'replace', key: v.key }) }] : []),
                      ...(canAdminister ? [{ label: 'Delete…', danger: true, onClick: () => setToDelete(v.key) }] : []),
                    ]
                    return (
                      <li key={v.id} className="px-[16px] py-[12px] sm:px-[20px]">
                        <div className="flex items-start gap-[12px]">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-[12px] gap-y-[2px]">
                              <span className="font-mono text-[12.5px] font-medium leading-[20px] text-zinc-100 [overflow-wrap:anywhere]">{v.key}</span>
                              <code className="font-mono text-[12px] leading-[18px] text-faint">{v.preview}</code>
                            </div>
                            <div className="mt-[4px] flex flex-wrap items-center gap-x-[16px] gap-y-[2px] text-[12px] leading-[16px] text-faint">
                              <Time iso={v.updatedAt} mode="date" prefix="Updated" />
                              {v.description && <span className="min-w-0 [overflow-wrap:anywhere]">{v.description}</span>}
                              {by.length > 0 && (
                                <span>
                                  Read by{' '}
                                  {by.map((name, i) => (
                                    <span key={name}>
                                      {i > 0 && ', '}
                                      <Link href={`/app/projects/${projectId}/functions?fn=${encodeURIComponent(name)}`} className={`font-mono text-[11.5px] ${LINK}`}>
                                        {name}
                                      </Link>
                                    </span>
                                  ))}
                                </span>
                              )}
                            </div>
                            {provider && (
                              <p className="mt-[4px] text-[12px] leading-[16px] text-faint">
                                {provider.name} is an integration.{' '}
                                <Link href={`/app/projects/${projectId}/integrations?connector=${provider.id}`} className={LINK}>
                                  Connect it there
                                </Link>
                                .
                              </p>
                            )}
                            {refused?.key === v.key && <RefusedLine className="mt-[6px]">{refused.message}</RefusedLine>}
                          </div>
                          {menu.length > 0 && <OverflowMenu label={`Actions for ${v.key}`} items={menu} />}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      <SecretDialog
        projectId={projectId}
        editing={editing}
        taken={vars?.map((v) => v.key) ?? []}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null)
          await reload()
        }}
      />

      <KitConfirmDialog
        open={toDelete !== null}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void remove(toDelete)
        }}
        title={toDelete ? `Delete ${toDelete}?` : 'Delete secret?'}
        undoable={false}
        lost={toDelete ? `Functions reading ctx.env.${toDelete} get undefined until it's added again.` : undefined}
        confirmLabel="Delete"
        danger
        busy={deleting}
      />
    </div>
  )
}

/** Add a secret, or replace one's value. The value is never shown again once saved. */
function SecretDialog({
  projectId,
  editing,
  taken,
  onClose,
  onSaved,
}: {
  projectId: string
  editing: { mode: 'add' } | { mode: 'replace'; key: string } | null
  taken: readonly string[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const valueId = useId()
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [description, setDescription] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<{ field: 'key' | 'value' | 'form'; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [shown, setShown] = useState<typeof editing>(null)
  if (editing !== shown) {
    setShown(editing)
    setKey(editing?.mode === 'replace' ? editing.key : '')
    setValue('')
    setDescription('')
    setShow(false)
    setError(null)
  }
  const replacing = editing?.mode === 'replace'
  const name = replacing ? editing.key : key.trim()
  const provider = useMemo(() => (KEY_PATTERN.test(name) ? providerFor(name) : null), [name])

  const save = async () => {
    if (!replacing) {
      if (!KEY_PATTERN.test(name)) return setError({ field: 'key', message: 'Use capital letters, digits and underscores, starting with a letter.' })
      if (taken.includes(name)) return setError({ field: 'key', message: `${name} already exists. Use Replace value on its row.` })
    }
    if (!value) return setError({ field: 'value', message: 'Enter a value.' })
    setError(null)
    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/env-vars`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: name, value, ...(!replacing && description.trim() ? { description: description.trim() } : {}) }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || data?.success === false) {
        setError({ field: 'form', message: data?.error ?? `Could not save ${name} (${res.status}).` })
        return
      }
      await onSaved()
    } catch {
      setError({ field: 'form', message: 'Could not reach Backenly. Nothing was saved.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <KitModal
      open={editing !== null}
      onClose={onClose}
      title={replacing ? `Replace ${name}` : 'Add secret'}
      description={replacing ? 'Functions read the new value on their next run. The old one is not kept.' : 'Stored encrypted. The value is not shown again.'}
      width="max-w-[480px]"
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </KitButton>
          <KitButton variant="primary" onClick={save} loading={saving}>
            {replacing ? 'Replace' : 'Save'}
          </KitButton>
        </>
      }
    >
      <div className="space-y-[14px]">
        {!replacing && (
          <KitField label="Name" hint={error?.field === 'key' ? undefined : 'Read in code as ctx.env.NAME.'}>
            <KitInput
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              placeholder="MAIL_FROM"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error?.field === 'key' || undefined}
              className="font-mono"
            />
          </KitField>
        )}
        {error?.field === 'key' && <RefusedLine className="-mt-[8px]">{error.message}</RefusedLine>}
        {provider && (
          <p className="text-[12.5px] leading-[18px] text-zinc-50">
            {provider.name} is an integration.{' '}
            <Link href={`/app/projects/${projectId}/integrations?connector=${provider.id}`} className={LINK}>
              Connect it there
            </Link>{' '}
            so ctx.integrations.{provider.id} works.
          </p>
        )}
        <div>
          <label htmlFor={valueId} className="mb-1.5 block text-[12.5px] font-medium leading-[18px] text-zinc-300">
            {replacing ? 'New value' : 'Value'}
          </label>
          <div className="relative">
            <KitInput
              id={valueId}
              type={show ? 'text' : 'password'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error?.field === 'value' || undefined}
              className="pr-[40px] font-mono"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-pressed={show}
              aria-label={show ? 'Hide value' : 'Show value'}
              className={`absolute right-[4px] top-1/2 flex h-[26px] w-[26px] -translate-y-1/2 items-center justify-center ${R_CONTROL} text-zinc-500 hover:text-zinc-100 ${FOCUS}`}
            >
              {show ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}
            </button>
          </div>
          {error?.field === 'value' && <RefusedLine className="mt-[6px]">{error.message}</RefusedLine>}
        </div>
        {!replacing && (
          <KitField label="Description (optional)">
            <KitInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Sender for welcome emails" />
          </KitField>
        )}
        {error?.field === 'form' && <RefusedLine>{error.message}</RefusedLine>}
      </div>
    </KitModal>
  )
}
