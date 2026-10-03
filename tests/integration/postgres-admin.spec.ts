/**
 * EXTENSIONS AND TYPES, AGAINST A REAL POSTGRESQL CATALOG
 * ======================================================
 *
 * The last two REAL_GAP rows. Both are about admin surfaces where the only
 * meaningful test is what the server actually does: whether an extension is
 * trusted, whether a role may install it, whether a type has dependents, and
 * what `ALTER TYPE` will and will not accept are all properties of PostgreSQL,
 * not of this code.
 *
 * ── The privilege test uses a REAL non-superuser role ───────────────────────
 *
 * The interesting claim about extensions is "a role that is not superuser can
 * install the trusted ones and not the others". A test running as superuser
 * proves nothing about that, and the developer database here connects as
 * `backenly_user`, which IS superuser. So the suite creates a throwaway
 * non-superuser role, grants it CREATE on the database, and does the work under
 * `SET ROLE` — which really does drop superuser for the session.
 *
 * Without that, every install would succeed and the suite would report the
 * feature working while saying nothing about the role split it depends on.
 */

import { Client } from 'pg'
import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'

import {
  ALLOWED_EXTENSIONS,
  isAllowedExtension,
  installExtension,
  listExtensions,
  resetExtensionPool,
} from '@/lib/services/extensions'
import {
  addEnumValue,
  createDomain,
  createEnum,
  dropType,
  explainDropValueUnsupported,
  listTypes,
  renameEnumValue,
  TypeValidationError,
} from '@/lib/services/enums'

const prisma = new PrismaClient()

let ownerId: string
let projectId: string
let schema: string

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `pgadmin-${crypto.randomBytes(5).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'Postgres Admin Suite',
    },
    select: { id: true },
  })
  ownerId = owner.id

  projectId = (
    await prisma.project.create({ data: { name: 'pg-admin', userId: ownerId }, select: { id: true } })
  ).id
  schema = `workspace_${projectId}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}, 180_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await resetExtensionPool()
  await prisma.$disconnect()
}, 180_000)

// ── Extensions ───────────────────────────────────────────────────────────────

describe('the extension allowlist is the boundary', () => {
  it('refuses a name that is not on it, before composing any SQL', async () => {
    for (const attempt of [
      'pg_read_server_files',
      'plpython3u',
      'pgcrypto; DROP TABLE users',
      '"pgcrypto"',
      '',
    ]) {
      expect(isAllowedExtension(attempt)).toBe(false)

      const outcome = await installExtension(attempt)
      expect(outcome.ok).toBe(false)
      expect(outcome.code).toBe('NOT_ALLOWED')
    }

    // CONTROL: a name ON the list is recognised, so the refusals above are
    // about membership and not about the check rejecting everything.
    expect(isAllowedExtension('pgcrypto')).toBe(true)
  }, 60_000)

  it('reports what the SERVER says about each allowlisted extension', async () => {
    const listed = await listExtensions()
    expect(listed).toHaveLength(ALLOWED_EXTENSIONS.length)

    // Every entry answered from the live catalog rather than from this file's
    // expectations. `trusted` in particular: the allowlist records what we
    // BELIEVE, and the catalog records what CREATE EXTENSION will obey.
    const pgcrypto = listed.find(e => e.name === 'pgcrypto')!
    expect(pgcrypto.available).toBe(true)
    expect(pgcrypto.trusted).toBe(true)
    expect(pgcrypto.defaultVersion).toBeTruthy()

    // A non-trusted one is reported as such, with a reason rather than a button.
    const stat = listed.find(e => e.name === 'pg_stat_statements')!
    expect(stat.trusted).toBe(false)
    if (!stat.installed) {
      expect(stat.installable).toBe(false)
      expect(stat.blockedReason).toMatch(/superuser/i)
    }
  }, 60_000)

  it('never offers to install something the catalog says is unavailable', async () => {
    const listed = await listExtensions()
    for (const entry of listed) {
      if (!entry.available) {
        expect(entry.installable).toBe(false)
        expect(entry.blockedReason).toBeTruthy()
      }
    }
  }, 60_000)
})

