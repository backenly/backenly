/**
 * AN ASYNC HANDLER THAT REJECTS MUST NOT KILL THE SERVER
 * =====================================================
 *
 * Express 4 does not await the functions it calls. An `async` handler returns a
 * promise that Express drops on the floor, so a rejection never reaches the
 * global error middleware in server/app.ts — it becomes an unhandled rejection,
 * and Node 15+ terminates the process on those.
 *
 * That turned a transient database error into a total outage. Observed in the
 * final qualification run: PostgreSQL was restarted, the next `/api/v1/*`
 * request hit `getProjectIdFromAuth`, Prisma raised P1017 ("Server has closed
 * the connection"), and the runtime process EXITED. Every v1 surface — /db/*,
 * end-user auth, realtime, storage — stayed down afterwards, because nothing
 * in the compose stack restarts that process. With a supervisor it becomes a
 * crash loop instead, dropping every in-flight request and severing every SSE
 * stream on any database blip.
 *
 * The global error handler was correct all along. It simply could never be
 * reached from an async handler, which is why the 500 it exists to send was
 * never sent.
 *
 * ── Middleware counts too ───────────────────────────────────────────────────
 *
 * `v1AuthMiddleware` and `realtimeAuth` are async and both query the database
 * before any handler runs, so they fail in exactly the same way. Everything in
 * a route's chain is wrapped, not just the final handler.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'

type MaybeAsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown | Promise<unknown>

/**
 * Forward a rejection to Express instead of losing it.
 *
 * Synchronous throws already reach `next` on their own; this covers the
 * asynchronous half, which is the half that ends the process.
 */
export function asyncRoute(handler: MaybeAsyncHandler): RequestHandler {
  return (req, res, next) => {
    try {
      const result = handler(req, res, next)
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        ;(result as Promise<unknown>).catch(next)
      }
    } catch (err) {
      next(err)
    }
  }
}

/** Wrap every function in a route's chain. */
export function asyncRoutes(handlers: MaybeAsyncHandler[]): RequestHandler[] {
  return handlers.map(asyncRoute)
}

/**
 * The backstop, and it is FATAL on purpose.
 *
 * Every route is wrapped above, so an expected failure - a dependency erroring,
 * a query rejecting - never reaches here. It is caught by `asyncRoute`, handed
 * to the Express error middleware, and answered as a 500 while the process
 * carries on. That is the behaviour the P1017 crash was fixed to produce, and
 * nothing here changes it.
 *
 * So a rejection that DOES reach the process boundary means something escaped
 * the request model entirely: an unknown programming error, outside any route,
 * with a caller left hanging and no way to know what state it abandoned.
 * Continuing indefinitely from there is less safe than restarting from a known
 * one. A process that logs and soldiers on looks healthy to every health check
 * while holding whatever the bug left behind.
 *
 * Production supervises this process (PM2, `backenly-runtime`, autorestart),
 * so exiting IS the recovery. The value this handler adds over Node's default
 * termination is the loud, structured log and the chance to stop accepting new
 * connections before going, rather than dying mid-request with no explanation.
 *
 *   expected request/dependency failure -> asyncRoute -> error middleware -> 500
 *   unexpected unhandled rejection      -> log -> drain -> exit(1) -> restart
 */
export interface SafetyNetOptions {
  /** Closed before exit so in-flight requests are not cut mid-response. */
  server?: { close: (cb?: () => void) => unknown }
  /** Milliseconds to wait for a drain before exiting anyway. */
  drainMs?: number
  log?: (message: string) => void
  /** Overridden in tests. Real code must not need this. */
  exit?: (code: number) => void
}

export function installProcessSafetyNet(options: SafetyNetOptions = {}): void {
  const log = options.log ?? console.error
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const drainMs = options.drainMs ?? 5_000

  process.on('unhandledRejection', (reason: unknown) => {
    // The CODE as well as the message: `P1017` or `ECONNRESET` is what an
    // operator greps for, and it is the part a bare message leaves out.
    const code = (reason as { code?: unknown } | null)?.code
    const detail =
      reason instanceof Error
        ? `${reason.name}${code ? ` [${String(code)}]` : ''}: ${reason.message}`
        : String(reason)
    log(
      `[Runtime Server] FATAL: unhandled rejection reached the process boundary. ` +
        `Every route is wrapped, so this is a programming error outside the request ` +
        `model - a caller was left with no response and this process's state is ` +
        `unknown. Restarting from a known state is safer than continuing. ${detail}`,
    )
    if (reason instanceof Error && reason.stack) log(reason.stack)

    // Stop taking new work, give what is in flight a moment, then go. The timer
    // is what makes this deterministic: a `close` that never calls back, because
    // one connection is still open, must not leave a wedged process behind -
    // which would be the failure this exists to avoid, in a quieter form.
    let exited = false
    const finish = () => {
      if (exited) return
      exited = true
      exit(1)
    }
    const timer = setTimeout(finish, drainMs)
    if (typeof (timer as any).unref === 'function') (timer as any).unref()

    try {
      if (options.server) options.server.close(() => finish())
      else finish()
    } catch {
      finish()
    }
  })
}
