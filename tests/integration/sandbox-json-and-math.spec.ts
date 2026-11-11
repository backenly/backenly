/**
 * A function has the whole of JSON and Math.
 *
 * The sandbox gave each function frozen copies of JSON and Math made with
 * Object.assign, which copies only enumerable properties. None of theirs are,
 * so in every function run outside an HTTP route JSON.stringify, JSON.parse
 * and every Math method were undefined: "JSON.stringify is not a function"
 * (production QA, 2026-11-09), and an agent wrote its own object walker to log
 * an event.
 *
 * Real sandbox worker, real function rows.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'

let userId: string
let projectId: string

async function sandboxFunction(name: string, code: string): Promise<string> {
  const fn = await prisma.aiFunction.create({
    data: { projectId, name, description: name, generatedCode: code, triggerType: 'manual', status: 'active' },
  })
  return fn.id
}

const run = (id: string) => executeAiFunction(id, projectId, { type: 'manual', data: {} }, { selfHeal: false })

beforeAll(async () => {
  userId = (await prisma.user.create({
    data: { email: `sandbox-builtins-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'builtins' },
  })).id
  projectId = (await prisma.project.create({ data: { name: 'sandbox-builtins', userId } })).id
}, 60_000)

afterAll(async () => {
  await prisma.project.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

it('gives a function JSON.stringify, JSON.parse and Math', async () => {
  const id = await sandboxFunction('uses-json-and-math', `
    const text = JSON.stringify({ total: Math.round(2.6), max: Math.max(1, 7), pi: Math.PI > 3 })
    ctx.log(JSON.stringify(event))
    return { text, parsed: JSON.parse(text), floor: Math.floor(1.9), sqrt: Math.sqrt(16) }
  `)
  const result = await run(id)
  expect({ success: result.success, error: result.error }).toEqual({ success: true, error: undefined })
  expect(result.returnValue).toEqual({
    text: '{"total":3,"max":7,"pi":true}',
    parsed: { total: 3, max: 7, pi: true },
    floor: 1,
    sqrt: 4,
  })
  expect(result.logs).toEqual(['{"type":"manual","data":{}}'])
}, 60_000)

it('keeps what a function does to JSON or Math inside its own run', async () => {
  const meddles = await sandboxFunction('replaces-builtins', `
    JSON.stringify = () => 'replaced'
    Math.max = () => -1
    return JSON.stringify({ a: 1 })
  `)
  expect((await run(meddles)).returnValue).toBe('replaced')

  const after = await sandboxFunction('uses-builtins-after', `
    ctx.log({ logged: true })
    return [JSON.stringify({ a: 1 }), Math.max(1, 2)]
  `)
  const result = await run(after)
  expect(result.returnValue).toEqual(['{"a":1}', 2])
  expect(result.logs).toEqual(['{"logged":true}'])
}, 60_000)
