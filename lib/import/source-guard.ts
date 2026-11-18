/**
 * What a source database may send this process, checked before pg reads it.
 *
 * The importer runs inside the web server (lib/import/pressure.ts says why
 * memory is scarce there), and a source is whatever answers at the address a
 * person typed: PostgreSQL, a pooler, or a program that speaks just enough of
 * the protocol to be connected to. pg trusts what it is sent:
 *
 *   - it buffers each message whole at whatever length the message declares
 *     (pg-protocol's Parser grows its buffer, doubling, while the bytes
 *     arrive), and keeps a statement's rows until the server says the
 *     statement is done; a FETCH bounds rows, not bytes;
 *   - it reads a message's parts where the message says they are: a text
 *     field runs to the next zero byte wherever that is, so a field without
 *     one is read for ever, and a length that runs past the message reads
 *     into the next one, or past the buffer, where it throws;
 *   - it hands parts of an answer to the statement in progress without
 *     asking whether there is one, and throws when there is not.
 *
 * A throw there happens inside the socket's handler, where nothing catches
 * it, and a loop there never returns: either would take the website down.
 *
 * SourceWireGuard sits where pg reads the connection, after TLS
 * (guardSourceClient), and hands pg only whole messages it has checked, one
 * at a time. It ends the connection with a SourceWireError as soon as
 *
 *   - one message declares more than MAX_SOURCE_MESSAGE_BYTES (a row that
 *     large is refused, never read);
 *   - one statement's answer, from the statement to the server's
 *     ReadyForQuery, comes to more than MAX_SOURCE_RESPONSE_BYTES, each row
 *     counted at what holding it costs here, not only its bytes on the wire;
 *   - a message is not one PostgreSQL sends a client like this one, or its
 *     parts do not add up exactly to its length, read the way pg reads them;
 *   - a sign-in message arrives after signing in, an answer before it, or
 *     part of an answer when no statement is waiting for one.
 *
 * Should pg still throw on a message it was handed, the guard catches it and
 * ends the connection rather than the process.
 */

import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import type { Client as PgClient } from 'pg'
import { ImportInputError } from './driver'
import { formatBytes } from './limits'

const MB = 1024 * 1024

/** One message from the source: one row, at most. */
export const MAX_SOURCE_MESSAGE_BYTES = 64 * MB
/**
 * Everything one statement is answered with, counted as held. A batch of rows
 * aims at 8 MB (lib/import/pg-engine.ts BATCH_TARGET_BYTES), so this is room
 * for rows that grow sixteenfold between one batch and the next.
 */
export const MAX_SOURCE_RESPONSE_BYTES = 128 * MB

/** What holding a row costs beyond its bytes: pg's arrays for it. */
const ROW_COST = 64
/** And each of its values: a string's header and its slot in the row. */
const VALUE_COST = 32

const HEADER = 5 // type byte + length
const code = (c: string) => c.charCodeAt(0)

const AUTHENTICATION = code('R')
const BACKEND_KEY_DATA = code('K')
const PARAMETER_STATUS = code('S')
const NOTICE = code('N')
const ERROR = code('E')
const READY_FOR_QUERY = code('Z')
const ROW_DESCRIPTION = code('T')
const DATA_ROW = code('D')
const COMMAND_COMPLETE = code('C')
const EMPTY_QUERY = code('I')
const PORTAL_SUSPENDED = code('s')
const PARSE_COMPLETE = code('1')
const BIND_COMPLETE = code('2')
const CLOSE_COMPLETE = code('3')
const NO_DATA = code('n')
const PARAMETER_DESCRIPTION = code('t')

/** Sent while signing in, and only then. */
const SIGN_IN = new Set([AUTHENTICATION, BACKEND_KEY_DATA])
/** Sent at any time. */
const ANY_TIME = new Set([PARAMETER_STATUS, NOTICE, ERROR, READY_FOR_QUERY])
/** Parts of an answer: sent only while a statement waits for one. */
const ANSWER = new Set([
  ROW_DESCRIPTION,
  DATA_ROW,
  COMMAND_COMPLETE,
  EMPTY_QUERY,
  PORTAL_SUSPENDED,
  PARSE_COMPLETE,
  BIND_COMPLETE,
  CLOSE_COMPLETE,
  NO_DATA,
  PARAMETER_DESCRIPTION,
])

