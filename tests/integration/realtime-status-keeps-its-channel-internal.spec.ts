/**
 * THE REALTIME PAGE SAYS WHAT STREAMS, NOT HOW BACKENLY CARRIES IT
 * ===============================================================
 * Production QA (2026-11-09): the Realtime page showed "Postgres channel:
 * Changes are published with NOTIFY on this channel" with workspace_<id>_changes
 * to copy. The channel is how Backenly carries changes to the stream, not
 * something to build on; clients use the stream.
 *
 * Against a real database, through the route as the page calls it.
 */
import '../helpers/real-web-standard'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { createSession } from '@/lib/auth/session'
import { GET as statusGET } from '@/app/api/projects/[id]/realtime-status/route'

let ownerId: string
let projectId: string
let token: string
const originalEdition = process.env.BACKENLY_EDITION

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  const email = `rt-status-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'owner' } })).id
  token = (await createSession(ownerId, email)).token
  projectId = (await prisma.project.create({ data: { name: 'rt-status', userId: ownerId }, select: { id: true } })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "workspace_${projectId}"`)
})

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  process.env.BACKENLY_EDITION = originalEdition
})

it('answers what streams and who is online, and names no internal channel', async () => {
  const res = await statusGET(
    new NextRequest(`http://localhost:3000/api/projects/${projectId}/realtime-status`, {
      headers: { cookie: `auth-token=${token}` },
    }),
    { params: Promise.resolve({ id: projectId }) },
  )
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(JSON.parse(text)).toEqual({ enabled: false, triggeredTables: [], onlineUsers: 0 })
  expect(text).not.toContain('_changes')
})
