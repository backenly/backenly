/**
 * How a realtime frame reads on the Realtime page: the event it is, the row it
 * names, and what the drawer shows of it. Pure, so the page and its tests say
 * the same thing.
 *
 * A change frame is what the table's trigger sent (lib/realtime/channel-sql.ts),
 * as this stream may receive it (lib/realtime/visibility.ts):
 *
 *   { type: 'insert' | 'update' | 'delete', table, data, old, timestamp }
 *     data          the new row; for a delete, the removed row
 *     old           an update's previous row
 *     oldTruncated  `old` was cut to the primary key to fit the notify limit
 *     truncated     `data` was cut to the primary key (or to null, when the
 *                   table has no key) to fit the notify limit
 *
 * The console's own stream is opened with a ticket and sees every change as
 * sent. The anon-key fallback receives an update's `old` and a delete's row
 * reduced to the primary key.
 *
 * Presence frames: { type: 'presence', event: 'join' | 'leave' | 'update',
 * userId, metadata?, timestamp }. Broadcasts: { type: 'broadcast', channel,
 * payload, timestamp }. `timestamp` is seconds since the epoch.
 *
 * The page used to keep only an event's type and table, so "update reviews"
 * never said which review changed (round 1, Realtime). Everything a frame
 * carries is kept now.
 */

export type RowData = Record<string, unknown>

export interface LiveEvent {
  /** This session's id for the event: the drawer's ?event=. */
  id: string
  /** insert, update, delete, presence, broadcast, or whatever else the server sent. */
  type: string
  table: string | null
  /** A broadcast's channel. */
  channel: string | null
  /** When it happened, in ms since the epoch. */
  at: number
  /** The row: the new one for an insert or update, the removed one for a delete. */
  data: RowData | null
  /** An update's previous row, or only its key. */
  old: RowData | null
  /** The server cut `data` to the row's key (or to nothing) to fit its size limit. */
  truncated: boolean
  /** The server cut `old` to the row's key. */
  oldTruncated: boolean
  presence: { event: string; userId: string | null; metadata: unknown } | null
  /** A broadcast's payload. */
  payload: unknown
  /** The frame exactly as it arrived, for Copy JSON. */
  frame: Record<string, unknown>
}

export const ROW_EVENT_TYPES: ReadonlySet<string> = new Set(['insert', 'update', 'delete'])
/** The kinds the feed shows and counts. Control frames (connected, error, channel) are not events. */
export const FEED_EVENT_TYPES: ReadonlySet<string> = new Set(['insert', 'update', 'delete', 'presence', 'broadcast'])

