/**
 * WHO SENDS A PROJECT'S AUTH EMAILS, SAID TO THE PERSON WHO ASKS
 * ==============================================================
 *
 * Production QA (2026-11-09): on Backenly Cloud, the Auth page said mail "sends
 * through the deployment's SMTP environment variables" and the agent was told
 * auth emails "are sent through the deployment's SMTP". A Cloud customer has no
 * deployment and no environment variables: Backenly sends that mail, as the
 * app, from Backenly's address. A self-hosted operator does set those
 * variables, so their wording stays, with the sender named too.
 *
 * Against a real database, through the same functions the routes and the
 * agent's auth tool call.
 */

let cloud = false
jest.mock('@cloud/control-plane', () => ({
  get CLOUD_CONTROL_PLANE() {
    return cloud
  },
}))

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { getSmtpConfigView, saveSmtpConfig } from '@/lib/email/project-smtp'
import { emailSettings } from '@/lib/email/agent-actions'

const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_END_USER_FROM'] as const
const saved: Record<string, string | undefined> = {}
const originalEdition = process.env.BACKENLY_EDITION

let ownerId: string
let projectId: string

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  for (const k of ENV) saved[k] = process.env[k]
  const email = `mail-sender-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email, password: 'not-a-real-hash', name: 'owner' } })).id
  projectId = (await prisma.project.create({ data: { name: 'shopqa', userId: ownerId } })).id
}, 120_000)

afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  await prisma.projectEmailConfig.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

beforeEach(async () => {
  cloud = false
  await prisma.projectEmailConfig.deleteMany({ where: { projectId } })
  process.env.SMTP_HOST = 'smtp.example.test'
  process.env.SMTP_PORT = '587'
  process.env.SMTP_USER = 'deployment-user'
  process.env.SMTP_PASS = 'deployment-password'
  process.env.SMTP_FROM = 'Backenly <support@example.test>'
  delete process.env.SMTP_END_USER_FROM
})

const summary = async () => {
  const result = await emailSettings({ userId: ownerId, projectId })
  expect(result.ok).toBe(true)
  return result.summary
}

describe('the settings view names the address the app’s emails go out from', () => {
  it('is SMTP_FROM’s address, or SMTP_END_USER_FROM once the operator sets one', async () => {
    expect((await getSmtpConfigView(projectId)).deploymentSenderAddress).toBe('support@example.test')
    process.env.SMTP_END_USER_FROM = 'noreply@example.test'
    expect((await getSmtpConfigView(projectId)).deploymentSenderAddress).toBe('noreply@example.test')
  })

  it('is null when the deployment has no SMTP to send through', async () => {
    delete process.env.SMTP_HOST
    expect((await getSmtpConfigView(projectId)).deploymentSenderAddress).toBeNull()
  })
})

describe('the agent is told who sends the mail, in its edition’s terms', () => {
  it('on Cloud: Backenly sends it, as the app, and the project’s own SMTP is how to send from its domain', async () => {
    cloud = true
    process.env.SMTP_END_USER_FROM = 'noreply@example.test'
    const text = await summary()
    expect(text).toContain(
      'Backenly sends this project\'s auth emails as "shopqa" <noreply@example.test>. ' +
        'To send from the app\'s own domain, set its SMTP: auth { action: "set_smtp" }.',
    )
    expect(text).not.toMatch(/deployment/i)
  })

  it('self-hosted: the deployment’s SMTP sends it, as the app', async () => {
    const text = await summary()
    expect(text).toContain('Auth emails are sent through the deployment’s SMTP as "shopqa" <support@example.test>.')
  })

  it('does not report a test of the project’s settings when the deployment is the one sending', async () => {
    // Settings saved and switched off: the deployment sends, and those settings
    // have never been tested. That says nothing about the mail being sent.
    await saveSmtpConfig(projectId, {
      host: 'smtp.project.test', port: 587, username: 'u', password: 'p', fromAddress: 'auth@project.test', enabled: false,
    })
    expect(await summary()).not.toContain('not tested since the settings were saved')
  })

  it('CONTROL: the project’s own SMTP, when it sends, still carries its test result', async () => {
    await saveSmtpConfig(projectId, {
      host: 'smtp.project.test', port: 587, username: 'u', password: 'p', fromAddress: 'auth@project.test', enabled: true,
    })
    expect(await summary()).toContain(
      'Auth emails are sent through this project\'s SMTP (smtp.project.test:587); not tested since the settings were saved.',
    )
  })
})
