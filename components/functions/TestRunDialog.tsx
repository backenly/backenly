'use client'

/**
 * Test run: one real run of a function with the payload you give it, and its
 * result in the dialog, next to the thing tested.
 *
 * The page used to send every test an EMPTY event, so an event function could
 * not really be tested ("no review in the event; nothing to notify"), and the
 * result opened as a box inside a box that pushed the page down. Now the JSON
 * field is named for what the trigger sends, and the answer is read the way it
 * happened:
 *   - a 4xx is the endpoint answering, not failing (one sentence on why);
 *   - a 5xx or a thrown error is a failure;
 *   - the plan's run limit is not a code failure: the code never ran.
 * Runs execute for real (writes, emails and quota count), and the dialog says
 * so in one line. The run also lands at the top of Runs.
 */

import { useId, useState } from 'react'
import { KitButton, KitButtonLink, KitModal, KitTextarea, StatusGlyph } from '@/components/inspector/kit'
import { CodeWell } from '@/components/console/EventRow'
import { duration, formatTime } from '@/components/console/format'
import { payloadLabel, triggerKind, type AiFunction, type TestRunResult } from './model'

interface Outcome {
  result: TestRunResult | null
  /** The route's own refusal, in its words, when it answered without a run. */
  refused: string | null
  planLimit: boolean
}

/** What a 4xx from the handler means, in one sentence. */
function answeredBecause(status: number): string {
  if (status === 400) return 'It answered 400 to this payload: its own validation, not a failure.'
  if (status === 401 || status === 403) return 'Test runs call it as the project’s admin, so it also checks something this run didn’t carry.'
  if (status === 404) return 'It ran and answered 404: the test user has no matching records.'
  return `It ran and answered ${status}: its own answer, not a failure.`
}

/** The hint under the payload, by what the trigger sends. */
function payloadHint(fn: AiFunction): string {
  switch (triggerKind(fn)) {
    case 'http':
      return 'Sent as the request body, and read as the query string too.'
    case 'on_db_insert':
    case 'on_db_update':
    case 'on_db_delete':
      return `The row as the trigger sends it, column by column${fn.triggerTable ? `, from ${fn.triggerTable}` : ''}.`
    case 'on_signup':
      return 'The new user as sign-up sends it: id, email and name.'
    default:
      return 'Passed to the function as event.data.'
  }
}

export function TestRunDialog({
  open,
  onClose,
  projectId,
  fn,
  billingHref,
  onRan,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  fn: AiFunction
  billingHref: string
  /** A run was recorded: the page reads its runs and functions again. */
  onRan: () => void
}) {
  const fieldId = useId()
  const hintId = useId()
  const [payload, setPayload] = useState('{}')
  const [problem, setProblem] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [wasOpen, setWasOpen] = useState(open)
  // Each opening starts clean (reset while rendering, not in an effect).
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setPayload('{}')
      setProblem(null)
      setOutcome(null)
    }
  }

  const run = async () => {
    let event: unknown
    try {
      event = JSON.parse(payload.trim() || '{}')
    } catch (e) {
      setProblem(`This isn't valid JSON. ${e instanceof Error ? e.message : ''}`.trim())
      return
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      setProblem('Send a JSON object, like {}.')
      return
    }
    setProblem(null)
    setRunning(true)
    setOutcome(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/ai-functions/${fn.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ event }),
      })
      const data = await res.json().catch(() => null)
      const result: TestRunResult | null = data?.result ?? null
      const planLimit = result?.errorCode === 'PLAN_LIMIT_EXCEEDED' || data?.code === 'PLAN_LIMIT_EXCEEDED'
      setOutcome({
        result,
        refused: !res.ok && !planLimit ? data?.error ?? `The run was refused (${res.status}).` : null,
        planLimit,
      })
      if (result) onRan()
    } catch {
      setOutcome({ result: null, refused: 'Could not reach Backenly. Nothing ran.', planLimit: false })
    } finally {
      setRunning(false)
    }
  }

  return (
    <KitModal
      open={open}
      onClose={onClose}
      title="Test run"
      width="max-w-[640px]"
      description={
        <>
          Runs <code className="font-mono text-[12px] text-zinc-300">{fn.name}</code> for real. Writes, emails and quota count.
        </>
      }
      footer={
        <>
          <KitButton variant="ghost" onClick={onClose}>
            {outcome ? 'Close' : 'Cancel'}
          </KitButton>
          <KitButton variant="primary" onClick={run} loading={running}>
            {running ? 'Running…' : outcome ? 'Run again' : 'Run'}
          </KitButton>
        </>
      }
    >
      <label htmlFor={fieldId} className="mb-1.5 block text-[12.5px] font-medium leading-[18px] text-zinc-300">
        {payloadLabel(fn)}
      </label>
      <KitTextarea
        id={fieldId}
        aria-describedby={hintId}
        aria-invalid={problem ? true : undefined}
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        rows={6}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="font-mono !text-[12.5px]"
      />
      <p id={hintId} className={`mt-1.5 text-[12px] leading-[17px] ${problem ? 'text-rose-300' : 'text-faint'}`} role={problem ? 'alert' : undefined}>
        {problem ?? payloadHint(fn)}
      </p>
      <div aria-live="polite">{outcome && <RunOutcome outcome={outcome} billingHref={billingHref} />}</div>
    </KitModal>
  )
}

