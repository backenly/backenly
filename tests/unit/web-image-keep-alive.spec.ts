/**
 * THE WEB SERVER KEEPS ITS IDLE CONNECTIONS LONGER THAN THE LOAD BALANCER DOES
 * ===========================================================================
 *
 * A load balancer keeps each idle connection to its target open until its own
 * idle timeout (an AWS ALB: 60 s by default) and reuses it, ignoring the
 * "Keep-Alive: timeout=5" Node advertises. Node 20 closes an idle keep-alive
 * connection about one second after its keepAliveTimeout, which is 5000 ms
 * unless set: about 6 s. A request the balancer sends on a connection as Node
 * closes it fails as a 502 with no response from the target, the "rare, random"
 * gateway error that lands mostly on health checks, the steadiest traffic.
 *
 * So docker/web.Dockerfile sets KEEP_ALIVE_TIMEOUT above the balancer's idle
 * timeout, and Next's standalone server applies it. This pins the three links:
 * the image sets a value above 60 s; the installed Next still reads that
 * variable and applies it to its server (an upgrade that dropped it would bring
 * the 502s back without a single failing request in development); and, on a real
 * Node server, that value keeps an idle connection usable past the point where
 * Node's default has already closed it.
 */

import { readFileSync } from 'node:fs'
import { createServer, type Server, type ServerOptions } from 'node:http'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'

const DOCKERFILE = join(__dirname, '..', '..', 'docker', 'web.Dockerfile')
/** An AWS ALB's default idle timeout. */
const LOAD_BALANCER_IDLE_MS = 60_000

/** KEY=VALUE pairs of every ENV instruction in the final stage, continuation lines joined. */
function finalStageEnv(): Record<string, string> {
  const stages = readFileSync(DOCKERFILE, 'utf8').split(/^FROM\s/m)
  const lines = stages[stages.length - 1].split(/\r?\n/)
  const env: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    if (!/^ENV\s/.test(lines[i])) continue
    let statement = lines[i].replace(/^ENV\s+/, '')
    while (statement.trimEnd().endsWith('\\')) statement = statement.trimEnd().slice(0, -1) + ' ' + (lines[++i] ?? '')
    for (const m of statement.matchAll(/([A-Z_][A-Z0-9_]*)=(\S+)/g)) env[m[1]] = m[2]
  }
  return env
}

/** The image's value, parsed the way Next's standalone server parses it. */
function imageKeepAliveMs(): number {
  const raw = finalStageEnv().KEEP_ALIVE_TIMEOUT
  if (raw === undefined) throw new Error('web.Dockerfile sets no KEEP_ALIVE_TIMEOUT in its final stage')
  return parseInt(raw, 10)
}

async function listen(options: ServerOptions, settings: Partial<Server>): Promise<Server> {
  const server = createServer(options, (_req, res) => res.end('ok'))
  Object.assign(server, settings)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return server
}

/** One request on the socket: '200' when answered, 'closed' when the server had closed it. */
function request(socket: Socket): Promise<'200' | 'closed'> {
  return new Promise(resolve => {
    if (socket.destroyed) return resolve('closed')
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      if (buffer.includes('\r\n\r\nok')) { socket.off('data', onData); resolve('200') }
    }
    socket.on('data', onData)
    socket.once('close', () => resolve('closed'))
    socket.write('GET /api/health HTTP/1.1\r\nHost: web\r\nConnection: keep-alive\r\n\r\n', err => err && resolve('closed'))
  })
}

async function openKeepAlive(server: Server): Promise<Socket> {
  const { port } = server.address() as { port: number }
  const socket = connect(port, '127.0.0.1')
  await new Promise<void>(resolve => socket.once('connect', () => resolve()))
  return socket
}

async function shutDown(server: Server, socket: Socket): Promise<void> {
  socket.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

/** What a load balancer does: one request, an idle connection held open, then the next request on the same one. */
async function reuseAfterIdle(server: Server, idleMs: number): Promise<'200' | 'closed'> {
  const socket = await openKeepAlive(server)
  try {
    expect(await request(socket)).toBe('200')
    await new Promise(resolve => setTimeout(resolve, idleMs))
    return await request(socket)
  } finally {
    await shutDown(server, socket)
  }
}

/** How long after answering a request the server itself closes the idle connection (null: not within capMs). */
async function idleCloseAfter(server: Server, capMs: number): Promise<number | null> {
  const socket = await openKeepAlive(server)
  try {
    const closed = new Promise<number>(resolve => socket.once('close', () => resolve(Date.now())))
    expect(await request(socket)).toBe('200')
    const answeredAt = Date.now()
    const at = await Promise.race([closed, new Promise<null>(resolve => setTimeout(() => resolve(null), capMs))])
    return at === null ? null : at - answeredAt
  } finally {
    await shutDown(server, socket)
  }
}

describe('web.Dockerfile KEEP_ALIVE_TIMEOUT', () => {
  it('is set in the final stage, above the load balancer idle timeout', () => {
    const raw = finalStageEnv().KEEP_ALIVE_TIMEOUT
    expect(raw).toMatch(/^\d+$/)
    expect(imageKeepAliveMs()).toBeGreaterThan(LOAD_BALANCER_IDLE_MS)
  })

  it("is what the installed Next's standalone server applies to its HTTP server", () => {
    // The generated server.js reads the variable and hands it to startServer, which sets it on the server it
    // creates. Both are Next's code: if an upgrade renames or drops either, the image's value stops applying.
    const standalone = readFileSync(require.resolve('next/dist/build/utils.js'), 'utf8')
    expect(standalone).toContain('let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10)')
    expect(standalone).toMatch(/startServer\(\{[^}]*\bkeepAliveTimeout,[^}]*\}\)/)
    const startServer = readFileSync(require.resolve('next/dist/server/lib/start-server.js'), 'utf8')
    expect(startServer).toMatch(/if \(keepAliveTimeout\) \{\s*server\.keepAliveTimeout = keepAliveTimeout;/)
  })
})

describe('an idle keep-alive connection on a real Node server', () => {
  it("with Node's default, is closed by the server within seconds: long before a load balancer stops reusing it", async () => {
    const server = await listen({}, {})
    const after = await idleCloseAfter(server, 15_000)
    expect(after).not.toBeNull()
    expect(after!).toBeLessThan(LOAD_BALANCER_IDLE_MS)
  }, 25_000)

  it("with the image's value, is still usable after the point where Node's default has closed it", async () => {
    // Node's default closes about 6 s after the response; 7.5 s idle is past that with room to spare.
    const server = await listen({}, { keepAliveTimeout: imageKeepAliveMs() })
    expect(await reuseAfterIdle(server, 7_500)).toBe('200')
  }, 25_000)

  it('is governed by keepAliveTimeout, not headersTimeout, so 65 s above the 60 s headersTimeout is safe', async () => {
    // Scaled down: headersTimeout far below keepAliveTimeout, checked often.
    const server = await listen({ connectionsCheckingInterval: 200 }, { keepAliveTimeout: 6_000, headersTimeout: 1_500 })
    expect(await reuseAfterIdle(server, 2_500)).toBe('200')
  }, 20_000)
})
