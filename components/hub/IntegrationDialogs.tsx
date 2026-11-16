'use client'

/**
 * The Integrations page's dialogs: Connect (one step), Replace key, and a
 * provider's second credential on its own (Stripe's signing secret,
 * OneSignal's App ID). Dialogs only create, confirm, or show a secret once
 * (decision 6); these create.
 *
 *   Connect Stripe
 *   Secret key  STRIPE_SECRET_KEY
 *   [••••••••••••••••••••]                                   [eye]
 *   Find it in the Stripe Dashboard under Developers, API keys.
 *   Webhook signing secret  Optional  STRIPE_WEBHOOK_SECRET
 *   [whsec_…]                                                [eye]
 *   Stripe events are refused until it's stored. Add this address in Stripe as an endpoint:
 *   [https://…/webhooks/stripe                                 ⧉]
 *   Stored encrypted. Never shown again.             [Cancel] [Connect]
 *
 * Connect asks the provider first (POST …/credentials/verify), so a key it
 * refuses is said under its own field and nothing is stored; then it stores
 * (POST …/credentials), which checks again. A check that could not be made
 * (offline, a limit) does not stop it: storing checks the key itself. The
 * dialog closes only when the server has stored the key.
 */

import { useId, useState, type ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { CopyField, KitButton, KitInput, KitModal, Skeleton } from '@/components/inspector/kit'
import { FOCUS, RULE } from '@/components/console/tokens'
import type { CatalogProvider, SecondaryCredential } from './integration-catalog'
import { receivingUrl } from './integration-state'

/** Where the project's API is served, for a receiving URL: loading, known (null when this server has none), or failed. */
export type ApiBase = { state: 'loading' } | { state: 'ready'; url: string | null } | { state: 'failed' }

const STORED_NOTE = 'Stored encrypted. Never shown again.'
const NETWORK = 'Could not reach Backenly. Check your connection and try again.'

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

/** A key's field: its label, the name it is stored under, and show/hide. */
function KeyField({
  label,
  envVar,
  optional = false,
  value,
  onChange,
  onEnter,
  error,
  placeholder,
  children,
}: {
  label: string
  envVar: string
  optional?: boolean
  value: string
  onChange: (value: string) => void
  onEnter: () => void
  error?: string
  placeholder?: string
  /** Lines under the field: where to find it, what is missing without it. */
  children?: ReactNode
}) {
  const id = useId()
  const errorId = `${id}-error`
  const [shown, setShown] = useState(false)
  return (
    <div>
      <label htmlFor={id} className="mb-[6px] flex flex-wrap items-baseline gap-x-[8px] gap-y-[2px] text-[12.5px] font-medium leading-[18px] text-zinc-200">
        {label}
        {optional && <span className="font-normal text-faint">Optional</span>}
        <span className="font-mono text-[11.5px] font-normal text-faint">{envVar}</span>
      </label>
      <div className="relative">
        <KitInput
          id={id}
          name={envVar}
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onEnter()
            }
          }}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className={`pr-[40px] font-mono ${error ? '!border-zinc-50/50' : ''}`}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-label={shown ? 'Hide the value' : 'Show the value'}
          title={shown ? 'Hide' : 'Show'}
          className={`absolute right-[4px] top-1/2 flex h-[28px] w-[28px] -translate-y-1/2 items-center justify-center rounded-[6px] text-zinc-500 transition-colors duration-150 hover:bg-white/[0.06] hover:text-zinc-100 ${FOCUS}`}
        >
          {shown ? <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-[6px] text-[12px] leading-[17px] text-rose-300 [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      {children}
    </div>
  )
}

/** Where to find a key, in the provider's own dashboard. Opens a new tab. */
export function KeyDocsLink({ href, children }: { href: string; children: ReactNode }) {
  if (!href) return <p className="mt-[6px] text-[12px] leading-[17px] text-faint">{children}</p>
  return (
    <p className="mt-[6px] text-[12px] leading-[17px]">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`rounded-[3px] text-faint underline decoration-white/20 underline-offset-[3px] transition-colors duration-150 hover:text-zinc-100 hover:decoration-white/50 ${FOCUS}`}
      >
        {children}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </p>
  )
}