function RunOutcome({ outcome, billingHref }: { outcome: Outcome; billingHref: string }) {
  if (outcome.planLimit) {
    const now = new Date()
    const reset = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    return (
      <div className="mt-[16px] flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
        <p className="min-w-0 flex-1 text-[13px] leading-[20px] text-zinc-200">
          This month&apos;s function runs are used up. They reset {formatTime(reset, 'date')}.
        </p>
        <KitButtonLink href={billingHref} size="sm">
          Upgrade to Pro
        </KitButtonLink>
      </div>
    )
  }
  const r = outcome.result
  if (!r) {
    return (
      <p role="alert" className="mt-[16px] text-[13px] leading-[20px] text-rose-300 [overflow-wrap:anywhere]">
        {outcome.refused}
      </p>
    )
  }
  const rv = r.returnValue as { status?: unknown; body?: unknown } | undefined
  const status = rv && typeof rv === 'object' && typeof rv.status === 'number' ? rv.status : null
  const body = status !== null ? rv?.body : r.returnValue
  const took = duration(r.durationMs)
  const failed = !r.success || (status !== null && status >= 500)
  const answered4xx = !failed && status !== null && status >= 400
  const heading = !r.success
    ? `Failed in ${took}`
    : status !== null
      ? `${status >= 400 ? 'Answered' : 'Returned'} ${status} in ${took}`
      : `Ran in ${took}`

  let bodyText = ''
  if (body !== undefined && body !== null) {
    try {
      bodyText = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
    } catch {
      bodyText = String(body)
    }
  }
  if (bodyText.length > 2000) bodyText = `${bodyText.slice(0, 2000)}\n…`
  const output = [...r.logs, ...(bodyText ? [bodyText] : []), ...(r.error ? [r.error] : [])].join('\n')

  return (
    <div className="mt-[16px]">
      <p className="flex items-center gap-[8px] text-[13px] font-medium leading-[20px] text-zinc-100">
        <StatusGlyph state={failed ? 'failed' : answered4xx ? 'idle' : 'done'} label={failed ? 'Failed' : answered4xx ? 'Answered' : 'Succeeded'} />
        <span className={failed ? 'text-zinc-50' : ''}>{heading}</span>
      </p>
      {answered4xx && status !== null && <p className="mt-[4px] text-[13px] leading-[20px] text-zinc-400">{answeredBecause(status)}</p>}
      {output && (
        <CodeWell label="Output" copy={output} maxHeight={260} className="mt-[10px] rounded-[7px] border">
          {output}
        </CodeWell>
      )}
    </div>
  )
}