describe('what a NON-SUPERUSER role may actually install', () => {
  let client: Client
  let role: string

  beforeAll(async () => {
    role = `ext_probe_${crypto.randomBytes(4).toString('hex')}`
    client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()

    const db = (await client.query('SELECT current_database() AS d')).rows[0].d
    await client.query(`CREATE ROLE ${role} NOSUPERUSER LOGIN PASSWORD 'probe-only'`)
    // CREATE on the database is exactly the privilege PostgreSQL 13+ requires
    // for a trusted extension, and nothing more.
    await client.query(`GRANT CREATE ON DATABASE "${db}" TO ${role}`)
  }, 120_000)

  afterAll(async () => {
    if (client) {
      const db = (await client.query('SELECT current_database() AS d')).rows[0].d
      await client.query(`REVOKE CREATE ON DATABASE "${db}" FROM ${role}`).catch(() => {})
      await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
      await client.end()
    }
  }, 120_000)

  /** Attempt an install as the throwaway role, and always roll back. */
  async function attemptAs(name: string): Promise<{ ok: boolean; message: string }> {
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${role}`)
      await client.query(`CREATE EXTENSION "${name.replace(/"/g, '""')}"`)
      await client.query('ROLLBACK')
      return { ok: true, message: '' }
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {})
      return { ok: false, message: String(err?.message ?? err) }
    }
  }

  it('really has dropped superuser under SET ROLE', async () => {
    // The control for this entire describe. Without it, a "trusted installs,
    // untrusted does not" result could simply be two coincidences.
    await client.query('BEGIN')
    await client.query(`SET LOCAL ROLE ${role}`)
    const who = await client.query(
      `SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`,
    )
    await client.query('ROLLBACK')

    expect(who.rows[0].u).toBe(role)
    expect(who.rows[0].super).toBe(false)
  }, 60_000)

  it('installs a TRUSTED extension, and is refused a non-trusted one', async () => {
    const listed = await listExtensions()

    const trusted = listed.find(e => e.trusted === true && e.available && !e.installed)
    const untrusted = listed.find(e => e.trusted === false && e.available && !e.installed)

    // Stated rather than skipped. If the server has every trusted extension
    // already installed there is nothing to prove here, and saying so beats a
    // green tick over an assertion that never ran.
    if (!trusted) {
      throw new Error(
        'every trusted allowlisted extension is already installed on this server, so the ' +
          'non-superuser install claim cannot be tested',
      )
    }

    const allowed = await attemptAs(trusted.name)
    expect(allowed.ok).toBe(true)

    if (untrusted) {
      const refused = await attemptAs(untrusted.name)
      expect(refused.ok).toBe(false)
      // PostgreSQL's own refusal, which is the point: this is the database
      // enforcing the role split, not Backenly deciding to be careful.
      expect(refused.message).toMatch(/permission denied|must be superuser/i)
    }
  }, 120_000)

  it('agrees with what listExtensions() reports as installable', async () => {
    // The surface's claim and the database's behaviour have to be the same
    // claim. A dashboard offering a button that PostgreSQL refuses is the
    // "looks built" failure the register exists to catch.
    const listed = await listExtensions()
    for (const entry of listed) {
      if (!entry.available || entry.installed) continue
      const actual = await attemptAs(entry.name)
      // jest's expect takes no message argument (that is Playwright's), so the
      // detail goes in a throw. Which extension disagreed is the entire value
      // of this assertion.
      if (entry.installable !== actual.ok) {
        throw new Error(
          `${entry.name}: the surface says installable=${entry.installable}, ` +
            `the database says ${actual.ok}${actual.message ? ` (${actual.message})` : ''}`,
        )
      }
    }
  }, 180_000)
})

// ── Enums and domains ────────────────────────────────────────────────────────

