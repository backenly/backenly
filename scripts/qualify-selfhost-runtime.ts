/**
 * THE SURFACES THAT ONLY EXIST ON A REAL DEPLOYMENT
 * ================================================
 *
 * `/db/*` is served by the Express runtime against a real PostgREST, and
 * realtime is a live SSE stream fed by Postgres LISTEN/NOTIFY. Neither exists
 * in the jest integration job — there is no PostgREST there and no long-lived
 * server — so the dependency-failure suites deliberately do not pretend to
 * cover them. This script is where they are covered, on the deployment the
 * self-host CI job just installed.
 *
 * It asserts three things the brief named, in the only place they are real:
 *
 *   END-USER AUTH   through the v1 surface, not the dashboard's. These are
 *                   different systems on purpose, and a restart that leaves
 *                   operators able to sign in while a project's own users
 *                   cannot is a deployment that only half works.
 *
 *   REALTIME        open the stream, PROVE it is connected by reading the
 *                   frame that says so, interrupt Postgres underneath it,
 *                   cause a KNOWN row change, and require that exact event to
 *                   arrive. No networkidle, no "wait a bit and hope", and no
 *                   assertion that passes because some event arrived.
 *
 *   /db/* UNDER OUTAGE  the data plane, with the database taken away from an
 *                   application that is already running, and given back
 *                   without restarting it.
 *
 * ── Why a script rather than more YAML ──────────────────────────────────────
 *
 * These are stateful, multi-step, and asynchronous. Expressed in bash they
 * become curl pipelines whose failures read as "exit 1", and the last two
 * CI failures in this branch were both diagnostics that hid their own cause.
 * Here every stage says what it observed, and a failure names the value it got.
 *
 * ── It refuses rather than skipping ─────────────────────────────────────────
 *
 * If the runtime is not up, or PostgREST is not serving, this exits non-zero.
 * A skipped qualification that prints a tick is the reporting this programme
 * exists to remove.
 */

// The runtime and the installer both read .env; a bare tsx process does not,
// and DATABASE_URL lives there. Without this the script talks to whatever
// happens to be in the shell, which on a developer's machine is a different
// database from the deployment under test.
import 'dotenv/config'

import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { randomBytes, randomUUID } from 'crypto'

const ENV_PATH = '.env'
const RUNTIME = process.env.QUALIFY_RUNTIME_URL ?? 'http://127.0.0.1:3001'
const COMPOSE = ['compose', '-f', 'docker-compose.dev.yml']

let failures = 0

function envValue(key: string): string {
  if (!existsSync(ENV_PATH)) throw new Error(`${ENV_PATH} does not exist; run the installer first`)
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && m[1] === key) return m[2]
  }
  throw new Error(`${key} is not set in ${ENV_PATH}`)
}

