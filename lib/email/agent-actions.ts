/**
 * The Auth page's email settings, as operations an agent can run.
 *
 * Password-reset, verification and magic-link emails need a sender (SMTP) and,
 * usually, templates in the app's own words. Both lived only on the Auth page,
 * so an agent building sign-up could not finish it. These call the same
 * functions the page's routes call, with each route's permission level: reading
 * needs access, templates need write, SMTP needs admin.
 *
 * The SMTP password goes in and never comes out: every answer carries the
 * settings view, which says only whether a password is stored.
 */

import nodemailer from 'nodemailer'
import { canAccessProject, canAdministerProject, canWriteProject } from '@/lib/edition/guard'
import {
  deleteSmtpConfig,
  getSmtpConfigView,
  isTestRecipient,
  saveSmtpConfig,
  sendProjectSmtpTest,
  validateSmtpConfig,
} from '@/lib/email/project-smtp'
import { listProjectTemplates, revertProjectTemplate, saveProjectTemplate } from '@/lib/email/project-templates'
import { isTemplateKind, TEMPLATE_KINDS } from '@/lib/email/template-kinds'

export interface EmailActor {
  userId?: string
  projectId: string
}

export interface EmailActionResult {
  ok: boolean
  summary: string
  data?: unknown
  code?: string
}

type Access = 'read' | 'write' | 'admin'
const GUARD = { read: canAccessProject, write: canWriteProject, admin: canAdministerProject } as const

async function refused(actor: EmailActor, access: Access): Promise<EmailActionResult | null> {
  const allowed = actor.userId ? await GUARD[access](actor.userId, actor.projectId) : false
  return allowed ? null : { ok: false, code: 'PROJECT_NOT_FOUND', summary: 'Project not found, or this key may not do that here.' }
}

const badKind = (kind: unknown): EmailActionResult | null =>
  isTemplateKind(kind)
    ? null
    : { ok: false, code: 'INVALID_ARGUMENT', summary: `kind must be one of: ${TEMPLATE_KINDS.join(', ')}.` }

function senderLine(smtp: Awaited<ReturnType<typeof getSmtpConfigView>>): string {
  if (smtp.activeSource === 'none') return 'No sender is configured, so auth emails are not being sent.'
  const via = smtp.activeSource === 'project' ? `this project's SMTP (${smtp.host}:${smtp.effectivePort})` : 'the deployment’s SMTP'
  const proof = smtp.lastTestAt
    ? smtp.lastTestError ? `; the last test failed: ${smtp.lastTestError}` : `; the last test succeeded at ${smtp.lastTestAt}`
    : '; not tested since the settings were saved'
  return `Auth emails are sent through ${via}${proof}.`
}

export async function emailSettings(actor: EmailActor): Promise<EmailActionResult> {
  const denied = await refused(actor, 'read')
  if (denied) return denied
  const [smtp, templates] = await Promise.all([getSmtpConfigView(actor.projectId), listProjectTemplates(actor.projectId)])
  const customised = templates.templates.filter((t) => t.customised).map((t) => t.kind)
  return {
    ok: true,
    summary:
      `${senderLine(smtp)} Templates: ${customised.length ? `customised ${customised.join(', ')}` : 'all defaults'}. ` +
      `A template may use {{${templates.variables.join('}}, {{')}}}, and must include {{${templates.requiredVariables.join('}}, {{')}}}.`,
    data: { smtp, ...templates },
  }
}

