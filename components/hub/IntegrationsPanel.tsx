'use client'

/**
 * INTEGRATIONS: the providers this project's functions can call.
 *
 *   Integrations  2 connected
 *   Functions call a connected provider as ctx.integrations.<name>. The key never appears in code.
 *   Connected
 *   │ R  Resend ●                                                            ⋯ │
 *   │    re_d7a8…9dac   Connected Nov 10   Called from 2 functions            │
 *   │ ▤  PostHog ○                                                           ⋯ │
 *   │    Format checked only   phc_291…a9ad   Connected Nov 12                 │
 *   Available                                   [Search providers] [All categories]
 *   │ S  Stripe     Payment processing                                [Connect] │
 *   Need another provider? Request it.
 *
 * A document page (decision 6): providers are rows, connected first; each
 * provider has its own page at ?connector=<id> (ConnectorPage.tsx). Connect is
 * one step (IntegrationDialogs.tsx). Nothing changes on screen before the
 * server agrees: a key is shown as stored, re-checked or removed only from the
 * server's answer, and a refusal is said on the provider's row in the server's
 * own words.
 *
 * Roles (useProjectRole), hidden never disabled: viewers read; developers
 * connect, replace and re-check keys; disconnecting is admin only, as the keys
 * route's DELETE is.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { KitButton, KitConfirmDialog, KitSelect, OverflowMenu, PageHeader, StatusGlyph } from '@/components/inspector/kit'
import { FOCUS, PAGE_GUTTER, PAGE_WIDTH, T_SECTION } from '@/components/console/tokens'
import { Fact, Facts, Panel, RowList, RowSkeleton, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine } from '@/components/console/states'
import { SearchField, type MenuItems } from '@/components/console/InstrumentBar'
import { Time } from '@/components/console/Time'
import { getProject } from '@/lib/api/projects'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { integrationCatalog, type CatalogProvider } from './integration-catalog'
import { accessorsFor, functionsCalling, functionsWaitingOn } from './integration-calls'
import { ProviderMark } from './integration-marks'
import { ConnectDialog, SecondCredentialDialog, type ApiBase } from './IntegrationDialogs'
import { ConnectorPage, type Callers } from './ConnectorPage'
import {
  canRecheck,
  functionsCount,
  providerStates,
  providerStatus,
  shortKey,
  type IntegrationsAnswer,
  type KeyStatus,
  type ProviderState,
} from './integration-state'

const CATALOG = integrationCatalog()
const REQUEST_HREF = 'mailto:hello@backenly.com?subject=Connector%20request'

/** A function, as GET …/ai-functions lists it: enough to find what its code calls. */
interface FunctionCode {
  name: string
  generatedCode?: string | null
}

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; answer: IntegrationsAnswer; at: number; refreshFailed: boolean }

type Dialog =
  | { kind: 'connect'; id: string; then: 'page' | 'stay' }
  | { kind: 'replace'; id: string }
  | { kind: 'second'; id: string }
  | { kind: 'disconnect'; id: string }