export interface WireLimits {
  maxMessageBytes: number
  maxResponseBytes: number
}

export const SOURCE_WIRE_LIMITS: Readonly<WireLimits> = {
  maxMessageBytes: MAX_SOURCE_MESSAGE_BYTES,
  maxResponseBytes: MAX_SOURCE_RESPONSE_BYTES,
}

/** The source sent more than the importer holds, or something that is not PostgreSQL's protocol. */
export class SourceWireError extends ImportInputError {
  constructor(message: string) {
    super(message, 'connectionString')
    this.name = 'SourceWireError'
  }
}

const BROKEN = 'a message whose parts do not add up to its length'
const UNKNOWN = 'a kind of message PostgreSQL does not send a client like this one'
const UNSUPPORTED_SIGN_IN = 'unsupported sign-in'

function notProtocol(why: string): SourceWireError {
  return new SourceWireError(`The source does not answer in PostgreSQL's protocol (${why}), so Backenly stopped reading it.`)
}

/** Where the text field starting at `at` ends (just past its zero byte), or -1 when the body holds no end for it. */
function fieldEnd(body: Buffer, at: number): number {
  if (at > body.length) return -1
  const zero = body.indexOf(0, at)
  return zero === -1 ? -1 : zero + 1
}

/**
 * Why a message's parts do not add up the way pg-protocol reads them, or null
 * when they do: every text field ends inside the body, every count and length
 * is one the body holds exactly. Pure, for the tests.
 */
export function messageProblem(type: number, body: Buffer): string | null {
  const n = body.length
  switch (type) {
    case AUTHENTICATION: {
      if (n < 4) return BROKEN
      const method = body.readInt32BE(0)
      if (method === 0 || method === 3) return n === 4 ? null : BROKEN // ok, cleartext password
      if (method === 5) return n === 8 ? null : BROKEN // MD5, with its salt
      if (method === 11 || method === 12) return null // SASL continue and final: the rest is data
      if (method === 10) {
        // SASL: the mechanisms' names, then an empty one.
        for (let at = 4; ; ) {
          const end = fieldEnd(body, at)
          if (end === -1) return BROKEN
          if (end === at + 1) return end === n ? null : BROKEN
          at = end
        }
      }
      return UNSUPPORTED_SIGN_IN
    }
    case BACKEND_KEY_DATA:
      return n === 8 ? null : BROKEN
    case PARAMETER_STATUS: {
      const name = fieldEnd(body, 0)
      return name !== -1 && fieldEnd(body, name) === n ? null : BROKEN
    }
    case COMMAND_COMPLETE:
      return fieldEnd(body, 0) === n ? null : BROKEN
    case NOTICE:
    case ERROR: {
      // Fields, each a code byte and a text, then a zero byte.
      for (let at = 0; ; ) {
        if (at >= n) return BROKEN
        if (body[at] === 0) return at + 1 === n ? null : BROKEN
        at = fieldEnd(body, at + 1)
        if (at === -1) return BROKEN
      }
    }
    case READY_FOR_QUERY:
      return n === 1 && (body[0] === code('I') || body[0] === code('T') || body[0] === code('E')) ? null : BROKEN
    case ROW_DESCRIPTION: {
      if (n < 2) return BROKEN
      const fields = body.readInt16BE(0)
      if (fields < 0) return BROKEN
      let at = 2
      for (let i = 0; i < fields; i++) {
        const end = fieldEnd(body, at)
        if (end === -1) return BROKEN
        at = end + 18 // table, column, type, size, modifier, format
        if (at > n) return BROKEN
      }
      return at === n ? null : BROKEN
    }
    case DATA_ROW: {
      if (n < 2) return BROKEN
      const values = body.readInt16BE(0)
      if (values < 0) return BROKEN
      let at = 2
      for (let i = 0; i < values; i++) {
        if (at + 4 > n) return BROKEN
        const length = body.readInt32BE(at)
        at += 4
        if (length < -1) return BROKEN
        if (length > 0) at += length
        if (at > n) return BROKEN
      }
      return at === n ? null : BROKEN
    }
    case PARAMETER_DESCRIPTION: {
      if (n < 2) return BROKEN
      const count = body.readInt16BE(0)
      return count >= 0 && n === 2 + 4 * count ? null : BROKEN
    }
    case EMPTY_QUERY:
    case PORTAL_SUSPENDED:
    case PARSE_COMPLETE:
    case BIND_COMPLETE:
    case CLOSE_COMPLETE:
    case NO_DATA:
      return n === 0 ? null : BROKEN
    default:
      return UNKNOWN
  }
}

