/**
 * Starting one `postgrest` process for one project database.
 *
 * Each child is the official PostgREST binary, unmodified, configured only
 * through an environment built here from scratch: the host's own environment
 * is never passed on. Both of its ports are on 127.0.0.1 and are allocated
 * here; the admin port is used only to ask /ready and is never proxied.
 *
 * The child is configured like the region's PostgREST service (pre-config
 * function, anon role, the pgrst notification channel, the region's JWT
 * secret), plus `PGRST_JWT_AUD`, so a token minted for another project is
 * refused by PostgREST as well as by this host, and a small pool, because one
 * child serves one project.
 */

import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import http from 'http'
import net from 'net'
import { createInterface } from 'readline'

import { databaseUri, type HostConfig } from './config'
import { projectLine, redactor, uriPassword, type LogLine } from './log'

export interface LaunchSpec {
  projectId: string
  database: string
}

export interface ChildExit {
  code: number | null
  signal: string | null
}

/** A running child, as the registry sees it. A fake can stand in for it in tests. */
export interface LaunchedChild {
  readonly pid: number | null
  /** The child's server port on 127.0.0.1. */
  readonly port: number
  /** Resolves once the child's admin /ready answers 200; rejects if it exits first. Never times out on its own. */
  readonly ready: Promise<void>
  /** Resolves when the process has exited, however it ended. */
  readonly exited: Promise<ChildExit>
  /** SIGTERM, then SIGKILL after graceMs if it is still running. Resolves when it has exited. */
  stop(graceMs: number): Promise<ChildExit>
  /** Asks the child's admin /ready once. */
  probeReady(timeoutMs: number): Promise<boolean>
  /** Resident memory of the process, where the platform reports it. */
  rssBytes(): number | null
}

export type Launcher = (spec: LaunchSpec) => Promise<LaunchedChild>

/** The child's environment: PostgREST's own settings and nothing inherited but PATH. */
export function childEnvironment(
  config: Pick<HostConfig, 'dbUri' | 'jwtSecret' | 'childDbPool' | 'childPoolIdleSeconds'>,
  spec: LaunchSpec,
  ports: { server: number; admin: number },
  path: string | undefined = process.env.PATH,
): Record<string, string> {
  const env: Record<string, string> = {
    PGRST_DB_URI: databaseUri(config.dbUri, spec.database),
    PGRST_DB_PRE_CONFIG: 'postgrest.pre_config',
    PGRST_DB_ANON_ROLE: 'anon',
    PGRST_DB_CHANNEL_ENABLED: 'true',
    PGRST_DB_CHANNEL: 'pgrst',
    PGRST_JWT_SECRET: config.jwtSecret,
    PGRST_JWT_AUD: spec.projectId,
    PGRST_DB_POOL: String(config.childDbPool),
    PGRST_DB_POOL_MAX_IDLETIME: String(config.childPoolIdleSeconds),
    // Both on loopback. The admin server is named explicitly as well: it
    // describes the child's configuration, and only this host asks it anything.
    PGRST_SERVER_HOST: '127.0.0.1',
    PGRST_SERVER_PORT: String(ports.server),
    PGRST_ADMIN_SERVER_HOST: '127.0.0.1',
    PGRST_ADMIN_SERVER_PORT: String(ports.admin),
    LANG: 'C.UTF-8',
  }
  if (path) env.PATH = path
  return env
}

/** A port on 127.0.0.1 nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no port allocated'))))
    })
  })
}

/** One GET to a loopback port; the status, or 0 when nothing answered in time. */
export function probe(port: number, path: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', agent: false, timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(0))
    req.end()
  })
}

/** VmRSS from /proc/<pid>/status, in bytes; null where there is no /proc. */
export function readRssBytes(pid: number | null, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): number | null {
  if (!pid) return null
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(read(`/proc/${pid}/status`))
    return match ? Number(match[1]) * 1024 : null
  } catch {
    return null
  }
}

/** The part of a ChildProcess that stopProcess needs. */
export interface Killable {
  kill(signal: NodeJS.Signals): boolean
}

/**
 * SIGTERM now, SIGKILL after graceMs unless `exited` has resolved by then.
 * `onKill` is told when the grace ran out.
 */
export function stopProcess<T>(proc: Killable, exited: Promise<T>, graceMs: number, onKill?: () => void): Promise<T> {
  let done = false
  void exited.then(() => {
    done = true
  })
  try {
    proc.kill('SIGTERM')
  } catch {
    // Already gone: `exited` settles on its own.
  }
  const timer = setTimeout(() => {
    if (done) return
    onKill?.()
    try {
      proc.kill('SIGKILL')
    } catch {
      // Exited between the check and the signal.
    }
  }, graceMs)
  timer.unref?.()
  return exited.then((value) => {
    clearTimeout(timer)
    return value
  })
}

const READY_POLL_MS = 100
const READY_PROBE_TIMEOUT_MS = 1000

/** The launcher that runs the real postgrest binary. */
export function postgrestLauncher(config: HostConfig, log: LogLine): Launcher {
  const redact = redactor([config.jwtSecret, uriPassword(config.dbUri), new URL(config.dbUri).password])

  return async (spec) => {
    const server = await freePort()
    let admin = await freePort()
    while (admin === server) admin = await freePort()

    const env = childEnvironment(config, spec, { server, admin })
    // The child's environment is built from scratch (childEnvironment), so it
    // has no NODE_ENV; the cast only satisfies the repo's ProcessEnv typing.
    const proc: ChildProcess = spawn(config.binary, [], { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })

    let hasExited = false
    const exited = new Promise<ChildExit>((resolve) => {
      proc.once('exit', (code, signal) => {
        hasExited = true
        resolve({ code, signal })
      })
      // A binary that could not be started emits 'error' and may never emit 'exit'.
      proc.once('error', (err) => {
        log(projectLine(spec.projectId, `postgrest could not be run: ${redact(err.message)}`))
        if (proc.pid === undefined) {
          hasExited = true
          resolve({ code: null, signal: null })
        }
      })
    })

    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream) continue
      createInterface({ input: stream }).on('line', (line) => {
        if (line.trim()) log(projectLine(spec.projectId, `postgrest: ${redact(line)}`))
      })
    }

    const ready = (async () => {
      while (!hasExited) {
        if ((await probe(admin, '/ready', READY_PROBE_TIMEOUT_MS)) === 200) return
        if (hasExited) break
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
      }
      const exit = await exited
      throw new Error(`postgrest exited before it was ready (code ${exit.code}, signal ${exit.signal})`)
    })()
    ready.catch(() => {})

    return {
      pid: proc.pid ?? null,
      port: server,
      ready,
      exited,
      stop: (graceMs) =>
        hasExited
          ? exited
          : stopProcess(proc, exited, graceMs, () =>
              log(projectLine(spec.projectId, `did not stop within ${graceMs} ms of SIGTERM; sending SIGKILL`)),
            ),
      probeReady: async (timeoutMs) => !hasExited && (await probe(admin, '/ready', timeoutMs)) === 200,
      rssBytes: () => (hasExited ? null : readRssBytes(proc.pid ?? null)),
    }
  }
}
