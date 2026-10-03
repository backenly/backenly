'use client'

/**
 * OUTBOUND WEBHOOKS
 *
 * The backend for this was complete and unreachable. HMAC signing, a five-step
 * retry ladder, dead-lettering, a cron that processed retries — all real, and
 * `triggerWebhooks()` had no caller anywhere in the tree. The register called
 * it BACKEND_ONLY on the strength of a route existing.
 *
 * So this panel is not a UI wrapped around a working feature. It ships with the
 * event capture that makes the feature exist, and it reports that capture's
 * real state rather than assuming it.
 *
 * ── What this panel refuses to fake ─────────────────────────────────────────
 *
 * Delivery history is the log rows the deliverer wrote. There is no seeded
 * example, no "last delivered 2 minutes ago" placeholder, and an endpoint that
 * has never fired says so.
 *
 * "Send test" performs a real signed POST and reports the receiver's real
 * status code. It is not a simulation, and it does not report success because a
 * request was dispatched — a restore step in the recovery tranche returned a
 * cheerful string having restored nothing, and that class of answer is banned.
 *
 * Capture health is read from information_schema on every load. When a webhook
 * subscribes to row events and the database is not capturing them, the panel
 * says the webhook will not fire. A green row over a dead trigger is precisely
 * the defect this surface was built to end.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Webhook, Plus, Trash2, Send, KeyRound, Power,
  CheckCircle2, AlertTriangle, ChevronRight, Pencil,
} from 'lucide-react'
import {
  CopyButton, EmptyState, KitBadge, KitButton, KitConfirmDialog, KitField, KitInput, KitModal, KitNote,
  OverflowMenu, PageHeader, Skeleton, Tag,
} from '@/components/inspector/kit'
import { FOCUS, PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { WEBHOOK_EVENT_TYPES, EVENT_DESCRIPTIONS, type WebhookEventType } from '@/lib/webhooks/events'

interface WebhookRow {
  id: string
  eventType: string
  targetUrl: string
  active: boolean
  createdAt: string
  updatedAt: string
  logCount: number
}

interface CaptureState {
  tables: string[]
  required: boolean
  healthy: boolean
  readable: boolean
}

interface DeliveryLog {
  id: string
  eventType: string
  status: string
  statusCode: number | null
  attemptCount: number
  error: string | null
  responseBody: string | null
  deliveredAt: string | null
  createdAt: string
  nextRetryAt: string | null
}

const STATUS_TONE: Record<string, 'operational' | 'failed' | 'attention' | 'neutral'> = {
  SUCCESS: 'operational',
  FAILED: 'failed',
  DEAD_LETTER: 'failed',
  RETRYING: 'attention',
  PENDING: 'neutral',
  // Withdrawn because the project was paused. Not a receiver failure, so it is
  // not drawn as one.
  CANCELLED: 'neutral',
}

const STATUS_LABEL: Record<string, string> = {
  SUCCESS: 'Delivered',
  FAILED: 'Failed',
  DEAD_LETTER: 'Gave up',
  RETRYING: 'Retrying',
  PENDING: 'Pending',
  CANCELLED: 'Cancelled',
}

export function WebhooksPanel({ projectId }: { projectId: string }) {
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([])
  const [capture, setCapture] = useState<CaptureState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'danger' | 'success' | 'warn'; text: string } | null>(null)

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<WebhookRow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<WebhookRow | null>(null)
  const [confirmRotate, setConfirmRotate] = useState<WebhookRow | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [revealedSecret, setRevealedSecret] = useState<{ url: string; secret: string } | null>(null)

  const [openLogs, setOpenLogs] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, DeliveryLog[]>>({})
  const [logsLoading, setLogsLoading] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Webhooks could not be loaded.')
      setWebhooks(data.webhooks ?? [])
      setCapture(data.capture ?? null)
    } catch (err) {
      // Reported, not swallowed. An empty list rendered over a failed request
      // reads as "you have no webhooks", which is a different and false claim.
      setLoadError(err instanceof Error ? err.message : 'Webhooks could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  async function loadLogs(webhookId: string) {
    setLogsLoading(webhookId)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${webhookId}/logs?limit=25`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Delivery history could not be loaded.')
      setLogs(prev => ({ ...prev, [webhookId]: data.logs ?? [] }))
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'Delivery history could not be loaded.' })
    } finally {
      setLogsLoading(null)
    }
  }

  function toggleLogs(webhookId: string) {
    if (openLogs === webhookId) { setOpenLogs(null); return }
    setOpenLogs(webhookId)
    loadLogs(webhookId)
  }

  async function create(eventType: WebhookEventType, targetUrl: string) {
    const res = await fetch(`/api/projects/${projectId}/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, targetUrl }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'The webhook could not be created.')

    setCreating(false)
    setRevealedSecret({ url: targetUrl, secret: data.webhook.secret })
    if (data.captureError) {
      setMessage({
        tone: 'warn',
        text: `The webhook was created, but event capture could not be installed: ${data.captureError}. It will not fire until this is resolved.`,
      })
    }
    await load()
  }

  async function saveEdit(webhook: WebhookRow, eventType: WebhookEventType, targetUrl: string) {
    const res = await fetch(`/api/projects/${projectId}/webhooks/${webhook.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, targetUrl }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'The webhook could not be updated.')
    setEditing(null)
    setMessage({ tone: 'success', text: 'Webhook updated.' })
    await load()
  }

  async function setActive(webhook: WebhookRow, active: boolean) {
    setBusyId(webhook.id)
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${webhook.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'The webhook could not be updated.')
      await load()
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The webhook could not be updated.' })
    } finally {
      setBusyId(null)
    }
  }

  async function sendTest(webhook: WebhookRow) {
    setBusyId(webhook.id)
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${webhook.id}/test`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'The test delivery failed.')

      // The receiver's answer, verbatim. "Test sent" would be true and useless.
      if (data.success) {
        setMessage({ tone: 'success', text: `Delivered. ${webhook.targetUrl} answered ${data.statusCode}.` })
      } else if (data.blocked) {
        setMessage({ tone: 'danger', text: `Not sent. ${data.error}` })
      } else {
        setMessage({
          tone: 'danger',
          text: `Not delivered. ${data.statusCode ? `${webhook.targetUrl} answered ${data.statusCode}.` : ''} ${data.error ?? ''}`.trim(),
        })
      }
      if (openLogs === webhook.id) await loadLogs(webhook.id)
      await load()
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The test delivery failed.' })
    } finally {
      setBusyId(null)
    }
  }

  async function rotate(webhook: WebhookRow) {
    setBusyId(webhook.id)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${webhook.id}/secret`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'The secret could not be rotated.')
      setRevealedSecret({ url: webhook.targetUrl, secret: data.secret })
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The secret could not be rotated.' })
    } finally {
      setBusyId(null)
      setConfirmRotate(null)
    }
  }

  async function remove(webhook: WebhookRow) {
    setBusyId(webhook.id)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${webhook.id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'The webhook could not be deleted.')
      setMessage({ tone: 'success', text: 'Webhook deleted.' })
      await load()
    } catch (err) {
      setMessage({ tone: 'danger', text: err instanceof Error ? err.message : 'The webhook could not be deleted.' })
    } finally {
      setBusyId(null)
      setConfirmDelete(null)
    }
  }

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-16`}>
      <PageHeader
        className="!px-0"
        title="Webhooks"
        description="Send signed events to your own services when rows change or an end user signs up. Row events are captured in PostgreSQL, so they fire for every writer: the REST data plane, functions and the table editor alike."
        meta={
          !loading && webhooks.length > 0 ? (
            <span className="text-[13px] tabular-nums text-zinc-500">
              {webhooks.length} {webhooks.length === 1 ? 'endpoint' : 'endpoints'}
            </span>
          ) : undefined
        }
        actions={
          // The empty state carries this action itself; one button per intent.
          loading || webhooks.length > 0 ? (
            <KitButton variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              Add endpoint
            </KitButton>
          ) : undefined
        }
      />

      <div className="space-y-3">
        {loadError && <KitNote icon={AlertTriangle} tone="danger">{loadError}</KitNote>}

        {message && (
          <KitNote icon={message.tone === 'success' ? CheckCircle2 : AlertTriangle} tone={message.tone}>
            {message.text}
          </KitNote>
        )}

        {/* Ground truth from information_schema, not a stored flag. */}
        {capture?.required && !capture.healthy && (
          <KitNote icon={AlertTriangle} tone="warn" title="Row events are not being captured">
            {capture.readable
              ? 'This project subscribes to row events, but no table in its schema carries a capture trigger. Those webhooks will not fire. Re-saving an endpoint reinstalls capture.'
              : 'This project’s workspace schema could not be read, so whether row events are captured is unknown. Treat these endpoints as not firing until this resolves.'}
          </KitNote>
        )}
      </div>

      <div className={loadError || message || (capture?.required && !capture.healthy) ? 'mt-5' : ''}>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-[64px] w-full rounded-[10px]" />
            <Skeleton className="h-[64px] w-full rounded-[10px]" />
          </div>
        ) : webhooks.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-white/[0.10]">
            <EmptyState
              icon={Webhook}
              title="No endpoints yet"
              description="Add a URL and Backenly POSTs a signed JSON body to it when the event happens, with retries and a delivery log."
              action={
                <KitButton variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                  Add endpoint
                </KitButton>
              }
            />
          </div>
        ) : (
          <ul className="overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#0f1012] divide-y divide-white/[0.06]">
            {webhooks.map(webhook => {
              const expanded = openLogs === webhook.id
              return (
                <li key={webhook.id}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleLogs(webhook.id)}
                      className={`flex min-w-0 flex-1 items-center gap-3 rounded-[6px] text-left ${FOCUS}`}
                      aria-expanded={expanded}
                    >
                      <ChevronRight
                        className={`h-4 w-4 flex-shrink-0 text-zinc-600 transition-transform duration-150 ${expanded ? 'rotate-90 text-zinc-300' : ''}`}
                      />
                      <span
                        className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${webhook.active ? 'bg-emerald-400' : 'bg-zinc-600'}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[12.5px] text-zinc-100">{webhook.targetUrl}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-zinc-500">
                          <Tag mono>{webhook.eventType}</Tag>
                          <span>{webhook.active ? 'Enabled' : 'Disabled'}</span>
                          <span className="tabular-nums">
                            {webhook.logCount === 0
                              ? 'Never delivered'
                              : `${webhook.logCount.toLocaleString()} ${webhook.logCount === 1 ? 'delivery' : 'deliveries'}`}
                          </span>
                        </span>
                      </span>
                    </button>

                    <div className="flex flex-shrink-0 items-center gap-1">
                      <KitButton
                        variant="secondary"
                        size="sm"
                        icon={Send}
                        loading={busyId === webhook.id}
                        disabled={busyId !== null}
                        onClick={() => sendTest(webhook)}
                      >
                        <span className="hidden sm:inline">Send test</span>
                        <span className="sm:hidden">Test</span>
                      </KitButton>
                      <OverflowMenu
                        label={`More actions for ${webhook.targetUrl}`}
                        disabled={busyId !== null}
                        items={[
                          { label: 'Edit endpoint…', icon: Pencil, onClick: () => setEditing(webhook) },
                          { label: webhook.active ? 'Disable' : 'Enable', icon: Power, onClick: () => setActive(webhook, !webhook.active) },
                          { label: 'Rotate secret…', icon: KeyRound, onClick: () => setConfirmRotate(webhook) },
                          { separator: true },
                          { label: 'Delete endpoint…', icon: Trash2, danger: true, onClick: () => setConfirmDelete(webhook) },
                        ]}
                      />
                    </div>
                  </div>

                  {expanded && (
                    <div className="border-t border-white/[0.06] bg-[#0a0b0d] px-4 py-3">
                      {logsLoading === webhook.id ? (
                        <div className="space-y-2 py-1">
                          <Skeleton className="h-[16px] w-3/4" />
                          <Skeleton className="h-[16px] w-2/3" />
                        </div>
                      ) : (logs[webhook.id] ?? []).length === 0 ? (
                        <p className="py-1 text-[13px] text-zinc-500">
                          No deliveries recorded. This endpoint has not fired yet.
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[620px] text-left text-[12.5px]">
                            <thead>
                              <tr className="text-[12px] text-zinc-500">
                                <th scope="col" className="pb-2 pr-4 font-medium">Status</th>
                                <th scope="col" className="pb-2 pr-4 font-medium">Time</th>
                                <th scope="col" className="pb-2 pr-4 font-medium">Response</th>
                                <th scope="col" className="pb-2 pr-4 font-medium">Attempts</th>
                                <th scope="col" className="pb-2 font-medium">Detail</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/[0.05]">
                              {(logs[webhook.id] ?? []).map(log => (
                                <tr key={log.id}>
                                  <td className="py-2 pr-4 align-top">
                                    <KitBadge tone={STATUS_TONE[log.status] ?? 'neutral'}>{STATUS_LABEL[log.status] ?? log.status}</KitBadge>
                                  </td>
                                  <td className="whitespace-nowrap py-2 pr-4 align-top tabular-nums text-zinc-400">
                                    {new Date(log.createdAt).toLocaleString()}
                                  </td>
                                  <td className="py-2 pr-4 align-top font-mono text-[12px] text-zinc-400">{log.statusCode ?? '—'}</td>
                                  <td className="py-2 pr-4 align-top tabular-nums text-zinc-500">{log.attemptCount}</td>
                                  <td className={`py-2 align-top ${log.status === 'CANCELLED' ? 'text-zinc-500' : 'text-rose-300/90'}`}>
                                    {log.status === 'CANCELLED' && log.error === 'project_paused'
                                      ? 'Not sent: the project was paused'
                                      : log.error ?? ''}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* How a receiver verifies what it got: the contract, and a snippet
          that implements it exactly (lib/webhooks/index.ts signs
          'sha256=' + hex HMAC-SHA256 of the raw body). */}
      <section aria-labelledby="verify-heading" className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10">
        <div>
          <h2 id="verify-heading" className="text-[15px] font-semibold leading-[22px] tracking-[-0.012em] text-zinc-100">
            Verifying a delivery
          </h2>
          <div className="mt-2 space-y-3 text-[13px] leading-[21px] text-zinc-400">
            <p>
              Each request carries <code className="font-mono text-[12px] text-zinc-200">X-Webhook-Signature</code> as{' '}
              <code className="font-mono text-[12px] text-zinc-200">sha256=&lt;hex&gt;</code>, the HMAC-SHA256 of the raw
              request body keyed with the endpoint’s signing secret. Compute the same HMAC over the bytes you received
              and compare in constant time. Reject anything that does not match: the signature is what tells you the
              request came from Backenly.
            </p>
            <p>
              <code className="font-mono text-[12px] text-zinc-200">X-Webhook-Delivery</code> is unique per delivery and
              repeats when a retry re-sends the same event. Delivery is at-least-once, so use it to discard duplicates
              rather than assuming each request is new.
            </p>
          </div>
        </div>
        <div className="overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#08090a]">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
            <span className="text-[12px] text-zinc-500">verify.js</span>
            <CopyButton value={VERIFY_SNIPPET} label="Copy snippet" />
          </div>
          <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12px] leading-[20px] text-zinc-300">
            <code>{VERIFY_SNIPPET}</code>
          </pre>
        </div>
      </section>

      <WebhookForm
        open={creating}
        title="Add endpoint"
        onClose={() => setCreating(false)}
        onSubmit={create}
      />

      {editing && (
        <WebhookForm
          open
          title="Edit endpoint"
          initialUrl={editing.targetUrl}
          initialEvent={editing.eventType as WebhookEventType}
          onClose={() => setEditing(null)}
          onSubmit={(eventType, targetUrl) => saveEdit(editing, eventType, targetUrl)}
        />
      )}

      {/* Shown once. No route returns a stored secret, so this is the only
          moment it exists outside the database. */}
      {revealedSecret && (
        <KitModal
          open
          title="Signing secret"
          description="Shown once and cannot be retrieved later. Store it with your receiver now."
          onClose={() => setRevealedSecret(null)}
          footer={
            <KitButton variant="primary" onClick={() => setRevealedSecret(null)}>
              Done
            </KitButton>
          }
        >
          <p className="mb-2 truncate font-mono text-[12px] text-zinc-500">{revealedSecret.url}</p>
          <div className="flex items-start gap-2 rounded-[8px] border border-white/[0.08] bg-[#08090a] p-3">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-[12.5px] leading-[20px] text-zinc-100">
              {revealedSecret.secret}
            </code>
            <CopyButton value={revealedSecret.secret} label="Copy secret" showLabel />
          </div>
        </KitModal>
      )}

      {confirmRotate && (
        <KitConfirmDialog
          open
          danger
          busy={busyId !== null}
          title="Rotate this signing secret?"
          description={
            `Deliveries to ${confirmRotate.targetUrl} will be signed with a new secret immediately. ` +
            `Any receiver still verifying with the old one will reject them until you update its ` +
            `configuration. The new secret is shown once.`
          }
          confirmLabel={busyId ? 'Rotating…' : 'Rotate secret'}
          onConfirm={() => rotate(confirmRotate)}
          onCancel={() => setConfirmRotate(null)}
        />
      )}

      {confirmDelete && (
        <KitConfirmDialog
          open
          danger
          busy={busyId !== null}
          title="Delete this endpoint?"
          description={
            `${confirmDelete.targetUrl} stops receiving events immediately, and its delivery ` +
            `history is removed with it. Undelivered retries for this endpoint are abandoned.`
          }
          confirmLabel={busyId ? 'Deleting…' : 'Delete endpoint'}
          onConfirm={() => remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

const VERIFY_SNIPPET = `import crypto from 'node:crypto'

// rawBody: the exact bytes received, before any JSON parsing.
export function isFromBackenly(rawBody, signatureHeader, secret) {
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader ?? '')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}`

/**
 * The create/edit form.
 *
 * The event list is rendered from WEBHOOK_EVENT_TYPES rather than written out
 * here. The old route validated against a hand-written array that omitted
 * `row.updated` while the type union included it, so a picker built from the
 * type would have offered an option the API rejects. One list, one answer.
 */
function WebhookForm({
  open,
  title,
  initialUrl = '',
  initialEvent = 'row.inserted',
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  initialUrl?: string
  initialEvent?: WebhookEventType
  onClose: () => void
  onSubmit: (eventType: WebhookEventType, targetUrl: string) => Promise<void>
}) {
  const [url, setUrl] = useState(initialUrl)
  const [event, setEvent] = useState<WebhookEventType>(initialEvent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) { setUrl(initialUrl); setEvent(initialEvent); setError(null) }
  }, [open, initialUrl, initialEvent])

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await onSubmit(event, url.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The endpoint could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KitModal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose}>Cancel</KitButton>
          <KitButton variant="primary" loading={busy} disabled={url.trim() === ''} onClick={submit}>
            {busy ? 'Saving…' : 'Save endpoint'}
          </KitButton>
        </>
      }
    >
      <div className="space-y-4">
        <KitField
          label="Endpoint URL"
          hint="Must be https:// or http:// and reachable from this deployment. Private and loopback addresses are refused unless the operator has enabled them."
        >
          <KitInput
            type="url"
            inputMode="url"
            name="webhook-url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && url.trim()) submit() }}
            placeholder="https://example.com/hooks/backenly…"
          />
        </KitField>

        <KitField label="Event">
          <div className="space-y-1.5">
            {WEBHOOK_EVENT_TYPES.map(type => (
              <label
                key={type}
                className={`flex cursor-pointer items-start gap-2.5 rounded-[8px] border px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-violet-300/60 ${
                  event === type
                    ? 'border-violet-300/40 bg-violet-400/[0.06]'
                    : 'border-white/[0.08] hover:border-white/[0.14]'
                }`}
              >
                <input
                  type="radio"
                  name="webhook-event"
                  value={type}
                  checked={event === type}
                  onChange={() => setEvent(type)}
                  className="mt-0.5 accent-violet-400"
                />
                <span className="min-w-0">
                  <span className="block font-mono text-[12px] text-zinc-100">{type}</span>
                  <span className="mt-0.5 block text-[12px] leading-[17px] text-zinc-500">
                    {EVENT_DESCRIPTIONS[type]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </KitField>

        {error && <KitNote icon={AlertTriangle} tone="danger">{error}</KitNote>}
      </div>
    </KitModal>
  )
}
