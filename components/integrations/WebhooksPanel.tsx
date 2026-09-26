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
  Webhook, Loader2, Plus, Trash2, Send, KeyRound, Power,
  CheckCircle2, XCircle, AlertTriangle, Clock, ChevronRight, Pencil, Ban,
} from 'lucide-react'
import {
  KitButton, KitNote, KitConfirmDialog, KitModal, KitField, KitInput, KitBadge, EmptyState,
} from '@/components/inspector/kit'
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

function StatusIcon({ status }: { status: string }) {
  if (status === 'SUCCESS') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500/70" />
  if (status === 'RETRYING' || status === 'PENDING') return <Clock className="h-3.5 w-3.5 text-amber-500/70" />
  if (status === 'CANCELLED') return <Ban className="h-3.5 w-3.5 text-zinc-500" />
  return <XCircle className="h-3.5 w-3.5 text-rose-500/70" />
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
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
        <div className="flex items-center gap-2">
          <Webhook className="h-3.5 w-3.5 text-zinc-500" />
          <span className="text-[12px] font-medium text-zinc-200">Outbound webhooks</span>
        </div>
        <KitButton variant="secondary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
          Add endpoint
        </KitButton>
      </div>

      <div className="flex-1 px-4 py-4">
        <p className="max-w-[70ch] text-[12.5px] leading-relaxed text-zinc-400">
          Backenly POSTs a signed JSON body to your endpoint when the event happens. Row
          events are captured in PostgreSQL, so they fire for every writer &mdash; the REST
          data plane, functions and the table editor alike &mdash; not only for changes made
          in this dashboard.
        </p>

        {loadError && (
          <div className="mt-4 max-w-[70ch]">
            <KitNote icon={AlertTriangle} tone="danger">{loadError}</KitNote>
          </div>
        )}

        {message && (
          <div className="mt-4 max-w-[70ch]">
            <KitNote
              icon={message.tone === 'success' ? CheckCircle2 : AlertTriangle}
              tone={message.tone}
            >
              {message.text}
            </KitNote>
          </div>
        )}

        {/* Ground truth from information_schema, not a stored flag. */}
        {capture?.required && !capture.healthy && (
          <div className="mt-4 max-w-[70ch]">
            <KitNote icon={AlertTriangle} tone="warn" title="Row events are not being captured">
              {capture.readable
                ? 'This project subscribes to row events, but no table in its schema carries a capture trigger. Those webhooks will not fire. Re-saving an endpoint reinstalls capture.'
                : 'This project’s workspace schema could not be read, so whether row events are captured is unknown. Treat these endpoints as not firing until this resolves.'}
            </KitNote>
          </div>
        )}

        <div className="mt-5">
          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading endpoints…
            </div>
          ) : webhooks.length === 0 ? (
            <EmptyState
              icon={Webhook}
              title="No endpoints yet"
              description="Add a URL and Backenly will POST a signed body to it when the event happens."
              action={
                <KitButton variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
                  Add endpoint
                </KitButton>
              }
            />
          ) : (
            <div className="max-w-[80ch] space-y-2">
              {webhooks.map(webhook => (
                <div
                  key={webhook.id}
                  className="overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.015]"
                >
                  <div className="flex items-center gap-3 px-3.5 py-3">
                    <button
                      onClick={() => toggleLogs(webhook.id)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      aria-expanded={openLogs === webhook.id}
                    >
                      <ChevronRight
                        className={`h-3.5 w-3.5 flex-shrink-0 text-zinc-600 transition-transform ${
                          openLogs === webhook.id ? 'rotate-90' : ''
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[12px] text-zinc-200">{webhook.targetUrl}</p>
                        <p className="mt-0.5 text-[11px] text-zinc-500">
                          <span className="font-mono">{webhook.eventType}</span>
                          {' · '}
                          {webhook.logCount === 0
                            ? 'never delivered'
                            : `${webhook.logCount} ${webhook.logCount === 1 ? 'delivery' : 'deliveries'}`}
                        </p>
                      </div>
                    </button>

                    <KitBadge tone={webhook.active ? 'operational' : 'paused'}>
                      {webhook.active ? 'enabled' : 'disabled'}
                    </KitBadge>

                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <KitButton
                        variant="ghost"
                        size="sm"
                        icon={busyId === webhook.id ? Loader2 : Send}
                        disabled={busyId !== null}
                        onClick={() => sendTest(webhook)}
                      >
                        Test
                      </KitButton>
                      <KitButton
                        variant="ghost"
                        size="sm"
                        icon={Pencil}
                        disabled={busyId !== null}
                        onClick={() => setEditing(webhook)}
                      >
                        Edit
                      </KitButton>
                      <KitButton
                        variant="ghost"
                        size="sm"
                        icon={Power}
                        disabled={busyId !== null}
                        onClick={() => setActive(webhook, !webhook.active)}
                      >
                        {webhook.active ? 'Disable' : 'Enable'}
                      </KitButton>
                      <KitButton
                        variant="ghost"
                        size="sm"
                        icon={KeyRound}
                        disabled={busyId !== null}
                        onClick={() => setConfirmRotate(webhook)}
                      >
                        Rotate
                      </KitButton>
                      <KitButton
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        disabled={busyId !== null}
                        onClick={() => setConfirmDelete(webhook)}
                      >
                        Delete
                      </KitButton>
                    </div>
                  </div>

                  {openLogs === webhook.id && (
                    <div className="border-t border-white/[0.05] bg-black/20 px-3.5 py-3">
                      {logsLoading === webhook.id ? (
                        <div className="flex items-center gap-2 text-[11.5px] text-zinc-500">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Loading deliveries…
                        </div>
                      ) : (logs[webhook.id] ?? []).length === 0 ? (
                        <p className="text-[11.5px] text-zinc-500">
                          No deliveries recorded. This endpoint has not fired yet.
                        </p>
                      ) : (
                        <table className="w-full text-[11.5px]">
                          <tbody>
                            {(logs[webhook.id] ?? []).map(log => (
                              <tr key={log.id} className="border-b border-white/[0.04] last:border-0">
                                <td className="py-1.5 pr-2 align-top">
                                  <StatusIcon status={log.status} />
                                </td>
                                <td className="py-1.5 pr-3 align-top text-zinc-400">
                                  {new Date(log.createdAt).toLocaleString()}
                                </td>
                                <td className="py-1.5 pr-3 align-top">
                                  <KitBadge tone={STATUS_TONE[log.status] ?? 'neutral'}>
                                    {log.status.toLowerCase()}
                                  </KitBadge>
                                </td>
                                <td className="py-1.5 pr-3 align-top font-mono text-zinc-500">
                                  {log.statusCode ?? '—'}
                                </td>
                                <td className="py-1.5 pr-3 align-top text-zinc-500">
                                  {log.attemptCount > 1 ? `${log.attemptCount} attempts` : ''}
                                </td>
                                <td className={`py-1.5 align-top ${log.status === 'CANCELLED' ? 'text-zinc-500' : 'text-rose-400/80'}`}>
                                  {log.status === 'CANCELLED' && log.error === 'project_paused'
                                    ? 'not sent: the project was paused'
                                    : log.error ?? ''}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-8 max-w-[70ch]">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Verifying a delivery
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-400">
            Each request carries <span className="font-mono text-zinc-300">X-Webhook-Signature</span>{' '}
            as <span className="font-mono text-zinc-300">sha256=&lt;hex&gt;</span>, the HMAC-SHA256 of
            the raw request body keyed with the endpoint&rsquo;s signing secret. Compute the same
            HMAC over the bytes you received and compare in constant time. Reject anything that does
            not match &mdash; the signature is what tells you the request came from Backenly.
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-400">
            <span className="font-mono text-zinc-300">X-Webhook-Delivery</span> is unique per
            delivery and repeats when a retry re-sends the same event. Delivery is at-least-once, so
            use it to discard duplicates rather than assuming each request is new.
          </p>
        </div>
      </div>

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
          description="This is shown once and cannot be retrieved later. Store it with your receiver now."
          onClose={() => setRevealedSecret(null)}
          footer={
            <KitButton variant="primary" size="sm" onClick={() => setRevealedSecret(null)}>
              Done
            </KitButton>
          }
        >
          <p className="mb-3 truncate font-mono text-[11.5px] text-zinc-500">{revealedSecret.url}</p>
          <code className="block break-all rounded-md border border-white/10 bg-[#0f1015] px-3 py-2.5 font-mono text-[12px] text-zinc-100">
            {revealedSecret.secret}
          </code>
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
          confirmLabel={busyId ? 'Rotating…' : 'Rotate'}
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
          confirmLabel={busyId ? 'Deleting…' : 'Delete'}
          onConfirm={() => remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

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
          <KitButton variant="ghost" size="sm" onClick={onClose}>Cancel</KitButton>
          <KitButton
            variant="primary"
            size="sm"
            icon={busy ? Loader2 : undefined}
            disabled={busy || url.trim() === ''}
            onClick={submit}
          >
            {busy ? 'Saving…' : 'Save'}
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
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://example.com/hooks/backenly"
            autoFocus
          />
        </KitField>

        <KitField label="Event">
          <div className="space-y-1.5">
            {WEBHOOK_EVENT_TYPES.map(type => (
              <label
                key={type}
                className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors ${
                  event === type
                    ? 'border-violet-400/30 bg-violet-400/[0.06]'
                    : 'border-white/[0.06] hover:border-white/15'
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
                  <span className="block font-mono text-[12px] text-zinc-200">{type}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-zinc-500">
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
