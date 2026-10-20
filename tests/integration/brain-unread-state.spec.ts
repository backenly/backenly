/**
 * A project whose backend state could not be read is not a brand-new one
 * (#238). When collectProof failed, the turn's understanding had no state, and
 * no state counted as an empty one: the classifier was told nothing had been
 * built, and a BUILD, a description it hedged on, or a "go ahead" whose plan
 * was lost went to the architect, which designs a whole new backend from the
 * request. An unknown state now routes the turn as a built project's does, and
 * the understanding block says the state could not be read.
 *
 * Real database: the projects, their workspace schemas and conversations. The
 * model is scripted. collectProof is wrapped so a test can make the turn's read
 * fail, and getBlueprintForPrompt so a test can see whether the architect was
 * asked; both call through otherwise. Spend reservations go to the gateway's
 * in-memory ledger, as in tests/integration/brain-on-gateway.spec.ts.
 */

import crypto from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db/prisma'
import { setProviderForTests } from '@/lib/ai/llm'
import { scriptedMessage, scriptedProvider, type ScriptedProvider } from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { clarifyPrompt } from '@/lib/ai/brain/prompts'
import { saveTurn } from '@/lib/ai/brain/memory'
import { runBrain } from '@/lib/ai/brain/agent'
import { collectProof } from '@/lib/ai/proof-system'
import { getBlueprintForPrompt } from '@/lib/ai/blueprints'

jest.mock('@/lib/ai/proof-system', () => {
  const actual = jest.requireActual<typeof import('@/lib/ai/proof-system')>('@/lib/ai/proof-system')
  return { ...actual, collectProof: jest.fn(actual.collectProof) }
})

jest.mock('@/lib/ai/blueprints', () => {
  const actual = jest.requireActual<typeof import('@/lib/ai/blueprints')>('@/lib/ai/blueprints')
  return { ...actual, getBlueprintForPrompt: jest.fn(actual.getBlueprintForPrompt) }
})

const proofMock = collectProof as jest.MockedFunction<typeof collectProof>
const architect = getBlueprintForPrompt as jest.MockedFunction<typeof getBlueprintForPrompt>

let ownerId: string
/** Has a posts table. */
let builtProjectId: string
/** Has nothing built. */
let freshProjectId: string

/** Long enough, and not a table spec, for the lost-plan fallback to re-architect it on a fresh project. */
const ORIGINAL_REQUEST =
  'A recipe sharing app where home cooks post recipes with photos, ingredients and steps, follow each ' +
  'other, save favourites into collections, and leave ratings and comments on what they cooked, with a ' +
  'feed of new recipes from the people they follow.'

const classified = (intent: string) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence: 0.9, reasoning: 'scripted' }) })
const finished = (summary: string) =>
  scriptedMessage({ toolUse: [{ id: 'toolu_finish', name: 'finish', input: { summary } }] })

/** Every system block of one call, as one text. */
const systemOf = (provider: ScriptedProvider, call: number) =>
  ((provider.calls[call].params.system ?? []) as Anthropic.TextBlockParam[]).map((b) => b.text).join('\n')

/** The turn's own read of the backend state fails, as when its catalog cannot be reached. */
const failTheStateRead = () => proofMock.mockRejectedValueOnce(new Error('catalog unavailable'))

async function turn(provider: ScriptedProvider, projectId: string, message: string) {
  setProviderForTests(provider)
  return runBrain({ projectId, userId: ownerId, message }, () => {})
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `brain-unread-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'brain' },
  })).id
  builtProjectId = (await prisma.project.create({ data: { name: 'brain-unread-state', userId: ownerId } })).id
  freshProjectId = (await prisma.project.create({ data: { name: 'brain-fresh-state', userId: ownerId } })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${builtProjectId}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "workspace_${builtProjectId}"."posts" (id serial PRIMARY KEY, title text)`)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${freshProjectId}"`)
}, 60_000)

beforeEach(async () => {
  setSpendLedgerForTests(memorySpendLedger())
  proofMock.mockClear()
  architect.mockClear()
  await prisma.conversationMessage.deleteMany({ where: { projectId: { in: [builtProjectId, freshProjectId] } } })
})

afterEach(() => {
  setProviderForTests(null)
  setSpendLedgerForTests(null)
})

afterAll(async () => {
  for (const id of [builtProjectId, freshProjectId]) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId: id } }).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a project whose state could not be read', () => {
  it('is not called brand new to the classifier, and its BUILD goes to the agent loop, not the architect', async () => {
    failTheStateRead()
    const provider = scriptedProvider([classified('BUILD'), finished('Nothing changed yet.')])

    const result = await turn(provider, builtProjectId, 'add a comments table linked to posts')

    expect(proofMock).toHaveBeenCalledTimes(1)
    expect(systemOf(provider, 0)).not.toContain('brand new')
    expect(architect).not.toHaveBeenCalled()
    expect(provider.calls).toHaveLength(2)
    // The loop is told the state is unknown, not that it is empty.
    expect(systemOf(provider, 1)).toContain('BACKEND STATE: (could not read')
    expect(result).toMatchObject({ classification: { intent: 'BUILD' }, toolsRun: ['finish'] })
  }, 60_000)

  it('asks about a description the classifier hedged on, instead of designing a backend from it', async () => {
    failTheStateRead()
    const provider = scriptedProvider([
      classified('UNCLEAR'),
      scriptedMessage({ text: JSON.stringify({ question: 'Should this extend your backend, or replace it?', options: [] }) }),
    ])

    const result = await turn(provider, builtProjectId, 'Users can post recipes with photos and follow each other')

    expect(architect).not.toHaveBeenCalled()
    expect(provider.calls).toHaveLength(2)
    expect(systemOf(provider, 1)).toBe(clarifyPrompt())
    expect(result).toMatchObject({ needsUser: true, toolsRun: ['ask_user'] })
  }, 60_000)

  it('does not re-architect and run the original request when "go ahead" finds no stored plan', async () => {
    // A plan was shown, but nothing executable was kept, so the CONFIRM path
    // falls back to designing the original request again and running it.
    await saveTurn(builtProjectId, ORIGINAL_REQUEST, 'Here is the plan.\n\nReply "go ahead" to run this, or tell me what to add or remove.')
    failTheStateRead()
    const provider = scriptedProvider([classified('CONFIRM'), finished('There is no stored plan to run.')])

    const result = await turn(provider, builtProjectId, 'go ahead')

    expect(architect).not.toHaveBeenCalled()
    expect(result).toMatchObject({ classification: { intent: 'CONFIRM' }, toolsRun: ['finish'] })
  }, 60_000)
})

describe('a project whose state was read and is empty', () => {
  it('is still brand new: the classifier is told so, and a BUILD goes to the architect', async () => {
    // The architect designs nothing here, so the turn goes on to the loop, as
    // it does when the architect fails.
    architect.mockResolvedValueOnce(null)
    const provider = scriptedProvider([classified('BUILD'), finished('Nothing changed yet.')])

    await turn(provider, freshProjectId, 'add a comments table linked to posts')

    expect(systemOf(provider, 0)).toContain('this project is brand new')
    expect(architect).toHaveBeenCalledWith('add a comments table linked to posts', freshProjectId)
  }, 60_000)
})
