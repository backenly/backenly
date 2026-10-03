/**
 * THE SELF-HOST SCHEMA STEP
 * =========================
 *
 * Replaces `prisma db push` for both cases, because `db push` was only ever
 * correct for one of them and silently did nothing for the other.
 *
 *   empty database    canonical `migrate deploy`. The install is under
 *                     migration control from birth, so every future upgrade is
 *                     an ordinary deploy.
 *
 *   legacy install    one-time adoption (lib/selfhost/migration-adoption.ts),
 *                     then deploy. Afterwards it is indistinguishable from an
 *                     install born under migrations.
 *
 *   tracked install   deploy, and nothing else, for ever.
 *
 * ── Why not db push, even on an empty database ──────────────────────────────
 *
 * `db push` records no history, so a database it created cannot be upgraded
 * later without manufacturing a story about what had already run. Fixing the
 * upgrade path while leaving `db push` on fresh installs would fix this
 * release's problem and recreate it for the next one.
 *
 * It is also the statement that cannot be run twice here: the PostgREST
 * registry and its event triggers are created by SQL rather than by Prisma, so
 * push sees objects its schema does not describe and sets out to drop them.
 *
 * ── Why not migrate diff ────────────────────────────────────────────────────
 *
 * For the same reason. `migrate diff` would generate a script that drops the
 * registry and the event triggers, because Prisma deliberately does not model
 * every PostgreSQL object Backenly relies on. It is an analysis aid, never the
 * thing that decides what to remove from a live deployment.
 *
 * ── Backenly's own objects are verified afterwards ──────────────────────────
 *
 * A migration run that left the schema correct and the PostgREST registry gone
 * would pass every Prisma check and break the data plane. So the objects Prisma
 * does not know about are checked explicitly, after.
 */

import { execFileSync } from 'child_process'
import type { Client } from 'pg'

import { planMigrations, type MigrationPlan } from './migration-adoption'

export class MigrationRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationRefused'
  }
}

/**
 * A migration RAN and failed, as opposed to a plan that was refused.
 *
 * It carries Prisma's own output, and that is the entire point of it existing.
 * `execFileSync` throws an Error whose `message` is only
 *
 *   Command failed: <node> <prisma cli> migrate deploy --schema <temp path>
 *
 * while everything an operator needs - the P3018 code, WHICH migration failed,
 * the PostgreSQL error underneath it, and the link explaining how to recover -
 * is on `stderr`, which was being discarded. An upgrade that fails at 3am and
 * says nothing but "Command failed" is an upgrade nobody can act on, and this
 * is the third time in this programme a diagnostic has hidden its own cause.
 */
export class MigrationFailed extends Error {
  readonly stdout: string
  readonly stderr: string
  /** The migration Prisma named, when its output named one. */
  readonly migration: string | null

  constructor(stdout: string, stderr: string) {
    const named = /Migration name:\s*(\S+)/.exec(stderr)
    const code = /Error:\s*(P\d{4})/.exec(stderr)
    super(
      `The migration run failed` +
        (named ? ` on ${named[1]}` : '') +
        (code ? ` (${code[1]})` : '') +
        `. Prisma reported:

${stderr.trim() || stdout.trim() || '(no output)'}`,
    )
    this.name = 'MigrationFailed'
    this.stdout = stdout
    this.stderr = stderr
    this.migration = named ? named[1] : null
  }
}

export interface MigrationReport {
  plan: MigrationPlan
  /** Migrations recorded as already applied, without running them. */
  adopted: string[]
  /** Migrations actually executed by `migrate deploy`. */
  deployed: string[]
  /** Non-Prisma objects checked afterwards, and whether they survived. */
  supportObjects: Array<{ name: string; present: boolean }>
}

/**
 * PostgreSQL objects Backenly creates outside Prisma.
 *
 * Checked after a migration run because Prisma's own verification cannot see
 * them, and a deploy that removed one would look completely successful.
 *
 * Absence is only a FAILURE on a database that had them before. A fresh install
 * has not created them yet — they are installed by the SQL step that follows —
 * so the caller passes what it expects rather than this asserting blindly.
 */
export const SUPPORT_OBJECTS = [
  { name: 'backenly_pgrst_schema_registry', kind: 'table' as const },
  { name: 'backenly_pgrst_ddl_sync', kind: 'event_trigger' as const },
  { name: 'backenly_pgrst_schema_create', kind: 'event_trigger' as const },
  { name: 'backenly_pgrst_schema_drop', kind: 'event_trigger' as const },
]

