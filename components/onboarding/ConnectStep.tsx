'use client'

/**
 * Connect: what each source needs, and nothing more.
 *
 *   Supabase  the database's connection string (direct, port 5432), and, only
 *             to move Storage files too, the project URL and service_role key
 *   Firebase  a service account key, from a file or pasted
 *   Postgres  a connection string, and the schemas to move (public if empty)
 *
 * Every credential is masked and never echoed: a key file is shown by what it
 * says about itself (its project and service account), not its contents.
 * Continue asks the server to read the source (POST /api/import/inspect);
 * its refusal comes back in the source's own words under the field it names.
 */

import { useEffect, useId, useRef, useState, type DragEvent } from 'react'
import { FileJson, Upload } from 'lucide-react'
import type { ImportConnection, ImportSourceId } from '@/lib/import/contract'
import {
  BUTTON_BASE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  INPUT_BASE,
  KitButton,
  KitButtonLink,
  KitInput,
} from '@/components/inspector/kit'
import { EDGE, PLATE, R_CONTROL, R_PANEL, WELL } from '@/components/console/tokens'
import { SOURCES } from '@/components/migrate/sources'
import { SourcePicker } from './StartChoice'
import { FieldError, FormFooter, FormRow, SecretInput } from './parts'

export interface ConnectValues {
  connectionString: string
  projectUrl: string
  serviceRoleKey: string
  /** The service account key's JSON text, once read from a file or pasted. */
  serviceAccountJson: string
  /** What the key says about itself, shown instead of the key. */
  keyInfo: { fileName: string | null; projectId: string; clientEmail: string } | null
  schemas: string
}

export const EMPTY_CONNECT: ConnectValues = {
  connectionString: '',
  projectUrl: '',
  serviceRoleKey: '',
  serviceAccountJson: '',
  keyInfo: null,
  schemas: '',
}

export type ConnectField = 'connectionString' | 'projectUrl' | 'serviceRoleKey' | 'serviceAccountJson' | 'schemas'
export const CONNECT_FIELDS: readonly ConnectField[] = ['connectionString', 'projectUrl', 'serviceRoleKey', 'serviceAccountJson', 'schemas']
export type ConnectErrors = Partial<Record<ConnectField, string>>

export function isConnectField(field: string | undefined): field is ConnectField {
  return !!field && (CONNECT_FIELDS as readonly string[]).includes(field)
}

/** The request's `connection`, from what was typed. */
export function connectionOf(source: ImportSourceId, v: ConnectValues): ImportConnection {
  if (source === 'firebase') return { source, serviceAccountJson: v.serviceAccountJson }
  const connectionString = v.connectionString.trim()
  if (source === 'postgres') {
    const schemas = v.schemas
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return { source, connectionString, ...(schemas.length ? { schemas } : {}) }
  }
  const projectUrl = v.projectUrl.trim()
  const serviceRoleKey = v.serviceRoleKey.trim()
  return { source, connectionString, ...(projectUrl ? { projectUrl } : {}), ...(serviceRoleKey ? { serviceRoleKey } : {}) }
}

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i

