/**
 * "continue" AFTER A LOOP TURN STOPPED UNFINISHED PICKS UP WHERE IT STOPPED
 * =========================================================================
 * A loop turn that ran out of steps tells the caller to say "continue". That
 * used to reach the classifier as CONFIRM with nothing pending, and the caller
 * got "nothing is waiting for confirmation". The turn now saves its request and
 * what it applied, and "continue" resumes the loop on that.
 *
 * Real database: the project, its workspace schema and the saved resume point.
 * Only the model is scripted.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import {
  scriptedMessage,
  scriptedProvider,
  type ScriptedProvider,
} from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { runBrain, type BrainInput } from '@/lib/ai/brain/agent'
import { loadLoopResume, saveLoopResume, resumePrompt } from '@/lib/ai/brain/loop-resume'
import fs from 'node:fs'
import { Client } from 'pg'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'



let ownerId: string
let projectId: string
let schema: string

// Keep autonomy event kicks disabled during this integration test.
const previousAutonomyFlag = process.env.ENABLE_AUTONOMY_RECONCILER


const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_resume_${crypto.randomBytes(4).toString('hex')}`

let regionalUrl: string
let regionalDbCreated = false
let previousRegionUrl: string | undefined

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is not configured')

  const parsed = new URL(url)
  if (parsed.pathname !== '/backenly_test') {
    throw new Error('Expected TEST_DATABASE_URL to point to backenly_test')
  }

  return url
}

function regionalDatabaseUrl(database: string): string {
  const url = new URL(testDatabaseUrl())
  url.pathname = `/${database}`
  return url.toString()
}

async function runSql(connectionString: string, sql: string): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()

  try {
    await client.query(sql)
  } finally {
    await client.end().catch(() => {})
  }
}


const classified = (intent: string) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }) })

async function turn(provider: ScriptedProvider, message: string, extra: Partial<BrainInput> = {}) {
  setProviderForTests(provider)
  return runBrain({ projectId, userId: ownerId, message, ...extra }, () => {})
}

/** One create_table call per model step, so a script of N of them uses N loop steps. */
const creates = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) =>
    scriptedMessage({
      toolUse: [
        {
          id: `toolu_${prefix}_${i}`,
          name: 'create_table',
          input: { tableName: `${prefix}_${i}`, columns: [] },
        },
      ],
    })
  )

const REQUEST = 'add twelve small lookup tables named step_0 through step_11 to my backend'