/**
 * The address a provider sends events to, to add in the provider's dashboard.
 * Stripe issues a signing secret only for an endpoint entered there. Built from
 * the project's own API address, never this page's origin.
 */
export function ReceivingUrl({ apiBase, path, label = 'Copy endpoint URL' }: { apiBase: ApiBase; path: string; label?: string }) {
  if (apiBase.state === 'loading') return <Skeleton className="h-[34px] w-full" />
  if (apiBase.state === 'failed') {
    return <p className="text-[12.5px] leading-[18px] text-faint">The endpoint URL couldn’t be loaded. Reload the page to try again.</p>
  }
  const url = receivingUrl(apiBase.url, path)
  if (!url) {
    return (
      <p className="text-[12.5px] leading-[18px] text-faint">
        This server has no API address for the project’s region, so its endpoint URL can’t be shown.
      </p>
    )
  }
  return <CopyField value={url} wrap label={label} />
}

function StoredNote() {
  return <p className={`mt-[18px] border-t ${RULE} pt-[12px] text-[12px] leading-[17px] text-faint`}>{STORED_NOTE}</p>
}

/**
 * Connect a provider, or replace its key. One step: the key (and, when
 * connecting, the provider's optional second credential), then Connect.
 */
export function ConnectDialog({
  mode,
  provider,
  projectId,
  apiBase,
  onClose,
  onDone,
}: {
  mode: 'connect' | 'replace'
  provider: CatalogProvider
  projectId: string
  apiBase: ApiBase
  onClose: () => void
  /** The server stored the key. */
  onDone: () => void
}) {
  const second = mode === 'connect' ? provider.webhookKey : undefined
  const [key, setKey] = useState('')
  const [secondValue, setSecondValue] = useState('')
  const [keyError, setKeyError] = useState('')
  const [secondError, setSecondError] = useState('')
  const [formError, setFormError] = useState('')
  const [phase, setPhase] = useState<'idle' | 'checking' | 'storing'>('idle')

  const submit = async () => {
    if (phase !== 'idle') return
    const trimmed = key.trim()
    setFormError('')
    if (!trimmed) {
      setKeyError(`Paste the ${provider.keyLabel.toLowerCase()} to ${mode === 'connect' ? 'connect' : 'replace it'}.`)
      return
    }
    if (trimmed.length < 10) {
      setKeyError('This doesn’t look like a whole key. Check that you copied all of it.')
      return
    }
    setKeyError('')
    setSecondError('')
    const values: Record<string, string> = { [provider.envVar]: trimmed }
    if (second && secondValue.trim()) values[second.envVar] = secondValue.trim()

    try {
      setPhase('checking')
      const check = await postJson(`/api/projects/${projectId}/credentials/verify`, { integrationId: provider.id, values })
      if (check.status === 422) {
        // What storing would refuse, under the field it is about.
        const message = check.data?.error || 'This key was refused.'
        if (second && check.data?.envVar === second.envVar) setSecondError(message)
        else setKeyError(message)
        setPhase('idle')
        return
      }
      // Any other answer (a limit, offline, a server error) is not a refusal:
      // storing asks the provider again before anything is kept.
      setPhase('storing')
      const stored = await postJson(`/api/projects/${projectId}/credentials`, { integrationId: provider.id, values })
      if (!stored.ok || stored.data?.success === false) {
        setFormError(stored.data?.error || 'The key could not be stored. Try again.')
        setPhase('idle')
        return
      }
      setPhase('idle')
      onDone()
    } catch {
      setFormError(NETWORK)
      setPhase('idle')
    }
  }

  const working = phase !== 'idle'
  const label =
    phase === 'checking' ? `Checking with ${provider.name}…`
    : phase === 'storing' ? (mode === 'connect' ? 'Connecting…' : 'Replacing…')
    : mode === 'connect' ? 'Connect' : 'Replace key'

  return (
    <KitModal
      open
      onClose={working ? () => {} : onClose}
      width="max-w-[520px]"
      title={mode === 'connect' ? `Connect ${provider.name}` : `Replace the ${provider.name} key`}
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </KitButton>
          <KitButton variant="primary" onClick={submit} loading={working}>
            {label}
          </KitButton>
        </>
      }
    >
      <div className="space-y-[18px]">
        <KeyField
          label={provider.keyLabel}
          envVar={provider.envVar}
          value={key}
          onChange={(v) => {
            setKey(v)
            setKeyError('')
          }}
          onEnter={submit}
          error={keyError}
          placeholder={provider.keyPlaceholder}
        >
          <KeyDocsLink href={provider.keyDocsUrl}>{provider.keyHelperText}</KeyDocsLink>
        </KeyField>

        {second && (
          <SecondField
            provider={provider}
            second={second}
            apiBase={apiBase}
            value={secondValue}
            onChange={(v) => {
              setSecondValue(v)
              setSecondError('')
            }}
            onEnter={submit}
            error={secondError}
            optional
          />
        )}
      </div>
      {formError && (
        <p role="alert" className="mt-[14px] text-[12.5px] leading-[18px] text-rose-300 [overflow-wrap:anywhere]">
          {formError}
        </p>
      )}
      <StoredNote />
    </KitModal>
  )
}

