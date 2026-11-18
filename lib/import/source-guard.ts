/**
 * A ceiling on what a source database can make this process hold.
 *
 * The importer runs inside the web server (lib/import/pressure.ts says why
 * memory is scarce there), and a source is whatever answers at the address a
 * person typed: PostgreSQL, a pooler, or a program that speaks just enough of
 * the protocol to be connected to. pg buffers each message from the server
 * whole before handing it on (pg-protocol's Parser grows its buffer, doubling,
 * for as long as the message's declared length says more is coming), and keeps
 * a statement's rows until the server says the statement is done. Neither has
 * a limit of its own, and the source decides both: a FETCH bounds rows, not
 * bytes, and nothing makes a server stop at the rows it was asked for.
 *
 * SourceWireGuard reads the boundaries of what the source sends (each message
 * is a type byte and a 4-byte length) before pg sees a byte of it, and ends the
 * connection with a SourceWireError as soon as
 *
 *   - one message declares more than MAX_SOURCE_MESSAGE_BYTES (a row that
 *     large is refused, never read), or
 *   - one statement's answer, from the statement to the server's
 *     ReadyForQuery, comes to more than MAX_SOURCE_RESPONSE_BYTES, each row
 *     counted at what holding it costs here, not only its bytes on the wire
 *     (a row of many tiny values costs more to hold than it took to send).
 *
 * A refused message never reaches pg's parser, so its declared size is never
 * allocated. The guard sits where pg reads the connection, after TLS
 * (guardSourceClient), so it counts what the server said, not ciphertext.
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

const DATA_ROW = 0x44 // 'D'
const READY_FOR_QUERY = 0x5a // 'Z'
const HEADER = 5 // type byte + length

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

/**
 * Follows the messages a source sends, chunk by chunk, and says when to stop.
 * Pure: no socket, so the tests feed it bytes split anywhere.
 */
export class SourceWireGuard {
  /** A message's type, length and, for a row, its value count. */
  private readonly head = Buffer.alloc(7)
  private have = 0
  private need = HEADER
  /** Bytes of the current message still to pass. */
  private skip = 0
  /** What the current statement's answer has cost so far. */
  private held = 0
  private refused: SourceWireError | null = null

  constructor(private readonly limits: WireLimits = SOURCE_WIRE_LIMITS) {}

  /** The refusal that ended the connection, once there is one. */
  get refusal(): SourceWireError | null {
    return this.refused
  }

  /** Account for the next chunk. Null while reading may go on; once refused, always the refusal. */
  inspect(chunk: Uint8Array): SourceWireError | null {
    if (this.refused) return this.refused
    let i = 0
    while (i < chunk.length) {
      if (this.skip > 0) {
        const step = Math.min(this.skip, chunk.length - i)
        this.skip -= step
        i += step
        continue
      }
      const step = Math.min(this.need - this.have, chunk.length - i)
      this.head.set(chunk.subarray(i, i + step), this.have)
      this.have += step
      i += step
      if (this.have < this.need) break
      const refused = this.onHead()
      if (refused) {
        this.refused = refused
        return refused
      }
    }
    return null
  }

  private onHead(): SourceWireError | null {
    const type = this.head[0]
    const length = this.head.readUInt32BE(1)
    if (this.need === HEADER) {
      if (length < 4) return new SourceWireError("The source does not answer in PostgreSQL's protocol, so Backenly stopped reading it.")
      const body = length - 4
      if (body > this.limits.maxMessageBytes) {
        const what = type === DATA_ROW ? `one row of ${formatBytes(body)}` : `${formatBytes(body)} in one message`
        return new SourceWireError(
          `The source sent ${what}; Backenly reads at most ${formatBytes(this.limits.maxMessageBytes)} at once, so it stopped reading the source.`,
        )
      }
      // A row says how many values it has next: read that too, then count the row.
      if (type === DATA_ROW && body >= 2) {
        this.need = HEADER + 2
        return null
      }
      return this.count(type, length, 0)
    }
    return this.count(type, length, this.head.readUInt16BE(HEADER))
  }

  private count(type: number, length: number, values: number): SourceWireError | null {
    this.skip = length - 4 - (this.need - HEADER)
    this.have = 0
    this.need = HEADER
    if (type === READY_FOR_QUERY) {
      this.held = 0
      return null
    }
    this.held += 1 + length + (type === DATA_ROW ? ROW_COST + VALUE_COST * values : 0)
    if (this.held > this.limits.maxResponseBytes) {
      return new SourceWireError(
        `One answer from the source came to more than ${formatBytes(this.limits.maxResponseBytes)}, the most Backenly holds at once, so it stopped reading the source.`,
      )
    }
    return null
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
  connection.attachListeners = (stream: Duplex) => {
    // pg-protocol's parse() listens for 'data' and 'end' only.
    const relay = new EventEmitter()
    stream.on('data', (chunk: Buffer) => {
      const refused = guard.inspect(chunk)
      if (refused) {
        // pg hears the error from the socket, as for any connection that fails,
        // and fails the statement waiting on it with this refusal.
        stream.destroy(refused)
        return
      }
      relay.emit('data', chunk)
    })
    stream.on('end', () => relay.emit('end'))
    return attach.call(connection, relay as unknown as Duplex)
  }
  return guard
}
