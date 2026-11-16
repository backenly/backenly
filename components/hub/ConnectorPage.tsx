'use client'

/**
 * One provider's page: /integrations?connector=stripe (decision 6: a
 * configured object gets its own URL page).
 *
 *   Integrations / Stripe
 *   (S) Stripe  ○ Not connected                                        [Connect]
 *   Functions call it as ctx.integrations.stripe.
 *   Keys
 *   │ ○ STRIPE_SECRET_KEY      Secret key       Not stored                      │
 *   │ ○ STRIPE_WEBHOOK_SECRET  Webhook signing secret  Not stored               │
 *   │   Stripe events are refused until it's stored.                            │
 *   Stripe sends events to
 *   [https://backenly.com/api/v1/p_movie/webhooks/stripe                     ⧉]
 *   Add it as an endpoint in Stripe, then store the webhook signing secret it shows.
 *   Called from                                                   Found in code
 *   │ No function calls Stripe yet.                                             │
 *   Build with Stripe
 *   │ Stripe webhook endpoint                                                   │  before connecting: a plain list
 *   ┌ Ask your agent ──────────────────────────────────────────────────────────┐  after: one copyable request each
 *
 * Nothing here changes before the server agrees: the parent runs every action
 * and passes its outcome back (busy, refused).
 */

import { useId, type ReactNode } from 'react'
import Link from 'next/link'
import {
  Breadcrumbs,
  CopyButton,
  KitButton,
  OverflowMenu,
  PageHeader,
  StatusGlyph,
} from '@/components/inspector/kit'
import { EDGE, FOCUS, RULE, R_PANEL, WELL } from '@/components/console/tokens'
import { Fact, Facts, Panel, RowList, RowSkeleton, ROW_TITLE, Section } from '@/components/autonomy/rows'
import { ErrorRow, RefusedLine, agentSentence, type AgentState } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import type { MenuItems } from '@/components/console/InstrumentBar'
import { ProviderMark } from './integration-marks'
import { ReceivingUrl, type ApiBase } from './IntegrationDialogs'
import {
  buildOptions,
  buildRequest,
  credentialGlyph,
  shortKey,
  type KeyStatus,
  type ProviderState,
  type ProviderStatus,
} from './integration-state'

export interface Caller {
  name: string
  /** The accessors in its code that reach this provider: ['email']. */
  accessors: string[]
}

export type Callers = { status: 'loading' } | { status: 'error' } | { status: 'ready'; list: Caller[] }

export interface ConnectorPageProps {
  projectId: string
  /** The provider and what the last read said about it; null while the first read is out or failed. */
  state: ProviderState
  status: ProviderStatus | null
  loading: boolean
  loadFailed: boolean
  onRetryLoad: () => void
  listHref: string
  canWrite: boolean
  canAdminister: boolean
  viewer: boolean
  agent: AgentState
  apiBase: ApiBase
  callers: Callers
  onRetryCallers: () => void
  busy: 'recheck' | 'disconnect' | null
  refused: string | null
  menu: MenuItems
  /** The one visible action a state asks for (Replace key for a rejected key, Check again when unreachable). */
  attention: { label: string; onClick: () => void; loading?: boolean } | null
  onConnect: () => void
  onSecond: () => void
}