export function IntegrationsPanel() {
  const params = useParams()
  const projectId = params.id as string
  const router = useRouter()
  const pathname = usePathname() ?? `/app/projects/${projectId}/integrations`
  const search = useSearchParams()
  const connectorId = search?.get('connector') ?? null

  const role = useProjectRole(projectId)
  const agentConnection = useAgentConnection(projectId)
  const agent = { status: agentConnection.status, client: agentConnection.client }

  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [reloading, setReloading] = useState(false)
  const [fns, setFns] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; list: FunctionCode[] }>({ status: 'loading' })
  // The project's API base as the Connect page gives it out: an operator's
  // override when one is set, else the address of the project's region. A
  // receiving URL is built from it, never from this page's own origin.
  const [apiBase, setApiBase] = useState<ApiBase>({ state: 'loading' })
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState<Record<string, 'recheck' | 'disconnect' | undefined>>({})
  const [refused, setRefused] = useState<Record<string, string | undefined>>({})
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')

  const fetchIntegrations = useCallback(async () => {
    setReloading(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/integrations`)
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as Partial<IntegrationsAnswer>
      const answer: IntegrationsAnswer = { integrations: body.integrations ?? {}, keyVault: body.keyVault ?? {} }
      setLoad({ status: 'ready', answer, at: Date.now(), refreshFailed: false })
    } catch {
      // A failed refresh keeps what was read; a failed first read shows no state at all.
      setLoad((prev) => (prev.status === 'ready' ? { ...prev, refreshFailed: true } : { status: 'error' }))
    } finally {
      setReloading(false)
    }
  }, [projectId])

  const fetchFunctions = useCallback(async () => {
    setFns({ status: 'loading' })
    try {
      const res = await fetch(`/api/projects/${projectId}/ai-functions`)
      if (!res.ok) throw new Error(String(res.status))
      const body = await res.json()
      const list: FunctionCode[] = Array.isArray(body?.functions) ? body.functions : []
      setFns({ status: 'ready', list })
    } catch {
      setFns({ status: 'error' })
    }
  }, [projectId])

  useEffect(() => {
    void fetchIntegrations()
    void fetchFunctions()
  }, [fetchIntegrations, fetchFunctions])

  useEffect(() => {
    let live = true
    getProject(projectId).then(
      (project) => {
        if (!live) return
        const url = project.apiUrlProd || project.apiUrlStaging || project.apiUrlDev || project.apiBaseUrl || null
        setApiBase({ state: 'ready', url })
      },
      () => {
        if (live) setApiBase({ state: 'failed' })
      },
    )
    return () => {
      live = false
    }
  }, [projectId])

  const answer = load.status === 'ready' ? load.answer : null
  const states = useMemo(() => providerStates(CATALOG, answer), [answer])
  const byId = useMemo(() => new Map(states.map((s) => [s.provider.id, s])), [states])
  const callersOf = useCallback(
    (providerId: string): FunctionCode[] | null => (fns.status === 'ready' ? functionsCalling(providerId, fns.list) : null),
    [fns],
  )
  const connectedIds = useMemo(() => states.filter((s) => s.connected).map((s) => s.provider.id), [states])
  /** Functions whose calls fail until this provider is connected: nothing connected serves them. */
  const waitingOn = useCallback(
    (providerId: string): FunctionCode[] | null => (fns.status === 'ready' ? functionsWaitingOn(providerId, fns.list, connectedIds) : null),
    [fns, connectedIds],
  )

  const canWrite = role.canWrite
  const canAdminister = role.canAdminister
  const viewer = role.role === 'VIEWER'
  const providerHref = (id: string) => `${pathname}?connector=${encodeURIComponent(id)}`

  // ── Actions: each waits for the server, then shows its answer ──────────────

  const recheck = async (s: ProviderState) => {
    const id = s.provider.id
    if (busy[id]) return
    setBusy((b) => ({ ...b, [id]: 'recheck' }))
    setRefused((r) => ({ ...r, [id]: undefined }))
    try {
      const res = await fetch(`/api/projects/${projectId}/integrations/keys/recheck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId: id }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body?.key) {
        setRefused((r) => ({ ...r, [id]: body?.error || `Could not check the ${s.provider.name} key. Try again.` }))
        return
      }
      const fresh = body.key as KeyStatus
      // The server's own answer about the key, as the next read would give it.
      setLoad((prev) =>
        prev.status === 'ready'
          ? { ...prev, answer: { ...prev.answer, keyVault: { ...prev.answer.keyVault, [id]: { ...prev.answer.keyVault[id], ...fresh } } } }
          : prev,
      )
    } catch {
      setRefused((r) => ({ ...r, [id]: 'Could not reach Backenly. Check your connection and try again.' }))
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }))
    }
  }

  const disconnect = async (s: ProviderState) => {
    const id = s.provider.id
    setBusy((b) => ({ ...b, [id]: 'disconnect' }))
    setRefused((r) => ({ ...r, [id]: undefined }))
    // The key, then the second credential: a provider is disconnected only with both gone.
    const vaultIds = [id, ...(s.provider.webhookKey && s.second ? [s.provider.webhookKey.vaultId] : [])]
    let refusal: string | null = null
    for (const vaultId of vaultIds) {
      try {
        const res = await fetch(`/api/projects/${projectId}/integrations/keys?integrationId=${encodeURIComponent(vaultId)}`, { method: 'DELETE' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok || body?.success === false) {
          refusal =
            res.status === 403
              ? 'Only admins can disconnect a provider.'
              : body?.error || `Could not disconnect ${s.provider.name}. Try again.`
          break
        }
      } catch {
        refusal = 'Could not reach Backenly. Check your connection and try again.'
        break
      }
    }
    setDialog(null)
    if (refusal) setRefused((r) => ({ ...r, [id]: refusal ?? undefined }))
    await fetchIntegrations()
    setBusy((b) => ({ ...b, [id]: undefined }))
  }

  const openConnect = (id: string, then: 'page' | 'stay') => {
    setRefused((r) => ({ ...r, [id]: undefined }))
    setDialog({ kind: 'connect', id, then })
  }

  /** The ⋯ items a connected provider offers this person, without the one its state shows as a button. */
  const menuFor = (s: ProviderState, attention: string | null): MenuItems => {
    if (!canWrite || !s.connected) return []
    const items: MenuItems = []
    const second = s.provider.webhookKey
    if (attention !== 'replace') items.push({ label: 'Replace key', onClick: () => setDialog({ kind: 'replace', id: s.provider.id }) })
    if (second && s.second) items.push({ label: `Replace the ${second.noun}`, onClick: () => setDialog({ kind: 'second', id: s.provider.id }) })
    if (attention !== 'recheck' && canRecheck(s)) items.push({ label: 'Check again', onClick: () => void recheck(s) })
    if (canAdminister) {
      items.push({ separator: true })
      items.push({ label: 'Disconnect…', danger: true, onClick: () => setDialog({ kind: 'disconnect', id: s.provider.id }) })
    }
    return items
  }

  /** The one action a provider's state asks for, shown as a button: a rejected key is replaced, an unreachable one checked again. */
  const attentionFor = (s: ProviderState): 'replace' | 'recheck' | null => {
    if (!canWrite || !s.connected) return null
    if (s.key?.verification === 'rejected') return 'replace'
    if (s.key?.verification === 'unreachable') return 'recheck'
    return null
  }

  const dialogProvider = dialog ? byId.get(dialog.id) ?? null : null
  const dialogs = dialogProvider && dialog && (
    <>
      {(dialog.kind === 'connect' || dialog.kind === 'replace') && (
        <ConnectDialog
          mode={dialog.kind}
          provider={dialogProvider.provider}
          projectId={projectId}
          apiBase={apiBase}
          onClose={() => setDialog(null)}
          onDone={() => {
            const goTo = dialog.kind === 'connect' && dialog.then === 'page'
            setDialog(null)
            void fetchIntegrations()
            if (goTo) router.push(providerHref(dialogProvider.provider.id))
          }}
        />
      )}
      {dialog.kind === 'second' && dialogProvider.provider.webhookKey && (
        <SecondCredentialDialog
          provider={dialogProvider.provider}
          projectId={projectId}
          apiBase={apiBase}
          stored={!!dialogProvider.second}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null)
            void fetchIntegrations()
          }}
        />
      )}
      <KitConfirmDialog
        open={dialog.kind === 'disconnect'}
        onCancel={() => setDialog(null)}
        onConfirm={() => void disconnect(dialogProvider)}
        busy={busy[dialogProvider.provider.id] === 'disconnect'}
        danger
        title={`Disconnect ${dialogProvider.provider.name}?`}
        description={
          <>
            Functions that call <code className="font-mono text-[12.5px] text-zinc-300">ctx.integrations.{dialogProvider.provider.id}</code> fail
            until you connect it again.
          </>
        }
        undoable={false}
        lost={dialogProvider.second ? 'The keys aren’t kept, so you’ll paste them again.' : 'The key isn’t kept, so you’ll paste it again.'}
        confirmLabel="Disconnect"
      />
    </>
  )

  // ── A provider's own page ──────────────────────────────────────────────────

  const open = connectorId ? byId.get(connectorId) ?? null : null
  if (open) {
    const id = open.provider.id
    const callerList = callersOf(id)
    const callers: Callers =
      fns.status === 'loading' ? { status: 'loading' }
      : fns.status === 'error' || !callerList ? { status: 'error' }
      : { status: 'ready', list: callerList.map((f) => ({ name: f.name, accessors: accessorsFor(id, f.generatedCode) })) }
    const attention = attentionFor(open)
    return (
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-[48px]`}>
        <ConnectorPage
          projectId={projectId}
          state={open}
          status={answer ? providerStatus(open) : null}
          loading={load.status === 'loading'}
          loadFailed={load.status === 'error'}
          onRetryLoad={() => void fetchIntegrations()}
          listHref={pathname}
          canWrite={canWrite}
          canAdminister={canAdminister}
          viewer={viewer}
          agent={agent}
          apiBase={apiBase}
          callers={callers}
          onRetryCallers={() => void fetchFunctions()}
          busy={busy[id] ?? null}
          refused={refused[id] ?? null}
          menu={menuFor(open, attention)}
          attention={
            attention === 'replace'
              ? { label: 'Replace key', onClick: () => setDialog({ kind: 'replace', id }) }
              : attention === 'recheck'
                ? { label: 'Check again', onClick: () => void recheck(open), loading: busy[id] === 'recheck' }
                : null
          }
          onConnect={() => openConnect(id, 'stay')}
          onSecond={() => setDialog({ kind: 'second', id })}
        />
        {dialogs}
      </div>
    )
  }

  // ── The list ───────────────────────────────────────────────────────────────

  const connected = states
    .filter((s) => s.connected)
    .sort((a, b) => rank(a) - rank(b))
  const completeCount = states.filter((s) => s.complete).length
  const q = query.trim().toLowerCase()
  const available = states
    .filter((s) => !s.connected)
    .filter((s) => category === 'all' || s.category.id === category)
    .filter((s) => !q || `${s.provider.name} ${s.provider.tagline} ${s.category.title}`.toLowerCase().includes(q))
    // A provider some function already calls comes first: those calls fail until it is connected.
    .sort((a, b) => Number((waitingOn(b.provider.id)?.length ?? 0) > 0) - Number((waitingOn(a.provider.id)?.length ?? 0) > 0))

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-[48px]`}>
      <PageHeader
        flush
        title="Integrations"
        meta={
          load.status === 'ready' ? (
            <span className="text-[13px] tabular-nums text-faint">{completeCount > 0 ? `${completeCount} connected` : 'None connected'}</span>
          ) : undefined
        }
        description={
          <>
            Functions call a connected provider as <code className="font-mono text-[13px] text-zinc-300">ctx.integrations.&lt;name&gt;</code>. The key
            never appears in code.
          </>
        }
      />
      {viewer && <p className="-mt-[8px] mb-[24px] text-[13px] leading-[20px] text-faint">Only developers and admins can connect providers.</p>}

      <div className="space-y-[32px]">
        {load.status === 'error' ? (
          <Section id="integrations-connected" title="Connected">
            <Panel>
              <ErrorRow things="connected providers" stillWorks={canWrite ? 'You can still connect a provider below.' : undefined} onRetry={() => void fetchIntegrations()} retrying={reloading} />
            </Panel>
          </Section>
        ) : load.status === 'loading' ? (
          <Section id="integrations-connected" title="Connected">
            <Panel>
              <RowSkeleton rows={2} />
            </Panel>
          </Section>
        ) : (
          connected.length > 0 && (
            <Section id="integrations-connected" title="Connected">
              <Panel>
                {load.refreshFailed && (
                  <ErrorRow things="providers" staleAt={load.at} onRetry={() => void fetchIntegrations()} retrying={reloading} />
                )}
                <RowList>
                  {connected.map((s) => {
                    const attention = attentionFor(s)
                    return (
                      <ConnectedRow
                        key={s.provider.id}
                        state={s}
                        href={providerHref(s.provider.id)}
                        callers={callersOf(s.provider.id)}
                        canWrite={canWrite}
                        busy={busy[s.provider.id] ?? null}
                        refused={refused[s.provider.id] ?? null}
                        menu={menuFor(s, attention)}
                        attention={attention}
                        onReplace={() => setDialog({ kind: 'replace', id: s.provider.id })}
                        onRecheck={() => void recheck(s)}
                        onSecond={() => setDialog({ kind: 'second', id: s.provider.id })}
                      />
                    )
                  })}
                </RowList>
              </Panel>
            </Section>
          )
        )}

        <section aria-labelledby="integrations-available">
          <div className="mb-[10px] flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
            <h2 id="integrations-available" className={T_SECTION}>
              Available
            </h2>
            <div className="flex w-full items-center gap-[8px] sm:ml-auto sm:w-auto">
              <SearchField value={query} onChange={setQuery} placeholder="Search providers" className="min-w-0 flex-1 sm:w-[220px] sm:flex-none" />
              <KitSelect
                aria-label="Category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                wrapperClassName="!w-[150px] flex-shrink-0 sm:!w-[180px]"
              >
                <option value="all">All categories</option>
                {CATALOG.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </KitSelect>
            </div>
          </div>
          <Panel>
            {load.status === 'loading' ? (
              <RowSkeleton rows={5} lead="icon" />
            ) : available.length === 0 ? (
              <p className="px-[20px] py-[14px] text-[13px] leading-[20px] text-zinc-400">
                {q || category !== 'all' ? 'No provider matches.' : 'Every provider is connected.'}
              </p>
            ) : (
              <RowList>
                {available.map((s) => (
                  <AvailableRow
                    key={s.provider.id}
                    state={s}
                    href={providerHref(s.provider.id)}
                    callers={waitingOn(s.provider.id)}
                    canWrite={canWrite}
                    onConnect={() => openConnect(s.provider.id, 'page')}
                  />
                ))}
              </RowList>
            )}
          </Panel>
        </section>

        <p className="text-[13px] leading-[20px] text-faint">
          Need another provider?{' '}
          <a
            href={REQUEST_HREF}
            className={`rounded-[3px] text-zinc-200 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/60 ${FOCUS}`}
          >
            Request it
          </a>
          .
        </p>
      </div>
      {dialogs}
    </div>
  )
}