export async function checkSupportObjects(
  client: Client,
): Promise<Array<{ name: string; present: boolean }>> {
  const out: Array<{ name: string; present: boolean }> = []
  for (const obj of SUPPORT_OBJECTS) {
    if (obj.kind === 'table') {
      const { rows } = await client.query<{ present: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`public.${obj.name}`],
      )
      out.push({ name: obj.name, present: rows[0]?.present === true })
    } else {
      const { rows } = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = $1) AS present`,
        [obj.name],
      )
      out.push({ name: obj.name, present: rows[0]?.present === true })
    }
  }
  return out
}

/**
 * Run the Prisma CLI without going through a shell.
 *
 * Neither `npx` + `shell: true` nor `npx.cmd` works here. The shell form
 * concatenates arguments without escaping them, which Node deprecated for the
 * obvious reason; and Node refuses to execFile a `.cmd` without a shell at all
 * (EINVAL), which is the mitigation for CVE-2024-27980.
 *
 * So the CLI's own entrypoint is resolved and handed to node directly. argv
 * stays intact, there is no shell to re-parse a schema path containing a space,
 * and it behaves the same on every platform.
 */
function prisma(args: string[], schemaPath: string, databaseUrl: string): string {
  const cli = require.resolve('prisma/build/index.js')
  try {
    return execFileSync(process.execPath, [cli, ...args, '--schema', schemaPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
    })
  } catch (err: any) {
    // Prisma explains itself on stderr and exits non-zero; execFileSync keeps
    // that text on the error and puts none of it in `message`. Re-thrown with
    // the output attached so the operator reads Prisma's explanation instead
    // of the command line that produced it.
    throw new MigrationFailed(String(err?.stdout ?? ''), String(err?.stderr ?? ''))
  }
}

/**
 * Bring a database to the current canonical schema.
 *
 * `log` is injected so the installer can print in its own voice and a test can
 * capture without a global.
 */
export async function runSelfHostMigrations(opts: {
  root: string
  client: Client
  databaseUrl: string
  /** Assembles schema + canonical migrations into a temp dir. */
  assemble: (root: string) => { schemaPath: string; migrationsDir: string; dispose: () => void }
  log?: (message: string) => void
}): Promise<MigrationReport> {
  const { root, client, databaseUrl, assemble } = opts
  const log = opts.log ?? (() => {})

  // ── Decide everything first ───────────────────────────────────────────────
  const plan = await planMigrations(root, client)
  if (plan.refusal) {
    // Nothing has been written. That is the guarantee, and it is why planning is
    // a separate step from acting.
    throw new MigrationRefused(plan.refusal)
  }

  // What Backenly's own objects looked like BEFORE, so their absence afterwards
  // can be told apart from their never having existed.
  const supportBefore = await checkSupportObjects(client)

  const workspace = assemble(root)
  try {
    if (plan.adopt.length > 0) {
      log(`adopting ${plan.adopt.length} migration(s) this database already satisfies`)
      for (const id of plan.adopt) {
        // --applied records it as run WITHOUT running it, which is correct
        // precisely because its postconditions were verified in full first.
        prisma(['migrate', 'resolve', '--applied', id], workspace.schemaPath, databaseUrl)
      }
    }

    if (plan.deploy.length > 0) {
      log(`deploying ${plan.deploy.length} migration(s)`)
    }
    // Always run deploy, even with nothing pending: it is the step that creates
    // `_prisma_migrations` on an empty database, and a no-op deploy is the
    // cheapest possible confirmation that the history is consistent.
    prisma(['migrate', 'deploy'], workspace.schemaPath, databaseUrl)
  } finally {
    workspace.dispose()
  }

  // ── Verify what Prisma cannot see ─────────────────────────────────────────
  const supportAfter = await checkSupportObjects(client)
  const lost = supportAfter.filter((obj, i) => supportBefore[i].present && !obj.present)
  if (lost.length > 0) {
    throw new Error(
      `The migration run removed PostgreSQL objects Prisma does not model: ` +
        `${lost.map(o => o.name).join(', ')}. The data plane reads these, so the ` +
        `deployment is not usable until they are restored.`,
    )
  }

  return {
    plan,
    adopted: plan.adopt,
    deployed: plan.deploy,
    supportObjects: supportAfter,
  }
}
