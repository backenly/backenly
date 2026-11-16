'use client'

/**
 * Functions: what ran, what failed and why, first (project console rebuild,
 * 2026-11-16).
 *
 * The page opened on configuration (a description, a five-row box, the
 * endpoint) and each run sat in its own boxed well, so four and a half runs
 * fit on a screen and a failure showed only inside its function's tab. It now
 * opens on All runs: one-line rows under their day, a failure marked ✕ with
 * its error in rose, about a dozen a screen. The rail lists the functions
 * with their state (● ran fine, ○ never run, ‖ Off, ✕ Failed) and their
 * trigger in words, failed first; a function is its own URL (`?fn=<name>`,
 * what Monitoring and Integrations link to) with Runs and Code; Secrets
 * (`?view=secrets`, decision 3) are the values its code reads as ctx.env.NAME.
 *
 * The screen never says what the server has not: a failed read is an error
 * row (never "No functions yet"), turning a function off or deleting it waits
 * for the server's answer and shows a refusal in its words, and the delete
 * dialog says History can bring it back (lib/changes/resources/functions.ts).
 * Roles (useProjectRole): viewers get one sentence instead of controls;
 * deleting needs an admin, as the route does.
 *
 * The workbench's inner layer is absolutely positioned so a wide log line
 * cannot push the app shell's flex chain sideways.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ChevronDown, ChevronLeft, Play } from 'lucide-react'
import {
  CopyField,
  KIT,
  KitButton,
  KitConfirmDialog,
  KitModal,
  KitSelect,
  NoticeStrip,
  Segmented,
  StatusGlyph,
} from '@/components/inspector/kit'
import { InstrumentBar, PaneToolbar, SearchField, count, type MenuItems } from '@/components/console/InstrumentBar'
import { AskYourAgent, EmptyPanel, ErrorRow, RefusedLine, agentSentence } from '@/components/console/states'
import { Time } from '@/components/console/Time'
import { FOCUS_INSET, RAIL, RULE } from '@/components/console/tokens'
import { RowSkeleton } from '@/components/autonomy/rows'
import { EnvVarsPanel, useSecrets } from '@/components/inspector/EnvVarsPanel'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { RunsList } from './RunsList'
import { CodeView } from './CodeView'
import { TestRunDialog } from './TestRunDialog'
import {
  byAttention,
  endpointOf,
  envReads,
  fnState,
  isAdminGated,
  isBulkRunnable,
  isSchemaQueryFunction,
  triggerKind,
  triggerWords,
  type AiFunction,
  type FunctionsCapture,
} from './model'

/** What people actually ask for first: the empty panel's and New function's requests. */
const EXAMPLE_PROMPTS = [
  'When a user signs up, send them a welcome email.',
  'Add POST /checkout that validates the cart and returns the order id.',
  'Every night at 02:00 UTC, delete sessions older than 30 days.',
]

/** Search and the trigger filter appear only once the rail is long enough to need them. */
const FIND_AT = 8

const TRIGGER_FILTERS: Array<{ key: string; label: string }> = [
  { key: 'http', label: 'Endpoints' },
  { key: 'on_signup', label: 'On sign-up' },
  { key: 'on_db_insert', label: 'On insert' },
  { key: 'on_db_update', label: 'On update' },
  { key: 'on_db_delete', label: 'On delete' },
  { key: 'cron', label: 'Scheduled' },
  { key: 'manual', label: 'Run by hand' },
]

type ListRead = { status: 'loading' } | { status: 'error'; at: number | null } | { status: 'ready'; at: number }

const adminKeyCache = new Map<string, Promise<string | null>>()
function fetchAdminKey(projectId: string): Promise<string | null> {
  if (!adminKeyCache.has(projectId)) {
    adminKeyCache.set(
      projectId,
      fetch(`/api/projects/${projectId}/ai-functions/admin-key`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.adminKey ?? null)
        .catch(() => null),
    )
  }
  return adminKeyCache.get(projectId)!
}

const copyText = (text: string) => navigator.clipboard?.writeText(text).catch(() => {})

