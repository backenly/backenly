/**
 * The environment a pg_dump or psql child runs with.
 *
 * libpq reads its per-user files from the home directory, $HOME first
 * (src/interfaces/libpq/fe-connect.c, pqGetHomeDirectory), and on every TLS
 * connection it looks there for a client certificate,
 * $HOME/.postgresql/postgresql.crt. A certificate that is not there is fine.
 * One it cannot even look for ends the connection: any error but "no such
 * file" is fatal (src/interfaces/libpq/fe-secure-openssl.c, initialize_SSL).
 *
 * The images start as root and run the app as node
 * (docker/function-isolation/entrypoint.sh), and the app kept root's HOME,
 * which node cannot enter. Every pg_dump and psql the app started inherited it
 * and failed with `could not open certificate file
 * "/root/.postgresql/postgresql.crt": Permission denied`: exports, daily
 * snapshots and restores alike (production QA re-test, 2026-11-16, N5). The
 * entrypoint now hands the app node's own home. This is the same rule for
 * however else the app is started: a child whose inherited HOME this process
 * cannot enter gets the home of the user the process runs as instead.
 */
import { accessSync, constants } from 'fs'
import { userInfo } from 'os'

/** A copy of `base` for a libpq child, with a HOME it can look in. `base` is not changed. */
export function libpqChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  if (env.HOME && canEnter(env.HOME)) return env
  const home = ownHome()
  if (home) env.HOME = home
  // No home that can be entered: libpq then looks the user up itself, and
  // goes on without its per-user files when it finds none.
  else delete env.HOME
  return env
}

function canEnter(dir: string): boolean {
  try {
    accessSync(dir, constants.R_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The passwd home of the user this process runs as, when it can be entered. */
function ownHome(): string | null {
  try {
    const home = userInfo().homedir
    return home && canEnter(home) ? home : null
  } catch {
    // No passwd entry for this uid.
    return null
  }
}
