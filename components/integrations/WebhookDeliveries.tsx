'use client'

/**
 * What an endpoint (or an agent trigger) delivered, by day: one row per
 * delivery, the result glyph first, the receiver's status code as the result,
 * and words only for Retrying, Failed and Gave up. A row opens in place
 * (decision 6) onto the receiver's own answer, which the page used to drop:
 * "Cannot read properties of null (reading 'trim')" is why a 500 happened,
 * and "HTTP 500" alone is not.
 */

import { useState, type ReactNode } from 'react'
import { KitButton, CopyField, StatusGlyph } from '@/components/inspector/kit'
import { CodeWell, DayGroup, DayGroupList, EventRow, EventRowSkeleton } from '@/components/console/EventRow'
import { ErrorRow } from '@/components/console/states'
import { GridFooter } from '@/components/console/InstrumentBar'
import { EmptyLine } from '@/components/autonomy/rows'
import { Time } from '@/components/console/Time'
import { groupByDay } from '@/components/console/format'
import { RULE, WELL } from '@/components/console/tokens'
import {
  deliveryLook,
  errorWorthShowing,
  readableBody,
  triggerDeliveryLook,
  type DeliveryLog,
  type TriggerDeliveryRow,
} from './webhooks-present'

/** Every list of deliveries shows these columns at the same widths. */
const COLUMNS = { result: 44 }

/** The ids of the open rows, toggled one at a time. */
function useOpenRows() {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return { open, toggle }
}

function attempts(n: number): string {
  return `${n} ${n === 1 ? 'attempt' : 'attempts'}`
}

/** The words after an endpoint delivery's state: attempts, the next one, the error. */
function deliveryLine(log: DeliveryLog): ReactNode {
  const err = errorWorthShowing(log)
  switch (log.status) {
    case 'RETRYING':
      return (
        <>
          {attempts(log.attemptCount)}
          {log.nextRetryAt && (
            <span className="ml-[12px]">
              Next attempt <Time iso={log.nextRetryAt} mode="clock" />
            </span>
          )}
        </>
      )
    case 'DEAD_LETTER':
      return (
        <>
          after {attempts(log.attemptCount)}
          {err && <span className="ml-[12px]">{err}</span>}
        </>
      )
    case 'FAILED':
      return err ?? (log.attemptCount > 1 ? `after ${attempts(log.attemptCount)}` : null)
    case 'CANCELLED':
      return err ?? 'The project was paused.'
    case 'SUCCESS':
      return log.attemptCount > 1 ? `on attempt ${log.attemptCount}` : null
    default:
      return err
  }
}

/** The open row: the delivery's id (the receiver sees it as X-Webhook-Delivery), then its answer. */
function DeliveryDetail({ log }: { log: DeliveryLog }) {
  const body = readableBody(log.responseBody)
  const err = errorWorthShowing(log)
  return (
    <div>
      <div className={`flex flex-wrap items-center gap-x-[18px] gap-y-[4px] border-t ${RULE} ${WELL} px-[16px] pt-[10px] text-[12px] leading-[18px] text-faint sm:px-[20px]`}>
        <span className="inline-flex min-w-0 max-w-full items-center gap-[6px]">
          <span className="flex-shrink-0">X-Webhook-Delivery</span>
          <CopyField variant="inline" value={log.id} label="Copy delivery id" />
        </span>
        {log.attemptCount > 1 && <span>{attempts(log.attemptCount)}</span>}
        {log.deliveredAt && (
          <span>
            Delivered <Time iso={log.deliveredAt} mode="clockSeconds" />
          </span>
        )}
      </div>
      {body ? (
        <CodeWell label="Response" copy={log.responseBody ?? ''} className="!border-t-0">
          {body}
        </CodeWell>
      ) : err ? (
        <CodeWell label="Error" copy={err} className="!border-t-0">
          {err}
        </CodeWell>
      ) : (
        <CodeWell className="!border-t-0">
          <span className="font-sans text-faint">No response body.</span>
        </CodeWell>
      )}
    </div>
  )
}

export interface DeliveryListProps {
  /** Null until the first read. */
  logs: DeliveryLog[] | null
  /** The first read failed: the error row replaces the rows. */
  failed: boolean
  /** A later read failed: the rows stay, with this time on them. */
  staleAt: string | null
  onRetry: () => void
  retrying?: boolean
  filter: 'all' | 'failed'
  /** How many were asked for: "Showing the last 50". */
  limit: number
  onLoadMore?: () => void
  loadingMore?: boolean
  /** A row to mark as the one just made (a test, a resend). */
  highlight: string | null
  /** The Send again button for a row, or nothing. */
  sendAgain: (log: DeliveryLog) => ReactNode
  /** The line for an endpoint with nothing delivered yet. */
  emptyLine: string
}