const isRecord = (v: unknown): v is RowData => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * A frame from the stream as a feed event, or null for a frame that is not an
 * event (connected, error, the channel's own control frames).
 */
export function toLiveEvent(frame: unknown, id: string, receivedAt: number = Date.now()): LiveEvent | null {
  if (!isRecord(frame) || typeof frame.type !== 'string') return null
  const type = frame.type
  if (!FEED_EVENT_TYPES.has(type)) return null
  const seconds = typeof frame.timestamp === 'number' && Number.isFinite(frame.timestamp) ? frame.timestamp : null
  return {
    id,
    type,
    table: typeof frame.table === 'string' && frame.table ? frame.table : null,
    channel: typeof frame.channel === 'string' && frame.channel ? frame.channel : null,
    at: seconds !== null ? Math.round(seconds * 1000) : receivedAt,
    data: isRecord(frame.data) ? frame.data : null,
    old: isRecord(frame.old) ? frame.old : null,
    truncated: frame.truncated === true,
    oldTruncated: frame.oldTruncated === true,
    presence:
      type === 'presence'
        ? {
            event: typeof frame.event === 'string' ? frame.event : 'update',
            userId: typeof frame.userId === 'string' ? frame.userId : null,
            metadata: frame.metadata ?? null,
          }
        : null,
    payload: type === 'broadcast' ? frame.payload ?? null : null,
    frame,
  }
}

// ─── The row an event names ──────────────────────────────────────────────────

/**
 * The row's key, as far as the frame says it: a cut-short row IS its key (the
 * server keeps exactly the primary key's columns), and otherwise `id` when the
 * row has one. A frame does not name its key columns, so a row without `id`
 * that was sent whole has no key here.
 */
export function rowKey(ev: Pick<LiveEvent, 'data' | 'truncated'>): RowData | null {
  if (!ev.data) return null
  if (ev.truncated) return Object.keys(ev.data).length > 0 ? ev.data : null
  if ('id' in ev.data && ev.data.id !== null && ev.data.id !== undefined) return { id: ev.data.id }
  return null
}

/** The key as one value, for a link: only a single-column key has one. */
export function singleKeyValue(ev: Pick<LiveEvent, 'data' | 'truncated'>): string | null {
  const key = rowKey(ev)
  if (!key) return null
  const values = Object.values(key)
  if (values.length !== 1) return null
  const v = values[0]
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' ? String(v) : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An id as the feed shows it: a uuid's first eight characters, a long string cut, a number whole. */
export function shortValue(v: unknown, max = 40): string {
  if (v === null) return 'null'
  if (v === undefined) return ''
  if (typeof v === 'string') {
    if (UUID.test(v)) return v.slice(0, 8)
    return v.length > max ? `"${v.slice(0, max).trimEnd()}…"` : `"${v}"`
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  const json = JSON.stringify(v)
  return json.length > max ? `${json.slice(0, max)}…` : json
}

/** A key value as an id: never quoted. */
function idValue(v: unknown): string {
  if (typeof v === 'string') return UUID.test(v) ? v.slice(0, 8) : v.length > 16 ? `${v.slice(0, 16)}…` : v
  return shortValue(v)
}

const FOREIGN_KEY = /_id$/i
const TIMESTAMP_NAME = /(^|_)(at|on|date|time|timestamp)$/i

/** The columns an update changed, when the frame carries the whole previous row. */
export function changedColumns(ev: Pick<LiveEvent, 'type' | 'data' | 'old' | 'oldTruncated'>): string[] {
  if (ev.type !== 'update' || !ev.data || !ev.old || ev.oldTruncated) return []
  // `old` reduced to the key (the anon stream) says nothing about what changed.
  const oldKeys = Object.keys(ev.old)
  if (oldKeys.length <= 1 && Object.keys(ev.data).length > 1) return []
  return Object.keys(ev.data).filter((k) => JSON.stringify(ev.data![k]) !== JSON.stringify(ev.old![k]))
}

/**
 * The Row column: the key, then the first readable values.
 *
 *   key: '9415a3c1'   rest: 'rating=3 body="The score carries it…"'
 *
 * An update leads with the columns it changed. Foreign keys and timestamps
 * are left out unless nothing else is there to show.
 */
export function rowSummary(ev: LiveEvent): { key: string | null; rest: string } {
  if (ev.type === 'presence' && ev.presence) {
    const who = ev.presence.userId ? idValue(ev.presence.userId) : null
    const meta = isRecord(ev.presence.metadata) ? pairs(ev.presence.metadata, [], 2) : ''
    return { key: who, rest: meta }
  }
  if (ev.type === 'broadcast') {
    return { key: null, rest: isRecord(ev.payload) ? pairs(ev.payload, [], 3) : ev.payload === null ? '' : shortValue(ev.payload) }
  }
  const key = rowKey(ev)
  const keyCols = key ? Object.keys(key) : []
  const keyText = key ? Object.values(key).map(idValue).join(' ') : null
  if (!ev.data || ev.truncated) return { key: keyText, rest: '' }
  const changed = changedColumns(ev).filter((c) => !keyCols.includes(c))
  return { key: keyText, rest: pairs(ev.data, keyCols, 3, changed) }
}

function pairs(row: RowData, skip: string[], limit: number, first: string[] = []): string {
  const names = Object.keys(row).filter((k) => !skip.includes(k))
  const readable = names.filter((k) => !FOREIGN_KEY.test(k) && !TIMESTAMP_NAME.test(k) && isScalar(row[k]))
  const pool = readable.length > 0 ? readable : names
  const order = [...first.filter((k) => names.includes(k)), ...pool.filter((k) => !first.includes(k))]
  return order
    .slice(0, limit)
    .map((k) => `${k}=${FOREIGN_KEY.test(k) || UUID.test(String(row[k])) ? idValue(row[k]) : shortValue(row[k])}`)
    .join(' ')
}

const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof v)

// ─── Words ───────────────────────────────────────────────────────────────────

const PRESENCE_VERB: Record<string, string> = { join: 'joined', leave: 'left', update: 'updated' }

/** What a presence event did, in words: joined, left, updated. */
export function presenceVerb(event: string): string {
  return PRESENCE_VERB[event] ?? event
}

/**
 * The event in words, for the drawer's title and screen readers:
 * "insert into reviews", "update of reviews", "delete from watchlist_items",
 * "user 506a28c4 joined", "broadcast on lobby".
 */
export function eventTitle(ev: Pick<LiveEvent, 'type' | 'table' | 'channel' | 'presence'>): string {
  const where = ev.table ?? ev.channel ?? ''
  switch (ev.type) {
    case 'insert':
      return where ? `insert into ${where}` : 'insert'
    case 'update':
      return where ? `update of ${where}` : 'update'
    case 'delete':
      return where ? `delete from ${where}` : 'delete'
    case 'presence': {
      const who = ev.presence?.userId ? `user ${idValue(ev.presence.userId)}` : 'a user'
      return `${who} ${presenceVerb(ev.presence?.event ?? 'update')}`
    }
    case 'broadcast':
      return where ? `broadcast on ${where}` : 'broadcast'
    default:
      return where ? `${ev.type} on ${where}` : ev.type
  }
}

/** "insert 10, update 3, delete 1, presence 2": the session's counts, in the feed's order. */
export function countsLine(counts: Readonly<Record<string, number>>): string {
  return ['insert', 'update', 'delete', 'presence', 'broadcast']
    .filter((t) => (counts[t] ?? 0) > 0)
    .map((t) => `${t} ${(counts[t] ?? 0).toLocaleString('en-US')}`)
    .join(', ')
}

/** "Listening on reviews and watchlist_items." for one, two or more tables. */
export function listingOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The JSON a drawer section shows. */
export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