/** The second credential's field, with what is off without it and where it comes from. */
function SecondField({
  provider,
  second,
  apiBase,
  value,
  onChange,
  onEnter,
  error,
  optional = false,
}: {
  provider: CatalogProvider
  second: SecondaryCredential
  apiBase: ApiBase
  value: string
  onChange: (value: string) => void
  onEnter: () => void
  error?: string
  optional?: boolean
}) {
  return (
    <KeyField
      label={second.label}
      envVar={second.envVar}
      optional={optional}
      value={value}
      onChange={onChange}
      onEnter={onEnter}
      error={error}
      placeholder={second.placeholder}
    >
      {/* It read "Optional, add after deploying" while the receiver refused every event without it. */}
      <p className="mt-[8px] text-[12.5px] leading-[18px] text-zinc-400">
        {second.missingMeans}
        {second.endpointPath && <> Add this address in {provider.name} as an endpoint, then paste the {second.noun} it shows.</>}
      </p>
      {second.endpointPath && (
        <div className="mt-[8px]">
          <ReceivingUrl apiBase={apiBase} path={second.endpointPath} />
        </div>
      )}
      <KeyDocsLink href={second.docsUrl}>{second.helperText}</KeyDocsLink>
    </KeyField>
  )
}

/**
 * Store or replace a provider's second credential on its own, beside the
 * stored key: no key again, nothing to pick.
 */
export function SecondCredentialDialog({
  provider,
  projectId,
  apiBase,
  stored,
  onClose,
  onDone,
}: {
  provider: CatalogProvider
  projectId: string
  apiBase: ApiBase
  /** A value is already stored: this replaces it. */
  stored: boolean
  onClose: () => void
  onDone: () => void
}) {
  const second = provider.webhookKey!
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const trimmed = value.trim()
    if (saving) return
    if (!trimmed) {
      setError(`Paste the ${second.noun} to save it.`)
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await postJson(`/api/projects/${projectId}/credentials`, { integrationId: provider.id, values: { [second.envVar]: trimmed } })
      if (!res.ok || res.data?.success === false) {
        setError(res.data?.error || `The ${second.noun} could not be stored. Try again.`)
        setSaving(false)
        return
      }
      setSaving(false)
      onDone()
    } catch {
      setError(NETWORK)
      setSaving(false)
    }
  }

  return (
    <KitModal
      open
      onClose={saving ? () => {} : onClose}
      width="max-w-[520px]"
      title={`${stored ? 'Replace' : 'Add'} the ${provider.name} ${second.noun}`}
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </KitButton>
          <KitButton variant="primary" onClick={save} loading={saving}>
            {saving ? 'Saving…' : 'Save'}
          </KitButton>
        </>
      }
    >
      <SecondField provider={provider} second={second} apiBase={apiBase} value={value} onChange={(v) => { setValue(v); setError('') }} onEnter={save} error={error} />
      <StoredNote />
    </KitModal>
  )
}
