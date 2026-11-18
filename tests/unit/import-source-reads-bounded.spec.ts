/**
 * What a source database can do to the web process is bounded
 * (lib/import/source-guard.ts), whatever the server on the other end sends.
 *
 * pg buffers a message whole, at whatever length it declares, and keeps a
 * statement's rows until the server says it is done; it reads a text field to
 * the next zero byte wherever that is, and hands parts of an answer to the
 * statement in progress without asking whether there is one. So the guard
 * hands pg only whole messages it has checked, one at a time, and ends the
 * connection when one message declares more than 64 MB, one answer comes to
 * more than 128 MB as held, a message's parts do not add up, or part of an
 * answer arrives with no statement waiting for it.
 *
 * The guard is driven here with bytes split anywhere, then through a real pg
 * client (connectSource) against a stand-in server that answers as no
 * PostgreSQL would: a 1.9 GB row, an answer that never ends, a huge message,
 * a text field with no end and a row before any statement at sign-in, rows
 * whose lengths do not add up, and the 1.9 GB row over TLS (the guard counts
 * what the server said, not the ciphertext).
 * No database.
 */

import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Duplex } from 'stream'
import { connectSource, type ParsedPgUrl, type SourceConnection } from '@/lib/import/net'
import { ImportInputError } from '@/lib/import/driver'
import {
  MAX_SOURCE_MESSAGE_BYTES,
  MAX_SOURCE_RESPONSE_BYTES,
  SourceWireError,
  SourceWireGuard,
  relayChecked,
} from '@/lib/import/source-guard'
import { pour, startFakeSource, wire, type FakeSource } from '../helpers/fake-postgres-source'
import { makeCertificates } from '../helpers/tls-postgres-stand-in'

const MB = 1024 * 1024
const ENV = 'BACKENLY_IMPORT_EGRESS_ALLOW_PRIVATE'
const ROW_1_9_GB = Math.round(1.9 * 1024 * MB)
const NOT_PROTOCOL = /^The source does not answer in PostgreSQL's protocol \(/

const signIn = () => Buffer.concat([wire.authenticationOk(), wire.readyForQuery()])
const int16 = (n: number) => {
  const b = Buffer.alloc(2)
  b.writeInt16BE(n, 0)
  return b
}
const int32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n, 0)
  return b
}

/** Give the guard `bytes` in pieces of `size`, admitting each message as if a statement waits (or not); what it let through, or its refusal. */
function feed(guard: SourceWireGuard, bytes: Buffer, size: number, inQuery = true): Buffer[] | SourceWireError {
  const passed: Buffer[] = []
  for (let i = 0; i < bytes.length; i += size) {
    const taken = guard.take(bytes.subarray(i, i + size))
    if (taken instanceof SourceWireError) return taken
    for (const message of taken) {
      const refused = guard.admit(message, inQuery)
      if (refused) return refused
      passed.push(message)
    }
  }
  return passed
}

function refused(result: Buffer[] | SourceWireError): SourceWireError {
  expect(result).toBeInstanceOf(SourceWireError)
  return result as SourceWireError
}

