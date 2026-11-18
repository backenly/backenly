/**
 * A stand-in for a source database, for what a real pg client does when the
 * server on the other end answers in ways PostgreSQL never would: a row
 * declared at gigabytes, an answer that never ends. No Postgres is involved.
 *
 * It speaks enough of protocol 3 for pg to connect: the startup message (and,
 * when given a certificate, the SSLRequest and TLS before it), then
 * AuthenticationOk and ReadyForQuery. Each simple query ('Q') goes to
 * `onQuery`, which answers on the socket with the builders below.
 */

import net from 'net'
import type { Duplex } from 'stream'
import tls from 'tls'

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.write(type, 0, 'latin1')
  head.writeUInt32BE(body.length + 4, 1)
  return Buffer.concat([head, body])
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n, 0)
  return b
}

export const wire = {
  message,
  authenticationOk: () => message('R', int32(0)),
  readyForQuery: () => message('Z', Buffer.from('I')),
  commandComplete: (tag: string) => message('C', Buffer.from(`${tag}\0`)),
  /** Text columns, in order. */
  rowDescription(names: string[]): Buffer {
    const parts: Buffer[] = [Buffer.alloc(2)]
    parts[0].writeInt16BE(names.length, 0)
    for (const name of names) {
      const field = Buffer.alloc(18)
      field.writeInt32BE(0, 0) // table oid
      field.writeInt16BE(0, 4) // column number
      field.writeInt32BE(25, 6) // text
      field.writeInt16BE(-1, 10) // variable length
      field.writeInt32BE(-1, 12) // no modifier
      field.writeInt16BE(0, 16) // text format
      parts.push(Buffer.from(`${name}\0`), field)
    }
    return message('T', Buffer.concat(parts))
  },
  dataRow(values: Array<string | null>): Buffer {
    const parts: Buffer[] = [Buffer.alloc(2)]
    parts[0].writeInt16BE(values.length, 0)
    for (const v of values) {
      if (v === null) {
        parts.push(int32(-1))
        continue
      }
      const bytes = Buffer.from(v)
      parts.push(int32(bytes.length), bytes)
    }
    return message('D', Buffer.concat(parts))
  },
  /** The first five bytes of a message that says it is `bodyBytes` long, and nothing of the body. */
  header(type: string, bodyBytes: number): Buffer {
    const head = Buffer.alloc(5)
    head.write(type, 0, 'latin1')
    head.writeUInt32BE(bodyBytes + 4, 1)
    return head
  },
}

/**
 * Write `chunk` again and again, as fast as the client takes it, until the
 * client goes away or `limit` bytes are sent. Resolves with the bytes sent.
 */
export function pour(socket: Duplex, chunk: Buffer, limit: number): Promise<number> {
  return new Promise((resolve) => {
    let sent = 0
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(sent)
    }
    socket.once('close', finish)
    socket.once('error', finish)
    const more = () => {
      while (!done && sent < limit) {
        sent += chunk.length
        if (!socket.write(chunk)) {
          socket.once('drain', more)
          return
        }
      }
      if (sent >= limit) finish()
    }
    more()
  })
}

export interface FakeSourceOptions {
  /** A certificate: answer the SSLRequest with 'S' and speak TLS from there. */
  tls?: { key: string; cert: string }
  /** Answer the startup message yourself; return true when you did. */
  onStartup?: (socket: Duplex) => boolean
  onQuery: (sql: string, socket: Duplex) => void
}

export interface FakeSource {
  port: number
  close(): Promise<void>
}

export async function startFakeSource(opts: FakeSourceOptions): Promise<FakeSource> {
  const sockets = new Set<net.Socket>()
  const serve = (socket: Duplex) => {
    let pending = Buffer.alloc(0)
    let started = false
    socket.on('error', () => {})
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        if (!started) {
          if (pending.length < 4 || pending.length < pending.readUInt32BE(0)) return
          pending = pending.subarray(pending.readUInt32BE(0))
          started = true
          if (!opts.onStartup?.(socket)) socket.write(Buffer.concat([wire.authenticationOk(), wire.readyForQuery()]))
          continue
        }
        if (pending.length < 5 || pending.length < 1 + pending.readUInt32BE(1)) return
        const type = String.fromCharCode(pending[0])
        const body = pending.subarray(5, 1 + pending.readUInt32BE(1))
        pending = pending.subarray(1 + pending.readUInt32BE(1))
        if (type === 'Q') opts.onQuery(body.toString('utf8', 0, body.length - 1), socket)
        else if (type === 'X') socket.end()
      }
    })
  }
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    if (!opts.tls) return serve(socket)
    const { key, cert } = opts.tls
    socket.once('data', () => {
      // The SSLRequest (length 8, code 80877103): yes, TLS.
      socket.write('S')
      serve(new tls.TLSSocket(socket, { isServer: true, key, cert }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
