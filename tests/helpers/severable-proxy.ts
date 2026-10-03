/**
 * A TCP PROXY THAT CAN BE CUT AND RECONNECTED
 * ===========================================
 *
 * Used to take a dependency away from an application that is already running,
 * without stopping the dependency itself.
 *
 * `sever()` stops listening AND destroys every live socket. Both halves matter:
 * a proxy that only stops accepting leaves established connections working, so
 * a pool that is already warm notices nothing and the outage under test never
 * happens.
 *
 * ── Why a proxy rather than stopping PostgreSQL ─────────────────────────────
 *
 * Two reasons, and the second is the one that decided it:
 *
 *   - the only PostgreSQL on a developer's machine is the one their work
 *     depends on, and a suite that stops it to prove a point is a worse bug
 *     than the one it is testing;
 *   - what the client experiences is identical either way. Its sockets die,
 *     its checked-out connections error, and it must re-establish. A restarted
 *     server and a severed connection are the same event from inside a pool.
 *
 * What a proxy CANNOT show is the server losing its own state. That belongs to
 * the self-host CI job, where a real deployment exists and containers can be
 * restarted for real.
 */

import net from 'net'

export interface Severable {
  /** The loopback port to point a client at, stable across sever/restore. */
  readonly port: number
  sever: () => Promise<void>
  restore: () => Promise<void>
  close: () => Promise<void>
}

export async function severableProxy(targetHost: string, targetPort: number): Promise<Severable> {
  let sockets: net.Socket[] = []
  let server: net.Server | null = null
  let port = 0

  const build = () =>
    net.createServer(client => {
      sockets.push(client)
      const upstream = net.connect(targetPort, targetHost)
      sockets.push(upstream)
      client.pipe(upstream)
      upstream.pipe(client)
      client.on('error', () => {})
      upstream.on('error', () => {})
    })

  server = build()
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as net.AddressInfo).port

  const shutdown = async (s: net.Server) => {
    // close() only calls back once every existing connection has ended, so the
    // sockets are destroyed first. Awaiting before destroying waits for
    // something nobody is doing — that cost two 60-second timeouts before it
    // was understood.
    const closed = new Promise<void>(resolve => s.close(() => resolve()))
    for (const sock of sockets.splice(0)) sock.destroy()
    await closed
  }

  return {
    get port() {
      return port
    },
    async sever() {
      if (server) {
        await shutdown(server)
        server = null
      }
    },
    async restore() {
      if (server) return
      server = build()
      // The SAME port, so a client configured before the outage is still
      // configured correctly after it. Recovery must not require reconfiguring
      // the application.
      await new Promise<void>(resolve => server!.listen(port, '127.0.0.1', resolve))
    },
    async close() {
      if (server) await shutdown(server)
      server = null
    },
  }
}

/** Rewrite a connection URL to point at the proxy instead of the real service. */
export function throughProxy(originalUrl: string, proxyPort: number): string {
  const url = new URL(originalUrl)
  url.hostname = '127.0.0.1'
  url.port = String(proxyPort)
  return url.toString()
}