describe('the guard hands pg whole messages it has checked', () => {
  const answer = Buffer.concat([
    wire.rowDescription(['a', 'b']),
    wire.dataRow(['one', null]),
    wire.dataRow(['two', 'x'.repeat(300)]),
    wire.commandComplete('SELECT 2'),
    wire.readyForQuery(),
  ])

  it('passes an ordinary sign-in and answer, a whole message at a time, however the bytes are split', () => {
    const all = Buffer.concat([signIn(), answer, answer, answer])
    for (const size of [1, 2, 3, 5, 6, 7, 64, all.length]) {
      const passed = feed(new SourceWireGuard({ maxMessageBytes: 1000, maxResponseBytes: 10_000 }), all, size)
      expect(passed).not.toBeInstanceOf(SourceWireError)
      expect((passed as Buffer[]).length).toBe(2 + 3 * 5)
      expect(Buffer.concat(passed as Buffer[]).equals(all)).toBe(true)
    }
  })

  it('refuses a message declared over the limit from its header alone, however the header is split', () => {
    for (const size of [1, 2, 4, 5]) {
      const guard = new SourceWireGuard({ maxMessageBytes: 1000, maxResponseBytes: 10_000 })
      const err = refused(feed(guard, Buffer.concat([signIn(), wire.header('D', 1001)]), size))
      expect(err.message).toMatch(/one row of 1001 bytes; Backenly reads at most 1000 bytes at once/)
      // Once refused, it stays refused.
      expect(guard.take(wire.readyForQuery())).toBe(err)
    }
  })

  it('counts one answer up to ReadyForQuery, then starts again', () => {
    const row = wire.dataRow(['x'.repeat(100)])
    const limits = { maxMessageBytes: 1000, maxResponseBytes: 2000 }
    // Ten rows, each answer its own: never near the limit.
    const each = Buffer.concat([signIn(), ...Array.from({ length: 10 }, () => Buffer.concat([row, wire.readyForQuery()]))])
    expect(feed(new SourceWireGuard(limits), each, 7)).not.toBeInstanceOf(SourceWireError)
    // The same ten rows in one answer: over it.
    const one = Buffer.concat([signIn(), ...Array.from({ length: 10 }, () => row)])
    expect(refused(feed(new SourceWireGuard(limits), one, 7)).message).toMatch(/^One answer from the source came to more than 2 KB, the most Backenly holds at once/)
  })

  it('counts a row of many tiny values at what holding them costs, not at its bytes', () => {
    const tiny = wire.dataRow(Array.from({ length: 50 }, () => 'ab'))
    expect(tiny.length).toBeLessThan(400)
    const guard = new SourceWireGuard({ maxMessageBytes: 1000, maxResponseBytes: 10 * tiny.length })
    // Ten rows of 50 values are 3 KB on the wire, but 50 strings each to hold.
    expect(feed(guard, Buffer.concat([signIn(), ...Array.from({ length: 10 }, () => tiny)]), 64)).toBeInstanceOf(SourceWireError)
  })

  it('refuses a message whose parts do not add up the way pg reads them', () => {
    const cases: Array<[string, Buffer]> = [
      ['a length shorter than the header', Buffer.from([0x44, 0, 0, 0, 2])],
      ['a parameter with no end to its text', wire.message('S', Buffer.from('abc'))],
      ['a parameter with a name and no value', wire.message('S', Buffer.from('name\0'))],
      ['a command tag with no end', wire.message('C', Buffer.from('SELECT 1'))],
      ['an error with no final zero', wire.message('E', Buffer.from('SERROR\0'))],
      ['an error field with no end', wire.message('E', Buffer.from('Mbad'))],
      ['a row whose value runs past it', wire.message('D', Buffer.concat([int16(1), int32(100), Buffer.from('short')]))],
      ['a row with bytes left over', wire.message('D', Buffer.concat([int16(1), int32(2), Buffer.from('ab'), Buffer.from('extra')]))],
      ['a row with a negative count', wire.message('D', int16(-1))],
      ['a row with a length below -1', wire.message('D', Buffer.concat([int16(1), int32(-5)]))],
      ['a column description cut short', wire.message('T', Buffer.concat([int16(1), Buffer.from('a\0'), Buffer.alloc(10)]))],
      ['a column name with no end', wire.message('T', Buffer.concat([int16(1), Buffer.from('abc')]))],
      ['a ready message of the wrong state', wire.message('Z', Buffer.from('X'))],
      ['a key data message cut short', wire.message('K', int32(1))],
      ['an MD5 request with half a salt', wire.message('R', Buffer.concat([int32(5), Buffer.from('ab')]))],
      ['SASL mechanisms with no end', wire.message('R', Buffer.concat([int32(10), Buffer.from('SCRAM-SHA-256')]))],
      ['a notification (no LISTEN is ever sent)', wire.message('A', Buffer.concat([int32(1), Buffer.from('c\0p\0')]))],
      ['a copy (no COPY is ever sent)', wire.message('G', Buffer.concat([Buffer.from([0]), int16(0)]))],
    ]
    for (const [what, message] of cases) {
      // At sign-in for the sign-in messages, after it for the rest.
      const signingIn = message[0] === 0x52 || message[0] === 0x4b
      const bytes = signingIn ? message : Buffer.concat([signIn(), message])
      const err = refused(feed(new SourceWireGuard(), bytes, 3))
      expect({ what, message: err.message }).toEqual({ what, message: expect.stringMatching(NOT_PROTOCOL) })
    }
  })

  it('refuses part of an answer with no statement waiting, a sign-in message after sign-in, and an answer before it', () => {
    const row = wire.dataRow(['1'])
    expect(refused(feed(new SourceWireGuard(), Buffer.concat([signIn(), row]), 64, false)).message).toMatch(
      /part of an answer when no statement was waiting for one/,
    )
    expect(refused(feed(new SourceWireGuard(), Buffer.concat([wire.authenticationOk(), row]), 64)).message).toMatch(/an answer before signing in finished/)
    expect(refused(feed(new SourceWireGuard(), Buffer.concat([signIn(), wire.authenticationOk()]), 64)).message).toMatch(/a sign-in message after signing in/)
  })

  it('says so when the source asks for a way of signing in Backenly does not have', () => {
    // 7: GSSAPI. pg throws on it inside the socket's handler.
    expect(refused(feed(new SourceWireGuard(), wire.message('R', int32(7)), 64)).message).toBe(
      'The source asks for a way of signing in that Backenly does not support: it signs in with a password.',
    )
  })

  it('ends the connection, not the process, when pg throws on what it was handed', () => {
    const stream = Object.assign(new EventEmitter(), { destroy: jest.fn() }) as unknown as Duplex & { destroy: jest.Mock }
    relayChecked(stream, new SourceWireGuard(), () => true, (relay) =>
      (relay as unknown as EventEmitter).on('data', () => {
        throw new TypeError("Cannot read properties of null (reading 'handleDataRow')")
      }),
    )
    expect(() => stream.emit('data', signIn())).not.toThrow()
    expect(stream.destroy).toHaveBeenCalledTimes(1)
    expect(stream.destroy.mock.calls[0][0]).toBeInstanceOf(SourceWireError)
    expect(stream.destroy.mock.calls[0][0].message).toMatch(/a message pg could not read/)
  })
})

