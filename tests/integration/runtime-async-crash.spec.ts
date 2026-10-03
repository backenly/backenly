/**
 * A REJECTING ROUTE MUST ANSWER 500, NOT KILL THE SERVER
 * =====================================================
 *
 * Found by the final synthetic-production qualification, on a real deployment.
 *
 * PostgreSQL was restarted. The next `/api/v1/*` request reached
 * `getProjectIdFromAuth`, Prisma raised P1017 ("Server has closed the
 * connection"), and the RUNTIME PROCESS EXITED — Node printed the uncaught
 * error and its version banner, and that was the end of the log. Every v1
 * surface stayed down afterwards: /db/*, end-user auth, realtime, storage. The
 * qualification observed `HTTP 0 fetch failed` 480 times over four minutes and
 * the runtime never came back, because nothing in the compose stack restarts
 * that process.
 *
 * ── Why it died rather than returning 500 ───────────────────────────────────
 *
 * Express 4 does not await the functions it calls. An `async` handler returns a
 * promise Express drops, so a rejection never reaches the global error
 * middleware in server/app.ts — it becomes an unhandled rejection, and Node 15+
 * terminates the process on those.
 *
 * The global error handler was correct the whole time. It simply could not be
 * reached from an async handler, which is why the 500 it exists to send was
 * never sent. Middleware has the same problem: `v1AuthMiddleware` and
 * `realtimeAuth` are async and both query the database before any handler runs.
 *
 * ── What this asserts ───────────────────────────────────────────────────────
 *
 * The app is exercised through a real HTTP server on a real socket, because the
 * property under test is what Express does with a rejected promise and that
 * cannot be observed by calling the handler directly.
 *
 *   a rejecting handler     -> 500, and the process is still alive
 *   a rejecting middleware  -> 500, and the process is still alive
 *   a healthy route         -> 200                 (the control)
 *
 * The control matters: "the server is still alive" is trivially true of a
 * server that was never asked to do anything.
 */

import { spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import express from 'express'
import http from 'http'
import type { AddressInfo } from 'net'

import { asyncRoute } from '@/server/lib/async-route'

/** The same global error handler server/app.ts installs. */
function errorHandler(): express.ErrorRequestHandler {
  return (err, _req, res, next) => {
    // The same guard server/app.ts has: once headers are out there is no status
    // left to set, and writing a JSON body into a half-sent response corrupts
    // it. SSE commits its headers and then streams for minutes.
    if (res.headersSent) return next(err)
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
}

interface Harness {
  port: number
  close: () => Promise<void>
}

async function serve(build: (app: express.Express) => void): Promise<Harness> {
  const app = express()
  build(app)
  app.use(errorHandler())
  const server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

async function get(port: number, path: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return res.status
}

/**
 * The failure the deployment actually hit: Prisma's P1017.
 *
 * Reproduced by shape rather than by restarting PostgreSQL — what Express does
 * with a rejected promise does not depend on why it rejected, and a suite that
 * restarts the database to prove a routing property would be testing two things
 * and blaming the wrong one when it failed.
 */
function serverClosedTheConnection(): Error {
  const err: any = new Error('Server has closed the connection.')
  err.name = 'PrismaClientKnownRequestError'
  err.code = 'P1017'
  return err
}

describe('an async route that rejects', () => {
  let harness: Harness
  let rejections: unknown[]
  let onRejection: (reason: unknown) => void

  beforeAll(async () => {
    // Watch for the thing that killed the process. If the wrapper works, this
    // stays empty; without it, this is what Node terminates on.
    rejections = []
    onRejection = reason => rejections.push(reason)
    process.on('unhandledRejection', onRejection)

    harness = await serve(app => {
      app.get('/healthy', asyncRoute(async (_req, res) => {
        res.json({ ok: true })
      }))
      app.get(
        '/rejects',
        asyncRoute(async () => {
          throw serverClosedTheConnection()
        }),
      )
      app.get(
        '/middleware-rejects',
        asyncRoute(async () => {
          throw serverClosedTheConnection()
        }),
        asyncRoute(async (_req, res) => {
          // Must never run: the middleware before it rejected.
          res.json({ reached: true })
        }),
      )
    })
  }, 120_000)

  afterAll(async () => {
    process.off('unhandledRejection', onRejection)
    await harness?.close()
  }, 120_000)

  it('serves a healthy route, which is the control', async () => {
    expect(await get(harness.port, '/healthy')).toBe(200)
  }, 60_000)

  it('answers 500 instead of terminating the process', async () => {
    expect(await get(harness.port, '/rejects')).toBe(500)
  }, 60_000)

  it('answers 500 when an async MIDDLEWARE rejects', async () => {
    // v1AuthMiddleware and realtimeAuth are both async and both query the
    // database before any handler runs, so they fail exactly this way.
    expect(await get(harness.port, '/middleware-rejects')).toBe(500)
  }, 60_000)

  it('left no unhandled rejection for Node to terminate on', async () => {
    // The actual defect, stated directly. Node 15+ exits the process on an
    // unhandled rejection, which is how one database blip became a total,
    // permanent outage of every v1 surface.
    await new Promise(r => setTimeout(r, 200))
    expect(rejections).toEqual([])
  }, 60_000)

  it('is still serving afterwards', async () => {
    // Paired with the control above: the server answered before the rejections
    // and answers after them, so "still alive" is a claim about surviving them.
    expect(await get(harness.port, '/healthy')).toBe(200)
  }, 60_000)
})

/**
 * The demonstration, in a SUBPROCESS.
 *
 * It cannot be done in-process: jest installs its own `unhandledRejection`
 * handler, so the rejection is reported as a test failure instead of ending the
 * process, and the thing under test — Node terminating — never happens.
 *
 * A child process has Node's real default behaviour, which is the behaviour the
 * deployment had. Wrapped, it survives the request and answers 500. Unwrapped,
 * it EXITS, exactly as the runtime did in CI.
 */
describe('the same route in a real process', () => {
  const wrappedServer = () => `
    const express = require('express')
    const http = require('http')
    const app = express()
    const boom = () => {
      const e = new Error('Server has closed the connection.')
      e.name = 'PrismaClientKnownRequestError'
      e.code = 'P1017'
      throw e
    }
    const handler = async () => boom()
    const asyncRoute = fn => (req, res, next) => {
      try {
        const r = fn(req, res, next)
        if (r && typeof r.catch === 'function') r.catch(next)
      } catch (err) { next(err) }
    }
    app.get('/boom', asyncRoute(handler))
    app.use((err, req, res, next) => res.status(500).json({ error: 'Internal server error' }))
    const server = http.createServer(app)
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port
      let status = 0
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/boom', { signal: AbortSignal.timeout(2000) })
        status = res.status
      } catch { status = 0 }
      // Reached only if the process is still alive.
      console.log('STATUS=' + status)
      process.exit(0)
    })
  `

  function run(source: string): { code: number | null; out: string } {
    const r = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 30_000 })
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }

  it('SURVIVES and answers 500 when the handler is wrapped', () => {
    const result = run(wrappedServer())
    expect(result.out).toContain('STATUS=500')
    expect(result.code).toBe(0)
  }, 120_000)

  it('EXITS when the handler is not wrapped, which is what took the runtime down', () => {
    // The same server with `app.get('/boom', handler)` instead. Node prints the
    // uncaught error and terminates - the exact shape of the CI log, which
    // ended with the Prisma stack and "Node.js v20.20.2".
    const unwrapped = wrappedServer().replace('asyncRoute(handler)', 'handler')
    const result = run(unwrapped)

    expect(result.out).not.toContain('STATUS=')
    expect(result.code).not.toBe(0)
    expect(result.out).toContain('P1017')
  }, 120_000)
})

describe('the process backstop is FATAL, not a shrug', () => {
  /**
   * Driven through tsx in a child process, for the same reason the crash
   * demonstration is: jest installs its own `unhandledRejection` handler, so
   * the product's never runs and the thing under test - this process exiting -
   * cannot happen inside the runner.
   *
   * The child imports the REAL module. Nothing here is a copy of it.
   */
  function runChild(body: string): { code: number | null; out: string } {
    const file = join(process.cwd(), `.backstop-under-test-${randomBytes(4).toString('hex')}.ts`)
    writeFileSync(file, body, 'utf8')
    try {
      const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', file], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 60_000,
      })
      return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    } finally {
      rmSync(file, { force: true })
    }
  }

  it('logs, drains and exits non-zero when a rejection escapes every route', () => {
    // The policy, stated as a test:
    //
    //   expected failure   -> asyncRoute -> error middleware -> 500, alive
    //   escaped rejection  -> log -> drain -> exit(1) -> PM2 restarts
    //
    // A handler that logs and keeps going would leave a process that looks
    // healthy to every health check while holding whatever the bug abandoned.
    // Production supervises this process, so exiting IS the recovery.
    const result = runChild(`
      import { installProcessSafetyNet } from './server/lib/async-route'

      let closed = false
      installProcessSafetyNet({
        server: { close: (cb?: () => void) => { closed = true; cb?.() } },
        drainMs: 200,
      })

      process.on('exit', () => console.log('DRAINED=' + closed))

      // A rejection nobody catches, exactly as an escaped bug produces one.
      void Promise.reject(Object.assign(new Error('Server has closed the connection.'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P1017',
      }))

      // Would keep the process alive for a minute if the backstop did nothing.
      setTimeout(() => { console.log('STILL_ALIVE'); process.exit(0) }, 60_000)
    `)

    expect(result.out).toContain('FATAL')
    expect(result.out).toContain('P1017')
    // It drained before going, rather than dying mid-request.
    expect(result.out).toContain('DRAINED=true')
    // And it did NOT soldier on.
    expect(result.out).not.toContain('STILL_ALIVE')
    // Non-zero, so a supervisor treats it as a crash and restarts it.
    expect(result.code).toBe(1)
  }, 180_000)

  it('still exits when the drain never finishes', () => {
    // A `close` that never calls back, because one connection is still open,
    // must not leave a wedged process behind - that is the same failure in a
    // quieter form.
    const result = runChild(`
      import { installProcessSafetyNet } from './server/lib/async-route'

      installProcessSafetyNet({ server: { close: () => undefined }, drainMs: 200 })

      void Promise.reject(new Error('drain never finishes'))

      setTimeout(() => { console.log('STILL_ALIVE'); process.exit(0) }, 60_000)
    `)

    expect(result.out).not.toContain('STILL_ALIVE')
    expect(result.code).toBe(1)
  }, 180_000)
})