/**
 * Follows what a source sends, chunk by chunk: `take` gathers whole messages
 * and checks each, `admit` says whether pg may have the next one now. Pure: no
 * socket, so the tests feed it bytes split anywhere.
 */
export class SourceWireGuard {
  private readonly head = Buffer.alloc(HEADER)
  private headHave = 0
  /** A message begun in an earlier chunk. */
  private pending: { parts: Buffer[]; need: number; total: number } | null = null
  /** What the current statement's answer has cost so far. */
  private held = 0
  private signedIn = false
  private refused: SourceWireError | null = null

  constructor(private readonly limits: WireLimits = SOURCE_WIRE_LIMITS) {}

  /** The refusal that ended the connection, once there is one. */
  get refusal(): SourceWireError | null {
    return this.refused
  }

  /**
   * Take the next chunk. Returns the whole messages it completes, each checked,
   * in order; or the refusal that ends the connection, which every later call
   * returns too.
   */
  take(chunk: Buffer): Buffer[] | SourceWireError {
    if (this.refused) return this.refused
    const done: Buffer[] = []
    let i = 0
    while (i < chunk.length) {
      if (this.pending) {
        const p = this.pending
        const step = Math.min(p.need, chunk.length - i)
        p.parts.push(chunk.subarray(i, i + step))
        p.need -= step
        i += step
        if (p.need > 0) break
        this.pending = null
        const refused = this.finish(Buffer.concat(p.parts, p.total), done)
        if (refused) return this.refuse(refused)
        continue
      }

      let type: number
      let length: number
      let start = -1
      if (this.headHave === 0 && chunk.length - i >= HEADER) {
        type = chunk[i]
        length = chunk.readUInt32BE(i + 1)
        start = i
        i += HEADER
      } else {
        const step = Math.min(HEADER - this.headHave, chunk.length - i)
        chunk.copy(this.head, this.headHave, i, i + step)
        this.headHave += step
        i += step
        if (this.headHave < HEADER) break
        this.headHave = 0
        type = this.head[0]
        length = this.head.readUInt32BE(1)
      }

      if (length < 4) return this.refuse(notProtocol('a message shorter than its own header'))
      const body = length - 4
      if (body > this.limits.maxMessageBytes) {
        const what = type === DATA_ROW ? `one row of ${formatBytes(body)}` : `${formatBytes(body)} in one message`
        return this.refuse(
          new SourceWireError(
            `The source sent ${what}; Backenly reads at most ${formatBytes(this.limits.maxMessageBytes)} at once, so it stopped reading the source.`,
          ),
        )
      }

      if (start >= 0 && chunk.length - i >= body) {
        // The whole message is in this chunk: handed on as it is, uncopied.
        const refused = this.finish(chunk.subarray(start, i + body), done)
        if (refused) return this.refuse(refused)
        i += body
        continue
      }
      const head = start >= 0 ? chunk.subarray(start, start + HEADER) : Buffer.from(this.head)
      const step = Math.min(body, chunk.length - i)
      this.pending = { parts: [head, chunk.subarray(i, i + step)], need: body - step, total: HEADER + body }
      i += step
      if (this.pending.need === 0) {
        const p = this.pending
        this.pending = null
        const refused = this.finish(Buffer.concat(p.parts, p.total), done)
        if (refused) return this.refuse(refused)
      }
    }
    return done
  }