/** Mistakes worth saying before the server is asked. */
export function checkConnect(source: ImportSourceId, v: ConnectValues): ConnectErrors {
  const errors: ConnectErrors = {}
  if (source === 'firebase') {
    if (!v.serviceAccountJson) errors.serviceAccountJson = 'Choose the key file, or paste the key.'
    return errors
  }
  const conn = v.connectionString.trim()
  if (!conn) errors.connectionString = 'Paste the connection string.'
  else if (!POSTGRES_URL.test(conn)) errors.connectionString = 'A connection string starts with postgresql://'
  else if (conn.includes('[YOUR-PASSWORD]')) errors.connectionString = 'Replace [YOUR-PASSWORD] with the database password.'
  if (source === 'supabase') {
    const url = v.projectUrl.trim()
    const key = v.serviceRoleKey.trim()
    if (url && !/^https:\/\//i.test(url)) errors.projectUrl = 'The project URL starts with https://'
    else if (key && !url) errors.projectUrl = 'Add the project URL too, or leave both empty.'
    if (url && !key) errors.serviceRoleKey = 'Add the service_role key too, or leave both empty.'
  }
  return errors
}

/** A Firebase service account key's own description of itself, or null when the text is not one. */
export function readServiceAccount(text: string): { projectId: string; clientEmail: string } | null {
  try {
    const key = JSON.parse(text) as Record<string, unknown> | null
    if (
      key &&
      key.type === 'service_account' &&
      typeof key.private_key === 'string' &&
      typeof key.client_email === 'string' &&
      typeof key.project_id === 'string'
    ) {
      return { projectId: key.project_id, clientEmail: key.client_email }
    }
  } catch {
    /* not JSON */
  }
  return null
}

const NOT_A_KEY = 'This is not a service account key. Use the JSON file from Project settings, Service accounts.'

export function ConnectStep({
  source,
  onSource,
  values,
  onChange,
  errors,
  onFieldError,
  formError,
  busy,
  onSubmit,
  cancelHref,
}: {
  source: ImportSourceId
  onSource: (source: ImportSourceId) => void
  values: ConnectValues
  onChange: (patch: Partial<ConnectValues>) => void
  errors: ConnectErrors
  /** Say (or clear) what is wrong with one field, found on this side: a file that is not a key. */
  onFieldError: (field: ConnectField, message: string | null) => void
  formError: string | null
  busy: boolean
  onSubmit: () => void
  cancelHref: string
}) {
  const from = SOURCES[source].name
  const id = useId()
  const ids = {
    conn: `${id}-conn`,
    url: `${id}-url`,
    key: `${id}-key`,
    files: `${id}-files`,
    json: `${id}-json`,
    schemas: `${id}-schemas`,
  }
  const connRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const pickRef = useRef<HTMLButtonElement>(null)
  const schemasRef = useRef<HTMLInputElement>(null)

  // A refusal moves focus to the first field it names, so it is read out and fixed there.
  useEffect(() => {
    const first = CONNECT_FIELDS.find((f) => errors[f])
    const target = {
      connectionString: connRef,
      projectUrl: urlRef,
      serviceRoleKey: keyRef,
      serviceAccountJson: pickRef,
      schemas: schemasRef,
    }
    if (first) target[first].current?.focus()
  }, [errors])

  const describedBy = (field: ConnectField, hint?: string) =>
    [hint, errors[field] ? `${id}-${field}-error` : null].filter(Boolean).join(' ') || undefined

  return (
    <form
      noValidate
      aria-label={`Connect ${from}`}
      className={`${PLATE} border ${EDGE} ${R_PANEL}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy) onSubmit()
      }}
    >
      <div className="divide-y divide-white/[0.06]">
        <FormRow label="From" labelId={`${id}-from`}>
          <SourcePicker legend="From" value={source} onChange={onSource} disabled={busy} />
        </FormRow>

        {(source === 'supabase' || source === 'postgres') && (
          <FormRow
            label="Connection string"
            hint={
              source === 'supabase'
                ? 'In Supabase, press Connect and copy the Session pooler string (port 5432). It works on every network.'
                : 'Any Postgres reachable from the internet. A read-only user is enough.'
            }
            hintId={`${ids.conn}-hint`}
            htmlFor={ids.conn}
          >
            <SecretInput
              ref={connRef}
              id={ids.conn}
              what="connection string"
              value={values.connectionString}
              onChange={(e) => onChange({ connectionString: e.target.value })}
              placeholder={
                source === 'supabase'
                  ? 'postgresql://postgres.…:…@aws-0-….pooler.supabase.com:5432/postgres'
                  : 'postgresql://user:password@host:5432/database'
              }
              aria-invalid={errors.connectionString ? true : undefined}
              aria-describedby={describedBy('connectionString', `${ids.conn}-hint`)}
              disabled={busy}
            />
            <FieldError id={`${id}-connectionString-error`} error={errors.connectionString} />
          </FormRow>
        )}

        {source === 'supabase' && (
          <FormRow
            label="Storage files"
            hint="Optional, to move Storage files too. Both are in Project Settings, API."
            hintId={`${ids.files}-hint`}
            labelId={ids.files}
          >
            <div role="group" aria-labelledby={ids.files} aria-describedby={`${ids.files}-hint`} className="grid gap-[12px] md:grid-cols-2">
              <div className="min-w-0">
                <label htmlFor={ids.url} className="mb-[6px] block text-[12.5px] leading-[18px] text-zinc-300">
                  Project URL
                </label>
                <KitInput
                  ref={urlRef}
                  id={ids.url}
                  value={values.projectUrl}
                  onChange={(e) => onChange({ projectUrl: e.target.value })}
                  placeholder="https://….supabase.co"
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-invalid={errors.projectUrl ? true : undefined}
                  aria-describedby={describedBy('projectUrl')}
                  disabled={busy}
                  className="font-mono"
                />
                <FieldError id={`${id}-projectUrl-error`} error={errors.projectUrl} />
              </div>
              <div className="min-w-0">
                <label htmlFor={ids.key} className="mb-[6px] block text-[12.5px] leading-[18px] text-zinc-300">
                  <code className="font-mono text-[12px]">service_role</code> key
                </label>
                <SecretInput
                  ref={keyRef}
                  id={ids.key}
                  what="service_role key"
                  value={values.serviceRoleKey}
                  onChange={(e) => onChange({ serviceRoleKey: e.target.value })}
                  placeholder="eyJhbGciOi…"
                  aria-invalid={errors.serviceRoleKey ? true : undefined}
                  aria-describedby={describedBy('serviceRoleKey')}
                  disabled={busy}
                />
                <FieldError id={`${id}-serviceRoleKey-error`} error={errors.serviceRoleKey} />
              </div>
            </div>
          </FormRow>
        )}

        {source === 'firebase' && (
          <FormRow
            label="Service account key"
            hint="Project settings, Service accounts, Generate new private key."
            hintId={`${ids.json}-hint`}
            labelId={ids.json}
          >
            <ServiceAccountKey
              pickRef={pickRef}
              labelledBy={ids.json}
              describedBy={describedBy('serviceAccountJson', `${ids.json}-hint`)}
              keyInfo={values.keyInfo}
              disabled={busy}
              onKey={(text, info) => {
                onChange({ serviceAccountJson: text, keyInfo: info })
                onFieldError('serviceAccountJson', null)
              }}
              onClear={() => onChange({ serviceAccountJson: '', keyInfo: null })}
              onError={(message) => {
                onChange({ serviceAccountJson: '', keyInfo: null })
                onFieldError('serviceAccountJson', message)
              }}
            />
            <FieldError id={`${id}-serviceAccountJson-error`} error={errors.serviceAccountJson} />
          </FormRow>
        )}

        {source === 'postgres' && (
          <FormRow
            label="Schemas"
            hint="Optional. Separate them with commas. Just public when empty."
            hintId={`${ids.schemas}-hint`}
            htmlFor={ids.schemas}
          >
            <KitInput
              ref={schemasRef}
              id={ids.schemas}
              value={values.schemas}
              onChange={(e) => onChange({ schemas: e.target.value })}
              placeholder="public"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={errors.schemas ? true : undefined}
              aria-describedby={describedBy('schemas', `${ids.schemas}-hint`)}
              disabled={busy}
              className="font-mono"
            />
            <FieldError id={`${id}-schemas-error`} error={errors.schemas} />
          </FormRow>
        )}
      </div>

      <FormFooter
        error={formError}
        aside={busy ? `This takes about a minute. Backenly only reads ${from}; nothing there changes.` : `Backenly only reads ${from}. Nothing there changes.`}
      >
        <KitButtonLink href={cancelHref} variant="ghost">
          Cancel
        </KitButtonLink>
        <KitButton type="submit" variant="primary" loading={busy}>
          {busy ? `Reading ${from}…` : 'Continue'}
        </KitButton>
      </FormFooter>
    </form>
  )
}

/**
 * The Firebase key: a file (chosen or dropped) or pasted text. Once read, the
 * key itself leaves the screen and its project and service account stand in.
 */
function ServiceAccountKey({
  pickRef,
  labelledBy,
  describedBy,
  keyInfo,
  disabled,
  onKey,
  onClear,
  onError,
}: {
  pickRef: React.RefObject<HTMLButtonElement | null>
  labelledBy: string
  describedBy?: string
  keyInfo: ConnectValues['keyInfo']
  disabled: boolean
  onKey: (text: string, info: NonNullable<ConnectValues['keyInfo']>) => void
  onClear: () => void
  onError: (message: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [pasting, setPasting] = useState(false)
  const [dragging, setDragging] = useState(false)

  const take = (text: string, fileName: string | null) => {
    const info = readServiceAccount(text)
    if (!info) {
      onError(NOT_A_KEY)
      return
    }
    setPasting(false)
    onKey(text, { ...info, fileName })
  }

  const readFile = async (file: File | undefined | null) => {
    if (!file) return
    // A service account key is about 2 KB; anything far larger is something else.
    if (file.size > 64 * 1024) {
      onError(NOT_A_KEY)
      return
    }
    take(await file.text(), file.name)
  }

  if (keyInfo) {
    return (
      <div
        role="group"
        aria-labelledby={labelledBy}
        className={`flex items-center gap-[12px] border ${EDGE} ${R_CONTROL} ${WELL} px-[12px] py-[9px]`}
      >
        <FileJson aria-hidden className="h-[15px] w-[15px] flex-shrink-0 text-zinc-400" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[12.5px] leading-[18px] text-zinc-100">{keyInfo.fileName ?? keyInfo.projectId}</p>
          <p className="truncate text-[12px] leading-[17px] text-faint">
            {keyInfo.fileName ? `${keyInfo.projectId}, ` : ''}
            {keyInfo.clientEmail}
          </p>
        </div>
        <KitButton
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            onClear()
            setPasting(false)
          }}
        >
          Replace
        </KitButton>
      </div>
    )
  }

  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    if (!disabled) readFile(e.dataTransfer.files?.[0])
  }

  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
      className={`${R_CONTROL} border border-dashed px-[12px] py-[12px] transition-colors duration-150 ${
        dragging ? 'border-white/30 bg-white/[0.03]' : 'border-white/[0.12]'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
        <button
          ref={pickRef}
          type="button"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          className={`${BUTTON_BASE} ${BUTTON_SIZES.sm} ${BUTTON_VARIANTS.secondary}`}
        >
          <Upload aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
          Choose key file
        </button>
        <span className="text-[12.5px] leading-[18px] text-faint">
          or drop it here, or{' '}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setPasting(true)}
            className="rounded-[3px] text-zinc-300 underline decoration-white/25 underline-offset-[3px] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            paste it
          </button>
        </span>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          readFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {pasting && (
        <textarea
          autoFocus
          rows={4}
          aria-label="Service account key"
          placeholder='{ "type": "service_account", … }'
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          onChange={(e) => {
            const text = e.target.value.trim()
            // Read it once it is whole; the key never stays on screen once it is.
            if (text.startsWith('{') && text.endsWith('}')) take(text, null)
          }}
          className={`${INPUT_BASE} mt-[12px] block resize-none px-[12px] py-[8px] font-mono leading-[20px]`}
        />
      )}
    </div>
  )
}
