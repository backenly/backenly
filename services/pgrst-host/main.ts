/**
 * BACKENLY POSTGREST HOST
 * =======================
 * A project can have a database of its own (`p_<32 hex>`) instead of a schema
 * in its region's shared database. PostgREST serves exactly one database per
 * process, so such a project is served by a PostgREST process of its own. This
 * service runs those processes: one child per project database, started on the
 * project's first request, stopped when idle, and reverse-proxied from one
 * port. Projects in the shared database keep the region's PostgREST service.
 *
 * It holds no platform database credential and no Prisma client: only the
 * region's PostgREST JWT secret and the authenticator's connection URI, the
 * two things PostgREST itself is given. The runtime decides which project
 * lives in which database and says so in the token it mints for each request
 * (lib/postgrest/gateway.ts); this host verifies that token before it starts or
 * reaches anything (token.ts).
 *
 * HTTP contract: server.ts. Configuration: config.ts. Image:
 * services/pgrst-host/Dockerfile.
 *
 * Environment (defaults in brackets):
 *   PGRST_HOST_JWT_SECRET               the region's PostgREST JWT secret (required, 32+ chars)
 *   PGRST_HOST_DB_URI                   the authenticator's postgres:// URI on the data instance;
 *                                       each child gets it with the database replaced (required)
 *   PGRST_HOST_BIND                     listen address [0.0.0.0]; children always bind 127.0.0.1
 *   PGRST_HOST_PORT                     listen port [3200]
 *   PGRST_HOST_BINARY                   the postgrest executable [postgrest]
 *   PGRST_HOST_MAX_CHILDREN             hard cap on running children [20]
 *   PGRST_HOST_CHILD_DB_POOL            PGRST_DB_POOL of each child [3]
 *   PGRST_HOST_IDLE_SECONDS             stop a child after this long without a request [600]
 *   PGRST_HOST_READY_TIMEOUT_SECONDS    a new child must answer /ready within this [10]
 *   PGRST_HOST_STOP_GRACE_SECONDS       SIGTERM to SIGKILL [10]
 *   PGRST_HOST_MAX_BODY_BYTES           largest request body forwarded [10485760]
 *   PGRST_HOST_UPSTREAM_TIMEOUT_SECONDS a silent child answers 504 after this [60]
 */

import { readConfig, type HostConfig } from './config'
import { consoleLog, PREFIX } from './log'
import { createPgrstHost } from './server'

async function main(): Promise<void> {
  let config: HostConfig
  try {
    config = readConfig(process.env)
  } catch (err) {
    consoleLog(`${PREFIX} not started: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const host = createPgrstHost({ config })
  const address = await host.listen()
  consoleLog(
    `${PREFIX} listening on ${address.address}:${address.port}; up to ${config.maxChildren} children, ` +
      `stopped after ${config.idleMs / 1000} s idle`,
  )

  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    consoleLog(`${PREFIX} ${signal}: stopping every child`)
    // Every child gets its grace; past that and a margin, exit regardless.
    setTimeout(() => process.exit(1), config.stopGraceMs + 5000).unref()
    host.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
}

main().catch((err) => {
  consoleLog(`${PREFIX} failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
