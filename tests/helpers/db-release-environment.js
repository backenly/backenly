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
 * jest.setup.js records each Pool and PrismaClient as it is constructed; this
 * closes them. It runs in `teardown`, which comes after every hook in the
 * file. A setup-file `afterAll` would not do: it runs BEFORE the file's own
 * `afterAll`, and a file whose cleanup still queries would find its pool ended.
 */

const { TestEnvironment } = require('jest-environment-node')

/** A handle that will not close must not hold up the run. */
const CLOSE_BUDGET_MS = 10_000

/**
 * End every recorded pool and disconnect every recorded client, within a time
 * budget. Resolves with how many handles were asked to close.
 */
async function releaseDbHandles(handles, budgetMs = CLOSE_BUDGET_MS) {
  if (!handles) return 0
  const closing = [
    ...[...handles.pools].map((pool) => (pool.ending || pool.ended ? null : pool.end())),
    ...[...handles.clients].map((client) => client.$disconnect()),
  ].filter(Boolean)
  handles.pools.clear()
  handles.clients.clear()
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
  async teardown() {
    await releaseDbHandles(this.global && this.global.__backenlyDbHandles)
    await super.teardown()
  }
}

module.exports = DbReleaseEnvironment
module.exports.releaseDbHandles = releaseDbHandles