beforeAll(async () => {
  // Prevent new event-driven reconciler kicks from this test.
  process.env.ENABLE_AUTONOMY_RECONCILER = 'false'

  ownerId = (
    await prisma.user.create({
      data: {
        email: `brain-continue-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'brain',
      },
    })
  ).id

  projectId = (
    await prisma.project.create({
      data: {
        name: 'brain-continue-resume',
        userId: ownerId,
      },
    })
  ).id

  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(
    `CREATE SCHEMA IF NOT EXISTS "${schema}"`
  )
}, 60_000)


beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  await prisma.conversationMessage.deleteMany({ where: { projectId } })
  await prisma.projectPreference.deleteMany({ where: { projectId } })
})

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('"continue" after a turn that ran out of steps', () => {
  it('resumes the saved request with what already landed, and clears the resume point', async () => {
    const first = await turn(
      scriptedProvider([classified('MODIFY'), ...creates(12, 'step')]),
      REQUEST
    )
    expect(first.failureCode).toBe('STEP_BUDGET_EXHAUSTED')
    expect(first.summary).toMatch(/continue/i)
    expect(first.applied).toHaveLength(12)

    const saved = await loadLoopResume(projectId)
    expect(saved).toMatchObject({ request: REQUEST })
    expect(saved!.applied).toEqual(first.applied)

    const provider = scriptedProvider([
      classified('CONFIRM'),
      scriptedMessage({ toolUse: [{ id: 'toolu_read', name: 'read_backend_state', input: {} }] }),
      scriptedMessage({
        toolUse: [
          {
            id: 'toolu_finish',
            name: 'finish',
            input: { summary: 'All twelve tables are in place.' },
          },
        ],
      }),
    ])
    const second = await turn(provider, 'continue')

    // The agent got a turn, not the dead end.
    expect(second.summary).toBe('All twelve tables are in place.')
    expect(second.summary).not.toMatch(/nothing waiting/i)
    expect(second.iterations).toBeGreaterThan(0)

    // The model was sent the original request and the applied list, not a bare "continue".
    const sent = JSON.stringify(provider.calls[1].params.messages.at(-1)!.content)
    expect(sent).toContain(REQUEST)
    for (const title of first.applied!) expect(sent).toContain(title)
    expect(sent).toMatch(/do not redo/i)

    expect(await loadLoopResume(projectId)).toBeNull()
  }, 120_000)

  it('carries what landed across a second stop, so nothing is lost on the next "continue"', async () => {
    await turn(scriptedProvider([classified('MODIFY'), ...creates(12, 'first')]), REQUEST)
    const again = await turn(
      scriptedProvider([classified('CONFIRM'), ...creates(12, 'second')]),
      'continue'
    )
    expect(again.failureCode).toBe('STEP_BUDGET_EXHAUSTED')

    const saved = await loadLoopResume(projectId)
    expect(saved!.request).toBe(REQUEST)
    expect(saved!.applied).toHaveLength(24)
  }, 120_000)

  it('keeps the resume point through a read-only question, so "continue" still works after it', async () => {
    await saveLoopResume(projectId, 'an older request', ['made a table'], 'step_budget')
    await turn(
      scriptedProvider([
        classified('QUESTION'),
        scriptedMessage({
          toolUse: [
            { id: 'toolu_finish', name: 'finish', input: { summary: 'You have no tables.' } },
          ],
        }),
      ]),
      'what tables do I have?'
    )
    expect(await loadLoopResume(projectId)).toMatchObject({ request: 'an older request' })
  }, 60_000)

  it('clears the resume point when a different request changes the backend and finishes', async () => {
    await saveLoopResume(projectId, 'an older request', ['made a table'], 'step_budget')
    await turn(
      scriptedProvider([
        classified('MODIFY'),
        scriptedMessage({
          toolUse: [
            {
              id: 'toolu_create',
              name: 'create_table',
              input: { tableName: 'fresh_start', columns: [] },
            },
          ],
        }),
        scriptedMessage({ toolUse: [{ id: 'toolu_read', name: 'read_backend_state', input: {} }] }),
        scriptedMessage({
          toolUse: [
            { id: 'toolu_finish', name: 'finish', input: { summary: 'Added fresh_start.' } },
          ],
        }),
      ]),
      'add a fresh_start table'
    )
    expect(await loadLoopResume(projectId)).toBeNull()
  }, 60_000)
})

describe('"continue" after Architect failed', () => {
  it('saves the Architect failure flag when the loop stops unfinished', async () => {
    // Save a resume marker representing an unfinished loop
    // after Architect failed earlier in the turn.
    await saveLoopResume(projectId, REQUEST, ['Created step_0'], 'step_budget', true)

    const saved = await loadLoopResume(projectId)

    expect(saved).toMatchObject({
      request: REQUEST,
      architectFailed: true,
      applied: ['Created step_0'],
    })
  })
})

describe('"continue" with nothing saved', () => {
  it('still says nothing is waiting, without calling the model again', async () => {
    const provider = scriptedProvider([classified('CONFIRM')])
    const result = await turn(provider, 'continue')
    expect(result.summary).toMatch(/nothing waiting/i)
    expect(result.iterations).toBe(0)
    expect(provider.calls).toHaveLength(1)
  })

  it('does not resume a marker that has expired', async () => {
    await saveLoopResume(projectId, 'an old request', [], 'step_budget')
    await prisma.projectPreference.updateMany({
      where: { projectId, key: 'loop_resume' },
      data: {
        value: JSON.stringify({
          request: 'an old request',
          applied: [],
          reason: 'x',
          createdAt: '2020-01-01T00:00:00Z',
          expiresAt: '2020-01-01T00:30:00Z',
        }),
      },
    })
    expect(await loadLoopResume(projectId)).toBeNull()
  })
})

// The marker lives in the home region's platform database. A project kept in
// another region keeps its words there (lib/data-plane/residency.ts), so its
// marker holds neither the request nor the applied titles, and the resumed turn
// is pointed at the conversation, which stays in the region.

describe('a project kept in another region', () => {
  let regionalId: string

  beforeAll(async () => {
    const home = testDatabaseUrl()
    regionalUrl = regionalDatabaseUrl(REGIONAL_DB)
    previousRegionUrl = process.env[REGION_VARIABLE]

    // Create a separate regional test database.
    await runSql(home, `CREATE DATABASE "${REGIONAL_DB}"`)
    regionalDbCreated = true

    // Install the regional database function.
    await runSql(
      regionalUrl,
      `CREATE FUNCTION public.backenly_app_role()
       RETURNS text
       LANGUAGE sql
       AS $$ SELECT current_user::text $$`,
    )

    // Install the regional bodies table.
    await runSql(
      regionalUrl,
      fs.readFileSync('scripts/sql/regional-bodies.sql', 'utf8'),
    )

    // Configure the regional connection.
    process.env[REGION_VARIABLE] = regionalUrl

    // Create the regional project.
    regionalId = (
      await prisma.project.create({
        data: {
          name: 'brain-continue-regional',
          userId: ownerId,
          region: 'us-east-1',
        },
        select: { id: true },
      })
    ).id
  }, 120_000)


afterAll(async () => {
  // Remove the regional project's home-database marker.
  if (regionalId) {
    await prisma.projectPreference.deleteMany({
      where: { projectId: regionalId },
    }).catch(() => {})
  }

  // Restore the previous regional connection.
  if (previousRegionUrl === undefined) {
    delete process.env[REGION_VARIABLE]
  } else {
    process.env[REGION_VARIABLE] = previousRegionUrl
  }

  // Disconnect clients before dropping the temporary database.
  await disconnectRegionalClients().catch(() => {})

  if (regionalDbCreated) {
    await runSql(
      testDatabaseUrl(),
      `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`,
    ).catch((err) => {
      console.error('Could not drop temporary regional DB:', err)
    })
  }
}, 120_000)

  it('stores neither the request nor what landed in the home database, and can still be resumed', async () => {
    await saveLoopResume(
      regionalId,
      'block alice@example.com and add her to the audit table',
      ['Blocking alice@example.com'],
      'step_budget'
    )

    const row = await prisma.projectPreference.findFirstOrThrow({
      where: { projectId: regionalId, key: 'loop_resume' },
    })
    expect(row.value).not.toContain('alice@example.com')
    expect(row.value).not.toContain('audit table')

    const marker = await loadLoopResume(regionalId)
    expect(marker).toMatchObject({
      request: 'block alice@example.com and add her to the audit table',
      applied: [],
      keptInRegion: true,
      reason: 'it ran out of steps',
    })

    const prompt = resumePrompt(marker!, 'continue')
    expect(prompt).toMatch(/in the conversation above/)
    expect(prompt).not.toMatch(/ORIGINAL REQUEST/)
  })
})

describe('resumePrompt', () => {
  it('names the request, lists what landed, and says when nothing did', () => {
    const base = {
      request: 'add a posts table',
      reason: 'it ran out of steps',
      createdAt: '',
      expiresAt: '',
    }
    const withWork = resumePrompt({ ...base, applied: ['Create table posts'] }, 'continue')
    expect(withWork).toContain('add a posts table')
    expect(withWork).toContain('Create table posts')
    expect(resumePrompt({ ...base, applied: [] }, 'continue')).toContain('Nothing was applied')
  })
})
