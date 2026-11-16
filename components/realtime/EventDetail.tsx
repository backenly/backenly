'use client'

/**
 * A selected event, in the shared record drawer: the row it carried (Row),
 * an update's previous row (Before), and Copy JSON for the frame exactly as
 * it arrived. A payload the server cut short says so and links to the row in
 * Database (decision 11).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Check, Copy } from 'lucide-react'
import { CopyField, KitButton } from '@/components/inspector/kit'
import { EDGE, FOCUS, WELL } from '@/components/console/tokens'
import { presenceVerb, pretty, rowKey, singleKeyValue, type LiveEvent } from './event-format'

const MONO = 'font-mono text-[14px] font-medium tracking-normal'

/** The drawer's title: "insert into reviews", the machine words in mono. */
export function EventTitle({ event: ev }: { event: LiveEvent }) {
  const where = ev.table ?? ev.channel
  const name = (s: string) => <code className={MONO}>{s}</code>
  switch (ev.type) {
    case 'insert':
    case 'update':
    case 'delete': {
      const joiner = ev.type === 'insert' ? 'into' : ev.type === 'update' ? 'of' : 'from'
      return (
        <>
          {name(ev.type)}
          {where && (
            <>
              {' '}
              {joiner} {name(where)}
            </>
          )}
        </>
      )
    }
    case 'presence': {
      const who = ev.presence?.userId
      return (
        <>
          {who ? (
            <>
              User {name(who.length > 12 ? who.slice(0, 8) : who)}
            </>
          ) : (
            'A user'
          )}{' '}
          {presenceVerb(ev.presence?.event ?? 'update')}
        </>
      )
    }
    case 'broadcast':
      return (
        <>
          {name('broadcast')}
          {where && <> on {name(where)}</>}
        </>
      )
    default:
      return name(ev.type)
  }
}

/** One part of the drawer: a small label above its value. */
function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-[20px] first:mt-0">
      <h3 className="mb-[8px] text-[12.5px] font-medium leading-[18px] text-zinc-300">{label}</h3>
      {children}
    </section>
  )
}

/** JSON as the stream sent it, in a well. The drawer scrolls, so the well does not. */
function Json({ value }: { value: unknown }) {
  return (
    <pre
      className={`overflow-x-auto whitespace-pre-wrap break-words rounded-[7px] border ${EDGE} ${WELL} px-[14px] py-[10px] font-mono text-[12px] leading-[19px] text-zinc-300`}
    >
      {pretty(value)}
    </pre>
  )
}

const NOTE = 'text-[13px] leading-[20px] text-zinc-400'
const LINK = `rounded-[3px] text-zinc-200 underline decoration-white/25 underline-offset-[3px] transition-colors duration-150 hover:text-white hover:decoration-white/60 ${FOCUS}`

export function EventDetail({ event: ev, projectId }: { event: LiveEvent; projectId: string }) {
  if (ev.type === 'presence') {
    const meta = ev.presence?.metadata
    return (
      <>
        {ev.presence?.userId && (
          <Part label="User">
            <CopyField value={ev.presence.userId} label="Copy user id" />
          </Part>
        )}
        {meta !== null && meta !== undefined && (
          <Part label="Metadata">
            <Json value={meta} />
          </Part>
        )}
      </>
    )
  }

  if (ev.type === 'broadcast') {
    return (
      <Part label="Payload">
        <Json value={ev.payload} />
      </Part>
    )
  }

  if (ev.truncated) {
    const key = rowKey(ev)
    const one = singleKeyValue(ev)
    // A removed row cannot be opened; a row with no single key opens its table.
    const db =
      ev.table && ev.type !== 'delete'
        ? `/app/projects/${projectId}/database?table=${encodeURIComponent(ev.table)}${one ? `&row=${encodeURIComponent(one)}` : ''}`
        : null
    return (
      <>
        <p className={NOTE}>
          Cut short by the server.
          {db && (
            <>
              {' '}
              <Link href={db} className={LINK}>
                {one ? 'Open the row in Database' : `Open ${ev.table} in Database`}
              </Link>
              .
            </>
          )}
        </p>
        {key && (
          <Part label="Key">
            <Json value={key} />
          </Part>
        )}
        {ev.old && (
          <Part label="Before">
            <Json value={ev.old} />
          </Part>
        )}
      </>
    )
  }

  return (
    <>
      {ev.data && (
        <Part label={ev.type === 'delete' ? 'Removed row' : 'Row'}>
          <Json value={ev.data} />
        </Part>
      )}
      {ev.type === 'update' && ev.old && (
        <Part label="Before">
          {ev.oldTruncated && <p className={`mb-[8px] ${NOTE}`}>Cut to its key by the server.</p>}
          <Json value={ev.old} />
        </Part>
      )}
      {!ev.data && <p className={NOTE}>This event carried no row.</p>}
    </>
  )
}

/** Copies the whole frame, as it arrived. */
export function CopyJsonButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1600)
      },
      () => {},
    )
  }, [value])
  return (
    <KitButton icon={copied ? Check : Copy} onClick={copy}>
      <span aria-live="polite">{copied ? 'Copied' : 'Copy JSON'}</span>
    </KitButton>
  )
}
