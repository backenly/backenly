/**
 * A foreign key is installed exactly as the migration declares it.
 *
 * apply_migration used to keep only the referenced table and let the executor
 * choose the rest, so
 *
 *   ALTER TABLE enrolments ADD CONSTRAINT enrolments_clan_fkey
 *     FOREIGN KEY (clan_id) REFERENCES guilds(id) ON DELETE SET NULL
 *
 * installed `fk_enrolments_clan … ON DELETE CASCADE`, and deleting a guild
 * deleted every enrolment in it. Each case reads the installed key back from the
 * catalog, and the delete cases check what PostgreSQL then does to the rows.
 *
 * Real PostgreSQL, real migration dispatch and executor; only the model call is
 * stubbed, and it must never be reached.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'

jest.mock('@/lib/ai/llm/chat', () => ({
  ...jest.requireActual('@/lib/ai/llm/chat'),
  chat: jest.fn(),
}))
import { chat } from '@/lib/ai/llm/chat'

let ownerId: string
let projectId: string
let schema: string
const originalEngineMode = process.env.ENGINE_MODE
const originalEdition = process.env.BACKENLY_EDITION

const ACTIONS: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }

const migrate = (sql: string) => applyMigrationToMain(projectId, ownerId, sql, { workspaceSchema: schema, agentSurface: true })

/** Every foreign key on table.column, as the catalog has it. */
async function foreignKeys(table: string, column: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; del: string; upd: string; ref_table: string; ref_column: string }>>(
    `SELECT con.conname AS name, con.confdeltype::text AS del, con.confupdtype::text AS upd,
            ref.relname AS ref_table, refatt.attname AS ref_column
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       JOIN pg_class ref ON ref.oid = con.confrelid
       JOIN pg_attribute refatt ON refatt.attrelid = con.confrelid AND refatt.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND ns.nspname = $1 AND rel.relname = $2 AND att.attname = $3`,
    schema, table, column,
  )
  return rows.map((r) => ({ name: r.name, onDelete: ACTIONS[r.del], onUpdate: ACTIONS[r.upd], references: `${r.ref_table}(${r.ref_column})` }))
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`, schema, table,
  )
  return rows[0].n > 0
}

const T = (table: string) => `"${schema}"."${table}"`
async function newGuild(name: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO ${T('guilds')} (name) VALUES ($1) RETURNING id`, name)
  return rows[0].id
}

beforeAll(async () => {
  process.env.ENGINE_MODE = 'runtime'
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `foreign-keys-${crypto.randomUUID()}@example.test`, password: 'test-only-hash', name: 'foreign keys' },
  })).id
  const project = await createProvisionedProject({ name: 'foreign-keys', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
  const created = await migrate('CREATE TABLE guilds (name text NOT NULL)')
  expect(created.ok).toBe(true)
}, 120_000)

afterAll(async () => {
  expect(jest.mocked(chat)).not.toHaveBeenCalled()
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } })
    await prisma.user.delete({ where: { id: ownerId } })
  }
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
}, 60_000)