export function ConnectorPage({
  projectId,
  state,
  status,
  loading,
  loadFailed,
  onRetryLoad,
  listHref,
  canWrite,
  canAdminister,
  viewer,
  agent,
  apiBase,
  callers,
  onRetryCallers,
  busy,
  refused,
  menu,
  attention,
  onConnect,
  onSecond,
}: ConnectorPageProps) {
  const { provider, category } = state
  const second = provider.webhookKey
  const known = !loading && !loadFailed
  const connected = known && state.connected
  const name = provider.name

  const actions = known && canWrite ? (
    connected ? (
      <>
        {attention && (
          <KitButton onClick={attention.onClick} loading={attention.loading}>
            {attention.label}
          </KitButton>
        )}
        {menu.length > 0 && <OverflowMenu label={`More actions for ${name}`} items={menu} width="w-[230px]" />}
      </>
    ) : (
      <KitButton variant="primary" size="lg" onClick={onConnect}>
        Connect
      </KitButton>
    )
  ) : null

  return (
    <>
      <PageHeader
        flush
        breadcrumb={<Breadcrumbs items={[{ label: 'Integrations', href: listHref }, { label: name }]} />}
        title={
          <span className="inline-flex items-center gap-[12px]">
            <ProviderMark provider={provider} categoryId={category.id} size={24} />
            {name}
          </span>
        }
        meta={known && status ? <StatusGlyph state={status.glyph} label={status.label} showLabel className="text-[13px]" /> : undefined}
        description={
          <>
            Functions call it as <code className="font-mono text-[13px] text-zinc-300">ctx.integrations.{provider.id}</code>.
          </>
        }
        actions={actions}
      />
      {viewer && <p className="-mt-[8px] mb-[24px] text-[13px] leading-[20px] text-faint">Only developers and admins can connect providers.</p>}
      {refused && <RefusedLine className="-mt-[8px] mb-[20px]">{refused}</RefusedLine>}
      {busy === 'disconnect' && (
        <p role="status" className="-mt-[8px] mb-[20px] text-[12.5px] leading-[18px] text-faint">
          Disconnecting {name}…
        </p>
      )}

      <div className="space-y-[32px]">
        <Section id="connector-keys" title="Keys">
          <Panel>
            {loading ? (
              <RowSkeleton rows={second ? 2 : 1} />
            ) : loadFailed ? (
              <ErrorRow things={`${name}'s keys`} onRetry={onRetryLoad} />
            ) : (
              <RowList>
                <KeyRow
                  envVar={provider.envVar}
                  label={provider.keyLabel}
                  status={state.key}
                  providerName={name}
                  checking={busy === 'recheck'}
                />
                {second && (
                  <KeyRow
                    envVar={second.envVar}
                    label={second.label}
                    status={state.second}
                    providerName={name}
                    missing={state.connected ? 'attention' : 'quiet'}
                    missingMeans={second.missingMeans}
                    action={
                      canWrite && state.connected ? (
                        state.second ? (
                          <KitButton size="sm" variant="ghost" onClick={onSecond}>
                            Replace
                          </KitButton>
                        ) : (
                          <KitButton size="sm" onClick={onSecond}>
                            Add {second.noun}
                          </KitButton>
                        )
                      ) : null
                    }
                  />
                )}
              </RowList>
            )}
          </Panel>
        </Section>

        {second?.endpointPath && (
          <Section id="connector-receives" title={`${name} sends events to`}>
            <ReceivingUrl apiBase={apiBase} path={second.endpointPath} />
            <p className="mt-[8px] text-[13px] leading-[20px] text-faint">
              Add it as an endpoint in {name}, then store the {second.label.charAt(0).toLowerCase() + second.label.slice(1)} it shows.
            </p>
          </Section>
        )}

        <Section id="connector-callers" title="Called from" aside={<span className="text-[12.5px] text-faint">Found in code</span>}>
          {known && !state.connected && callers.status === 'ready' && callers.list.length > 0 && (
            <p className="-mt-[2px] mb-[10px] flex items-center gap-[8px] text-[13px] leading-[20px] text-zinc-50">
              <StatusGlyph state="waiting" label="" />
              {callers.list.length === 1 ? 'It fails' : 'They fail'} until {name} is connected.
            </p>
          )}
          <Panel>
            {callers.status === 'loading' ? (
              <RowSkeleton rows={1} lead="none" />
            ) : callers.status === 'error' ? (
              <ErrorRow things="functions" onRetry={onRetryCallers} />
            ) : callers.list.length === 0 ? (
              <p className="px-[20px] py-[14px] text-[13px] leading-[20px] text-zinc-400">No function calls {name} yet.</p>
            ) : (
              <RowList>
                {callers.list.map((c) => (
                  <li key={c.name} className="px-[20px] py-[12px]">
                    <Link
                      href={`/app/projects/${projectId}/functions?fn=${encodeURIComponent(c.name)}`}
                      className={`rounded-[3px] font-mono text-[12.5px] leading-[20px] text-zinc-100 underline decoration-white/20 underline-offset-[3px] transition-colors duration-150 hover:decoration-white/60 [overflow-wrap:anywhere] ${FOCUS}`}
                    >
                      {c.name}
                    </Link>
                    <Facts className="!mt-[4px]">
                      {c.accessors.map((a) => (
                        <Fact key={a}>
                          Calls <code className="font-mono text-[11.5px] text-zinc-400">ctx.integrations.{a}</code>
                        </Fact>
                      ))}
                    </Facts>
                  </li>
                ))}
              </RowList>
            )}
          </Panel>
        </Section>

        <BuildSection projectId={projectId} state={state} connected={connected} agent={agent} canConnect={canAdminister} />
      </div>
    </>
  )
}

