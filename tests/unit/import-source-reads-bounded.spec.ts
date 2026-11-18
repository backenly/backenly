/**
 * What a source database can make the web process hold is bounded
 * (lib/import/source-guard.ts), whatever the server on the other end says.
 *
 * pg buffers a message whole, at whatever length it declares, and keeps a
 * statement's rows until the server says it is done; a FETCH bounds rows,
 * not bytes. So the guard follows message boundaries before pg sees a byte
 * and ends the connection when one message declares more than 64 MB, or one
 * answer comes to more than 128 MB as held.
 *
 * The guard is driven here with bytes split anywhere, then through a real pg
 * client (connectSource) against a stand-in server that answers as no
 * PostgreSQL would: a 1.9 GB row, an answer that never ends, a huge message
 * before sign-in, and the same over TLS, where the guard must count what the
 * server said and not the ciphertext. No database.
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { connectSource, type ParsedPgUrl, type SourceConnection } from '@/lib/import/net'
import { ImportInputError } from '@/lib/import/driver'
import { MAX_SOURCE_MESSAGE_BYTES, MAX_SOURCE_RESPONSE_BYTES, SourceWireError, SourceWireGuard } from '@/lib/import/source-guard'
import { pour, startFakeSource, wire, type FakeSource } from '../helpers/fake-postgres-source'
import { makeCertificates } from '../helpers/tls-postgres-stand-in'

const MB = 1024 * 1024
const ENV = 'BACKENLY_IMPORT_EGRESS_ALLOW_PRIVATE'
const ROW_1_9_GB = Math.round(1.9 * 1024 * MB)

/** Feed `bytes` to a guard in pieces of `size`, returning the first refusal. */
function feed(guard: SourceWireGuard, bytes: Buffer, size: number): SourceWireError | null {
  for (let i = 0; i < bytes.length; i += size) {
    const refused = guard.inspect(bytes.subarray(i, i + size))
    if (refused) return refused
  }
  return null
}

describe('the guard follows message boundaries', () => {
  const answer = Buffer.concat([
    wire.rowDescription(['a', 'b']),
    wire.dataRow(['one', null]),
    wire.dataRow(['two', 'x'.repeat(300)]),
    wire.commandComplete('SELECT 2'),
    wire.readyForQuery(),
  ])

  it('lets an ordinary answer through, however it is split', () => {
    for (const size of [1, 2, 3, 5, 6, 7, 64, answer.length]) {
      const guard = new SourceWireGuard({ maxMessageBytes: 1000, maxResponseBytes: 10_000 })
      expect(feed(guard, Buffer.concat([answer, answer, answer]), size)).toBeNull()
    }
  })

  it('refuses a message declared over the limit from its header alone, however the header is split', () => {
    const header = wire.header('D', 1001)
    for (const size of [1, 2, 4, 5]) {
      const guard = new SourceWireGuard({ maxMessageBytes: 1000, maxResponseBytes: 10_000 })
      const refused = feed(guard, header, size)
      expect(refused).toBeInstanceOf(SourceWireError)
      expect(refused!.message).toMatch(/one row of 1001 bytes; Backenly reads at most 1000 bytes at once/)
      // Once refused, it stays refused.
      expect(guard.inspect(wire.readyForQuery())).toBe(refused)
    }
  })

  it('counts one answer up to ReadyForQuery, then starts again', () => {
    const row = wire.dataRow(['x'.repeat(100)])
    const limits = { maxMessageBytes: 1000, maxResponseBytes: 2000 }
    const ok = new SourceWireGuard(limits)
    // Ten rows, each answer its own: never near the limit.
    for (let i = 0; i < 10; i++) expect(ok.inspect(Buffer.concat([row, wire.readyForQuery()]))).toBeNull()
    // The same ten rows in one answer: over it.
    const over = new SourceWireGuard(limits)
    const refused = feed(over, Buffer.concat(Array.from({ length: 10 }, () => row)), 7)
    expect(refused?.message).toMatch(/^One answer from the source came to more than 2 KB, the most Backenly holds at once/)
  })

  it('counts a row of many tiny values at what holding them costs, not at its bytes', () => {
    const tiny = wire.dataRow(Array.from({ length: 50 }, () => 'ab'))
    expect(tiny.length).toBeLessThan(400)
    const guard = new SourceWireGuard({ maxMessageBytes: 1000, maxResponseBytes: 10 * tiny.length })
    // Ten rows of 50 values are 3 KB on the wire, but 50 strings each to hold.
    expect(feed(guard, Buffer.concat(Array.from({ length: 10 }, () => tiny)), 64)).toBeInstanceOf(SourceWireError)
  })

  it("refuses a length no PostgreSQL message can have", () => {
    const bad = Buffer.from([0x44, 0, 0, 0, 2])
    expect(new SourceWireGuard().inspect(bad)?.message).toMatch(/does not answer in PostgreSQL's protocol/)
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