describe('a real pg client against a source that answers as no PostgreSQL would', () => {
  let source: FakeSource | null = null
  let conn: SourceConnection | null = null

  beforeEach(() => {
    process.env[ENV] = 'true'
  })
  afterEach(async () => {
    delete process.env[ENV]
    await conn?.end()
    conn = null
    await source?.close()
    source = null
  })

  const at = (port: number, sslmode: ParsedPgUrl['sslmode']): ParsedPgUrl => ({
    host: '127.0.0.1',
    port,
    user: 'reader',
    password: 'pw',
    database: 'app',
    sslmode,
  })

  /** A source that answers the first query with a row header declaring 1.9 GB, then pours bytes until the client goes. */
  async function hugeRowSource(opts: { tls?: { key: string; cert: string } } = {}) {
    let sent: Promise<number> = Promise.resolve(0)
    source = await startFakeSource({
      tls: opts.tls,
      onQuery: (_sql, socket) => {
        socket.write(Buffer.concat([wire.rowDescription(['v']), wire.header('D', ROW_1_9_GB)]))
        sent = pour(socket, Buffer.alloc(64 * 1024, 0x61), 512 * MB)
      },
    })
    return { sent: () => sent }
  }

  it('ends the connection at a row declared at 1.9 GB, before holding it, and says the limit', async () => {
    const { sent } = await hugeRowSource()
    conn = await connectSource(at(source!.port, 'disable'), { requireTls: false, secrets: [] })
    const before = process.memoryUsage().arrayBuffers
    const started = Date.now()
    const err = await conn.client.query('SELECT v FROM wide').catch((e) => e)
    expect(err).toBeInstanceOf(SourceWireError)
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.message).toBe(
      'The source sent one row of 1.9 GB; Backenly reads at most 64 MB at once, so it stopped reading the source.',
    )
    expect(Date.now() - started).toBeLessThan(10_000)
    // The client went at the header: the source got little of what it poured into the socket.
    expect(await sent()).toBeLessThan(32 * MB)
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(MAX_SOURCE_MESSAGE_BYTES)
  })

  it('ends the connection when one answer never ends', async () => {
    source = await startFakeSource({
      onQuery: (_sql, socket) => {
        socket.write(wire.rowDescription(Array.from({ length: 20 }, (_, i) => `c${i}`)))
        const row = wire.dataRow(Array.from({ length: 20 }, () => 'abc'))
        // Rows forever, far more than any FETCH asked for, never a CommandComplete.
        void pour(socket, Buffer.concat(Array.from({ length: 400 }, () => row)), 2048 * MB)
      },
    })
    conn = await connectSource(at(source.port, 'disable'), { requireTls: false, secrets: [] })
    const err = await conn.client.query('FETCH FORWARD 50 FROM bkn_import_0').catch((e) => e)
    expect(err).toBeInstanceOf(SourceWireError)
    expect(err.message).toBe(
      `One answer from the source came to more than ${MAX_SOURCE_RESPONSE_BYTES / MB} MB, the most Backenly holds at once, so it stopped reading the source.`,
    )
  })

  it('refuses a huge message before sign-in, as a connection error under the connection string', async () => {
    source = await startFakeSource({
      onStartup: (socket) => {
        socket.write(wire.header('R', 1024 * MB))
        return true
      },
      onQuery: () => {},
    })
    const err = await connectSource(at(source.port, 'disable'), { requireTls: false, secrets: [] }).catch((e) => e)
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.field).toBe('connectionString')
    expect(err.message).toBe('The source sent 1 GB in one message; Backenly reads at most 64 MB at once, so it stopped reading the source.')
  })

  it('refuses a text field with no end at sign-in, which pg would read for ever', async () => {
    source = await startFakeSource({
      onStartup: (socket) => {
        // A 7-byte ParameterStatus: 'abc' and no zero byte.
        socket.write(Buffer.concat([wire.authenticationOk(), wire.message('S', Buffer.from('abc'))]))
        return true
      },
      onQuery: () => {},
    })
    const started = Date.now()
    const err = await connectSource(at(source.port, 'disable'), { requireTls: false, secrets: [] }).catch((e) => e)
    expect(err).toBeInstanceOf(ImportInputError)
    expect(err.message).toMatch(NOT_PROTOCOL)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('refuses a row whose values run past it, or stop short of it', async () => {
    const rows = [
      wire.message('D', Buffer.concat([int16(1), int32(1000), Buffer.from('ten bytes.')])),
      wire.message('D', Buffer.concat([int16(1), int32(2), Buffer.from('ab'), Buffer.from('left over')])),
    ]
    for (const row of rows) {
      source = await startFakeSource({
        onQuery: (_sql, socket) => {
          socket.write(Buffer.concat([wire.rowDescription(['v']), row, wire.commandComplete('SELECT 1'), wire.readyForQuery()]))
        },
      })
      conn = await connectSource(at(source.port, 'disable'), { requireTls: false, secrets: [] })
      const err = await conn.client.query('SELECT v FROM t').catch((e) => e)
      expect(err).toBeInstanceOf(SourceWireError)
      expect(err.message).toMatch(/parts do not add up to its length/)
      await conn.end()
      conn = null
      await source.close()
      source = null
    }
  })

  it('refuses a row that arrives with no statement waiting, which pg would throw on inside the socket', async () => {
    source = await startFakeSource({
      onStartup: (socket) => {
        socket.write(signIn())
        setTimeout(() => socket.write(wire.dataRow(['unasked'])), 50)
        return true
      },
      onQuery: () => {},
    })
    conn = await connectSource(at(source.port, 'disable'), { requireTls: false, secrets: [] })
    const err = await new Promise<Error>((resolve) => conn!.client.once('error', resolve))
    expect(err).toBeInstanceOf(SourceWireError)
    expect(err.message).toMatch(/part of an answer when no statement was waiting for one/)
    await expect(conn.client.query('SELECT 1')).rejects.toThrow()
  })

  it('still reads an ordinary answer', async () => {
    source = await startFakeSource({
      onQuery: (_sql, socket) => {
        const answer = Buffer.concat([
          wire.rowDescription(['id', 'note']),
          wire.dataRow(['1', 'first']),
          wire.dataRow(['2', null]),
          wire.commandComplete('SELECT 2'),
          wire.readyForQuery(),
        ])
        // Byte by byte, so every boundary falls inside a chunk somewhere.
        for (const byte of answer) socket.write(Buffer.from([byte]))
      },
    })
    conn = await connectSource(at(source.port, 'disable'), { requireTls: false, secrets: [] })
    const r = await conn.client.query('SELECT id, note FROM t')
    expect(r.rows).toEqual([
      { id: '1', note: 'first' },
      { id: '2', note: null },
    ])
  })

  describe('over TLS', () => {
    let dir = ''
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'bkn-source-guard-'))
    })
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('counts what the server said, not the ciphertext', async () => {
      const certs = makeCertificates(dir, 'source.example.test')
      const { sent } = await hugeRowSource({ tls: certs })
      conn = await connectSource(at(source!.port, 'require'), { requireTls: true, secrets: [] })
      expect(conn.tls).toBe(true)
      const err = await conn.client.query('SELECT v FROM wide').catch((e) => e)
      expect(err).toBeInstanceOf(SourceWireError)
      expect(err.message).toMatch(/^The source sent one row of 1\.9 GB; Backenly reads at most 64 MB at once/)
      expect(await sent()).toBeLessThan(32 * MB)
    })
  })
})