describe('enum types', () => {
  it('creates one, lists it, and appends to it', async () => {
    const name = `status_${crypto.randomBytes(3).toString('hex')}`
    await createEnum(projectId, name, ['draft', 'published'])

    let found = (await listTypes(projectId)).enums.find(e => e.name === name)
    expect(found).toBeDefined()
    expect(found!.values).toEqual(['draft', 'published'])
    expect(found!.usedBy).toEqual([])

    await addEnumValue(projectId, name, 'archived')
    found = (await listTypes(projectId)).enums.find(e => e.name === name)
    // Appended, and in sort order, which is what enumsortorder guarantees.
    expect(found!.values).toEqual(['draft', 'published', 'archived'])

    // Re-adding is not an error, so a retried request is safe.
    await addEnumValue(projectId, name, 'archived')
    found = (await listTypes(projectId)).enums.find(e => e.name === name)
    expect(found!.values).toEqual(['draft', 'published', 'archived'])
  }, 60_000)

  it('renames a value, and existing rows follow', async () => {
    const name = `state_${crypto.randomBytes(3).toString('hex')}`
    const table = `t_${crypto.randomBytes(3).toString('hex')}`
    await createEnum(projectId, name, ['on', 'off'])
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."${table}" (id serial PRIMARY KEY, s "${schema}"."${name}")`,
    )
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."${table}" (s) VALUES ('on')`)

    await renameEnumValue(projectId, name, 'on', 'enabled')

    // The row followed, because it stores the OID rather than the label. This is
    // the fact that makes a rename safe for DATA and unsafe for application code
    // matching the old string, which is why the surface surfaces dependents.
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT s::text AS s FROM "${schema}"."${table}"`,
    )) as Array<{ s: string }>
    expect(rows[0].s).toBe('enabled')
  }, 60_000)

  it('reports which columns use a type', async () => {
    const name = `used_${crypto.randomBytes(3).toString('hex')}`
    const table = `u_${crypto.randomBytes(3).toString('hex')}`
    await createEnum(projectId, name, ['a', 'b'])
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."${table}" (id serial PRIMARY KEY, kind "${schema}"."${name}")`,
    )

    const found = (await listTypes(projectId)).enums.find(e => e.name === name)!
    expect(found.usedBy).toEqual([`${table}.kind`])
  }, 60_000)

  it('refuses names PostgreSQL would fold or quote into something else', async () => {
    for (const bad of ['Status', 'my type', '1status', 'droptable;--', 'a'.repeat(64)]) {
      await expect(createEnum(projectId, bad, ['x'])).rejects.toBeInstanceOf(TypeValidationError)
    }
    // CONTROL: a well-formed name is accepted.
    const ok = `fine_${crypto.randomBytes(3).toString('hex')}`
    await expect(createEnum(projectId, ok, ['x'])).resolves.toBeUndefined()
  }, 60_000)

  it('refuses an empty value list and duplicate values', async () => {
    const name = `dup_${crypto.randomBytes(3).toString('hex')}`
    await expect(createEnum(projectId, name, [])).rejects.toBeInstanceOf(TypeValidationError)
    await expect(createEnum(projectId, name, ['a', 'a'])).rejects.toBeInstanceOf(TypeValidationError)
  }, 60_000)

  it('stores a value containing a quote without breaking the statement', async () => {
    // The literal-escaping path. A label is a VALUE, not an identifier, and
    // this is the case that would end a statement early if it were not escaped.
    const name = `quoted_${crypto.randomBytes(3).toString('hex')}`
    await createEnum(projectId, name, ["it's", 'plain'])

    const found = (await listTypes(projectId)).enums.find(e => e.name === name)!
    expect(found.values).toEqual(["it's", 'plain'])
  }, 60_000)

  it('explains that removing a value is not something PostgreSQL can do', () => {
    const message = explainDropValueUnsupported('status', 'draft')
    expect(message).toMatch(/no ALTER TYPE \.\.\. DROP VALUE/i)
    // It says what the real procedure is, rather than only refusing.
    expect(message).toMatch(/rewrites data|converting every column/i)
  })
})