/** Attention first: a rejected key, then a missing second credential, then the rest in catalog order. */
function rank(s: ProviderState): number {
  if (s.key?.verification === 'rejected') return 0
  if (s.needsSecond) return 1
  return 2
}

/** The row's name is a link to the provider's page; the whole row is its target, its controls stay their own. */
function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-[3px] after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-white/70`}
    >
      {children}
    </Link>
  )
}

function ConnectedRow({
  state,
  href,
  callers,
  canWrite,
  busy,
  refused,
  menu,
  attention,
  onReplace,
  onRecheck,
  onSecond,
}: {
  state: ProviderState
  href: string
  callers: FunctionCode[] | null
  canWrite: boolean
  busy: 'recheck' | 'disconnect' | null
  refused: string | null
  menu: MenuItems
  attention: 'replace' | 'recheck' | null
  onReplace: () => void
  onRecheck: () => void
  onSecond: () => void
}) {
  const { provider, category, key } = state
  const status = providerStatus(state)
  const n = callers?.length ?? 0
  return (
    <li className="relative px-[20px] py-[14px] transition-colors duration-150 hover:bg-[#121316]">
      <div className="flex items-start gap-[12px]">
        <ProviderMark provider={provider} categoryId={category.id} className="mt-[0.5px]" />
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-6 gap-y-3 sm:flex-nowrap">
          <div className="min-w-0 flex-[1_1_240px]">
            <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[2px]">
              <span className={ROW_TITLE}>
                <RowLink href={href}>{provider.name}</RowLink>
              </span>
              {status.word && status.glyph === 'waiting' && canWrite ? (
                // The state is the action: it opens the dialog that adds what is missing.
                <button
                  type="button"
                  onClick={onSecond}
                  className={`relative z-[1] inline-flex items-center gap-[6px] rounded-[5px] text-[12.5px] font-medium leading-[16px] text-zinc-50 underline decoration-zinc-50/30 underline-offset-[3px] transition-colors duration-150 hover:decoration-zinc-50/80 ${FOCUS}`}
                >
                  <StatusGlyph state="waiting" label="" />
                  {status.word}
                </button>
              ) : (
                <StatusGlyph state={status.glyph} label={status.label} showLabel={!!status.word} />
              )}
            </div>
            <Facts className="!mt-[4px]">
              {busy === 'recheck' ? (
                <Fact>
                  <span role="status">Checking with {provider.name}…</span>
                </Fact>
              ) : (
                status.fact && (
                  <Fact>
                    <span title={status.detail}>{status.fact}</span>
                  </Fact>
                )
              )}
              {key && (
                <Fact>
                  <code className="font-mono text-[11.5px] text-zinc-400">{shortKey(key.maskedKey)}</code>
                </Fact>
              )}
              {key && (
                <Fact>
                  <Time iso={key.connectedAt} mode="date" prefix="Connected" />
                </Fact>
              )}
              {n > 0 && <Fact>Called from {functionsCount(n)}</Fact>}
            </Facts>
            {status.glyph === 'failed' && status.detail && (
              <p className="mt-[6px] text-[12.5px] leading-[18px] text-rose-300 [overflow-wrap:anywhere]">{status.detail}</p>
            )}
            {busy === 'disconnect' && (
              <p role="status" className="mt-[6px] text-[12.5px] leading-[18px] text-faint">
                Disconnecting…
              </p>
            )}
            {refused && <RefusedLine className="mt-[6px]">{refused}</RefusedLine>}
          </div>
          {attention && (
            <div className="relative z-[1] flex flex-shrink-0 items-center">
              {attention === 'replace' ? (
                <KitButton size="sm" onClick={onReplace}>
                  Replace key
                </KitButton>
              ) : (
                <KitButton size="sm" onClick={onRecheck} loading={busy === 'recheck'}>
                  Check again
                </KitButton>
              )}
            </div>
          )}
        </div>
        {menu.length > 0 && (
          <div className="relative z-[1] -mr-[6px] -mt-[3px] flex-shrink-0">
            <OverflowMenu label={`More actions for ${provider.name}`} items={menu} width="w-[230px]" />
          </div>
        )}
      </div>
    </li>
  )
}

function AvailableRow({
  state,
  href,
  callers,
  canWrite,
  onConnect,
}: {
  state: ProviderState
  href: string
  callers: FunctionCode[] | null
  canWrite: boolean
  onConnect: () => void
}) {
  const { provider, category } = state
  const n = callers?.length ?? 0
  const accessor = n > 0 ? `ctx.integrations.${accessorsFor(provider.id, callers![0].generatedCode)[0] ?? provider.id}` : ''
  return (
    <li className="relative px-[20px] py-[12px] transition-colors duration-150 hover:bg-[#121316]">
      <div className="flex min-h-[32px] items-center gap-[12px]">
        <ProviderMark provider={provider} categoryId={category.id} />
        <div className="flex min-w-0 flex-1 flex-col gap-y-[2px] sm:flex-row sm:items-baseline sm:gap-x-[12px]">
          <span className={`${ROW_TITLE} flex-shrink-0`}>
            <RowLink href={href}>{provider.name}</RowLink>
          </span>
          <span className="min-w-0 truncate text-[12.5px] leading-[18px] text-faint">{provider.tagline}</span>
          {n > 0 && (
            <span
              className="inline-flex flex-shrink-0 items-center gap-[6px] text-[12.5px] font-medium leading-[18px] text-zinc-50"
              title={`${n === 1 ? callers![0].name : functionsCount(n)} ${n === 1 ? 'calls' : 'call'} ${accessor}, which fails until ${provider.name} is connected.`}
            >
              <StatusGlyph state="waiting" label="Not connected and already called" />
              Called from {functionsCount(n)}
            </span>
          )}
        </div>
        {canWrite && (
          <div className="relative z-[1] flex-shrink-0">
            <KitButton size="sm" onClick={onConnect} aria-label={`Connect ${provider.name}`}>
              Connect
            </KitButton>
          </div>
        )}
      </div>
    </li>
  )
}