function docker(args: string[]): string {
  return execFileSync('docker', [...COMPOSE, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function step(message: string): void {
  console.log(`\n── ${message}`)
}

function ok(message: string): void {
  console.log(`   ok    ${message}`)
}

function bad(message: string): void {
  failures += 1
  console.error(`   FAIL  ${message}`)
}

function must(condition: boolean, message: string): void {
  if (condition) ok(message)
  else bad(message)
}

async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

/**
 * Poll until `probe` returns a value, or fail loudly WITH WHAT IT LAST SAW.
 *
 * `observe` exists because the first version of this threw
 * "timed out after 120000ms waiting for /db to serve again" and nothing else -
 * the statuses it had spent two minutes collecting were all discarded. That is
 * the same defect as the one this branch fixed in the migration runner and in
 * the upgrade suite, so the helper carries the evidence rather than each caller
 * remembering to.
 */
async function until<T>(
  what: string,
  probe: () => Promise<T | null>,
  timeoutMs = 60_000,
  observe?: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  const seen = new Map<string, number>()
  while (Date.now() < deadline) {
    const got = await probe()
    if (got) return got
    if (observe) {
      const note = observe()
      seen.set(note, (seen.get(note) ?? 0) + 1)
    }
    await sleep(500)
  }
  const detail = seen.size
    ? `; observed ${[...seen.entries()].map(([k, n]) => `${k} x${n}`).join(', ')}`
    : ''
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${detail}`)
}

interface Answer {
  status: number
  body: any
  text: string
}

async function call(
  path: string,
  init: RequestInit & { apiKey?: string } = {},
): Promise<Answer> {
  const { apiKey, ...rest } = init
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((rest.headers as Record<string, string>) ?? {}),
  }
  if (apiKey) headers['x-api-key'] = apiKey

  let res: Response
  try {
    res = await fetch(`${RUNTIME}${path}`, { ...rest, headers })
  } catch (err: any) {
    // A refused connection is itself an answer: the runtime is not there.
    return { status: 0, body: null, text: String(err?.message ?? err) }
  }
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    /* non-JSON is reported as text */
  }
  return { status: res.status, body, text }
}

// ── The SSE stream, read frame by frame ──────────────────────────────────────

interface Stream {
  frames: any[]
  raw: string[]
  close: () => void
  /** Resolves once a frame satisfying `match` arrives, or rejects on timeout. */
  waitFor: (what: string, match: (frame: any) => boolean, timeoutMs?: number) => Promise<any>
}

async function openStream(path: string, apiKey: string): Promise<Stream> {
  const controller = new AbortController()
  const frames: any[] = []
  const raw: string[] = []

  const res = await fetch(`${RUNTIME}${path}`, {
    headers: { 'x-api-key': apiKey, accept: 'text/event-stream' },
    signal: controller.signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`the realtime stream did not open: HTTP ${res.status}`)
  }

  // Read in the background. Each `data:` line is one frame; keepalives arrive
  // as `:` comments and are kept in `raw` but are not frames.
  ;(async () => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() ?? ''
        for (const chunk of chunks) {
          raw.push(chunk)
          const line = chunk.split('\n').find(l => l.startsWith('data: '))
          if (!line) continue
          try {
            frames.push(JSON.parse(line.slice(6)))
          } catch {
            /* a frame that is not JSON is kept in raw only */
          }
        }
      }
    } catch {
      /* the stream ended, deliberately or not; `frames` holds what arrived */
    }
  })()

  return {
    frames,
    raw,
    close: () => controller.abort(),
    async waitFor(what, match, timeoutMs = 60_000) {
      return until(what, async () => frames.find(match) ?? null, timeoutMs)
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const projectId = envValue('BACKENLY_PROJECT_ID')
  const pgUser = (() => {
    try {
      return envValue('POSTGRES_USER')
    } catch {
      return 'backenly_user'
    }
  })()
  const pgDb = (() => {
    try {
      return envValue('POSTGRES_DB')
    } catch {
      return 'backenly'
    }
  })()

  const psql = (sql: string): string =>
    docker(['exec', '-T', 'postgres', 'psql', '-h', '127.0.0.1', '-U', pgUser, '-d', pgDb, '-tAc', sql])

  const TABLE = 'qualification'
  const schema = `workspace_${projectId}`
  const endUserEmail = `qualify-${randomBytes(4).toString('hex')}@example.test`
  const endUserPassword = 'Qualify!Password9'

  console.log(`project ${projectId}`)
  console.log(`runtime ${RUNTIME}`)

  // ── Preconditions ─────────────────────────────────────────────────────────
  step('the runtime is serving')
  const health = await call('/health')
  if (health.status === 0) {
    throw new Error(`the runtime at ${RUNTIME} is not answering: ${health.text}`)
  }
  ok(`runtime answered ${health.status}`)

  // ── Fixture, through the product's own functions ──────────────────────────
  step('a table, a realtime trigger, an API key and an end user')

  const { prisma } = await import('@/lib/db/prisma')
  const { installRealtimeTrigger } = await import('@/lib/services/realtimeTriggers')
  const { ensureSchemaRegistered } = await import('@/lib/postgrest/registration')
  const { createApiKey } = await import('@/lib/auth/apiKeyAuth')

  const operator = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (!operator) throw new Error('no operator account exists; the browser suite should have created one')

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schema}"."${TABLE}" (
       id serial PRIMARY KEY,
       marker text NOT NULL
     )`,
  )

  // Registration is what makes the schema servable at all; without it every
  // /db/* call answers PGRST106 and the whole stage would be testing that.
  const registration = await ensureSchemaRegistered(projectId)
  ok(`schema registration: ${JSON.stringify(registration)}`)

  await installRealtimeTrigger(projectId, TABLE)
  ok(`realtime trigger installed on ${TABLE}`)

  // TWO credentials, because they are meant to get different answers.
  //
  // The first run of this used one anonymous key for everything and its write
  // came back 401 with `permission denied for table qualification`. That was
  // the product being RIGHT: an API key with no end-user identity mints the
  // `anon` role, and anon has SELECT on a registered schema but not INSERT.
  // A service-role key is what a server-side integration uses to write.
  const { rawKey: anonKey } = await createApiKey(projectId, operator.id, {
    name: 'qualification client',
  })
  const { rawKey: serviceKey, record: serviceRecord } = await createApiKey(
    projectId,
    operator.id,
    { name: 'qualification server' },
  )
  await prisma.apiKey.update({
    where: { id: serviceRecord.id },
    data: { serviceRole: true, keyType: 'service' },
  })

  // Read back, because the whole service-role half of this file depends on it
  // and "the update did not throw" is not the same claim as "the row says so".
  const serviceRow = await prisma.apiKey.findUnique({
    where: { id: serviceRecord.id },
    select: { serviceRole: true, keyType: true, expiresAt: true, projectId: true },
  })
  must(
    serviceRow?.serviceRole === true,
    `the service key row reads back as service-role (${JSON.stringify(serviceRow)})`,
  )
  ok('api keys created (client + service-role)')

  // ── CONTROL: every surface works before anything is broken ────────────────
  step('CONTROL — every surface answers while the deployment is healthy')

  const seeded = `control-${randomUUID()}`
  const created = await call(`/api/v1/${projectId}/db/${TABLE}`, {
    method: 'POST',
    apiKey: serviceKey,
    body: JSON.stringify({ marker: seeded }),
  })
  must(
    created.status >= 200 && created.status < 300,
    `/db/${TABLE} accepted a service-role write (HTTP ${created.status}` +
      `${created.status >= 400 ? ` — ${created.text.slice(0, 300)}` : ''})`,
  )

  // The paired refusal. Without it, "a write succeeded" says nothing about
  // whether the data plane distinguishes the two credentials at all.
  const anonWrite = await call(`/api/v1/${projectId}/db/${TABLE}`, {
    method: 'POST',
    apiKey: anonKey,
    body: JSON.stringify({ marker: `anon-${randomUUID()}` }),
  })
  must(
    anonWrite.status >= 400,
    `/db/${TABLE} refused an anonymous write (HTTP ${anonWrite.status})`,
  )

  const listed = await call(`/api/v1/${projectId}/db/${TABLE}`, { apiKey: anonKey })
  const rows = listed.body?.data ?? listed.body?.rows ?? listed.body
  must(listed.status === 200, `/db/${TABLE} served a read (HTTP ${listed.status})`)
  must(
    JSON.stringify(rows ?? '').includes(seeded),
    `the read contained the row that was just written (body: ${listed.text.slice(0, 300)})`,
  )

  const signup = await call(`/api/v1/${projectId}/auth/signup`, {
    method: 'POST',
    body: JSON.stringify({ email: endUserEmail, password: endUserPassword, name: 'Qualification' }),
  })
  must(signup.status >= 200 && signup.status < 300, `v1 end-user signup (HTTP ${signup.status})`)

  const signin = await call(`/api/v1/${projectId}/auth/signin`, {
    method: 'POST',
    body: JSON.stringify({ email: endUserEmail, password: endUserPassword }),
  })
  must(signin.status === 200, `v1 end-user signin (HTTP ${signin.status})`)

  // ── Realtime, across a restart of the dependency it depends on ────────────
  step('REALTIME — a known event, after Postgres restarts underneath the stream')

  let stream = await openStream(`/api/v1/${projectId}/realtime?table=${TABLE}`, anonKey)
  await stream.waitFor('the connected frame', f => f?.type === 'connected', 30_000)
  ok('stream open, and it said `connected` — not merely "no error yet"')

  // The hub holds ONE pg LISTEN connection per process. Restarting Postgres
  // destroys it; the claim under test is that it comes back and re-LISTENs
  // without the runtime being restarted.
  docker(['restart', 'postgres'])
  ok('postgres restarted')

  await until(
    'postgres to answer again',
    async () => {
      try {
        psql('select 1')
        return true
      } catch {
        return null
      }
    },
    120_000,
  )
  ok('postgres is answering')

  // The SSE connection may or may not have survived; both are acceptable, and
  // what must be true either way is that a stream can carry a known event
  // again. Reopening is what a client does, so reopening is what is tested.
  const stillOpen = stream.frames.some(f => f?.type === 'connected')
  if (!stillOpen) {
    stream.close()
    stream = await openStream(`/api/v1/${projectId}/realtime?table=${TABLE}`, anonKey)
    await stream.waitFor('the connected frame after reopening', f => f?.type === 'connected', 60_000)
  }

  // A marker nothing else can produce, so "an event arrived" cannot pass for
  // "THIS event arrived".
  const marker = `after-restart-${randomUUID()}`
  let delivered = false
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !delivered) {
    // Re-inserted on a schedule: the hub reconnects with backoff, and
    // LISTEN/NOTIFY has no replay, so an event published while it was
    // reconnecting is genuinely gone. Retrying the CAUSE is honest; waiting
    // longer for a lost notification would not be.
    psql(`INSERT INTO "${schema}"."${TABLE}" (marker) VALUES ('${marker}')`)
    try {
      await stream.waitFor(
        'the row change to arrive on the stream',
        f => JSON.stringify(f?.data ?? {}).includes(marker),
        10_000,
      )
      delivered = true
    } catch {
      /* try again; the loop's deadline is the real timeout */
    }
  }
  must(delivered, 'the exact row change arrived on the realtime stream after the restart')
  stream.close()

  // ── The surfaces, after the restart ───────────────────────────────────────
  step('AFTER THE RESTART — the data plane and end-user auth still work')

  let lastDb = 'nothing yet'
  const afterRead = await until(
    '/db to serve again',
    async () => {
      const res = await call(`/api/v1/${projectId}/db/${TABLE}`, { apiKey: anonKey })
      lastDb = `HTTP ${res.status} ${res.text.slice(0, 120)}`
      return res.status === 200 ? res : null
    },
    // PostgREST keeps its own pool and reconnects with backoff after the server
    // it was talking to goes away. This is the window that recovery has to fit
    // inside WITHOUT anything being restarted by hand.
    240_000,
    () => lastDb,
  )
  must(
    JSON.stringify(afterRead.body ?? '').includes(seeded),
    'the row written before the restart is still served',
  )

  const afterSignin = await call(`/api/v1/${projectId}/auth/signin`, {
    method: 'POST',
    body: JSON.stringify({ email: endUserEmail, password: endUserPassword }),
  })
  must(
    afterSignin.status === 200,
    `v1 end-user signin after the restart (HTTP ${afterSignin.status})`,
  )

  // ── Dependency failure, against the application that is already running ───
  step('DEPENDENCY FAILURE — the database is taken away from a running app')

  docker(['stop', 'postgres'])
  ok('postgres stopped')
  // The session and exposure caches are short-lived; waiting past them is what
  // makes the next calls address the database rather than memory.
  await sleep(20_000)

  const dbDuring = await call(`/api/v1/${projectId}/db/${TABLE}`, { apiKey: anonKey })
  must(dbDuring.status !== 200, `/db/* did not report success (HTTP ${dbDuring.status})`)
  must(
    dbDuring.status !== 404,
    `/db/* did not claim the table does not exist (HTTP ${dbDuring.status})`,
  )
  must(dbDuring.status >= 500, `/db/* reported an outage (HTTP ${dbDuring.status})`)

  const authDuring = await call(`/api/v1/${projectId}/auth/signin`, {
    method: 'POST',
    body: JSON.stringify({ email: endUserEmail, password: endUserPassword }),
  })
  must(authDuring.status !== 200, `end-user auth did not succeed (HTTP ${authDuring.status})`)
  must(
    authDuring.status !== 401,
    `end-user auth did not fabricate a credential verdict (HTTP ${authDuring.status})`,
  )
  must(
    !/postgres(ql)?:\/\/|127\.0\.0\.1:5432/.test(authDuring.text),
    'the failure did not describe the infrastructure to an unauthenticated caller',
  )

  docker(['start', 'postgres'])
  ok('postgres started')

  // ── Recovery, without restarting the application ──────────────────────────
  step('RECOVERY — the same application process serves again')

  let lastRecovery = 'nothing yet'
  const recovered = await until(
    '/db to serve again after the outage',
    async () => {
      const res = await call(`/api/v1/${projectId}/db/${TABLE}`, { apiKey: anonKey })
      lastRecovery = `HTTP ${res.status} ${res.text.slice(0, 120)}`
      return res.status === 200 ? res : null
    },
    240_000,
    () => lastRecovery,
  )
  must(
    JSON.stringify(recovered.body ?? '').includes(seeded),
    'the data plane recovered with its data intact, and nothing was restarted',
  )

  const authAfter = await until(
    'end-user auth to work again',
    async () => {
      const res = await call(`/api/v1/${projectId}/auth/signin`, {
        method: 'POST',
        body: JSON.stringify({ email: endUserEmail, password: endUserPassword }),
      })
      return res.status === 200 ? res : null
    },
    180_000,
  )
  must(authAfter.status === 200, 'end-user auth recovered')

  await prisma.$disconnect().catch(() => {})
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} qualification check(s) failed`)
      process.exit(1)
    }
    console.log('\nevery runtime qualification check passed')
    process.exit(0)
  })
  .catch(err => {
    console.error(`\nqualification could not complete: ${err?.message ?? err}`)
    process.exit(1)
  })