  /**
   * Whether pg may have this message now: call it just before handing the
   * message over, with whether a statement is waiting for an answer.
   */
  admit(message: Buffer, inQuery: boolean): SourceWireError | null {
    if (this.refused) return this.refused
    const type = message[0]
    if (!this.signedIn) {
      if (!SIGN_IN.has(type) && !ANY_TIME.has(type)) return this.refuse(notProtocol('an answer before signing in finished'))
      if (type === READY_FOR_QUERY) this.signedIn = true
      return null
    }
    if (SIGN_IN.has(type)) return this.refuse(notProtocol('a sign-in message after signing in'))
    if (ANSWER.has(type) && !inQuery) return this.refuse(notProtocol('part of an answer when no statement was waiting for one'))
    return null
  }

  /** pg could not read a message it was handed: refuse the rest. */
  fail(): SourceWireError {
    return this.refuse(notProtocol('a message pg could not read'))
  }

  private finish(message: Buffer, done: Buffer[]): SourceWireError | null {
    const type = message[0]
    const body = message.subarray(HEADER)
    const problem = messageProblem(type, body)
    if (problem === UNSUPPORTED_SIGN_IN) {
      return new SourceWireError('The source asks for a way of signing in that Backenly does not support: it signs in with a password.')
    }
    if (problem) return notProtocol(problem)
    if (type === READY_FOR_QUERY) {
      this.held = 0
    } else {
      this.held += message.length + (type === DATA_ROW ? ROW_COST + VALUE_COST * body.readInt16BE(0) : 0)
      if (this.held > this.limits.maxResponseBytes) {
        return new SourceWireError(
          `One answer from the source came to more than ${formatBytes(this.limits.maxResponseBytes)}, the most Backenly holds at once, so it stopped reading the source.`,
        )
      }
    }
    done.push(message)
    return null
  }

  private refuse(err: SourceWireError): SourceWireError {
    this.refused = err
    return err
  }
}

interface ReadsItsConnection {
  attachListeners?: (stream: Duplex) => unknown
}

/**
 * Put a SourceWireGuard between `client`'s connection and pg's parser. Call it
 * before connect(), so the startup exchange is guarded too.
 *
 * pg reads a connection in Connection#attachListeners, once per connection,
 * with the socket or with the TLS socket over it; the guard takes that place
 * and hands pg only what it lets through. When a version of pg reads its
 * connection some other way this throws, so no source is ever read unguarded
 * (and the tests that drive a real pg client against a stand-in server fail).
 */
export function guardSourceClient(client: PgClient, limits: WireLimits = SOURCE_WIRE_LIMITS): SourceWireGuard {
  const connection = (client as unknown as { connection?: ReadsItsConnection }).connection
  const attach = connection?.attachListeners
  if (!connection || typeof attach !== 'function') {
    throw new Error('Backenly could not put its limits on the connection to the source, so it did not connect.')
  }
  const guard = new SourceWireGuard(limits)
  // pg's client has a statement in progress from when it sends one until its ReadyForQuery.
  const inQuery = () => (client as unknown as { activeQuery?: unknown }).activeQuery != null
  connection.attachListeners = (stream: Duplex) => relayChecked(stream, guard, inQuery, (relay) => attach.call(connection, relay))
  return guard
}

/**
 * Hand `attach`'s reader (pg's parser) what `stream` brings, one checked
 * message at a time. A refusal, or anything the reader throws, ends `stream`
 * with a SourceWireError, which pg hears as it hears any connection failing,
 * and fails the statement waiting on it with.
 */
export function relayChecked(stream: Duplex, guard: SourceWireGuard, inQuery: () => boolean, attach: (relay: Duplex) => unknown): unknown {
  // pg-protocol's parse() listens for 'data' and 'end' only.
  const relay = new EventEmitter()
  stream.on('data', (chunk: Buffer) => {
    const taken = guard.take(chunk)
    if (taken instanceof SourceWireError) {
      stream.destroy(taken)
      return
    }
    for (const message of taken) {
      const refused = guard.admit(message, inQuery())
      if (refused) {
        stream.destroy(refused)
        return
      }
      try {
        relay.emit('data', message)
      } catch {
        stream.destroy(guard.fail())
        return
      }
    }
  })
  stream.on('end', () => relay.emit('end'))
  return attach(relay as unknown as Duplex)
}