describe('a declared foreign key is installed as written', () => {
  it('ADD CONSTRAINT … ON DELETE SET NULL keeps its name and action, and a deleted guild keeps its enrolments', async () => {
    expect((await migrate('CREATE TABLE enrolments (clan_id uuid, player text NOT NULL)')).ok).toBe(true)
    const added = await migrate(
      'ALTER TABLE enrolments ADD CONSTRAINT enrolments_clan_fkey FOREIGN KEY (clan_id) REFERENCES guilds(id) ON DELETE SET NULL',
    )
    expect(added.ok).toBe(true)
    expect(await foreignKeys('enrolments', 'clan_id')).toEqual([
      { name: 'enrolments_clan_fkey', onDelete: 'SET NULL', onUpdate: 'NO ACTION', references: 'guilds(id)' },
    ])

    const guild = await newGuild('north')
    await prisma.$executeRawUnsafe(`INSERT INTO ${T('enrolments')} (clan_id, player) VALUES ($1::uuid, 'ada')`, guild)
    await prisma.$executeRawUnsafe(`DELETE FROM ${T('guilds')} WHERE id = $1::uuid`, guild)
    const left = await prisma.$queryRawUnsafe<Array<{ player: string; clan_id: string | null }>>(`SELECT player, clan_id FROM ${T('enrolments')}`)
    expect(left).toEqual([{ player: 'ada', clan_id: null }])
  }, 60_000)

  it('an inline REFERENCES keeps both actions, whatever the column\'s nullability', async () => {
    // NOT NULL used to mean ON DELETE CASCADE, whatever the migration said.
    const made = await migrate(
      'CREATE TABLE members (guild_id uuid NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT ON UPDATE CASCADE, nick text)',
    )
    expect(made.ok).toBe(true)
    expect(await foreignKeys('members', 'guild_id')).toEqual([
      { name: 'members_guild_id_fkey', onDelete: 'RESTRICT', onUpdate: 'CASCADE', references: 'guilds(id)' },
    ])

    const guild = await newGuild('south')
    await prisma.$executeRawUnsafe(`INSERT INTO ${T('members')} (guild_id, nick) VALUES ($1::uuid, 'grace')`, guild)
    await expect(prisma.$executeRawUnsafe(`DELETE FROM ${T('guilds')} WHERE id = $1::uuid`, guild)).rejects.toThrow()
    const kept = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${T('members')} WHERE guild_id = $1::uuid`, guild)
    expect(kept[0].n).toBe(1)
  }, 60_000)

  it('a REFERENCES with no actions is NO ACTION, as in SQL: a guild with posts cannot be deleted from under them', async () => {
    // A nullable column used to get ON DELETE SET NULL here, a NOT NULL one CASCADE.
    expect((await migrate('CREATE TABLE posts (guild_id uuid REFERENCES guilds(id), title text)')).ok).toBe(true)
    expect(await foreignKeys('posts', 'guild_id')).toEqual([
      { name: 'posts_guild_id_fkey', onDelete: 'NO ACTION', onUpdate: 'NO ACTION', references: 'guilds(id)' },
    ])

    const guild = await newGuild('east')
    await prisma.$executeRawUnsafe(`INSERT INTO ${T('posts')} (guild_id, title) VALUES ($1::uuid, 'hello')`, guild)
    await expect(prisma.$executeRawUnsafe(`DELETE FROM ${T('guilds')} WHERE id = $1::uuid`, guild)).rejects.toThrow()
    const kept = await prisma.$queryRawUnsafe<Array<{ title: string }>>(`SELECT title FROM ${T('posts')} WHERE guild_id = $1::uuid`, guild)
    expect(kept).toEqual([{ title: 'hello' }])
  }, 60_000)

  it('a REFERENCES naming no column references the primary key, resolved by PostgreSQL', async () => {
    expect((await migrate('CREATE TABLE notes (guild_id uuid REFERENCES guilds ON DELETE CASCADE, body text)')).ok).toBe(true)
    expect(await foreignKeys('notes', 'guild_id')).toEqual([
      { name: 'notes_guild_id_fkey', onDelete: 'CASCADE', onUpdate: 'NO ACTION', references: 'guilds(id)' },
    ])
  }, 60_000)

  it('a named table-level key keeps its name and its referenced column, even declared before the column', async () => {
    expect((await migrate('CREATE TABLE invites (code text NOT NULL UNIQUE)')).ok).toBe(true)
    const made = await migrate(
      'CREATE TABLE redemptions (CONSTRAINT redemptions_code FOREIGN KEY (invite_code) REFERENCES invites(code) ON DELETE CASCADE, invite_code text NOT NULL)',
    )
    expect(made.ok).toBe(true)
    expect(await foreignKeys('redemptions', 'invite_code')).toEqual([
      { name: 'redemptions_code', onDelete: 'CASCADE', onUpdate: 'NO ACTION', references: 'invites(code)' },
    ])
  }, 60_000)

  it('ADD COLUMN keeps a self-reference and its action', async () => {
    const added = await migrate('ALTER TABLE members ADD COLUMN mentor_id uuid REFERENCES members(id) ON DELETE SET NULL')
    expect(added.ok).toBe(true)
    expect(await foreignKeys('members', 'mentor_id')).toEqual([
      { name: 'members_mentor_id_fkey', onDelete: 'SET NULL', onUpdate: 'NO ACTION', references: 'members(id)' },
    ])
  }, 60_000)

  it('later tables do not replace a declared key with one Backenly infers', async () => {
    // Every CREATE TABLE runs the inferred-key repair over the whole project.
    expect((await migrate('CREATE TABLE clans (name text)')).ok).toBe(true)
    expect(await foreignKeys('enrolments', 'clan_id')).toEqual([
      { name: 'enrolments_clan_fkey', onDelete: 'SET NULL', onUpdate: 'NO ACTION', references: 'guilds(id)' },
    ])
    expect(await foreignKeys('posts', 'guild_id')).toHaveLength(1)
  }, 60_000)
})

describe('a declared key that cannot be installed creates nothing', () => {
  it('a key to a table that does not exist leaves no table behind', async () => {
    const out = await migrate('CREATE TABLE orphans (ghost_id uuid REFERENCES ghosts(id))')
    expect(out.ok).toBe(false)
    expect(await tableExists('orphans')).toBe(false)
  }, 60_000)

  it('a key to a column with no unique constraint leaves no table behind', async () => {
    const out = await migrate('CREATE TABLE badges (guild_name text REFERENCES guilds(name))')
    expect(out.ok).toBe(false)
    expect(await tableExists('badges')).toBe(false)
  }, 60_000)

  it('an ALTER whose key cannot be added adds nothing', async () => {
    expect((await migrate('CREATE TABLE trophies (winner_id uuid)')).ok).toBe(true)
    const out = await migrate('ALTER TABLE trophies ADD CONSTRAINT trophies_winner FOREIGN KEY (winner_id) REFERENCES champions(id)')
    expect(out.ok).toBe(false)
    expect(await foreignKeys('trophies', 'winner_id')).toEqual([])
  }, 60_000)
})