describe('the error middleware after headers are committed', () => {
  it('does not try to answer a response that has already started', async () => {
    // The SSE shape: headers flushed, bytes on the wire, then a failure. There
    // is no status left to set, and writing a JSON body into a half-sent
    // response corrupts the stream the client is reading.
    let reachedDefaultHandler = false

    const harness = await serve(app => {
      app.get(
        '/stream-then-fail',
        asyncRoute(async (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('data: {"type":"connected"}' + '\n\n')
          throw serverClosedTheConnection()
        }),
      )
      app.use(((err: any, _req: any, res: any, next: any) => {
        if (res.headersSent) {
          reachedDefaultHandler = true
          return next(err)
        }
        res.status(500).json({ error: 'Internal server error' })
      }) as express.ErrorRequestHandler)
    })

    try {
      const res = await fetch(`http://127.0.0.1:${harness.port}/stream-then-fail`)
      // Already 200, and it cannot be rewritten to 500. Without the guard the
      // middleware would call res.status(500).json() on a committed response,
      // which throws ERR_HTTP_HEADERS_SENT and corrupts the stream.
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      // The body may or may not arrive: Express's default handler destroys the
      // socket, so the client can legitimately see a reset instead. What must
      // be true either way is that no JSON error was appended to the stream.
      const body = await res.text().catch(() => '')
      expect(body).not.toContain('Internal server error')

      expect(reachedDefaultHandler).toBe(true)
    } finally {
      await harness.close()
    }
  }, 120_000)
})
