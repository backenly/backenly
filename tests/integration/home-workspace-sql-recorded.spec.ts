/**
 * A HOME PROJECT'S CHANGE STILL RECORDS THE STATEMENTS IT RAN
 * ===========================================================
 * A home project's workspace SQL runs on the home workspace client, not on the
 * platform client: workspace SQL needs Prisma's statement cache off
 * (lib/data-plane/regional.ts, lib/data-plane/statement-cache.ts). What a change
 * records of the SQL it ran is captured by a middleware on the client that sent
 * it (lib/execution/sql-recorder.ts), so the recorder has to be on the workspace
 * client as well. A governed change installs it there (lib/changes/ledger.ts);
 * the auto-fix engine installs it on both home clients, which
 * tests/core/sql-recorder.test.ts covers end to end.
 *
 * Here a governed change for a home project runs its DDL through
 * executeWithUserContext, as the data routes, the MCP data tools and the
 * executors do, and its record must carry that statement.
 */

jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { withChangeAttribution, withGovernedChange } from '@/lib/changes/ledger'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { disconnectRegionalClients, workspaceRawClient } from '@/lib/data-plane/regional'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

jest.setTimeout(120_000)

let ownerId = ''
let projectId = ''
let schema = ''

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `home-recorded-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'x', name: 'Ada Owner' },
  })).id
  const project = await createProvisionedProject({ name: 'home-workspace-sql-recorded', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."notes" (id serial PRIMARY KEY, body text)`)
})

afterAll(async () => {
  if (projectId) {
    const vaults = await prisma
      .$queryRawUnsafe<Array<{ nspname: string }>>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`)
      .catch(() => [])
    for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
    if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    // The ledger's guard allows deleting a project's changes only once the project is gone.
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  await disconnectRegionalClients()
  for (const [name, value] of [['BACKENLY_EDITION', originalEdition], ['ENGINE_MODE', originalEngineMode]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

it('records the DDL a home change ran on the home workspace client', async () => {
  // The statement goes through the workspace client, which is not the platform one.
  expect(await workspaceRawClient(projectId)).not.toBe(prisma)

  const sql = `ALTER TABLE "${schema}"."notes" ADD COLUMN recorded text`
  const { change } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    withGovernedChange({ projectId, title: 'notes.recorded' }, async () => {
      await executeWithUserContext(projectId, '', true, sql)
    }),
  )
  expect(change).not.toBeNull()

  const row = await prisma.backendChange.findUniqueOrThrow({ where: { id: change!.id } })
  expect((row.statements as Array<{ sql: string }>).map((s) => s.sql)).toContain(sql)
})