export async function setSmtp(
  actor: EmailActor,
  args: { host?: unknown; port?: unknown; username?: unknown; password?: unknown; fromAddress?: unknown; fromName?: unknown; enabled?: unknown },
): Promise<EmailActionResult> {
  const denied = await refused(actor, 'admin')
  if (denied) return denied
  const current = await getSmtpConfigView(actor.projectId)
  const input = {
    host: String(args.host ?? ''),
    port: Number(args.port),
    username: String(args.username ?? ''),
    password: typeof args.password === 'string' && args.password.length > 0 ? args.password : undefined,
    fromAddress: String(args.fromAddress ?? ''),
    fromName: typeof args.fromName === 'string' ? args.fromName : null,
    enabled: args.enabled !== false,
  }
  const problems = validateSmtpConfig(input, current.passwordConfigured)
  if (problems.length > 0) {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      summary: `These settings cannot be used, and nothing was saved: ${problems.map((p) => `${p.field}: ${p.message}`).join(' ')}`,
      data: { problems },
    }
  }
  await saveSmtpConfig(actor.projectId, input)
  const smtp = await getSmtpConfigView(actor.projectId)
  return {
    ok: true,
    summary:
      `Saved the SMTP settings (${smtp.host}:${smtp.effectivePort}${smtp.portNormalised ? ', normalised from 465' : ''}, from ${smtp.fromAddress}). ` +
      'They are not proven until a test send succeeds: auth { action: "test_smtp", to }.',
    data: { smtp },
  }
}

export async function testSmtp(actor: EmailActor, args: { to?: unknown }): Promise<EmailActionResult> {
  if (!isTestRecipient(args.to)) {
    return { ok: false, code: 'INVALID_ARGUMENT', summary: 'to is required: an address where the test can be checked.' }
  }
  const denied = await refused(actor, 'admin')
  if (denied) return denied
  const result = await sendProjectSmtpTest(nodemailer, actor.projectId, args.to.trim())
  const smtp = await getSmtpConfigView(actor.projectId)
  return {
    ok: result.sent,
    code: result.sent ? undefined : result.source === 'none' ? 'NOT_CONFIGURED' : 'SEND_FAILED',
    summary: result.sent
      ? `Sent a test message to ${args.to.trim()} through the ${result.source} settings. Confirm it arrived before relying on it.`
      : `The test was not delivered: ${result.error}`,
    data: { sent: result.sent, source: result.source, error: result.error ?? null, smtp },
  }
}

export async function removeSmtp(actor: EmailActor): Promise<EmailActionResult> {
  const denied = await refused(actor, 'admin')
  if (denied) return denied
  const removed = await deleteSmtpConfig(actor.projectId)
  const smtp = await getSmtpConfigView(actor.projectId)
  return {
    ok: true,
    summary: (removed ? 'Removed this project’s SMTP settings. ' : 'This project had no SMTP settings. ') + senderLine(smtp),
    data: { removed, smtp },
  }
}

export async function setEmailTemplate(
  actor: EmailActor,
  args: { kind?: unknown; subject?: unknown; bodyHtml?: unknown },
): Promise<EmailActionResult> {
  const invalid = badKind(args.kind)
  if (invalid) return invalid
  const denied = await refused(actor, 'write')
  if (denied) return denied
  const result = await saveProjectTemplate(
    actor.projectId,
    args.kind as any,
    typeof args.subject === 'string' ? args.subject : '',
    typeof args.bodyHtml === 'string' ? args.bodyHtml : '',
  )
  if ('errors' in result) {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      summary: `This template cannot be used, and nothing was saved: ${result.errors.map((e) => e.message).join(' ')}`,
      data: { errors: result.errors },
    }
  }
  return { ok: true, summary: `Saved the ${result.template.kind} template. It is used for the next email of that kind.`, data: { template: result.template } }
}

export async function resetEmailTemplate(actor: EmailActor, args: { kind?: unknown }): Promise<EmailActionResult> {
  const invalid = badKind(args.kind)
  if (invalid) return invalid
  const denied = await refused(actor, 'write')
  if (denied) return denied
  const reverted = await revertProjectTemplate(actor.projectId, args.kind as any)
  return {
    ok: true,
    summary: reverted ? `The ${String(args.kind)} email uses Backenly’s default again.` : `The ${String(args.kind)} email was already the default.`,
    data: { reverted },
  }
}
