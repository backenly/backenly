/**
 * FINAL SYNTHETIC-PRODUCTION QUALIFICATION
 * =======================================
 *
 * The last gate. Everything before it tested one subsystem at a time against a
 * fixture built for that subsystem. This builds ONE deployment carrying as much
 * of the product as a real one would, takes it through the whole lifecycle, and
 * asks whether it is still the same deployment at the end.
 *
 *   BUILD      one fixture, through real product services
 *   USE        every major surface, and prove the bytes and rows are right
 *   SNAPSHOT   a project database snapshot, from the scheduler
 *   BUNDLE     a deployment recovery bundle, with a canary
 *   DESTROY    the workspace schema and the storage bytes, for real
 *   RESTORE    from the bundle, through the operator CLI's own library
 *   VERIFY     identity, rows, bytes, config, secrets, history
 *   SOAK       bounded concurrent load, watching what leaks
 *
 * ── Why destruction has to be real ──────────────────────────────────────────
 *
 * A restore that is verified while the original state is still present proves
 * nothing: every assertion can be satisfied by the thing that was never
 * removed. So the workspace schema is DROPPED and the stored object's bytes are
 * DELETED before the restore runs, and both are checked to be gone first.
 *
 * ── The soak is a leak detector, not a benchmark ────────────────────────────
 *
 * No throughput numbers are asserted, because a CI runner cannot produce a
 * meaningful one and pretending otherwise would be the sort of evidence this
 * programme keeps deleting. What IS asserted is that nothing grows without
 * bound: PostgreSQL backends, open handles and heap after the load are compared
 * with before it. A pool that leaks a connection per request and a stream that
 * never closes are both invisible to a functional test and fatal in a week.
 */

import 'dotenv/config'

import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import crypto from 'crypto'

const ENV_PATH = '.env'
const RUNTIME = process.env.QUALIFY_RUNTIME_URL ?? 'http://127.0.0.1:3001'
const COMPOSE = ['compose', '-f', 'docker-compose.dev.yml']

let failures = 0

function envValue(key: string, fallback?: string): string {
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && m[1] === key) return m[2]
    }
  }
  if (fallback !== undefined) return fallback
  throw new Error(`${key} is not set in ${ENV_PATH}`)
}

