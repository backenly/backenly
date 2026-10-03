/**
 * REAL CONTROL OVER A REAL REDIS
 * ==============================
 *
 * The limiter's claims — that it fails as an OUTAGE rather than as a limit,
 * that it recovers on its own, that two instances share one budget — are claims
 * about what happens when Redis genuinely goes away. A mock would be asserting
 * the mock, so these suites stop and start the actual server.
 *
 * HOW that is done differs by environment, and getting it wrong is how a suite
 * ends up green having tested nothing:
 *
 *   - CI runs Redis as a service container, so `docker stop` / `docker start`
 *     is the process boundary;
 *   - this developer's machine runs it inside WSL, where `redis-cli shutdown`
 *     and `redis-server` are.
 *
 * Both are genuine restarts of the server process. Neither is a simulation.
 *
 * The first version of this lived inline in restart-recovery.spec.ts and knew
 * only about WSL. It passed locally and failed in CI with `spawnSync wsl.exe
 * ENOENT` — a test defect, not a product one, and the reason this is a helper
 * with explicit environment detection rather than one hard-coded path.
 *
 * Reachability is probed over TCP rather than through `redis-cli`, because the
 * runner is not guaranteed to have redis-cli at all and because TCP is what the
 * application actually depends on.
 */

import { execFileSync } from 'child_process'
import net from 'net'

export interface RedisProcess {
  /** How this Redis is being controlled, for test output. */
  readonly kind: string
  stop(): void
  start(): void
}

/** Speaks just enough RESP to ask whether a server is answering. */
export async function redisAnswers(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (answered: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(answered)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => socket.write('PING\r\n'))
    socket.on('data', chunk => finish(chunk.toString('utf8').includes('PONG')))
    socket.on('error', () => finish(false))
    socket.on('timeout', () => finish(false))
    // A server that is going down ACCEPTS the connection and then closes it
    // without answering. That emits neither `data`, `error` nor `timeout`, so
    // without these two the promise never settles: the socket closes, the event
    // loop empties, and the caller waits for ever. Under jest that presented as
    // a 300-second test timeout with no failed assertion, which is a far worse
    // symptom than the one-line cause deserves.
    socket.on('end', () => finish(false))
    socket.on('close', () => finish(false))
  })
}

function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .replace(/\0/g, '')
    .trim()
}

/** The container id publishing `port`, if this machine has docker and one is. */
function dockerContainerOnPort(port: string): string | null {
  try {
    const out = run('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.ID}}'])
    return out.split(/\r?\n/).filter(Boolean)[0] ?? null
  } catch {
    return null
  }
}

function wslAvailable(): boolean {
  if (process.platform !== 'win32') return false
  try {
    run('wsl.exe', ['-d', 'backenly-builder', '-u', 'root', '-e', 'bash', '-lc', 'true'])
    return true
  } catch {
    return false
  }
}

/**
 * Pick a way to stop and start the Redis behind `redisUrl`.
 *
 * Throws rather than returning a no-op. A control that silently does nothing
 * would make every assertion below it pass against a Redis that never went
 * away, which is the failure mode this whole programme exists to remove.
 */
export function redisProcessControl(redisUrl: string): RedisProcess {
  const url = new URL(redisUrl)
  const port = url.port || '6379'

  const container = dockerContainerOnPort(port)
  if (container) {
    return {
      kind: `docker container ${container}`,
      // `docker stop` is SIGTERM then SIGKILL, and redis-server exits on
      // SIGTERM. The container keeps its port mapping across a start, so the
      // application's URL stays valid.
      stop: () => run('docker', ['stop', container]),
      start: () => run('docker', ['start', container]),
    }
  }

  if (wslAvailable()) {
    const wsl = (command: string) =>
      run('wsl.exe', ['-d', 'backenly-builder', '-u', 'root', '-e', 'bash', '-lc', command])
    return {
      kind: 'redis-server in WSL (backenly-builder)',
      stop: () => {
        wsl(`redis-cli -h 127.0.0.1 -p ${port} shutdown nosave 2>&1 || true`)
      },
      start: () => {
        wsl(`redis-server --daemonize yes --bind 0.0.0.0 --protected-mode no --port ${port}`)
      },
    }
  }

  throw new Error(
    `REDIS_URL is set to ${redisUrl}, but this machine offers no way to stop and start that ` +
      `server: no docker container publishes port ${port}, and the backenly-builder WSL distro ` +
      `is not available. These suites restart Redis for real, so there is nothing to assert here.`,
  )
}

/** Wait until Redis is answering (`up`) or has gone (`!up`). */
export async function waitForRedis(
  redisUrl: string,
  up: boolean,
  timeoutMs = 60_000,
): Promise<boolean> {
  const url = new URL(redisUrl)
  const host = url.hostname || '127.0.0.1'
  const port = Number(url.port || 6379)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await redisAnswers(host, port)) === up) return true
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}