/** An endpoint's deliveries, newest first, by day. */
export function EndpointDeliveries({
  logs,
  failed,
  staleAt,
  onRetry,
  retrying = false,
  filter,
  limit,
  onLoadMore,
  loadingMore = false,
  highlight,
  sendAgain,
  emptyLine,
}: DeliveryListProps) {
  const { open, toggle } = useOpenRows()
  if (failed) return <ErrorRow things="deliveries" onRetry={onRetry} retrying={retrying} />
  if (!logs) return <EventRowSkeleton rows={6} what={false} />
  const shown = filter === 'failed' ? logs.filter((l) => l.status === 'RETRYING' || l.status === 'FAILED' || l.status === 'DEAD_LETTER') : logs
  const days = groupByDay(shown, (l) => l.createdAt)
  const capped = logs.length >= limit
  return (
    <>
      {staleAt && <ErrorRow things="deliveries" onRetry={onRetry} retrying={retrying} staleAt={staleAt} />}
      {logs.length === 0 ? (
        <EmptyLine>{emptyLine}</EmptyLine>
      ) : shown.length === 0 ? (
        <EmptyLine>{capped ? `No failed deliveries in the last ${limit}.` : 'No failed deliveries.'}</EmptyLine>
      ) : (
        <DayGroupList>
          {days.map((day) => (
            <DayGroup key={day.key} label={day.label}>
              {day.items.map((log) => {
                const look = deliveryLook(log.status)
                return (
                  <EventRow
                    key={log.id}
                    id={`delivery-${log.id}`}
                    glyph={look.glyph}
                    glyphLabel={look.label}
                    word={look.word}
                    time={log.createdAt}
                    result={log.statusCode ?? '—'}
                    columns={COLUMNS}
                    line={deliveryLine(log)}
                    action={sendAgain(log)}
                    expanded={open.has(log.id)}
                    onToggle={() => toggle(log.id)}
                    current={log.id === highlight}
                  >
                    <DeliveryDetail log={log} />
                  </EventRow>
                )
              })}
            </DayGroup>
          ))}
        </DayGroupList>
      )}
      {logs.length > 0 && (
        <GridFooter
          mode="more"
          shown={logs.length}
          hasMore={capped && !!onLoadMore}
          onLoadMore={onLoadMore ?? (() => {})}
          loading={loadingMore}
          note={
            filter === 'failed'
              ? `${shown.length} failed in the ${capped ? `last ${logs.length}` : `${logs.length} deliveries`}`
              : capped
                ? `Showing the last ${logs.length}`
                : `${logs.length} ${logs.length === 1 ? 'delivery' : 'deliveries'}`
          }
        />
      )}
    </>
  )
}

/** An agent trigger's recent deliveries (the route returns the project's last 50). */
export function TriggerDeliveries({
  deliveries,
  sendAgain,
  highlight,
}: {
  deliveries: TriggerDeliveryRow[]
  sendAgain: (log: TriggerDeliveryRow) => ReactNode
  highlight: string | null
}) {
  const { open, toggle } = useOpenRows()
  if (deliveries.length === 0) return <EmptyLine>No deliveries yet. It posts when the row event fires.</EmptyLine>
  const days = groupByDay(deliveries, (d) => d.createdAt)
  return (
    <DayGroupList>
      {days.map((day) => (
        <DayGroup key={day.key} label={day.label}>
          {day.items.map((log) => {
            const look = triggerDeliveryLook(log.status)
            const detail = log.error?.trim() || null
            return (
              <EventRow
                key={log.id}
                id={`trigger-delivery-${log.id}`}
                glyph={look.glyph}
                glyphLabel={look.label}
                word={look.word}
                time={log.createdAt}
                result={log.statusCode ?? '—'}
                columns={COLUMNS}
                line={
                  log.status === 'DEAD'
                    ? `after ${attempts(log.attemptCount)}`
                    : log.status === 'SUCCESS' && log.attemptCount > 1
                      ? `on attempt ${log.attemptCount}`
                      : detail
                }
                action={sendAgain(log)}
                current={log.id === highlight}
                {...(detail ? { expanded: open.has(log.id), onToggle: () => toggle(log.id) } : {})}
              >
                {detail ? (
                  <CodeWell label="Error" copy={detail}>
                    {detail}
                  </CodeWell>
                ) : null}
              </EventRow>
            )
          })}
        </DayGroup>
      ))}
    </DayGroupList>
  )
}

/**
 * What a test or a resend just did, in a line under the header: the glyph and
 * the receiver's answer. A failure is said in rose and announced.
 */
export function AnswerLine({ ok, text, className = '' }: { ok: boolean; text: string; className?: string }) {
  return (
    <p
      role={ok ? 'status' : 'alert'}
      className={`flex items-start gap-[8px] text-[13px] leading-[20px] [overflow-wrap:anywhere] ${ok ? 'text-zinc-200' : 'text-rose-300'} ${className}`}
    >
      <StatusGlyph state={ok ? 'done' : 'failed'} label={ok ? 'Done' : 'Failed'} className="mt-[4px]" />
      <span className="min-w-0">{text}</span>
    </p>
  )
}
