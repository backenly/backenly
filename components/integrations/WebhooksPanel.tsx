'use client'

/**
 * OUTBOUND WEBHOOKS
 *
 * The backend for this was complete and unreachable. HMAC signing, a five-step
 * retry ladder, dead-lettering, a cron that processed retries — all real, and
 * `triggerWebhooks()` had no caller anywhere in the tree. The register called
 * it BACKEND_ONLY on the strength of a route existing.
 *
 * So this page is not a UI wrapped around a working feature. It ships with the
 * event capture that makes the feature exist, and it reports that capture's
 * real state rather than assuming it.
 *
 * ── The page (project console rebuild, 2026-11-16) ──────────────────────────
 *
 * A document page, list then detail, each with its own URL (decision 6):
 *
 *   Webhooks                 the endpoints, the agent's triggers, how to verify
 *   ?endpoint=<id>           one endpoint: its deliveries by day, All | Failed,
 *                            the receiver's own answer, Send test, Send again
 *   ?trigger=<id>            one agent trigger: the same delivery view
 *
 * ── What this page refuses to fake ──────────────────────────────────────────
 *
 * Delivery history is the log rows the deliverer wrote. There is no seeded
 * example, no "last delivered 2 minutes ago" placeholder, and an endpoint that
 * has never fired says so.
 *
 * "Send test" performs a real signed POST and reports the receiver's real
 * status code. It is not a simulation, and it does not report success because a
 * request was dispatched — a restore step in the recovery tranche returned a
 * cheerful string having restored nothing, and that class of answer is banned.
 * "Send again" is the same: one real attempt, its own log row, its answer.
 *
 * Capture health is read from information_schema on every load. When a webhook
 * subscribes to row events and the database is not capturing them, the page
 * says the webhook will not fire. A healthy row over a dead trigger is precisely
 * the defect this surface was built to end.
 *
 * Nothing on the screen changes before the server agrees: turning an endpoint
 * off, deleting it and rotating its secret wait for the answer, and a refusal
 * is said on the endpoint's row (or under its header) in the server's words.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Plus, Send } from 'lucide-react'
import {
  Breadcrumbs,
  CopyButton,
  CopyField,
  KitButton,
  KitButtonLink,
  KitConfirmDialog,
  KitNote,
  OverflowMenu,
  PageHeader,
  Segmented,
  StatusGlyph,
} from '@/components/inspector/kit'
import { FOCUS, PAGE_GUTTER, PAGE_WIDTH } from '@/components/console/tokens'
import { CodeWell } from '@/components/console/EventRow'
import { EmptyPanel, ErrorRow, RefusedLine } from '@/components/console/states'
import { RefreshButton, count, type MenuItems } from '@/components/console/InstrumentBar'
import { SecretOnceDialog } from '@/components/console/SecretOnceDialog'
import { Time } from '@/components/console/Time'
import { Disclosure, EmptyLine, Fact, Facts, Panel, Row, RowList, RowSkeleton, Section } from '@/components/autonomy/rows'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { planDisplayName } from '@/lib/entitlements/plan-names'
import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'
import type { WebhookEventType } from '@/lib/webhooks/events'
import { WebhookForm } from './WebhookForm'
import { AnswerLine, EndpointDeliveries, TriggerDeliveries } from './WebhookDeliveries'
import {
  answerLine,
  canSendAgain,
  hostAndPath,
  recentDeliveries,
  shortEndpoint,
  tablesWords,
  triggerEventWords,
  VERIFY_SNIPPET,
  type CaptureState,
  type DeliveryLog,
  type TriggerDeliveryRow,
  type TriggerWebhookRow,
  type WebhookPlanState,
  type WebhookRow,
} from './webhooks-present'

interface ListData {
  webhooks: WebhookRow[]
  availableTables: string[]
  plan: WebhookPlanState | null
  capture: CaptureState | null
}

interface TriggerData {
  triggers: TriggerWebhookRow[]
  deliveries: TriggerDeliveryRow[]
}

/** A line about what just happened, shown under the header of the view it belongs to. */
interface Notice {
  view: string
  ok: boolean
  text: string
}

/** The endpoints whose recent deliveries the list reads for its facts. More are listed without them. */
const RECENT_FOR = 20
/** Deliveries per read on an endpoint's page, and the route's own ceiling (lib/webhooks/index.ts). */
const PAGE = 50
const MAX_LOGS = 200

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}))
}

