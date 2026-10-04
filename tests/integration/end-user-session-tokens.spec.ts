/**
 * AN END USER'S SESSION WORKS FROM THE MOMENT THEY SIGN UP
 * =======================================================
 *
 * Two defects made the session a new end user receives unusable, both on a
 * project provisioned the normal way (createProvisionedProject, which stores
 * the project's signing secret encrypted):
 *
 *   - the Next sign-up route, which serves Cloud, signed the token with the
 *     STORED secret, the ciphertext, while every verifier decrypts it first.
 *     The token verified nowhere: the data plane served its holder as
 *     anonymous, so row security showed them nothing, until they signed in.
 *   - refresh-token looked the user up with `id = $1`. A bare parameter
 *     arrives as text and the canonical `users.id` is uuid, so every refresh
 *     failed with 42883 (uuid = text) and answered 500.
 *
 * Found by tests/integration/branch-auth.spec.ts, the first suite to use a
 * sign-up token and refresh one. Through the real routes, against a real
 * database; only PostgREST's schema registry, an external service's
 * configuration, and the Cloud entitlement lookup are stubbed.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import '@/tests/helpers/real-web-standard'

import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'

import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { POST as signup } from '@/app/api/v1/[projectId]/auth/signup/route'
import { POST as signin } from '@/app/api/v1/[projectId]/auth/signin/route'
import { POST as refresh } from '@/app/api/v1/[projectId]/auth/refresh-token/route'

let ownerId: string
let projectId: string
let mainSchema: string
let ip = 0

async function call(route: typeof signup, action: string, body: unknown) {
  ip++
  const res = await route(
    new NextRequest(`https://backenly.test/api/v1/${projectId}/auth/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.88.0.${ip}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId }) },
  )
  return { status: res.status, body: (await res.json()) as any }
}

const originalEdition = process.env.BACKENLY_EDITION

beforeAll(async () => {
  // Cloud: the edition that provisions projects, and the one the Next routes serve.
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `session-tokens-${crypto.randomBytes(6).toString('hex')}@example.test` },
  })).id
  const project = await createProvisionedProject({ name: 'session-tokens', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema
}, 120_000)

afterAll(async () => {
  if (mainSchema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${mainSchema}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
}, 120_000)

it('provisions the signing secret encrypted, which is what both defects depend on', async () => {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { jwtSecret: true } })
  expect(p?.jwtSecret).toMatch(/^[0-9a-f]{24,32}:[0-9a-f]{32}:[0-9a-f]+$/)
  expect(resolveJwtSecret(p!.jwtSecret!)).not.toBe(p!.jwtSecret)
})

describe('a new end user', () => {
  let token: string
  let userId: string

  beforeAll(async () => {
    const res = await call(signup, 'signup', { email: 'new-user@example.test', password: 'Correct-Horse-9' })
    expect(res.status).toBe(201)
    token = res.body.data.token
    userId = String(res.body.data.user.id)
  }, 60_000)

  it('gets a sign-up token the data plane accepts as them', async () => {
    expect(await resolveEndUserFromToken(projectId, token)).toMatchObject({ userId })
  }, 60_000)

  it('can refresh it, on the canonical uuid users table', async () => {
    const res = await call(refresh, 'refresh-token', { token })
    expect(res.status).toBe(200)
    expect(String(res.body.data.user.id)).toBe(userId)
    expect(await resolveEndUserFromToken(projectId, res.body.data.token)).toMatchObject({ userId })
    expect((jwt.decode(res.body.data.token) as any).jti).not.toBe((jwt.decode(token) as any).jti)
  }, 60_000)

  it('can refresh a sign-in token too, which always verified but could never be refreshed', async () => {
    const signedIn = await call(signin, 'signin', { email: 'new-user@example.test', password: 'Correct-Horse-9' })
    expect(signedIn.status).toBe(200)
    const res = await call(refresh, 'refresh-token', { token: signedIn.body.data.token })
    expect(res.status).toBe(200)
    expect(String(res.body.data.user.id)).toBe(userId)
  }, 60_000)
})