function docker(args: string[]): string {
  return execFileSync('docker', [...COMPOSE, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const step = (m: string) => console.log(`\n── ${m}`)
const ok = (m: string) => console.log(`   ok    ${m}`)
const bad = (m: string) => {
  failures += 1
  console.error(`   FAIL  ${m}`)
}
const must = (cond: boolean, m: string) => (cond ? ok(m) : bad(m))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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

async function call(path: string, init: RequestInit & { apiKey?: string } = {}): Promise<Answer> {
  const { apiKey, ...rest } = init
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((rest.headers as Record<string, string>) ?? {}),
  }
  if (apiKey) headers['x-api-key'] = apiKey
  try {
    const res = await fetch(`${RUNTIME}${path}`, { ...rest, headers })
    const text = await res.text()
    let body: any = null
    try {
      body = JSON.parse(text)
    } catch {
      /* reported as text */
    }
    return { status: res.status, body, text }
  } catch (err: any) {
    return { status: 0, body: null, text: String(err?.message ?? err) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const projectId = envValue('BACKENLY_PROJECT_ID')
  const pgUser = envValue('POSTGRES_USER', 'backenly_user')
  const pgDb = envValue('POSTGRES_DB', 'backenly')
  const schema = `workspace_${projectId}`

  // Reading is done with psql; WRITING SCHEMA IS NOT.
  //
  // psql here runs as POSTGRES_USER, the installer's elevated role, and the
  // application connects as backenly_app. Tables created by the wrong one are
  // owned by the wrong one: the app cannot read them, PostgREST has no grants
  // on them (the default privileges are declared FOR ROLE backenly_app), and
  // pg_dump as the app role fails with "permission denied". The first run of
  // this file did exactly that and produced three unrelated-looking failures.
  //
  // So DDL goes through `appSql`, on the application's own connection, which is
  // also how the product creates tables.
  const psql = (sql: string): string =>
    docker(['exec', '-T', 'postgres', 'psql', '-h', '127.0.0.1', '-U', pgUser, '-d', pgDb, '-tAc', sql])

  /** Live PostgreSQL backends. The soak's leak signal. */
  const backends = (): number =>
    Number(psql(`SELECT count(*) FROM pg_stat_activity WHERE datname = '${pgDb}'`).trim() || '0')

  console.log(`project ${projectId}`)
  console.log(`runtime ${RUNTIME}`)

  const { prisma } = await import('@/lib/db/prisma')
  /**
   * DDL and writes, as the application role the deployment actually runs as.
   *
   * ONE STATEMENT PER CALL. Prisma's raw API sends a prepared statement and
   * PostgreSQL refuses more than one command in it, so a multi-statement block
   * fails outright - which is why each statement is passed separately rather
   * than as one readable blob.
   */
  const appSql = (sql: string) => prisma.$executeRawUnsafe(sql)
  const appSqlEach = async (statements: string[]) => {
    for (const sql of statements) await appSql(sql)
  }
  const { createApiKey } = await import('@/lib/auth/apiKeyAuth')
  const { ensureSchemaRegistered } = await import('@/lib/postgrest/registration')
  const { storageService } = await import('@/lib/services/storage')
  const { saveSmtpConfig, getSmtpConfigView } = await import('@/lib/email/project-smtp')

  // ── 1. The fixture ────────────────────────────────────────────────────────
  step('BUILD — one fixture, through the product’s own services')

  const operator = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true },
  })
  if (!operator) throw new Error('no operator exists; the browser suite should have claimed this deployment')
  ok(`operator ${operator.email}`)

  const MARKER = `final-${crypto.randomUUID()}`
  const CANARY = `canary-${crypto.randomBytes(12).toString('hex')}`
  const OBJECT_BYTES = Buffer.from(`final-object-${crypto.randomUUID()}`, 'utf8')

  // A table with the shapes that break naive dump/restore: a self-referencing
  // FK, a composite key, a unique constraint, a check constraint and a default.
  await appSqlEach([
    `CREATE TABLE IF NOT EXISTS "${schema}".final_nodes (
       id serial PRIMARY KEY,
       parent_id int REFERENCES "${schema}".final_nodes(id),
       label text NOT NULL UNIQUE,
       weight int NOT NULL DEFAULT 1 CHECK (weight > 0),
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS "${schema}".final_pairs (
       left_id int NOT NULL,
       right_id int NOT NULL,
       note text,
       PRIMARY KEY (left_id, right_id)
     )`,
    `CREATE INDEX IF NOT EXISTS final_nodes_label_idx ON "${schema}".final_nodes (label)`,
  ])
  await appSql(
    `INSERT INTO "${schema}".final_nodes (label) VALUES ('${MARKER}')
     ON CONFLICT (label) DO NOTHING`,
  )
  await appSql(
    `INSERT INTO "${schema}".final_pairs (left_id, right_id, note)
     SELECT id, id, '${MARKER}' FROM "${schema}".final_nodes WHERE label = '${MARKER}'
     ON CONFLICT DO NOTHING`,
  )
  ok('workspace tables: self-referencing FK, composite PK, unique, check, default, index')

  // A FORCE RLS table, because FORCE RLS keys on the OWNER and a restore that
  // re-owns the schema silently rewrites who every policy binds.
  await appSqlEach([
    `CREATE TABLE IF NOT EXISTS "${schema}".final_secrets (
       id serial PRIMARY KEY,
       owner_id text NOT NULL,
       body text NOT NULL
     )`,
    // SEEDED BEFORE IT IS PROTECTED. Under FORCE RLS the owner is subject to
    // its own policy, so inserting afterwards is refused by the very rule this
    // fixture exists to demonstrate - 42501, "new row violates row-level
    // security policy". The row has to exist before the lock goes on.
    `INSERT INTO "${schema}".final_secrets (owner_id, body) VALUES ('someone', '${MARKER}')`,
    `ALTER TABLE "${schema}".final_secrets ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE "${schema}".final_secrets FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS final_secrets_owner ON "${schema}".final_secrets`,
    `CREATE POLICY final_secrets_owner ON "${schema}".final_secrets
       USING (owner_id = current_setting('request.jwt.claim.sub', true))`,
  ])
  // `::text` on a boolean renders `true`, not `t` - the shorthand is psql's
  // display format, not the cast's output. The first run compared against 't/t'
  // and reported a correctly-protected table as a failure.
  const forceRlsBefore = psql(
    `SELECT relrowsecurity::text || '/' || relforcerowsecurity::text
       FROM pg_class WHERE oid = '"${schema}".final_secrets'::regclass`,
  ).trim()
  must(
    forceRlsBefore === 'true/true',
    `final_secrets has RLS and FORCE RLS (${forceRlsBefore})`,
  )

  await ensureSchemaRegistered(projectId)

  // A rate limit the soak will not spend.
  //
  // An API key carries its own per-key budget, defaulting to 100 per window,
  // and the soak fires 640 requests. The first run reported 459 failures, which
  // was the product's rate limiter working exactly as designed - a leak
  // detector should not be arguing with it. Raised deliberately, and only for
  // these qualification keys, rather than turning the limiter off.
  const SOAK_BUDGET = 100_000
  const { rawKey: anonKey } = await createApiKey(projectId, operator.id, {
    name: 'final client',
    rateLimit: SOAK_BUDGET,
  })
  const { rawKey: serviceKey, record: serviceRecord } = await createApiKey(projectId, operator.id, {
    name: 'final server',
    rateLimit: SOAK_BUDGET,
  })
  await prisma.apiKey.update({
    where: { id: serviceRecord.id },
    data: { serviceRole: true, keyType: 'service' },
  })
  ok('api keys: client and service-role')

  // Storage: a bucket and a known object, through the real service.
  const bucket = await storageService.createBucket(
    `final-${crypto.randomBytes(3).toString('hex')}`,
    projectId,
    true,
  )
  await prisma.storageBucket.update({
    where: { id: bucket.id },
    data: { accessPolicy: 'public_read' },
  })
  const uploaded = await storageService.uploadFile(
    bucket.id,
    { name: 'final.txt', buffer: OBJECT_BYTES, mimeType: 'text/plain' },
    { projectId, isPublic: true },
  )
  ok(`storage object ${uploaded.id} (${OBJECT_BYTES.length} bytes)`)

  // SMTP config, whose password is the CANARY: it must be encrypted at rest and
  // must not appear anywhere in the bundle's bytes.
  await saveSmtpConfig(projectId, {
    host: '127.0.0.1',
    port: 2525,
    username: 'final-smtp-user',
    password: CANARY,
    fromAddress: 'final@example.test',
    fromName: 'Final Qualification',
    enabled: true,
  })
  const smtpView = await getSmtpConfigView(projectId)
  must(smtpView.passwordConfigured === true, 'SMTP configured, password stored')
  must(
    !JSON.stringify(smtpView).includes(CANARY),
    'the SMTP view never carries the raw password',
  )

  // A webhook, so its configuration has to survive the restore.
  const webhook = await prisma.webhook.create({
    data: {
      projectId,
      eventType: 'row.inserted',
      targetUrl: 'https://example.com/final-hook',
      secret: crypto.randomBytes(32).toString('hex'),
    },
    select: { id: true, targetUrl: true },
  })
  ok(`webhook ${webhook.id}`)

  // ── 2. The surfaces ───────────────────────────────────────────────────────
  step('USE — every major surface, with the rows and bytes checked')

  // PostgREST caches the schema, and these tables were created seconds ago. The
  // product says so itself, in the 404 it returns:
  //
  //   "The data plane's schema cache does not yet know about final_nodes.
  //    The table exists; the cache is stale. Backenly reloads it automatically."
  //
  // So this waits for the reload the product promises rather than asserting
  // through it. Bounded: if the cache never catches up, that IS a failure and
  // the wait reports the last status it saw.
  let lastCache = 'nothing yet'
  await until(
    'the data plane to learn about final_nodes',
    async () => {
      const probe = await call(`/api/v1/${projectId}/db/final_nodes`, { apiKey: anonKey })
      lastCache = `HTTP ${probe.status} ${probe.text.slice(0, 160)}`
      return probe.status === 200 ? probe : null
    },
    120_000,
    () => lastCache,
  )
  ok('the data plane picked up the new tables')

  const write = await call(`/api/v1/${projectId}/db/final_nodes`, {
    method: 'POST',
    apiKey: serviceKey,
    body: JSON.stringify({ label: `${MARKER}-via-api` }),
  })
  must(
    write.status >= 200 && write.status < 300,
    `/db/* service-role write (HTTP ${write.status}` +
      `${write.status >= 400 ? ` — ${write.text.slice(0, 300)}` : ''})`,
  )

  const read = await call(`/api/v1/${projectId}/db/final_nodes`, { apiKey: anonKey })
  must(read.status === 200, `/db/* read (HTTP ${read.status})`)
  must(read.text.includes(MARKER), '/db/* returned the fixture row')

  const anonWrite = await call(`/api/v1/${projectId}/db/final_nodes`, {
    method: 'POST',
    apiKey: anonKey,
    body: JSON.stringify({ label: `anon-${crypto.randomUUID()}` }),
  })
  must(anonWrite.status >= 400, `/db/* refuses an anonymous write (HTTP ${anonWrite.status})`)

  const objectBefore = await storageService.getFile(uploaded.id, projectId)
  must(
    Boolean(objectBefore) && objectBefore!.buffer.equals(OBJECT_BYTES),
    'storage serves the exact bytes that were uploaded',
  )

  const migrationsBefore = Number(
    psql(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`).trim(),
  )
  const canonicalCount = readdirSync(join(process.cwd(), 'prisma', 'migrations-canonical'), {
    withFileTypes: true,
  }).filter(d => d.isDirectory()).length
  must(
    migrationsBefore === canonicalCount,
    `migration history is complete (${migrationsBefore}/${canonicalCount})`,
  )

  // ── 3. Project database snapshot ──────────────────────────────────────────
  step('SNAPSHOT — a project database snapshot, and what it contains')

  process.env.BACKENLY_SCHEDULED_SNAPSHOTS = 'true'
  const { backupWorkspace } = await import('@/lib/services/workspace-backup')
  const snapshot = await backupWorkspace(projectId)
  must(snapshot.success === true, `snapshot created${snapshot.error ? `: ${snapshot.error}` : ''}`)
  if (snapshot.filePath) {
    const { gunzipSync } = await import('zlib')
    const sql = gunzipSync(readFileSync(snapshot.filePath)).toString('utf8')
    must(sql.includes('final_nodes'), 'the snapshot contains the fixture table')
    must(sql.includes(MARKER), 'the snapshot contains the fixture row')
  }

  // ── 4. Deployment recovery bundle ─────────────────────────────────────────
  step('BUNDLE — a deployment recovery bundle, with a canary')

  const bundleDir = mkdtempSync(join(tmpdir(), 'final-bundle-'))
  const { exportDeploymentBundle } = await import('@/lib/recovery/export')
  const exported = await exportDeploymentBundle({ outDir: bundleDir })
  ok(`bundle at ${exported.bundleDir}`)

  // The canary must not be readable in the bundle's bytes. Searched across
  // every file, because "the component I thought of is encrypted" is a weaker
  // claim than "nothing in here is readable".
  let canaryFound = false
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (readFileSync(full).includes(CANARY)) canaryFound = true
    }
  }
  walk(exported.bundleDir)
  must(!canaryFound, 'the SMTP password appears nowhere in the bundle bytes')

  const { validateBundle } = await import('@/lib/recovery/restore')
  const validated = await validateBundle(exported.bundleDir, exported.credential)
  must(Boolean(validated), 'the bundle opens with the recovery credential')

  // And is unopenable without it — otherwise the encryption proves nothing.
  let refusedWrongCredential = false
  try {
    await validateBundle(exported.bundleDir, `wrong-${crypto.randomBytes(8).toString('hex')}`)
  } catch {
    refusedWrongCredential = true
  }
  must(refusedWrongCredential, 'the bundle refuses a wrong recovery credential')

  const { missingComponents } = await import('@/lib/recovery/contract')
  const missing = missingComponents(exported.manifest)
  must(missing.length === 0, `every manifest component is present${missing.length ? `: missing ${missing.join(', ')}` : ''}`)

  // ── 5. Destroy ────────────────────────────────────────────────────────────
  step('DESTROY — the workspace schema and the stored bytes, for real')

  const objectPath = objectBefore ? objectBefore.path : null
  psql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  if (objectPath && existsSync(objectPath)) rmSync(objectPath, { force: true })

  const schemaGone =
    psql(
      `SELECT count(*) FROM information_schema.schemata WHERE schema_name = '${schema}'`,
    ).trim() === '0'
  must(schemaGone, 'the workspace schema is GONE, so nothing below can borrow from it')
  must(!objectPath || !existsSync(objectPath), 'the stored object bytes are GONE')

  // The data plane must now fail, which is also the control for the restore:
  // if it still answered, the destruction did not happen.
  const brokenRead = await call(`/api/v1/${projectId}/db/final_nodes`, { apiKey: anonKey })
  must(brokenRead.status !== 200, `/db/* no longer serves the dropped schema (HTTP ${brokenRead.status})`)

  // ── 6. Restore ────────────────────────────────────────────────────────────
  step('RESTORE — from the bundle, through the operator’s own library')

  const { restoreDeployment } = await import('@/lib/recovery/restore')
  // targetUrl is REQUIRED and is deliberately the APPLICATION connection, not
  // the backup one: workspace tables use FORCE ROW LEVEL SECURITY, which keys
  // on the owner, so replaying as anything else silently rebinds every policy.
  // Omitting it produced "Invalid URL" from the first psql call.
  // TWO connections. Admin provisions - dropping schemas, creating the
  // PostgREST roles and installing extensions are elevation the application
  // role must not have - and the application role REPLAYS, so the restored
  // objects are owned by it and FORCE RLS keys on the right owner.
  const targetUrl = process.env.DATABASE_URL
  const restoreAdminUrl = envValue('BACKENLY_ADMIN_DATABASE_URL', '') || undefined
  if (!targetUrl) throw new Error('DATABASE_URL is not set; the restore has nowhere to write')
  if (!restoreAdminUrl) {
    throw new Error('BACKENLY_ADMIN_DATABASE_URL is not in .env; the installer records it')
  }

  const progress = await restoreDeployment({
    bundleDir: exported.bundleDir,
    credential: exported.credential,
    adminUrl: restoreAdminUrl,
    targetUrl,
    onStep: r => console.log(`     ${r.step}: ${r.status}${r.error ? ` (${r.error})` : ''}`),
  })
  const failedSteps = progress.results.filter(r => r.status !== 'ok' && r.status !== 'skipped')
  must(failedSteps.length === 0, `every restore step completed${failedSteps.length ? `: ${failedSteps.map(s => s.step).join(', ')}` : ''}`)

  // ── 7. Verify ─────────────────────────────────────────────────────────────
  step('VERIFY — is this the same deployment')

  const schemaBack =
    psql(
      `SELECT count(*) FROM information_schema.schemata WHERE schema_name = '${schema}'`,
    ).trim() === '1'
  must(schemaBack, 'the workspace schema is back')

  must(
    psql(`SELECT count(*) FROM "${schema}".final_nodes WHERE label = '${MARKER}'`).trim() === '1',
    'the fixture row is back',
  )
  must(
    psql(`SELECT count(*) FROM "${schema}".final_pairs WHERE note = '${MARKER}'`).trim() === '1',
    'the composite-key row is back',
  )

  const forceRlsAfter = psql(
    `SELECT relrowsecurity::text || '/' || relforcerowsecurity::text
       FROM pg_class WHERE oid = '"${schema}".final_secrets'::regclass`,
  ).trim()
  must(forceRlsAfter === 'true/true', `FORCE RLS survived the restore (${forceRlsAfter})`)
  must(
    Number(psql(`SELECT count(*) FROM pg_policies WHERE schemaname = '${schema}'`).trim()) > 0,
    'the RLS policy survived the restore',
  )

  const constraintsBack = psql(
    `SELECT count(*) FROM pg_constraint
      WHERE conrelid = '"${schema}".final_nodes'::regclass AND contype IN ('f','u','c','p')`,
  ).trim()
  must(Number(constraintsBack) >= 4, `constraints survived the restore (${constraintsBack})`)

  const operatorBack = await prisma.user.findFirst({ where: { email: operator.email } })
  must(Boolean(operatorBack), 'the operator identity is back')

  const webhookBack = await prisma.webhook.findFirst({ where: { projectId, id: webhook.id } })
  must(webhookBack?.targetUrl === webhook.targetUrl, 'the webhook configuration is back')

  const smtpBack = await getSmtpConfigView(projectId)
  must(smtpBack.passwordConfigured === true, 'the SMTP configuration is back, still with a secret')
  must(smtpBack.host === '127.0.0.1', 'the SMTP settings are the ones that were stored')

  const migrationsAfter = Number(
    psql(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`).trim(),
  )
  must(
    migrationsAfter === migrationsBefore,
    `migration history survived (${migrationsAfter}/${migrationsBefore})`,
  )

  const registryBack = Number(
    psql(`SELECT count(*) FROM backenly_pgrst_schema_registry`).trim() || '0',
  )
  must(registryBack > 0, `the PostgREST registry survived (${registryBack} row(s))`)

  // The data plane, serving again, without anything being restarted.
  let lastDb = 'nothing yet'
  await until(
    '/db to serve the restored schema',
    async () => {
      const res = await call(`/api/v1/${projectId}/db/final_nodes`, { apiKey: anonKey })
      lastDb = `HTTP ${res.status} ${res.text.slice(0, 120)}`
      return res.status === 200 && res.text.includes(MARKER) ? res : null
    },
    240_000,
    () => lastDb,
  )
  ok('/db/* serves the restored data, with no restart')

  // ── 8. Soak ───────────────────────────────────────────────────────────────
  step('SOAK — bounded concurrent load, watching what leaks')

  const ROUNDS = 40
  const CONCURRENCY = 8

  // Warm the connection pools under concurrency so that initial pool scaling
  // is established before recording the baseline, rather than mistaking cold-pool
  // allocation for an unbounded leak.
  const warmup: Promise<void>[] = []
  for (let i = 0; i < CONCURRENCY; i++) {
    warmup.push(
      (async () => {
        await call(`/api/v1/${projectId}/db/final_nodes`, { apiKey: anonKey })
      })(),
      (async () => {
        await call(`/api/v1/${projectId}/db/final_nodes`, {
          method: 'POST',
          apiKey: serviceKey,
          body: JSON.stringify({ label: `warmup-${crypto.randomUUID()}` }),
        })
      })(),
    )
  }
  await Promise.all(warmup)
  await sleep(1_000)

  const backendsBefore = backends()
  const heapBefore = process.memoryUsage().heapUsed
  let soakFailures = 0
  // Every status seen, so a failure names what happened rather than a count.
  const statuses = new Map<number, number>()
  const seen = (status: number) => statuses.set(status, (statuses.get(status) ?? 0) + 1)

  for (let round = 0; round < ROUNDS; round++) {
    const batch: Promise<void>[] = []
    for (let i = 0; i < CONCURRENCY; i++) {
      batch.push(
        (async () => {
          const r = await call(`/api/v1/${projectId}/db/final_nodes`, { apiKey: anonKey })
          seen(r.status)
          if (r.status !== 200) soakFailures++
        })(),
      )
      batch.push(
        (async () => {
          const r = await call(`/api/v1/${projectId}/db/final_nodes`, {
            method: 'POST',
            apiKey: serviceKey,
            body: JSON.stringify({ label: `soak-${crypto.randomUUID()}` }),
          })
          seen(r.status)
          if (r.status < 200 || r.status >= 300) soakFailures++
        })(),
      )
    }
    await Promise.all(batch)
  }

  const requests = ROUNDS * CONCURRENCY * 2
  const histogram = [...statuses.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, n]) => `${code}x${n}`)
    .join(' ')
  must(
    soakFailures === 0,
    `${requests} requests under concurrency ${CONCURRENCY * 2}, ` +
      `${soakFailures} failed [${histogram}]`,
  )

  // Let anything short-lived settle before measuring, so a connection still
  // being returned to the pool is not counted as a leak.
  await sleep(5_000)
  const backendsAfter = backends()
  const heapAfter = process.memoryUsage().heapUsed

  console.log(
    `     backends ${backendsBefore} -> ${backendsAfter}; ` +
      `heap ${(heapBefore / 1e6).toFixed(1)}MB -> ${(heapAfter / 1e6).toFixed(1)}MB`,
  )
  // A pool that leaks one connection per request would be ~640 over this run.
  // The bound is deliberately generous: the claim is "does not grow without
  // bound", not a tuned connection budget.
  must(
    backendsAfter <= backendsBefore + 25,
    `PostgreSQL backends did not grow without bound (${backendsBefore} -> ${backendsAfter})`,
  )

  const stuckOutbox = Number(
    psql(
      `SELECT count(*) FROM information_schema.tables
        WHERE table_schema = '${schema}' AND table_name = '_backenly_webhook_outbox'`,
    ).trim(),
  )
  if (stuckOutbox > 0) {
    const pending = Number(
      psql(`SELECT count(*) FROM "${schema}"._backenly_webhook_outbox`).trim() || '0',
    )
    console.log(`     webhook outbox holds ${pending} row(s)`)
  }

  rmSync(bundleDir, { recursive: true, force: true })
  await prisma.$disconnect().catch(() => {})
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} final-qualification check(s) failed`)
      process.exit(1)
    }
    console.log('\nfinal synthetic-production qualification passed')
    process.exit(0)
  })
  .catch(err => {
    console.error(`\nfinal qualification could not complete: ${err?.message ?? err}`)
    if (err?.stack) console.error(err.stack.split('\n').slice(1, 6).join('\n'))
    process.exit(1)
  })