export function FunctionsWorkbench({ projectId }: { projectId: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const fnParam = search?.get('fn') ?? null
  const viewParam = search?.get('view') ?? null
  /** `&tab=code` opens a function on its code (a link from a provider's "Called from"). */
  const tabParam = search?.get('tab') === 'code' ? 'code' : 'runs'
  const showSecrets = viewParam === 'secrets'

  const { canWrite, canAdminister, organizationId } = useProjectRole(projectId)
  const agent = useAgentConnection(projectId)
  const secrets = useSecrets(projectId)
  const billingHref = organizationId ? `/app/org/${organizationId}/billing` : '/app/billing'

  // ── The list ────────────────────────────────────────────────────────────────
  const [functions, setFunctions] = useState<AiFunction[]>([])
  const [capture, setCapture] = useState<FunctionsCapture | null>(null)
  const [read, setRead] = useState<ListRead>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [runsKey, setRunsKey] = useState(0)

  const fetchFunctions = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/ai-functions`, { credentials: 'include' })
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json()
      setFunctions(Array.isArray(data?.functions) ? data.functions : [])
      setCapture(data?.capture ?? null)
      setRead({ status: 'ready', at: Date.now() })
    } catch {
      // A failed first read clears nothing it never showed; a failed refresh keeps the list and says how old it is.
      setRead((prev) => ({ status: 'error', at: prev.status === 'ready' ? prev.at : prev.status === 'error' ? prev.at : null }))
    }
  }, [projectId])

  useEffect(() => {
    void fetchFunctions()
  }, [fetchFunctions])

  const refresh = async () => {
    setRefreshing(true)
    setRunsKey((k) => k + 1)
    await Promise.all([fetchFunctions(), secrets.reload()])
    setRefreshing(false)
  }

  const go = useCallback(
    (params: { fn?: string; view?: 'secrets' | 'runs' }) => {
      const q = new URLSearchParams()
      if (params.fn) q.set('fn', params.fn)
      if (params.view) q.set('view', params.view)
      const qs = q.toString()
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname],
  )

  // ── Derived ─────────────────────────────────────────────────────────────────
  const loaded = read.status === 'ready' || (read.status === 'error' && read.at !== null)
  const own = useMemo(() => functions.filter((f) => !f.generated).sort(byAttention), [functions])
  const generated = useMemo(() => functions.filter((f) => f.generated).sort(byAttention), [functions])
  const failedN = own.filter((f) => f.status === 'error').length
  const offN = own.filter((f) => f.status === 'inactive').length
  const schemaFns = functions.filter(isSchemaQueryFunction)
  const untestedEndpoints = own.filter((f) => f.runCount === 0 && f.status === 'active' && isBulkRunnable(f))
  const selected = fnParam ? functions.find((f) => f.name === fnParam) ?? null : null
  const empty = loaded && functions.length === 0

  /** Each secret's readers, found in code: shown on its row. */
  const readers = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const f of functions) for (const name of envReads(f.generatedCode)) map.set(name, [...(map.get(name) ?? []), f.name])
    return map
  }, [functions])

  // ── Find (8 or more) ────────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [trigger, setTrigger] = useState('all')
  const findable = functions.length >= FIND_AT
  const matches = (f: AiFunction) => {
    if (findable && trigger !== 'all' && triggerKind(f) !== trigger) return false
    const q = query.trim().toLowerCase()
    if (!findable || !q) return true
    return f.name.toLowerCase().includes(q) || (f.description || '').toLowerCase().includes(q) || (f.triggerTable || '').toLowerCase().includes(q)
  }
  const triggerCounts = useMemo(() => {
    const c = new Map<string, number>()
    for (const f of functions) c.set(triggerKind(f), (c.get(triggerKind(f)) ?? 0) + 1)
    return c
  }, [functions])

  // ── Actions ─────────────────────────────────────────────────────────────────
  const [showNew, setShowNew] = useState(false)
  const [testing, setTesting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<AiFunction | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ id: string; message: string } | null>(null)
  const [confirmCleanup, setConfirmCleanup] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [pageNote, setPageNote] = useState<{ tone: 'neutral' | 'danger'; text: string } | null>(null)

  const toggle = async (fn: AiFunction) => {
    const next = fn.status === 'inactive' ? 'active' : 'inactive'
    setToggling(fn.id)
    setRefused(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/ai-functions/${fn.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: next }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setRefused({ id: fn.id, message: data?.error ?? `Could not turn ${fn.name} ${next === 'active' ? 'on' : 'off'} (${res.status}).` })
        return
      }
      // Switching off drops the runs queued for it from row changes; say so.
      const dropped = typeof data?.droppedQueuedRuns === 'number' ? data.droppedQueuedRuns : 0
      if (dropped > 0) {
        setPageNote({
          tone: 'neutral',
          text: `${fn.name} is off. ${dropped.toLocaleString('en-US')} queued ${dropped === 1 ? 'run' : 'runs'} from row changes ${dropped === 1 ? 'was' : 'were'} dropped and will not run.`,
        })
      }
      // The server's answer moves the screen, never the click.
      await fetchFunctions()
    } catch {
      setRefused({ id: fn.id, message: `Could not reach Backenly. ${fn.name} is unchanged.` })
    } finally {
      setToggling(null)
    }
  }

  const performDelete = async (fn: AiFunction) => {
    setDeleting(true)
    setRefused(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/ai-functions/${fn.id}`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setRefused({ id: fn.id, message: data?.error ?? `Could not delete ${fn.name} (${res.status}).` })
        return
      }
      await fetchFunctions()
      go({})
    } catch {
      setRefused({ id: fn.id, message: `Could not reach Backenly. ${fn.name} is unchanged.` })
    } finally {
      setDeleting(false)
      setConfirmDelete(null)
    }
  }

  const performCleanup = async () => {
    const toDelete = functions.filter(isSchemaQueryFunction)
    if (!toDelete.length) return
    setCleaning(true)
    try {
      const results = await Promise.allSettled(
        toDelete.map((fn) =>
          fetch(`/api/projects/${projectId}/ai-functions/${fn.id}`, { method: 'DELETE', credentials: 'include' }).then((r) => {
            if (!r.ok) throw new Error(String(r.status))
          }),
        ),
      )
      const removed = results.filter((r) => r.status === 'fulfilled').length
      setPageNote(
        removed === toDelete.length
          ? { tone: 'neutral', text: `Removed ${count(removed)} schema ${removed === 1 ? 'endpoint' : 'endpoints'}. You can undo it in History.` }
          : { tone: 'danger', text: `Removed ${count(removed)} of ${count(toDelete.length)} schema endpoints. The others were refused.` },
      )
      await fetchFunctions()
    } finally {
      setCleaning(false)
      setConfirmCleanup(false)
    }
  }

  // Endpoint-style functions only: runnableUntestedFns never holds an event function.
  const runnableUntestedFns = untestedEndpoints
  const runUntested = async () => {
    if (!runnableUntestedFns.length) return
    setBulkRunning(true)
    try {
      const results = await Promise.allSettled(
        runnableUntestedFns.map((fn) =>
          fetch(`/api/projects/${projectId}/ai-functions/${fn.id}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ event: {} }),
          }).then((r) => {
            if (!r.ok) throw new Error(String(r.status))
          }),
        ),
      )
      const ran = results.filter((r) => r.status === 'fulfilled').length
      setPageNote({ tone: ran === results.length ? 'neutral' : 'danger', text: `Ran ${count(ran)} of ${count(results.length)} untested endpoints once. Their runs are below.` })
      setRunsKey((k) => k + 1)
      await fetchFunctions()
      go({})
    } finally {
      setBulkRunning(false)
      setConfirmBulk(false)
    }
  }

  // ── Bar ─────────────────────────────────────────────────────────────────────
  const barMenu: MenuItems = [
    ...(empty || functions.length === 0 ? [{ label: 'Secrets', onClick: () => go({ view: 'secrets' }) }] : []),
    ...(canWrite && untestedEndpoints.length > 0 ? [{ label: `Test untested endpoints (${untestedEndpoints.length})…`, onClick: () => setConfirmBulk(true) }] : []),
    ...(canAdminister && schemaFns.length > 0 ? [{ label: `Remove unused schema endpoints (${schemaFns.length})…`, onClick: () => setConfirmCleanup(true) }] : []),
    { label: 'Changes in History', onClick: () => router.push(`/app/projects/${projectId}/changes?part=functions`) },
    { label: 'Function logs in Monitoring', onClick: () => router.push(`/app/projects/${projectId}/monitoring?view=logs&type=function`) },
  ]

  const facts =
    read.status === 'ready' || loaded
      ? own.length > 0
        ? [
            { text: `${count(own.length)} ${own.length === 1 ? 'function' : 'functions'}` },
            failedN > 0
              ? { glyph: 'failed' as const, label: '', text: `${count(failedN)} failed`, tone: 'danger' as const }
              : offN > 0
                ? { glyph: 'paused' as const, label: '', text: `${count(offN)} off` }
                : null,
          ]
        : []
      : []

  // ── Panes ───────────────────────────────────────────────────────────────────
  const phoneDetail = !!fnParam || !!viewParam
  const firstLoadFailed = read.status === 'error' && read.at === null

  let body: React.ReactNode
  if (read.status === 'loading') {
    body = (
      <div className="flex min-h-0 flex-1">
        <div className={`hidden w-[280px] flex-shrink-0 border-r ${RULE} ${RAIL} md:block`}>
          <RowSkeleton rows={4} lead="glyph" />
        </div>
        <div className="min-w-0 flex-1">
          <RowSkeleton rows={6} lead="glyph" />
        </div>
      </div>
    )
  } else if (firstLoadFailed) {
    body = <ErrorRow things="functions" onRetry={() => void refresh()} retrying={refreshing} />
  } else if (empty && !showSecrets) {
    body = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyPanel
          title="No functions yet"
          sentence="Endpoints, schedules and code that runs when data changes."
          requests={EXAMPLE_PROMPTS}
          agent={agent}
          canConnect={canAdminister}
          docs={{ label: 'Functions docs', slug: 'functions' }}
          headingLevel={2}
        />
      </div>
    )
  } else {
    body = (
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">
          {!empty && (
            <nav
              aria-label="Functions"
              className={`w-full flex-shrink-0 overflow-y-auto overflow-x-hidden border-r ${RULE} ${RAIL} p-[8px] md:block md:w-[280px] ${phoneDetail ? 'hidden' : 'block'}`}
            >
              {findable && (
                <div className="mb-[8px] space-y-[6px]">
                  <SearchField value={query} onChange={setQuery} placeholder="Search functions" className="w-full" />
                  <KitSelect aria-label="Filter by trigger" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
                    <option value="all">All triggers</option>
                    {TRIGGER_FILTERS.filter((t) => triggerCounts.get(t.key)).map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label} ({triggerCounts.get(t.key)})
                      </option>
                    ))}
                  </KitSelect>
                </div>
              )}
              <ul className="space-y-px">
                {/* With nothing chosen, All runs is what the wide layout shows; a phone shows this list instead. */}
                <RailLink label="All runs" active={!fnParam && !showSecrets} implicit={!viewParam} onSelect={() => go({ view: 'runs' })} />
              </ul>
              <ul className="mt-[6px] space-y-px">
                {own.filter(matches).map((f) => (
                  <RailFunction key={f.id} fn={f} active={selected?.id === f.id} onSelect={() => go({ fn: f.name })} />
                ))}
              </ul>
              {generated.length > 0 && <GeneratedGroup fns={generated.filter(matches)} total={generated.length} selectedId={selected?.id ?? null} onSelect={(f) => go({ fn: f.name })} />}
              {findable && own.filter(matches).length + generated.filter(matches).length === 0 && (
                <p className="px-[10px] py-[8px] text-[12.5px] leading-[18px] text-faint">No function matches.</p>
              )}
              <ul className={`mt-[8px] space-y-px border-t ${RULE} pt-[8px]`}>
                <RailLink
                  label="Secrets"
                  n={secrets.read.status === 'ready' ? secrets.read.vars.length : undefined}
                  active={showSecrets}
                  onSelect={() => go({ view: 'secrets' })}
                />
              </ul>
            </nav>
          )}

          <section aria-label={showSecrets ? 'Secrets' : selected ? selected.name : 'All runs'} className={`min-w-0 flex-1 flex-col ${phoneDetail || empty ? 'flex' : 'hidden md:flex'}`}>
            {phoneDetail && !empty && (
              <div className={`flex h-[40px] flex-shrink-0 items-center border-b ${RULE} px-[8px] md:hidden`}>
                <button
                  type="button"
                  onClick={() => go({})}
                  className={`inline-flex h-[32px] items-center gap-[4px] rounded-[7px] pl-[4px] pr-[10px] text-[13px] font-medium text-zinc-300 hover:text-white ${FOCUS_INSET}`}
                >
                  <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
                  Functions
                </button>
              </div>
            )}
            {showSecrets ? (
              <EnvVarsPanel projectId={projectId} secrets={secrets} canWrite={canWrite} canAdminister={canAdminister} readers={readers} />
            ) : fnParam ? (
              selected ? (
                <FunctionPane
                  key={selected.id}
                  projectId={projectId}
                  fn={selected}
                  initialTab={tabParam}
                  capture={capture}
                  canWrite={canWrite}
                  canAdminister={canAdminister}
                  secretNames={secrets.names}
                  runsKey={runsKey}
                  toggling={toggling === selected.id}
                  refused={refused?.id === selected.id ? refused.message : null}
                  onTest={() => setTesting(true)}
                  onToggle={() => void toggle(selected)}
                  onDelete={() => setConfirmDelete(selected)}
                  onOpenSecrets={() => go({ view: 'secrets' })}
                />
              ) : (
                <p className="px-[16px] py-[16px] text-[13px] leading-[20px] text-zinc-400 sm:px-[20px]">
                  No function is named <code className="font-mono text-[12px] text-zinc-200">{fnParam}</code>.{' '}
                  <button type="button" onClick={() => go({})} className="text-zinc-200 underline decoration-white/25 underline-offset-[3px] hover:decoration-white/60">
                    Show all runs
                  </button>
                </p>
              )
            ) : (
              <AllRunsPane projectId={projectId} runsKey={runsKey} />
            )}
          </section>
        </div>
      </div>
    )
  }

  // A function's own page says it under its facts; the strip covers everywhere else.
  const uncaptured = capture && !capture.healthy ? capture.uncaptured.filter((u) => u.id !== selected?.id) : []
  return (
    <div className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`}>
      <InstrumentBar
        title="Functions"
        facts={facts}
        loading={read.status === 'loading'}
        freshness={read.status === 'ready' ? read.at : null}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        menu={barMenu}
        create={canWrite && !firstLoadFailed ? { label: 'New function', onClick: () => setShowNew(true), primary: own.length > 0 } : undefined}
      />
      {read.status === 'error' && read.at !== null && (
        <ErrorRow things="functions" staleAt={read.at} onRetry={() => void refresh()} retrying={refreshing} />
      )}
      {uncaptured.map((u) => (
        <NoticeStrip key={u.id} tone="attention">
          Row events on {u.table ? <code className="font-mono text-[12px] text-zinc-200">{u.table}</code> : 'its table'} aren&apos;t being captured, so{' '}
          <code className="font-mono text-[12px] text-zinc-200">{u.name}</code> won&apos;t fire. Turning it off and on again reinstalls capture.
        </NoticeStrip>
      ))}
      {pageNote && (
        <div role="status" className={`flex min-h-[40px] flex-shrink-0 items-center gap-[12px] border-b ${RULE} px-[16px] py-[8px] sm:px-[20px]`}>
          <p className={`min-w-0 flex-1 text-[12.5px] leading-[18px] ${pageNote.tone === 'danger' ? 'text-rose-300' : 'text-zinc-400'}`}>{pageNote.text}</p>
          <KitButton size="sm" variant="ghost" onClick={() => setPageNote(null)}>
            Dismiss
          </KitButton>
        </div>
      )}
      {body}

      {selected && (
        <TestRunDialog
          open={testing}
          onClose={() => setTesting(false)}
          projectId={projectId}
          fn={selected}
          billingHref={billingHref}
          onRan={() => {
            setRunsKey((k) => k + 1)
            void fetchFunctions()
          }}
        />
      )}

      {/* New function: the agent writes it, so this is the request to send it. */}
      <KitModal
        open={showNew}
        onClose={() => setShowNew(false)}
        title="New function"
        description={
          <>
            Your agent writes functions, and they go live without a deploy.
            {agentSentence(agent, EXAMPLE_PROMPTS.length, canAdminister) && <> {agentSentence(agent, EXAMPLE_PROMPTS.length, canAdminister)}</>}
          </>
        }
        width="max-w-[560px]"
        footer={
          <KitButton variant="ghost" onClick={() => setShowNew(false)}>
            Close
          </KitButton>
        }
      >
        <AskYourAgent requests={EXAMPLE_PROMPTS} />
      </KitModal>

      <KitConfirmDialog
        open={!!confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void performDelete(confirmDelete)
        }}
        title={confirmDelete ? `Delete ${confirmDelete.name}?` : 'Delete function?'}
        description="It stops running now."
        undoable={{ detail: 'code and all' }}
        confirmLabel="Delete"
        danger
        busy={deleting}
      />

      <KitConfirmDialog
        open={confirmCleanup}
        onCancel={() => setConfirmCleanup(false)}
        onConfirm={() => void performCleanup()}
        title={`Remove ${count(schemaFns.length)} unused schema ${schemaFns.length === 1 ? 'endpoint' : 'endpoints'}?`}
        description="Backenly generated them for your tables and nothing has called them yet. Your frontend can no longer fetch those validation schemas."
        undoable={{ detail: 'code and all' }}
        confirmLabel="Remove"
        danger
        busy={cleaning}
      />

      <KitConfirmDialog
        open={confirmBulk}
        onCancel={() => setConfirmBulk(false)}
        onConfirm={() => void runUntested()}
        title={`Test ${count(runnableUntestedFns.length)} untested ${runnableUntestedFns.length === 1 ? 'endpoint' : 'endpoints'}?`}
        description="Each runs once, for real, with an empty request: writes, emails and quota count. Event functions are never run this way; test each from its own page."
        confirmLabel="Run them"
        busy={bulkRunning}
      />
    </div>
  )
}

// ─── All runs ─────────────────────────────────────────────────────────────────

function AllRunsPane({ projectId, runsKey }: { projectId: string; runsKey: number }) {
  const [filter, setFilter] = useState<'all' | 'failed'>('all')
  return (
    <>
      <PaneToolbar
        title="All runs"
        view={{
          value: filter,
          onChange: (v) => setFilter(v === 'failed' ? 'failed' : 'all'),
          label: 'Show runs',
          options: [
            { value: 'all', label: 'All' },
            { value: 'failed', label: 'Failed' },
          ],
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RunsList
          projectId={projectId}
          failedOnly={filter === 'failed'}
          reloadKey={runsKey}
          showName
          empty={filter === 'failed' ? 'No failed runs.' : 'No runs yet. Runs show up here as your functions are called.'}
        />
      </div>
    </>
  )
}

// ─── One function ─────────────────────────────────────────────────────────────

function FunctionPane({
  projectId,
  fn,
  initialTab,
  capture,
  canWrite,
  canAdminister,
  secretNames,
  runsKey,
  toggling,
  refused,
  onTest,
  onToggle,
  onDelete,
  onOpenSecrets,
}: {
  projectId: string
  fn: AiFunction
  initialTab: 'runs' | 'code'
  capture: FunctionsCapture | null
  canWrite: boolean
  canAdminister: boolean
  secretNames: string[] | null
  runsKey: number
  toggling: boolean
  refused: string | null
  onTest: () => void
  onToggle: () => void
  onDelete: () => void
  onOpenSecrets: () => void
}) {
  const router = useRouter()
  const [tab, setTab] = useState<'runs' | 'code'>(initialTab)
  const [filter, setFilter] = useState<'all' | 'failed'>('all')
  const [openFirst, setOpenFirst] = useState(false)
  const endpoint = endpointOf(fn)
  const endpointUrl = endpoint ? `${typeof window !== 'undefined' ? window.location.origin : ''}${endpoint.path}` : null
  const state = fnState(fn)
  const off = fn.status === 'inactive'
  const kind = triggerKind(fn)
  const uncaptured = capture?.uncaptured.find((u) => u.id === fn.id)

  const menu: MenuItems = [
    ...(endpointUrl ? [{ label: 'Copy endpoint URL', onClick: () => void copyText(endpointUrl) }] : []),
    ...(canAdminister && isAdminGated(fn)
      ? [{ label: 'Copy admin key', onClick: () => void fetchAdminKey(projectId).then((k) => (k ? copyText(k) : undefined)) }]
      : []),
    ...(canWrite ? [{ label: off ? 'Turn on' : 'Turn off', onClick: onToggle, disabled: toggling }] : []),
    { label: 'Logs in Monitoring', onClick: () => router.push(`/app/projects/${projectId}/monitoring?view=logs&type=function&q=${encodeURIComponent(fn.name)}`) },
    { label: 'Changes in History', onClick: () => router.push(`/app/projects/${projectId}/changes?part=functions`) },
    ...(canAdminister ? [{ separator: true as const }, { label: 'Delete…', danger: true, onClick: onDelete }] : []),
  ]

  return (
    <>
      <PaneToolbar
        title={fn.name}
        mono
        menu={menu}
        menuLabel={`Actions for ${fn.name}`}
        filter={
          tab === 'runs' ? (
            <Segmented
              size="sm"
              label="Show runs"
              value={filter}
              onChange={(v) => setFilter(v === 'failed' ? 'failed' : 'all')}
              options={[
                { value: 'all', label: 'All' },
                { value: 'failed', label: 'Failed' },
              ]}
            />
          ) : undefined
        }
        view={{
          value: tab,
          onChange: (v) => setTab(v === 'code' ? 'code' : 'runs'),
          label: `${fn.name} view`,
          options: [
            { value: 'runs', label: 'Runs' },
            { value: 'code', label: 'Code' },
          ],
        }}
        action={
          canWrite && !off ? (
            <KitButton size="sm" icon={Play} onClick={onTest}>
              Test run
            </KitButton>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
        <div className={`space-y-[8px] border-b ${RULE} px-[16px] py-[12px] sm:px-[20px]`}>
          {fn.description && (
            <p title={fn.description} className="truncate text-[13px] leading-[20px] text-zinc-300">
              {fn.description}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] text-[12px] leading-[16px] text-faint">
            <span className="inline-flex items-center gap-[6px]">
              <StatusGlyph state={state.glyph} label={state.label} showLabel={state.show} />
              <span className="text-zinc-300">{triggerWords(fn)}</span>
            </span>
            {kind === 'cron' && fn.triggerTable && <code className="font-mono text-[11.5px] text-zinc-400">{fn.triggerTable}</code>}
            <span className="tabular-nums">
              {count(fn.runCount)} {fn.runCount === 1 ? 'run' : 'runs'}
            </span>
            {fn.lastRun ? <Time iso={fn.lastRun} prefix="Last run" /> : <span>Never run</span>}
            <span>{fn.generated || fn.codeOrigin === 'generated' ? 'Written by Backenly' : 'Written by your agent'}</span>
            <Time iso={fn.createdAt} mode="date" prefix="Created" />
          </div>
          {endpointUrl && endpoint && <CopyField value={endpointUrl} prefix={endpoint.method} label="Copy endpoint URL" className="max-w-[720px]" />}
          {endpointUrl && isAdminGated(fn) && (
            <p className="text-[12px] leading-[16px] text-faint">
              Send the project&apos;s admin key as the <code className="font-mono text-[11.5px] text-zinc-300">x-admin-key</code> header.
            </p>
          )}
          {off && (
            <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[6px]">
              <p className="text-[12.5px] leading-[18px] text-zinc-300">Off. It doesn&apos;t run on events or requests.</p>
              {canWrite && (
                <KitButton size="sm" onClick={onToggle} loading={toggling}>
                  Turn on
                </KitButton>
              )}
            </div>
          )}
          {fn.status === 'error' && fn.lastError && (
            <button
              type="button"
              onClick={() => {
                setTab('runs')
                setFilter('failed')
                setOpenFirst(true)
              }}
              className={`block w-full truncate rounded-[3px] text-left text-[12.5px] leading-[18px] text-rose-300 hover:text-rose-200 ${FOCUS_INSET}`}
            >
              Last run failed: <span className="font-mono text-[12px]">{fn.lastError}</span>
            </button>
          )}
          {uncaptured && (
            <p className="flex items-start gap-[8px] text-[12.5px] leading-[18px] text-zinc-50">
              <StatusGlyph state="waiting" label="Needs a look" className="mt-[3px]" />
              <span>Row events on {uncaptured.table ?? 'its table'} aren&apos;t being captured, so it won&apos;t fire. Turning it off and on again reinstalls capture.</span>
            </p>
          )}
          {!canWrite && <p className="text-[12.5px] leading-[18px] text-faint">Only developers and admins can run or change functions.</p>}
          {refused && <RefusedLine>{refused}</RefusedLine>}
        </div>
        {tab === 'runs' ? (
          <RunsList
            projectId={projectId}
            functionId={fn.id}
            failedOnly={filter === 'failed'}
            reloadKey={runsKey}
            showName={false}
            openFirst={openFirst}
            onOpenedFirst={() => setOpenFirst(false)}
            empty={filter === 'failed' ? 'No failed runs.' : 'No runs yet. Its runs show up here as it is called.'}
          />
        ) : (
          <CodeView projectId={projectId} fn={fn} secretNames={secretNames} onOpenSecrets={onOpenSecrets} />
        )}
      </div>
    </>
  )
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

const RAIL_ITEM = `flex w-full items-center gap-[10px] rounded-[7px] px-[10px] text-left transition-colors duration-150 ${FOCUS_INSET}`

function RailLink({ label, n, active, implicit = false, onSelect }: { label: string; n?: number; active: boolean; implicit?: boolean; onSelect: () => void }) {
  const on = active && !implicit
  return (
    <li>
      <button
        type="button"
        aria-current={on ? 'page' : undefined}
        onClick={onSelect}
        className={`${RAIL_ITEM} h-[34px] ${
          on
            ? 'bg-white/[0.07] text-white'
            : active
              ? 'text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100 md:bg-white/[0.07] md:text-white'
              : 'text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100'
        }`}
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{label}</span>
        {typeof n === 'number' && <span className="text-[12px] tabular-nums text-faint">{count(n)}</span>}
      </button>
    </li>
  )
}

function RailFunction({ fn, active, onSelect }: { fn: AiFunction; active: boolean; onSelect: () => void }) {
  const state = fnState(fn)
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        className={`${RAIL_ITEM} items-start py-[7px] ${active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}
      >
        <StatusGlyph state={state.glyph} label={state.label} className="mt-[3px]" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-[8px]">
            <span className={`min-w-0 flex-1 truncate font-mono text-[12.5px] leading-[18px] ${active ? 'text-white' : off(fn) ? 'text-zinc-400' : 'text-zinc-100'}`}>{fn.name}</span>
            {fn.lastRun && (
              <span className="flex-shrink-0 text-[11.5px] tabular-nums text-faint">
                <Time iso={fn.lastRun} />
              </span>
            )}
          </span>
          <span className="mt-[2px] flex items-baseline gap-[8px] text-[12px] leading-[16px] text-faint">
            {state.show && <span className={`flex-shrink-0 font-medium ${state.glyph === 'failed' ? 'text-zinc-50' : 'text-zinc-300'}`}>{state.label}</span>}
            <span className="min-w-0 truncate">{triggerWords(fn)}</span>
          </span>
        </span>
      </button>
    </li>
  )
}

const off = (fn: AiFunction) => fn.status === 'inactive'

/** What Backenly generated for the tables: listed apart, closed until asked for. */
function GeneratedGroup({ fns, total, selectedId, onSelect }: { fns: AiFunction[]; total: number; selectedId: string | null; onSelect: (f: AiFunction) => void }) {
  const [open, setOpen] = useState(() => fns.some((f) => f.id === selectedId))
  return (
    <section aria-label="Generated for your tables" className={`mt-[8px] border-t ${RULE} pt-[8px]`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`${RAIL_ITEM} h-[32px] text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100`}
      >
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">Generated for your tables</span>
        <span className="text-[12px] tabular-nums text-faint">{count(total)}</span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 text-zinc-500 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} strokeWidth={1.75} />
      </button>
      {open && (
        <ul className="mt-[2px] space-y-px">
          {fns.map((f) => (
            <RailFunction key={f.id} fn={f} active={selectedId === f.id} onSelect={() => onSelect(f)} />
          ))}
        </ul>
      )}
    </section>
  )
}