describe('domains', () => {
  it('creates one with a CHECK, and reports its shape', async () => {
    const name = `email_${crypto.randomBytes(3).toString('hex')}`
    await createDomain(projectId, {
      name,
      baseType: 'text',
      notNull: true,
      check: "VALUE ~ '^[^@]+@[^@]+$'",
    })

    const found = (await listTypes(projectId)).domains.find(d => d.name === name)!
    expect(found.baseType).toBe('text')
    expect(found.notNull).toBe(true)
    expect(found.constraints.join(' ')).toMatch(/CHECK/i)
  }, 60_000)

  it('enforces the CHECK on real inserts', async () => {
    const name = `positive_${crypto.randomBytes(3).toString('hex')}`
    const table = `p_${crypto.randomBytes(3).toString('hex')}`
    await createDomain(projectId, { name, baseType: 'integer', check: 'VALUE > 0' })
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."${table}" (id serial PRIMARY KEY, n "${schema}"."${name}")`,
    )

    // CONTROL: a conforming value is accepted, so the rejection below is the
    // constraint and not the table being broken.
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."${table}" (n) VALUES (5)`)
    await expect(
      prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."${table}" (n) VALUES (-1)`),
    ).rejects.toThrow()
  }, 60_000)

  it('refuses a base type that is not on the allowlist', async () => {
    await expect(
      createDomain(projectId, { name: `bad_${crypto.randomBytes(3).toString('hex')}`, baseType: 'text; DROP TABLE x' }),
    ).rejects.toBeInstanceOf(TypeValidationError)
    await expect(
      createDomain(projectId, { name: `bad2_${crypto.randomBytes(3).toString('hex')}`, baseType: 'pg_catalog.oid' }),
    ).rejects.toBeInstanceOf(TypeValidationError)
  }, 60_000)

  it('refuses a CHECK that does not mention VALUE', async () => {
    // Without VALUE it is not a constraint on this domain, it is an arbitrary
    // predicate — which is the thing this surface is deliberately not.
    await expect(
      createDomain(projectId, {
        name: `novalue_${crypto.randomBytes(3).toString('hex')}`,
        baseType: 'integer',
        check: '1 = 1',
      }),
    ).rejects.toBeInstanceOf(TypeValidationError)
  }, 60_000)
})

describe('dropping a type', () => {
  it('refuses while a column still uses it, and names the column', async () => {
    const name = `inuse_${crypto.randomBytes(3).toString('hex')}`
    const table = `d_${crypto.randomBytes(3).toString('hex')}`
    await createEnum(projectId, name, ['a'])
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."${table}" (id serial PRIMARY KEY, kind "${schema}"."${name}")`,
    )

    const refused = await dropType(projectId, name)
    expect(refused.dropped).toBe(false)
    expect(refused.usedBy).toEqual([`${table}.kind`])

    // Still there, because a refusal that dropped it anyway would be worse than
    // no refusal.
    expect((await listTypes(projectId)).enums.some(e => e.name === name)).toBe(true)
  }, 60_000)

  it('drops one that nothing uses', async () => {
    const name = `unused_${crypto.randomBytes(3).toString('hex')}`
    await createEnum(projectId, name, ['a'])

    // CONTROL: it exists first.
    expect((await listTypes(projectId)).enums.some(e => e.name === name)).toBe(true)

    const result = await dropType(projectId, name)
    expect(result.dropped).toBe(true)
    expect((await listTypes(projectId)).enums.some(e => e.name === name)).toBe(false)
  }, 60_000)

  it('reports a type that does not exist rather than throwing', async () => {
    const result = await dropType(projectId, `missing_${crypto.randomBytes(3).toString('hex')}`)
    expect(result.dropped).toBe(false)
    expect(result.usedBy).toEqual([])
  }, 60_000)
})