export function WebhooksPanel({ projectId }: { projectId: string }) {
  const router = useRouter()
  const pathname = usePathname() ?? `/app/projects/${projectId}/webhooks`
  const search = useSearchParams()
  const endpointId = search?.get('endpoint') ?? null
  const triggerId = endpointId ? null : search?.get('trigger') ?? null
  const viewKey = endpointId ? `endpoint:${endpointId}` : triggerId ? `trigger:${triggerId}` : 'list'

  const { role, canWrite, canAdminister, organizationId } = useProjectRole(projectId)
  const readOnly = role !== null && !canWrite

  // ── The list ──────────────────────────────────────────────────────────────
  const [list, setList] = useState<ListData | null>(null)
  const [listFailed, setListFailed] = useState(false)
  const [listStaleAt, setListStaleAt] = useState<string | null>(null)
  const [listRetrying, setListRetrying] = useState(false)
  const loadedAt = useRef<string | null>(null)
  const [triggers, setTriggers] = useState<TriggerData | null>(null)
  const [triggersFailed, setTriggersFailed] = useState(false)
  // Each endpoint's newest deliveries, for "Last delivery" and "1 retrying" on its row.
  const [recent, setRecent] = useState<Record<string, DeliveryLog[]>>({})

  const loadRecent = useCallback(
    async (webhooks: WebhookRow[]) => {
      const pairs = await Promise.all(
        webhooks.slice(0, RECENT_FOR).map(async (w) => {
          if (w.logCount === 0) return [w.id, [] as DeliveryLog[]] as const
          try {
            const res = await fetch(`/api/projects/${projectId}/webhooks/${w.id}/logs?limit=25`)
            if (!res.ok) return null
            return [w.id, ((await readJson(res)).logs ?? []) as DeliveryLog[]] as const
          } catch {
            return null
          }
        }),
      )
      const next: Record<string, DeliveryLog[]> = {}
      for (const p of pairs) if (p) next[p[0]] = [...p[1]]
      setRecent(next)
    },
    [projectId],
  )

  const loadTriggers = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/trigger-webhooks`)
      if (!res.ok) throw new Error()
      const data = await readJson(res)
      setTriggers({ triggers: data.triggers ?? [], deliveries: data.deliveries ?? [] })
      setTriggersFailed(false)
    } catch {
      setTriggersFailed(true)
    }
  }, [projectId])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks`)
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error ?? 'Webhooks could not be loaded.')
      const next: ListData = {
        webhooks: data.webhooks ?? [],
        availableTables: data.availableTables ?? [],
        plan: data.plan ?? null,
        capture: data.capture ?? null,
      }
      setList(next)
      setListFailed(false)
      setListStaleAt(null)
      loadedAt.current = new Date().toISOString()
      void loadRecent(next.webhooks)
    } catch {
      // Reported, never an empty list: "No endpoints yet" over a failed read
      // is a different and false claim. A failed refresh keeps what was read.
      if (loadedAt.current) setListStaleAt(loadedAt.current)
      else {
        setList(null)
        setListFailed(true)
      }
    }
  }, [projectId, loadRecent])

  useEffect(() => {
    void load()
    void loadTriggers()
  }, [load, loadTriggers])

  const retryList = async () => {
    setListRetrying(true)
    await Promise.all([load(), loadTriggers()])
    setListRetrying(false)
  }

  // ── One endpoint's deliveries ─────────────────────────────────────────────
  const [detail, setDetail] = useState<{ id: string; logs: DeliveryLog[] | null; limit: number; failed: boolean; staleAt: string | null; at: string | null }>({
    id: '',
    logs: null,
    limit: PAGE,
    failed: false,
    staleAt: null,
    at: null,
  })
  const [detailBusy, setDetailBusy] = useState<'refresh' | 'more' | null>(null)
  const [filter, setFilter] = useState<'all' | 'failed'>('all')
  const [highlight, setHighlight] = useState<string | null>(null)

  const loadDetail = useCallback(
    async (id: string, limit: number) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/webhooks/${id}/logs?limit=${limit}`)
        const data = await readJson(res)
        if (!res.ok) throw new Error(data.error ?? 'Deliveries could not be loaded.')
        setDetail({ id, logs: data.logs ?? [], limit, failed: false, staleAt: null, at: new Date().toISOString() })
      } catch {
        setDetail((d) =>
          d.id === id && d.logs ? { ...d, staleAt: d.at } : { id, logs: null, limit, failed: true, staleAt: null, at: null },
        )
      }
    },
    [projectId],
  )

  useEffect(() => {
    if (!endpointId) return
    setDetail({ id: endpointId, logs: null, limit: PAGE, failed: false, staleAt: null, at: null })
    setFilter('all')
    setHighlight(null)
    void loadDetail(endpointId, PAGE)
  }, [endpointId, loadDetail])

  // ── Actions ───────────────────────────────────────────────────────────────
  const [notice, setNotice] = useState<Notice | null>(null)
  const [rowNotice, setRowNotice] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [busy, setBusy] = useState<{ id: string; what: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<WebhookRow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<WebhookRow | null>(null)
  const [confirmRotate, setConfirmRotate] = useState<WebhookRow | null>(null)
  const [secret, setSecret] = useState<{ url: string; value: string } | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)

  /** Says what happened where it was asked from: on the endpoint's row in the list, or under the page's header. */
  const tell = (w: WebhookRow, ok: boolean, text: string) => {
    if (viewKey === 'list') setRowNotice((prev) => ({ ...prev, [w.id]: { ok, text } }))
    else setNotice({ view: viewKey, ok, text })
  }
  const clearTold = (w: WebhookRow) => {
    setRowNotice(({ [w.id]: _gone, ...rest }) => rest)
    setNotice(null)
  }

  async function create(eventType: WebhookEventType, targetUrl: string, tables: string[]) {
    const res = await fetch(`/api/projects/${projectId}/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, targetUrl, tables }),
    })
    const data = await readJson(res)
    if (!res.ok) throw new Error(data.error ?? 'The endpoint could not be added.')
    setCreating(false)
    setSecret({ url: targetUrl, value: data.webhook.secret })
    setCaptureError(data.captureError ?? null)
    await load()
  }

  async function saveEdit(w: WebhookRow, eventType: WebhookEventType, targetUrl: string, tables: string[]) {
    const res = await fetch(`/api/projects/${projectId}/webhooks/${w.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, targetUrl, tables }),
    })
    const data = await readJson(res)
    if (!res.ok) throw new Error(data.error ?? 'The endpoint could not be saved.')
    setEditing(null)
    setCaptureError(data.captureError ?? null)
    await load()
  }

  async function setActive(w: WebhookRow, active: boolean) {
    setBusy({ id: w.id, what: 'toggle' })
    clearTold(w)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${w.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error ?? `The endpoint could not be turned ${active ? 'on' : 'off'}.`)
      setCaptureError(data.captureError ?? null)
      await load()
    } catch (err) {
      tell(w, false, err instanceof Error ? err.message : `The endpoint could not be turned ${active ? 'on' : 'off'}.`)
    } finally {
      setBusy(null)
    }
  }

  async function sendTest(w: WebhookRow) {
    setBusy({ id: w.id, what: 'test' })
    clearTold(w)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${w.id}/test`, { method: 'POST' })
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error ?? 'The test could not be sent.')
      // The receiver's answer, verbatim. "Test sent" would be true and useless.
      const said = answerLine(data, 'test')
      tell(w, said.ok, said.text)
      if (viewKey === `endpoint:${w.id}`) {
        setFilter('all')
        setHighlight(data.logId ?? null)
        await loadDetail(w.id, detail.limit)
      }
      await load()
    } catch (err) {
      tell(w, false, err instanceof Error ? err.message : 'The test could not be sent.')
    } finally {
      setBusy(null)
    }
  }

  async function sendAgain(w: WebhookRow, log: DeliveryLog) {
    setBusy({ id: log.id, what: 'again' })
    setNotice(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${w.id}/logs/${log.id}/redeliver`, { method: 'POST' })
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error ?? 'The delivery could not be sent again.')
      const said = answerLine(data, 'again')
      setNotice({ view: viewKey, ...said })
      setHighlight(data.logId ?? null)
      setFilter('all')
      await loadDetail(w.id, detail.limit)
      void load()
    } catch (err) {
      setNotice({ view: viewKey, ok: false, text: err instanceof Error ? err.message : 'The delivery could not be sent again.' })
    } finally {
      setBusy(null)
    }
  }

  async function rotate(w: WebhookRow) {
    setBusy({ id: w.id, what: 'rotate' })
    clearTold(w)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${w.id}/secret`, { method: 'POST' })
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error ?? 'The secret could not be rotated.')
      setConfirmRotate(null)
      setSecret({ url: w.targetUrl, value: data.secret })
    } catch (err) {
      setConfirmRotate(null)
      tell(w, false, err instanceof Error ? err.message : 'The secret could not be rotated.')
    } finally {
      setBusy(null)
    }
  }

  async function remove(w: WebhookRow) {
    setBusy({ id: w.id, what: 'delete' })
    clearTold(w)
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks/${w.id}`, { method: 'DELETE' })
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error ?? 'The endpoint could not be deleted.')
      setConfirmDelete(null)
      setCaptureError(data.captureError ?? null)
      setNotice({ view: 'list', ok: true, text: `Deleted ${shortEndpoint(w.targetUrl)} (${w.eventType}).` })
      if (viewKey !== 'list') router.push(pathname)
      await load()
    } catch (err) {
      setConfirmDelete(null)
      tell(w, false, err instanceof Error ? err.message : 'The endpoint could not be deleted.')
    } finally {
      setBusy(null)
    }
  }

  // Agent-wired trigger webhooks. The MCP tool creates, replays and rotates
  // these rows; a page titled "Webhooks" that rendered none of them left the
  // owner blind to deliveries the agent set up.
  async function replayTriggerDelivery(log: TriggerDeliveryRow) {
    setBusy({ id: log.id, what: 'again' })
    setNotice(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/trigger-webhooks/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliveryLogId: log.id }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error ?? 'The delivery could not be sent again.')
      setNotice({ view: viewKey, ok: true, text: 'Sent again. It was delivered this time.' })
      setHighlight(log.id)
      await loadTriggers()
    } catch (err) {
      setNotice({ view: viewKey, ok: false, text: err instanceof Error ? err.message : 'The delivery could not be sent again.' })
    } finally {
      setBusy(null)
    }
  }

  // ── What this person may do here ──────────────────────────────────────────
  const plan = list?.plan ?? null
  // A plan without webhooks still stops what it has (lib/webhooks/plan.ts).
  const planAllows = plan?.allowed !== false
  const planName = plan?.currentPlan ? planDisplayName(plan.currentPlan) : 'a plan without webhooks'
  const billingHref = organizationId ? `/app/org/${organizationId}/billing` : '/app/billing'
  const canChange = canWrite && planAllows

  const menuFor = (w: WebhookRow, opts: { withTest: boolean }): MenuItems => {
    const items: MenuItems = []
    if (canChange && opts.withTest && w.active) items.push({ label: 'Send test', onClick: () => void sendTest(w) })
    if (canChange) items.push({ label: 'Edit endpoint…', onClick: () => setEditing(w) })
    // Turning one off never needs the plan; turning it back on does.
    if (canWrite && w.active) items.push({ label: 'Turn off', onClick: () => void setActive(w, false) })
    if (canChange && !w.active) items.push({ label: 'Turn on', onClick: () => void setActive(w, true) })
    if (canAdminister && planAllows) items.push({ label: 'Rotate secret…', onClick: () => setConfirmRotate(w) })
    if (canAdminister) {
      if (items.length > 0) items.push({ separator: true })
      items.push({ label: 'Delete endpoint…', danger: true, onClick: () => setConfirmDelete(w) })
    }
    return items
  }

  const shownNotice = notice && notice.view === viewKey ? notice : null
  const webhooks = list?.webhooks ?? []
  const endpoint = endpointId ? webhooks.find((w) => w.id === endpointId) ?? null : null
  const trigger = triggerId ? triggers?.triggers.find((t) => t.id === triggerId) ?? null : null

  const dialogs = (
    <>
      <WebhookForm
        open={creating}
        title="Add endpoint"
        availableTables={list?.availableTables ?? []}
        onClose={() => setCreating(false)}
        onSubmit={create}
      />
      {editing && (
        <WebhookForm
          open
          title="Edit endpoint"
          initialUrl={editing.targetUrl}
          initialEvent={editing.eventType as WebhookEventType}
          initialTables={editing.tables}
          availableTables={list?.availableTables ?? []}
          onClose={() => setEditing(null)}
          onSubmit={(eventType, targetUrl, tables) => saveEdit(editing, eventType, targetUrl, tables)}
        />
      )}
      {/* Shown once. No route returns a stored secret, so this is the only
          moment it exists outside the database. */}
      <SecretOnceDialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title={secret ? `Signing secret for ${shortEndpoint(secret.url)}` : 'Signing secret'}
        value={secret?.value ?? ''}
        copyLabel="Copy secret"
      >
        <p>Your receiver checks each delivery’s signature with it.</p>
        <CopyButton value={VERIFY_SNIPPET} label="Copy verify.js" showLabel className="-ml-[8px] mt-[6px]" />
      </SecretOnceDialog>
      <KitConfirmDialog
        open={!!confirmRotate}
        danger
        busy={busy?.what === 'rotate'}
        title="Rotate the signing secret?"
        description={
          confirmRotate
            ? `Deliveries to ${shortEndpoint(confirmRotate.targetUrl)} are signed with a new secret right away, and your receiver rejects them until it has the new one. It is shown once.`
            : undefined
        }
        undoable={false}
        lost="The old secret stops working."
        confirmLabel="Rotate secret"
        onConfirm={() => confirmRotate && void rotate(confirmRotate)}
        onCancel={() => setConfirmRotate(null)}
      />
      <KitConfirmDialog
        open={!!confirmDelete}
        danger
        busy={busy?.what === 'delete'}
        title="Delete this endpoint?"
        description={
          confirmDelete
            ? `${shortEndpoint(confirmDelete.targetUrl)} stops receiving ${confirmDelete.eventType} now, and retries waiting for it are dropped.`
            : undefined
        }
        undoable={false}
        lost="Its signing secret and delivery history go with it."
        confirmLabel="Delete endpoint"
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  )

  const listHref = pathname
  const upgrade =
    CLOUD_CONTROL_PLANE && !planAllows ? (
      <Link
        href={billingHref}
        className={`rounded-[3px] font-medium text-zinc-100 underline decoration-white/25 underline-offset-[3px] hover:decoration-white/60 ${FOCUS}`}
      >
        Upgrade to Pro
      </Link>
    ) : null

  // ── An endpoint's page ────────────────────────────────────────────────────
  if (endpointId) {
    const crumbs = (label: string) => <Breadcrumbs items={[{ label: 'Webhooks', href: listHref }, { label }]} />
    if (!list) {
      return (
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-[64px]`}>
          <PageHeader flush breadcrumb={crumbs('Endpoint')} title="Endpoint" />
          <Panel>{listFailed ? <ErrorRow things="this endpoint" onRetry={retryList} retrying={listRetrying} /> : <RowSkeleton rows={2} />}</Panel>
        </div>
      )
    }
    if (!endpoint) {
      return (
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-[64px]`}>
          <PageHeader flush breadcrumb={crumbs('Endpoint not found')} title="Endpoint not found" />
          <Panel>
            <EmptyLine>This endpoint was deleted, or the link is wrong.</EmptyLine>
          </Panel>
          {dialogs}
        </div>
      )
    }
    const w = endpoint
    const name = shortEndpoint(w.targetUrl)
    const menu = menuFor(w, { withTest: false })
    const tables = tablesWords(w.eventType, w.tables)
    const deliveries = detail.id === w.id ? detail : null
    return (
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-[64px]`}>
        <PageHeader
          flush
          breadcrumb={crumbs(name)}
          title={<span className="[overflow-wrap:anywhere]">{name}</span>}
          meta={!w.active ? <StatusGlyph state="paused" label="Off" showLabel /> : undefined}
          description={
            <span className="flex flex-wrap items-center gap-x-[18px] gap-y-[6px] text-[13px]">
              <code className="font-mono text-[12.5px] text-zinc-300">{w.eventType}</code>
              {tables && <span>{tables}</span>}
              <span>
                Added <Time iso={w.createdAt} mode="date" />
              </span>
              <span className="tabular-nums">{w.logCount === 0 ? 'No deliveries yet' : `${count(w.logCount)} ${w.logCount === 1 ? 'delivery' : 'deliveries'}`}</span>
              <CopyField variant="inline" value={w.targetUrl} label="Copy endpoint URL" className="max-w-full" />
            </span>
          }
          actions={
            canWrite && (canChange || menu.length > 0) ? (
              <>
                {canChange && w.active && (
                  <KitButton icon={Send} loading={busy?.id === w.id && busy.what === 'test'} disabled={!!busy} onClick={() => void sendTest(w)}>
                    Send test
                  </KitButton>
                )}
                {menu.length > 0 && <OverflowMenu label={`Actions for ${name}`} items={menu} disabled={!!busy} width="w-[220px]" />}
              </>
            ) : undefined
          }
        />
        <div className="-mt-[8px] mb-[24px] space-y-[8px] empty:hidden">
          {readOnly && <p className="text-[13px] leading-[20px] text-faint">Only developers and admins can change endpoints.</p>}
          {!planAllows && (
            <p className="text-[13px] leading-[20px] text-faint">
              This project is on {planName}. It keeps receiving; you can turn it off or delete it. {upgrade}
            </p>
          )}
          {list.capture?.required && !list.capture.healthy && w.active && w.eventType.startsWith('row.') && <CaptureWarning capture={list.capture} />}
          {captureError && <CaptureFailed error={captureError} />}
          {shownNotice && <AnswerLine ok={shownNotice.ok} text={shownNotice.text} />}
        </div>
        <Section
          id="webhook-deliveries"
          title="Deliveries"
          aside={
            <>
              <Segmented
                size="sm"
                label="Show deliveries"
                value={filter}
                onChange={(v) => setFilter(v === 'failed' ? 'failed' : 'all')}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'failed', label: 'Failed' },
                ]}
              />
              <RefreshButton
                label="Refresh deliveries"
                refreshing={detailBusy === 'refresh'}
                onRefresh={async () => {
                  setDetailBusy('refresh')
                  await loadDetail(w.id, deliveries?.limit ?? PAGE)
                  setDetailBusy(null)
                }}
              />
            </>
          }
        >
          <Panel>
            <EndpointDeliveries
              logs={deliveries?.logs ?? null}
              failed={!!deliveries?.failed}
              staleAt={deliveries?.staleAt ?? null}
              retrying={detailBusy === 'refresh'}
              onRetry={async () => {
                setDetailBusy('refresh')
                await loadDetail(w.id, deliveries?.limit ?? PAGE)
                setDetailBusy(null)
              }}
              filter={filter}
              limit={deliveries?.limit ?? PAGE}
              onLoadMore={
                (deliveries?.limit ?? PAGE) < MAX_LOGS
                  ? async () => {
                      setDetailBusy('more')
                      await loadDetail(w.id, Math.min((deliveries?.limit ?? PAGE) * 2, MAX_LOGS))
                      setDetailBusy(null)
                    }
                  : undefined
              }
              loadingMore={detailBusy === 'more'}
              highlight={highlight}
              emptyLine={canChange && w.active ? 'No deliveries yet. Send a test to see what it answers.' : 'No deliveries yet.'}
              sendAgain={(log) =>
                canChange && canSendAgain(log, w.active) ? (
                  <KitButton
                    size="sm"
                    loading={busy?.id === log.id}
                    disabled={!!busy}
                    onClick={() => void sendAgain(w, log)}
                  >
                    Send again
                  </KitButton>
                ) : null
              }
            />
          </Panel>
        </Section>
        {dialogs}
      </div>
    )
  }

  // ── An agent trigger's page ───────────────────────────────────────────────
  if (triggerId) {
    const crumbs = (label: string) => <Breadcrumbs items={[{ label: 'Webhooks', href: listHref }, { label }]} />
    if (!triggers) {
      return (
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-[64px]`}>
          <PageHeader flush breadcrumb={crumbs('Agent trigger')} title="Agent trigger" />
          <Panel>{triggersFailed ? <ErrorRow things="this trigger" onRetry={retryList} retrying={listRetrying} /> : <RowSkeleton rows={2} />}</Panel>
        </div>
      )
    }
    if (!trigger) {
      return (
        <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-[64px]`}>
          <PageHeader flush breadcrumb={crumbs('Trigger not found')} title="Trigger not found" />
          <Panel>
            <EmptyLine>This trigger was removed, or the link is wrong.</EmptyLine>
          </Panel>
        </div>
      )
    }
    const t = trigger
    const mine = triggers.deliveries.filter((d) => d.triggerId === t.id)
    return (
      <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-[64px]`}>
        <PageHeader
          flush
          breadcrumb={crumbs(t.name)}
          title={t.name}
          meta={!t.enabled ? <StatusGlyph state="paused" label="Off" showLabel /> : undefined}
          description={
            <span className="flex flex-wrap items-center gap-x-[18px] gap-y-[6px] text-[13px]">
              <span>{triggerEventWords(t.event, t.sourceTable)}</span>
              <span>
                Added <Time iso={t.createdAt} mode="date" />
              </span>
              {t.webhookUrl && <CopyField variant="inline" value={t.webhookUrl} label="Copy URL" className="max-w-full" />}
            </span>
          }
        />
        <div className="-mt-[8px] mb-[24px] space-y-[8px]">
          <p className="text-[13px] leading-[20px] text-faint">Your agent set this up. Ask it to change or remove it.</p>
          {shownNotice && <AnswerLine ok={shownNotice.ok} text={shownNotice.text} />}
        </div>
        <Section id="trigger-deliveries" title="Recent deliveries" aside={<RefreshButton label="Refresh deliveries" onRefresh={() => void loadTriggers()} />}>
          <Panel>
            <TriggerDeliveries
              deliveries={mine}
              highlight={highlight}
              sendAgain={(log) =>
                canWrite && log.status === 'DEAD' ? (
                  <KitButton size="sm" loading={busy?.id === log.id} disabled={!!busy} onClick={() => void replayTriggerDelivery(log)}>
                    Send again
                  </KitButton>
                ) : null
              }
            />
          </Panel>
        </Section>
      </div>
    )
  }

  // ── The list ──────────────────────────────────────────────────────────────
  const loaded = !!list
  const triggerRows = triggers?.triggers ?? []
  const showAdd = loaded && canChange
  const lockedEmpty = loaded && !planAllows && webhooks.length === 0
  const captureBroken = !!list?.capture?.required && !list.capture.healthy

  return (
    <div className={`${PAGE_WIDTH} ${PAGE_GUTTER} pb-[64px]`}>
      <PageHeader
        flush
        title="Webhooks"
        meta={
          webhooks.length > 0 ? (
            <span className="text-[13px] tabular-nums text-faint">
              {count(webhooks.length)} {webhooks.length === 1 ? 'endpoint' : 'endpoints'}
            </span>
          ) : undefined
        }
        description={readOnly ? 'Only developers and admins can change endpoints.' : undefined}
        actions={
          showAdd ? (
            <KitButton size="lg" variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              Add endpoint
            </KitButton>
          ) : undefined
        }
      />

      {(captureBroken || captureError || shownNotice) && (
        <div className="-mt-[4px] mb-[24px] space-y-[10px]">
          {captureBroken && list?.capture && <CaptureWarning capture={list.capture} />}
          {captureError && <CaptureFailed error={captureError} />}
          {shownNotice && <AnswerLine ok={shownNotice.ok} text={shownNotice.text} />}
        </div>
      )}

      <div className="space-y-[40px]">
        <Section
          id="webhooks-endpoints"
          title="Endpoints"
          description={
            loaded && !planAllows && webhooks.length > 0 ? (
              <>
                This project is on {planName}. Endpoints keep receiving; you can turn them off or delete them. {upgrade}
              </>
            ) : undefined
          }
        >
          <Panel>
            {listFailed ? (
              <ErrorRow things="endpoints" onRetry={retryList} retrying={listRetrying} />
            ) : !list ? (
              <RowSkeleton rows={3} />
            ) : (
              <>
                {listStaleAt && <ErrorRow things="endpoints" onRetry={retryList} retrying={listRetrying} staleAt={listStaleAt} />}
                {lockedEmpty ? (
                  <EmptyPanel title="Webhooks come with Pro" sentence="Add a URL and Backenly sends it a signed POST when a row changes or someone signs up.">
                    {CLOUD_CONTROL_PLANE && canWrite && (
                      <KitButtonLink href={billingHref} variant="primary">
                        Upgrade to Pro
                      </KitButtonLink>
                    )}
                  </EmptyPanel>
                ) : webhooks.length === 0 ? (
                  <EmptyPanel title="No endpoints yet" sentence="Add a URL and Backenly sends it a signed POST when a row changes or someone signs up." />
                ) : (
                  <RowList>
                    {webhooks.map((w) => (
                      <EndpointRow
                        key={w.id}
                        webhook={w}
                        href={`${listHref}?endpoint=${encodeURIComponent(w.id)}`}
                        recent={recent[w.id]}
                        menu={menuFor(w, { withTest: true })}
                        busy={busy?.id === w.id}
                        told={rowNotice[w.id]}
                      />
                    ))}
                  </RowList>
                )}
              </>
            )}
          </Panel>
        </Section>

        {(triggerRows.length > 0 || (triggersFailed && loaded)) && (
          <Section id="webhooks-triggers" title="Agent triggers">
            <Panel>
              {triggersFailed && !triggers ? (
                <ErrorRow things="agent triggers" onRetry={() => void loadTriggers()} />
              ) : (
                <RowList>
                  {triggerRows.map((t) => (
                    <TriggerRow
                      key={t.id}
                      trigger={t}
                      href={`${listHref}?trigger=${encodeURIComponent(t.id)}`}
                      deliveries={(triggers?.deliveries ?? []).filter((d) => d.triggerId === t.id)}
                    />
                  ))}
                </RowList>
              )}
            </Panel>
          </Section>
        )}

        {webhooks.length > 0 && <VerifySection />}
      </div>

      {dialogs}
    </div>
  )
}

// ─── Rows ────────────────────────────────────────────────────────────────────

/** Host and path, breaking only at the path's slashes, never inside the host. */
function EndpointName({ url }: { url: string }) {
  const { host, path } = hostAndPath(url)
  const parts = path.split(/(?=\/)/)
  return (
    <>
      <span className="whitespace-nowrap">{host}</span>
      {parts.map((p, i) => (
        <span key={i}>
          <wbr />
          {p}
        </span>
      ))}
    </>
  )
}

/** The whole row opens the endpoint; its ⋯ stays its own control above the link. */
const ROW_LINK = `min-w-0 rounded-[3px] after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-white/70`

function EndpointRow({
  webhook: w,
  href,
  recent,
  menu,
  busy,
  told,
}: {
  webhook: WebhookRow
  href: string
  recent: DeliveryLog[] | undefined
  menu: MenuItems
  busy: boolean
  told?: { ok: boolean; text: string }
}) {
  const r = recent ? recentDeliveries(recent) : null
  const tables = tablesWords(w.eventType, w.tables)
  const name = shortEndpoint(w.targetUrl)
  return (
    <Row
      lead="glyph"
      glyph={w.active ? 'live' : 'paused'}
      glyphLabel={w.active ? 'On' : 'Off'}
      busy={busy}
      className="relative transition-colors duration-150 hover:bg-[#121316]"
      title={
        <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-[2px] leading-[21px]">
          <Link href={href} className={`${ROW_LINK} font-mono text-[12.5px] font-medium text-zinc-50 [overflow-wrap:anywhere]`}>
            <EndpointName url={w.targetUrl} />
          </Link>
          <code className="font-mono text-[12px] text-zinc-400">{w.eventType}</code>
          {tables && <span className="text-[12.5px] text-faint">{tables}</span>}
        </div>
      }
      actions={
        menu.length > 0 ? (
          <div className="relative z-[1] -my-[4px]">
            <OverflowMenu label={`Actions for ${name} (${w.eventType})`} items={menu} disabled={busy} width="w-[220px]" />
          </div>
        ) : undefined
      }
    >
      <Facts className="!mt-[6px]">
        {!w.active && <span className="font-medium text-zinc-300">Off</span>}
        {r && r.retrying > 0 && (
          <span className="inline-flex items-center gap-[6px] font-medium text-zinc-50">
            <StatusGlyph state="busy" label="" />
            {r.retrying} retrying
          </span>
        )}
        {r && r.retrying === 0 && r.lastFailed && (
          <span className="inline-flex items-center gap-[6px] font-medium text-zinc-50">
            <StatusGlyph state="failed" label="" />
            Last delivery failed
          </span>
        )}
        {r?.lastAt && (
          <Fact>
            <Time iso={r.lastAt} prefix="Last delivery" />
          </Fact>
        )}
        <Fact>
          <span className="tabular-nums">{w.logCount === 0 ? 'No deliveries yet' : `${count(w.logCount)} ${w.logCount === 1 ? 'delivery' : 'deliveries'}`}</span>
        </Fact>
      </Facts>
      {told && (told.ok ? <AnswerLine ok text={told.text} className="relative z-[1] mt-[8px] !text-[12.5px]" /> : <RefusedLine className="relative z-[1] mt-[8px]">{told.text}</RefusedLine>)}
    </Row>
  )
}

function TriggerRow({ trigger: t, href, deliveries }: { trigger: TriggerWebhookRow; href: string; deliveries: TriggerDeliveryRow[] }) {
  const last = deliveries[0]?.createdAt ?? null
  const gaveUp = deliveries.filter((d) => d.status === 'DEAD').length
  const url = t.webhookUrl ? hostAndPath(t.webhookUrl) : null
  return (
    <Row
      lead="glyph"
      glyph={t.enabled ? 'live' : 'paused'}
      glyphLabel={t.enabled ? 'On' : 'Off'}
      className="relative transition-colors duration-150 hover:bg-[#121316]"
      title={
        <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-[2px] leading-[21px]">
          <Link href={href} className={`${ROW_LINK} text-[13.5px] font-medium text-zinc-50`}>
            {t.name}
          </Link>
          <span className="text-[12.5px] text-zinc-400">{triggerEventWords(t.event, t.sourceTable)}</span>
          {url && (
            <span className="font-mono text-[12px] text-faint [overflow-wrap:anywhere]">
              {url.host}
              {url.path}
            </span>
          )}
        </div>
      }
    >
      <Facts className="!mt-[6px]">
        {!t.enabled && <span className="font-medium text-zinc-300">Off</span>}
        {gaveUp > 0 && (
          <span className="inline-flex items-center gap-[6px] font-medium text-zinc-50">
            <StatusGlyph state="failed" label="" />
            {gaveUp} gave up
          </span>
        )}
        {last ? (
          <Fact>
            <Time iso={last} prefix="Last delivery" />
          </Fact>
        ) : (
          <Fact>No deliveries yet</Fact>
        )}
        {deliveries.length > 0 && (
          <Fact>
            <span className="tabular-nums">
              {count(deliveries.length)} recent {deliveries.length === 1 ? 'delivery' : 'deliveries'}
            </span>
          </Fact>
        )}
      </Facts>
    </Row>
  )
}

// ─── Notes ───────────────────────────────────────────────────────────────────

/** Ground truth from information_schema, not a stored flag. */
function CaptureWarning({ capture }: { capture: CaptureState }) {
  return (
    <KitNote tone="warn">
      {capture.readable
        ? 'Row events aren’t being captured. These endpoints won’t fire. Saving any endpoint again reinstalls capture.'
        : 'Whether row events are captured couldn’t be read. Treat row endpoints as not firing until it can.'}
    </KitNote>
  )
}

function CaptureFailed({ error }: { error: string }) {
  return <KitNote tone="warn">Saved, but row events could not be captured: {error}. It won’t fire until this is fixed.</KitNote>
}

/**
 * How a receiver verifies what it got: the contract in two lines, and a
 * snippet that implements it exactly (lib/webhooks/index.ts signs
 * "<timestamp>.<delivery id>.<raw body>" as X-Webhook-Signature-V2).
 */
function VerifySection() {
  const [open, setOpen] = useState(false)
  return (
    <Section id="webhooks-verify" title="Verify deliveries">
      <Panel>
        <div className="px-[20px] py-[14px]">
          <p className="text-[13px] leading-[20px] text-zinc-400 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-zinc-200">
            Each delivery is signed with <code>X-Webhook-Signature-V2</code>, an HMAC-SHA256 of{' '}
            <code>&lt;timestamp&gt;.&lt;delivery id&gt;.&lt;raw body&gt;</code> under the endpoint’s secret, with the time in{' '}
            <code>X-Webhook-Timestamp</code>. Refuse a delivery more than 5 minutes old, so a captured one can’t be sent again.
          </p>
          <p className="mt-[4px] text-[13px] leading-[20px] text-zinc-400 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-zinc-200">
            Retries repeat <code>X-Webhook-Delivery</code>, so drop the ones you’ve handled. <code>X-Webhook-Signature</code>, over the
            body alone, is still sent for older receivers.
          </p>
          <div className="mt-[10px] flex flex-wrap items-center gap-x-[14px] gap-y-[4px]">
            <CopyButton value={VERIFY_SNIPPET} label="Copy verify.js" showLabel className="-ml-[8px]" />
            <Disclosure open={open} onToggle={() => setOpen((o) => !o)}>
              {open ? 'Hide code' : 'Show code'}
            </Disclosure>
          </div>
        </div>
        {open && (
          <CodeWell label="verify.js" copy={VERIFY_SNIPPET} maxHeight={420}>
            {VERIFY_SNIPPET}
          </CodeWell>
        )}
      </Panel>
    </Section>
  )
}

/** Kept for readers of the old name: the panel renders the whole page. */
export default WebhooksPanel