/** One stored (or missing) credential on the connector page. */
function KeyRow({
  envVar,
  label,
  status,
  providerName,
  checking = false,
  missing = 'quiet',
  missingMeans,
  action,
}: {
  envVar: string
  label: string
  status: KeyStatus | null
  providerName: string
  checking?: boolean
  /** How a missing value reads: 'attention' when the provider is connected and waits on it. */
  missing?: 'attention' | 'quiet'
  missingMeans?: string
  action?: ReactNode
}) {
  const glyph = !status && missing === 'attention' ? { glyph: 'waiting' as const, label: 'Not stored' } : credentialGlyph(status)
  const verification = status?.verification
  const detail = status?.verificationDetail
  return (
    <li className="px-[20px] py-[14px]">
      <div className="flex items-start gap-[12px]">
        <StatusGlyph state={glyph.glyph} label={glyph.label} className="mt-[4.5px]" />
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-6 gap-y-3 sm:flex-nowrap">
          <div className="min-w-0 flex-[1_1_260px]">
            <p className={`${ROW_TITLE} flex flex-wrap items-baseline gap-x-[10px]`}>
              <span className="font-mono text-[12.5px]">{envVar}</span>
              <span className="text-[12.5px] font-normal text-faint">{label}</span>
            </p>
            <Facts className="!mt-[4px]">
              {status ? (
                <>
                  <Fact>
                    <code className="font-mono text-[11.5px] text-zinc-400">{shortKey(status.maskedKey)}</code>
                  </Fact>
                  {checking ? (
                    <Fact>
                      <span role="status">Checking with {providerName}…</span>
                    </Fact>
                  ) : verification === 'verified' ? (
                    <Fact>
                      {status.verifiedAt ? <Time iso={status.verifiedAt} prefix="Confirmed" /> : 'Confirmed'}
                    </Fact>
                  ) : verification === 'unverifiable' ? (
                    <Fact>Format checked only</Fact>
                  ) : verification === 'unreachable' ? (
                    <Fact>Couldn’t reach {providerName}</Fact>
                  ) : verification === 'rejected' ? null : (
                    <Fact>Not checked yet</Fact>
                  )}
                  <Fact>
                    <Time iso={status.connectedAt} mode="date" prefix="Stored" />
                  </Fact>
                </>
              ) : (
                <Fact>Not stored</Fact>
              )}
            </Facts>
            {status && verification === 'rejected' && detail && (
              <p className="mt-[6px] text-[12.5px] leading-[18px] text-rose-300 [overflow-wrap:anywhere]">{detail}</p>
            )}
            {status && !checking && (verification === 'unverifiable' || verification === 'unreachable') && detail && (
              <p className="mt-[6px] max-w-[720px] text-[12.5px] leading-[18px] text-faint [overflow-wrap:anywhere]">{detail}</p>
            )}
            {!status && missingMeans && (
              <p className={`mt-[6px] text-[12.5px] leading-[18px] ${missing === 'attention' ? 'text-zinc-50' : 'text-faint'}`}>{missingMeans}</p>
            )}
          </div>
          {action && <div className="flex flex-shrink-0 items-center gap-2">{action}</div>}
        </div>
      </div>
    </li>
  )
}

/**
 * What to build with the provider. Before it is connected, a plain list of
 * what the agent can build (nothing is built yet, so nothing is checked). Once
 * connected, one copyable request per option.
 */
function BuildSection({
  projectId,
  state,
  connected,
  agent,
  canConnect,
}: {
  projectId: string
  state: ProviderState
  connected: boolean
  agent: AgentState
  canConnect: boolean
}) {
  const { provider } = state
  if (!connected) {
    return (
      <Section id="connector-build" title={`Build with ${provider.name}`} description={`What your agent can build once ${provider.name} is connected.`}>
        <Panel>
          <RowList>
            {provider.provisions.map((p) => (
              <li key={p} className="px-[20px] py-[11px] text-[13px] leading-[20px] text-zinc-300">
                {p}
              </li>
            ))}
          </RowList>
        </Panel>
      </Section>
    )
  }
  const options = buildOptions(provider)
  const sentence = agentSentence(agent, options.length, canConnect)
  return (
    <Section id="connector-build" title={`Build with ${provider.name}`} description={sentence ?? undefined}>
      <BuildRequests
        requests={options.map((o) => ({ label: o.label, request: buildRequest(provider, projectId, o.intent) }))}
      />
      <p className="mt-[10px] text-[12.5px] leading-[18px] text-faint">Each request names this project and says the key is already stored.</p>
    </Section>
  )
}

/**
 * "Ask your agent", one row per option: the option in a few words, Copy for
 * the whole request. A local stand-in for AskYourAgent (components/console),
 * which shows each request verbatim and at most three; these requests carry
 * their context, so the row says what it is for and Copy copies all of it.
 */
function BuildRequests({ requests }: { requests: ReadonlyArray<{ label: string; request: string }> }) {
  const headId = useId()
  return (
    <div role="group" aria-labelledby={headId} className={`w-full max-w-[560px] overflow-hidden ${R_PANEL} border ${EDGE} ${WELL}`}>
      <div className={`flex min-h-[34px] items-center border-b ${RULE} px-[14px]`}>
        <p id={headId} className="py-[8px] text-[12px] leading-[16px] text-faint">
          Ask your agent
        </p>
      </div>
      <ul className="divide-y divide-white/[0.06]">
        {requests.map((r) => (
          <li key={r.label} className="flex items-center gap-[12px] py-[6px] pl-[14px] pr-[6px]">
            <p title={r.request} className="min-w-0 flex-1 py-[3px] text-[13px] leading-[20px] text-zinc-200 [text-wrap:pretty]">
              {r.label}
            </p>
            <CopyButton value={r.request} label={`Copy the request: ${r.label}`} />
          </li>
        ))}
      </ul>
    </div>
  )
}
