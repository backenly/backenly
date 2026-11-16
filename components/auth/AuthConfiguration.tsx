'use client'

/**
 * Sign-in methods: how the people using the app sign in, the rules that apply
 * to them, and what runs when someone signs up.
 *
 * Every provider the end-user OAuth runtime serves has a row (server/routes/
 * oauth.ts serves 'google', 'github', 'discord', 'facebook'), so a provider an
 * agent turned on can always be seen and turned off here (AUTH-F7).
 *
 * Social sign-in needs the founder's own OAuth app, so it is the one auth job
 * the agent cannot do: the dialog hands over the redirect URI ready to paste,
 * stores the client secret encrypted, and (for admins) turns a provider off.
 * Switches save the moment they change; a refusal shows on its row, in the
 * server's words.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { KeyRound, Mail } from 'lucide-react'
import { CopyField, KitButton, KitConfirmDialog, KitField, KitInput, KitModal, KitSwitch } from '@/components/inspector/kit'
import { Fact, Facts, Panel, Row, RowList, RowSkeleton, ROW_TEXT, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { FOCUS } from '@/components/console/tokens'
import { getProject } from '@/lib/api/projects'
import { authHeaders, readJson } from './api'
import { OAUTH_PROVIDER_IDS, PROVIDER_META, ProviderLabel, type ProviderId } from './providers'

export { ProviderLabel }

interface Policy {
  appName: string | null
  appUrl: string | null
  requireEmailVerification: boolean
  magicLinksEnabled: boolean
  effectiveAppName: string
  effectiveAppUrl: string | null
}

interface Hooks {
  functions: string[]
  endpoints: Array<{ id: string; host: string }>
}

const LINK = `rounded-[3px] text-zinc-100 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:decoration-white/60 ${FOCUS}`

export function SignInMethods({ projectId, canWrite, canAdminister, userCount }: { projectId: string; canWrite: boolean; canAdminister: boolean; userCount: number | null }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  const [emailOn, setEmailOn] = useState(false)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [noSender, setNoSender] = useState(false)
  const [apiBaseUrl, setApiBaseUrl] = useState<string | null>(null)
  const [hooks, setHooks] = useState<Hooks>({ functions: [], endpoints: [] })
  const [refused, setRefused] = useState<{ row: string; text: string } | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [dialog, setDialog] = useState<ProviderId | null>(null)
  const [appName, setAppName] = useState('')
  const [appUrl, setAppUrl] = useState('')

  const load = useCallback(async () => {
    try {
      const [oauth, authState, pol, smtp] = await Promise.all([
        fetch('/api/workspace-oauth', { headers: authHeaders(projectId), credentials: 'include', cache: 'no-store' }).then((r) => readJson<{ configs?: Array<{ provider: string; enabled: boolean }> }>(r, 'Sign-in methods could not be read.')),
        fetch(`/api/projects/${projectId}/auth-state`, { headers: authHeaders(projectId), credentials: 'include', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(`/api/projects/${projectId}/auth-email-settings`, { credentials: 'include', cache: 'no-store' }).then((r) => readJson<{ settings: Policy }>(r, 'Sign-in rules could not be read.')),
        fetch(`/api/projects/${projectId}/email/smtp`, { credentials: 'include', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ])
      setEnabled(new Set((oauth.configs ?? []).filter((c) => c.enabled).map((c) => c.provider)))
      setEmailOn(!!(authState?.providers ?? []).find((p: { id: string; enabled?: boolean }) => p.id === 'email')?.enabled)
      setPolicy(pol.settings)
      setAppName(pol.settings.appName ?? '')
      setAppUrl(pol.settings.appUrl ?? '')
      setNoSender(smtp?.smtp?.activeSource === 'none')
      setState('ready')
    } catch {
      setState((s) => (s === 'ready' ? s : 'failed'))
    }
  }, [projectId])

  useEffect(() => {
    void load()
    getProject(projectId)
      .then((p) => setApiBaseUrl(p.apiBaseUrl ?? null))
      .catch(() => setApiBaseUrl(null))
    // What runs when someone signs up: on-sign-up functions and auth.user.created endpoints.
    const read = (path: string) =>
      fetch(`/api/projects/${projectId}/${path}`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    void Promise.all([read('ai-functions'), read('webhooks')]).then(([fns, hooksBody]) => {
      const functions = ((fns?.functions ?? []) as Array<{ name?: string; triggerType?: string; status?: string }>)
        .filter((f) => f.name && f.triggerType === 'on_signup' && f.status !== 'inactive')
        .map((f) => f.name as string)
      const endpoints = ((hooksBody?.webhooks ?? []) as Array<{ id: string; eventType: string; targetUrl: string; active?: boolean }>)
        .filter((w) => w.eventType === 'auth.user.created' && w.active !== false)
        .map((w) => {
          let host = w.targetUrl
          try {
            host = new URL(w.targetUrl).host
          } catch {
            /* as stored */
          }
          return { id: w.id, host }
        })
      setHooks({ functions, endpoints })
    })
    // A provider connected in another tab (the agent's add_oauth_provider) shows on return.
    const onConnected = () => void load()
    window.addEventListener('backenly:oauth-connected', onConnected)
    return () => window.removeEventListener('backenly:oauth-connected', onConnected)
  }, [projectId, load])

  /** Saves the sign-in rules; the server's words when it refuses. */
  const savePolicy = async (row: string, patch: Partial<Pick<Policy, 'appName' | 'appUrl' | 'requireEmailVerification' | 'magicLinksEnabled'>>) => {
    if (!policy) return
    setSaving(row)
    setRefused(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/auth-email-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          appName: (patch.appName !== undefined ? patch.appName : policy.appName)?.trim() || null,
          appUrl: (patch.appUrl !== undefined ? patch.appUrl : policy.appUrl)?.trim() || null,
          requireEmailVerification: patch.requireEmailVerification ?? policy.requireEmailVerification,
          magicLinksEnabled: patch.magicLinksEnabled ?? policy.magicLinksEnabled,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const details: Record<string, string[] | undefined> = data.details ?? {}
        const words = Object.values(details).flat().filter(Boolean).join(' ')
        throw new Error(words || data.error || 'That change was not saved.')
      }
      setPolicy(data.settings)
      setAppName(data.settings.appName ?? '')
      setAppUrl(data.settings.appUrl ?? '')
    } catch (err) {
      setRefused({ row, text: err instanceof Error ? err.message : 'That change was not saved.' })
    } finally {
      setSaving(null)
    }
  }

  const emailActive = emailOn || (userCount ?? 0) > 0
  const base = `/app/projects/${projectId}`
  const refusedOn = (row: string) => (refused?.row === row ? <RefusedLine className="mt-[6px]">{refused.text}</RefusedLine> : null)
  const detailsDirty = !!policy && ((policy.appName ?? '') !== appName || (policy.appUrl ?? '') !== appUrl)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-[880px] space-y-[32px] px-[16px] py-[24px] sm:px-[24px]">
        <Section id="signin-methods" title="Methods">
          <Panel>
            {state === 'failed' ? (
              <ErrorRow things="sign-in methods" onRetry={() => void load()} />
            ) : state === 'loading' ? (
              <RowSkeleton rows={4} />
            ) : (
              <RowList>
                <Row
                  lead="glyph"
                  glyph={emailActive ? 'live' : 'idle'}
                  glyphLabel={emailActive ? 'On' : 'Off'}
                  title={
                    <span className={`${ROW_TITLE} inline-flex items-center gap-[8px]`}>
                      <Mail aria-hidden className="h-[14px] w-[14px] flex-shrink-0 text-zinc-400" strokeWidth={1.75} />
                      Email and password
                    </span>
                  }
                >
                  {!emailActive && <p className={`${ROW_TEXT} !mt-[2px] text-faint`}>Turns on when your agent adds sign-up.</p>}
                </Row>
                {OAUTH_PROVIDER_IDS.map((id) => {
                  const on = enabled.has(id)
                  return (
                    <Row
                      key={id}
                      lead="glyph"
                      glyph={on ? 'live' : 'idle'}
                      glyphLabel={on ? 'On' : 'Off'}
                      title={<ProviderLabel provider={id} className={`${ROW_TITLE} !gap-[8px]`} />}
                      actions={
                        canWrite ? (
                          <KitButton size="sm" variant={on ? 'ghost' : 'secondary'} onClick={() => setDialog(id)}>
                            {on ? 'Manage' : 'Set up'}
                          </KitButton>
                        ) : undefined
                      }
                    />
                  )
                })}
                {policy && (
                  <Row
                    lead="glyph"
                    glyph={policy.magicLinksEnabled ? 'live' : 'idle'}
                    glyphLabel={policy.magicLinksEnabled ? 'On' : 'Off'}
                    title={<span className={ROW_TITLE}>Magic links</span>}
                    actions={
                      canWrite ? (
                        <KitSwitch
                          checked={policy.magicLinksEnabled}
                          onChange={(next) => void savePolicy('magic', { magicLinksEnabled: next })}
                          label="Magic links"
                          disabled={saving !== null}
                        />
                      ) : undefined
                    }
                  >
                    <Facts className="!mt-[2px]">
                      <Fact>Sign in with an emailed link</Fact>
                      {policy.magicLinksEnabled && !policy.effectiveAppUrl && <span className="font-medium text-zinc-50">Needs an App URL</span>}
                    </Facts>
                    {refusedOn('magic')}
                  </Row>
                )}
              </RowList>
            )}
          </Panel>
        </Section>

        {policy && state === 'ready' && (
          <Section id="signin-rules" title="Rules">
            <Panel>
              <RowList>
                <Row
                  lead="none"
                  title={<span className={ROW_TITLE}>Require a verified email</span>}
                  actions={
                    canWrite ? (
                      <KitSwitch
                        checked={policy.requireEmailVerification}
                        onChange={(next) => void savePolicy('verify', { requireEmailVerification: next })}
                        label="Require a verified email"
                        disabled={saving !== null || (noSender && !policy.requireEmailVerification)}
                      />
                    ) : undefined
                  }
                >
                  <p className={`${ROW_TEXT} !mt-[2px] text-faint`}>
                    {noSender && !policy.requireEmailVerification
                      ? 'Set up a sender in Email first: without one, new people would wait for an email that never comes.'
                      : 'People who signed up earlier count as verified.'}
                  </p>
                  {refusedOn('verify')}
                </Row>
                <li className="px-[20px] py-[16px]">
                  <form
                    className="grid grid-cols-1 gap-[14px] sm:grid-cols-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void savePolicy('details', { appName, appUrl })
                    }}
                  >
                    <KitField label="App URL" hint="Where reset and magic links open.">
                      <KitInput type="url" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://app.example.com" spellCheck={false} disabled={!canWrite} />
                    </KitField>
                    <KitField label="App name" hint={`Shown in sign-in emails. Empty uses “${policy.effectiveAppName}”.`}>
                      <KitInput value={appName} onChange={(e) => setAppName(e.target.value)} placeholder={policy.effectiveAppName} disabled={!canWrite} />
                    </KitField>
                    {canWrite && (
                      <div className="flex items-center gap-[12px] sm:col-span-2">
                        <KitButton type="submit" size="sm" loading={saving === 'details'} disabled={!detailsDirty || saving !== null}>
                          Save
                        </KitButton>
                        {refusedOn('details')}
                      </div>
                    )}
                  </form>
                </li>
              </RowList>
            </Panel>
          </Section>
        )}

        {(hooks.functions.length > 0 || hooks.endpoints.length > 0) && (
          <Section id="signin-hooks" title="When someone signs up">
            <Panel>
              <RowList>
                {hooks.functions.map((name) => (
                  <Row
                    key={`fn-${name}`}
                    lead="none"
                    title={
                      <Link href={`${base}/functions?fn=${encodeURIComponent(name)}`} className={`${LINK} font-mono text-[12.5px]`}>
                        {name}
                      </Link>
                    }
                  >
                    <Facts className="!mt-[4px]">
                      <Fact>Function, runs on each sign-up</Fact>
                    </Facts>
                  </Row>
                ))}
                {hooks.endpoints.map((w) => (
                  <Row
                    key={`wh-${w.id}`}
                    lead="none"
                    title={
                      <Link href={`${base}/webhooks?endpoint=${encodeURIComponent(w.id)}`} className={`${LINK} text-[13px]`}>
                        {w.host}
                      </Link>
                    }
                  >
                    <Facts className="!mt-[4px]">
                      <Fact>Webhook, sent auth.user.created</Fact>
                    </Facts>
                  </Row>
                ))}
              </RowList>
            </Panel>
          </Section>
        )}
      </div>

      {dialog && (
        <OAuthDialog
          projectId={projectId}
          provider={dialog}
          enabled={enabled.has(dialog)}
          apiBaseUrl={apiBaseUrl}
          canAdminister={canAdminister}
          onClose={() => setDialog(null)}
          onChanged={async () => {
            setDialog(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

/** One provider's OAuth client: the redirect URI to paste, the ID and the secret; Turn off for admins. */
function OAuthDialog({
  projectId,
  provider,
  enabled,
  apiBaseUrl,
  canAdminister,
  onClose,
  onChanged,
}: {
  projectId: string
  provider: ProviderId
  enabled: boolean
  apiBaseUrl: string | null
  canAdminister: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const meta = PROVIDER_META[provider]
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState<'save' | 'off' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  const redirect = apiBaseUrl ? `${apiBaseUrl}/auth/${provider}/callback` : null
  const upper = provider.toUpperCase()

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/credentials`, {
        method: 'POST',
        headers: authHeaders(projectId, true),
        credentials: 'include',
        body: JSON.stringify({ integrationId: provider, values: { [`${upper}_CLIENT_ID`]: clientId.trim(), [`${upper}_CLIENT_SECRET`]: secret } }),
      })
      await readJson(res, 'The credentials were not saved.')
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The credentials were not saved.')
    } finally {
      setBusy(null)
    }
  }

  const turnOff = async () => {
    setBusy('off')
    setError(null)
    try {
      const res = await fetch(`/api/workspace-oauth/${provider}`, { method: 'DELETE', headers: authHeaders(projectId), credentials: 'include' })
      await readJson(res, `${meta.name} sign-in was not turned off.`)
      setConfirmOff(false)
      await onChanged()
    } catch (err) {
      setConfirmOff(false)
      setError(err instanceof Error ? err.message : `${meta.name} sign-in was not turned off.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <KitModal
        open={!confirmOff}
        onClose={() => busy === null && onClose()}
        width="max-w-lg"
        title={`${meta.name} sign-in`}
        footer={
          <>
            <span className="mr-auto hidden items-center gap-[6px] text-[12.5px] text-faint sm:inline-flex">
              <KeyRound aria-hidden className="h-[14px] w-[14px]" /> Encrypted at rest
            </span>
            {enabled && canAdminister && (
              <KitButton variant="ghost" onClick={() => setConfirmOff(true)} disabled={busy !== null} className="hover:!text-rose-200">
                Turn off
              </KitButton>
            )}
            <KitButton variant="ghost" onClick={onClose} disabled={busy !== null}>
              Cancel
            </KitButton>
            <KitButton variant="primary" onClick={() => void save()} loading={busy === 'save'} disabled={!clientId.trim() || !secret}>
              {enabled ? 'Save' : 'Turn on'}
            </KitButton>
          </>
        }
      >
        <div className="space-y-[16px]">
          <div>
            <p className="mb-[6px] text-[12.5px] font-medium leading-[18px] text-zinc-300">Redirect URI</p>
            {redirect ? <CopyField value={redirect} label="Copy redirect URI" /> : <p className="text-[12.5px] text-faint">The project’s address could not be read. Reload to try again.</p>}
            <p className="mt-[6px] text-[12px] leading-[17px] text-faint">
              Add it to your OAuth client in{' '}
              <a href={meta.console} target="_blank" rel="noopener noreferrer" className={LINK}>
                {meta.consoleName}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              .
            </p>
          </div>
          <KitField label="Client ID">
            <KitInput value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={enabled ? 'A new client ID replaces the stored one' : ''} autoComplete="off" spellCheck={false} />
          </KitField>
          <KitField label="Client secret">
            <KitInput type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />
          </KitField>
          {error && <RefusedLine>{error}</RefusedLine>}
        </div>
      </KitModal>
      <KitConfirmDialog
        open={confirmOff}
        onCancel={() => busy === null && setConfirmOff(false)}
        onConfirm={() => void turnOff()}
        title={`Turn off ${meta.name} sign-in?`}
        description={`People can no longer sign in with ${meta.name}.`}
        undoable={false}
        lost={`The client secret is deleted. You'll paste it again to turn ${meta.name} back on.`}
        confirmLabel="Turn off"
        danger
        busy={busy === 'off'}
      />
    </>
  )
}
