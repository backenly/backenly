/**
 * The node test environment, plus one duty: when a test file is finished, close
 * every database handle that file opened.
 *
 * Jest gives each test file its own module registry, so every file that
 * touches the database builds its own Prisma clients and its own `pg` pools:
 * the Prisma singleton, the workspace pools, and the pools several modules
 * create at load time (the invariant probes alone default to ten connections).
 * Nothing closed them when the file ended. In a `--runInBand` job, where forty
 * database-backed files share one process, they piled up until Postgres
 * refused new clients ("sorry, too many clients already") and whichever test
 * next needed a fresh connection failed. Which test that was depended on
 * timing, so the failure moved between unrelated branches.
 *
 * jest.setup.js records each Pool, PrismaClient and pg Client used on its own
 * as it is constructed; this closes them. It runs in `teardown`, which comes
 * after every hook in the file. A setup-file `afterAll` would not do: it runs
 * BEFORE the file's own `afterAll`, and a file whose cleanup still queries
 * would find its pool ended.
 *
 * Closing was not enough on its own. The file's timers kept running after it
 * ended: a webhook retry, the realtime listener's keep-alive and reconnect, a
 * usage flush. Each fired later in the same process, and a Prisma client
 * reconnects on its next query, so the clients closed here opened again and
 * stayed open. So the file's timers are recorded too (trackTimers): the ones
 * still pending are cleared before anything is closed and again after, timers
 * keep working while the handles close (closing uses them), and once all is
 * closed none is scheduled.
 */

const { TestEnvironment } = require('jest-environment-node')

/** A handle that will not close must not hold up the run. */
const CLOSE_BUDGET_MS = 10_000

/**
 * How long a query that was in flight when the file ended gets to settle
 * before the second close, which catches a client it reconnected.
 */
const SETTLE_MS = 25

/**
 * Record the timers a test file schedules through its global, so the ones
 * still pending when it ends can be cleared. `clearPending()` clears those and
 * leaves timers working, which closing a pool or a Prisma client needs;
 * `stop()` clears them and makes every later setTimeout, setInterval and
 * setImmediate schedule nothing, for once everything is closed. A timer that
 * has run, or that the file cleared, is forgotten. The functions keep their
 * util.promisify behaviour.
 */
function trackTimers(global) {
  const pending = new Map()
  let stopped = false

  const wrap = (setName, clearName, once) => {
    const set = global[setName]
    const clear = global[clearName]
    if (typeof set !== 'function' || typeof clear !== 'function') return
    const wrapped = function (callback, ...rest) {
      // Node's own refusal of a callback that is not a function, unchanged.
      if (typeof callback !== 'function') return set(callback, ...rest)
      if (stopped) {
        // After the file ends nothing runs. A real handle, cleared at once,
        // keeps .unref(), .ref() and .hasRef() working for the caller.
        const dead = set(() => {}, ...(setName === 'setImmediate' ? [] : [rest[0]]))
        clear(dead)
        return dead
      }
      let handle
      const run = once
        ? function (...args) {
            pending.delete(handle)
            return callback.apply(this, args)
          }
        : callback
      handle = set(run, ...rest)
      pending.set(handle, clear)
      return handle
    }
    // util.promisify(setTimeout) and friends read a symbol off the function.
    for (const key of Object.getOwnPropertySymbols(set)) {
      Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(set, key))
    }
    global[setName] = wrapped
    global[clearName] = function (handle) {
      pending.delete(handle)
      return clear(handle)
    }
  }

  wrap('setTimeout', 'clearTimeout', true)
  wrap('setInterval', 'clearInterval', false)
  wrap('setImmediate', 'clearImmediate', true)

  const clearPending = () => {
    for (const [handle, clear] of pending) clear(handle)
    pending.clear()
  }

  return {
    clearPending,
    stop() {
      stopped = true
      clearPending()
    },
    pendingCount() {
      return pending.size
    },
  }
}

/**
 * End every recorded pool and disconnect every recorded client, within a time
 * budget. Resolves with how many handles were asked to close.
 */
async function releaseDbHandles(handles, budgetMs = CLOSE_BUDGET_MS) {
  if (!handles) return 0
  const pgClients = handles.pgClients || new Set()
  const closing = [
    ...[...handles.pools].map((pool) => (pool.ending || pool.ended ? null : pool.end())),
    ...[...handles.clients].map((client) => client.$disconnect()),
    ...[...pgClients].map((client) => (client._ending ? null : client.end())),
  ].filter(Boolean)
  handles.pools.clear()
  handles.clients.clear()
  pgClients.clear()
  let timer
  await Promise.race([
    Promise.allSettled(closing),
    new Promise((resolve) => {
      timer = setTimeout(resolve, budgetMs)
    }),
  ])
  clearTimeout(timer)
  return closing.length
}

class DbReleaseEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context)
    this.fileTimers = trackTimers(this.global)
  }

  async teardown() {
    const timers = this.fileTimers
    // The file's own timers first (a retry, a keep-alive, a reconnect): one
    // left pending would reopen what is closed next. Timers keep working
    // while the handles close, because closing a pool or a client uses them.
    if (timers) timers.clearPending()
    const handles = this.global && this.global.__backenlyDbHandles
    const prismaClients = handles ? [...handles.clients] : []
    await releaseDbHandles(handles)
    if (handles) {
      // A query in flight as the file ended can finish after the close and
      // reconnect its client, and a client that closed can schedule its own
      // reconnect: let both settle, clear what they scheduled, close again.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      if (timers) timers.clearPending()
      for (const client of prismaClients) handles.clients.add(client)
      await releaseDbHandles(handles)
    }
    // Everything is closed: nothing in this file runs from here on.
    if (timers) timers.stop()
    await super.teardown()
  }
}

module.exports = DbReleaseEnvironment
module.exports.releaseDbHandles = releaseDbHandles
module.exports.trackTimers = trackTimers
