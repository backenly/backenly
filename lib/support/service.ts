/**
 * Support cases: one service behind every door.
 *
 * The customer-side functions are called by `app/api/support/*`; the staff-side
 * functions exist for the Cloud admin surface (the overlay's routes import
 * them), so the overlay composes this logic instead of duplicating it. All of
 * it refuses outside Backenly Cloud: a self-hosted install has no support team
 * behind the ticket box, and a form that files into the void would be a fake
 * surface, so the capability must not exist there (lib/edition/cloud-only.ts).
 *
 * Authorization: every customer-side read and write is scoped by userId inside
 * the query itself. A ticket someone else owns is indistinguishable from a
 * ticket that does not exist (404), like the api-keys routes.
 */
import { assertCloudEdition } from '@/lib/edition/cloud-only'
import { canAccessProject } from '@/lib/edition/guard'
import { getUserEntitlements } from '@/lib/entitlements'
import { planDisplayName } from '@/lib/entitlements/policy'
import type { UserEntitlements } from '@/lib/entitlements/types'
import { prisma } from '@/lib/db/prisma'
import {
  isSupportCategory,
  isSupportSeverity,
  severityAllowedOnPlan,
  supportAiRetryAllowed,
  SUPPORT_SEVERITIES,
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  TICKET_SUBJECT_MAX,
  type SupportSeverity,
  type TicketStatus,
} from './constants'
import { notifyCustomerOfCaseUpdate, notifyOperatorsOfCustomerMessage, type TicketRef } from './notify'

export class SupportError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SupportError'
    this.status = status
    this.code = code
  }
}

/** What the customer surface shows about the account's support level. */
export interface SupportLevel {
  plan: string
  /** Target first response from the team, in hours. Null = best effort. */
  targetResponseHours: number | null
  priority: boolean
  /** Severities this account may file at. */
  allowedSeverities: SupportSeverity[]
}

export function supportLevelOf(ent: UserEntitlements | null): SupportLevel {
  return {
    plan: planDisplayName(ent?.planName ?? 'SANDBOX'),
    targetResponseHours: ent?.supportResponseHours ?? null,
    priority: ent?.prioritySupport ?? false,
    allowedSeverities: SUPPORT_SEVERITIES.filter((s) => severityAllowedOnPlan(ent, s.id)).map((s) => s.id),
  }
}

const ticketListSelect = {
  id: true,
  caseNumber: true,
  subject: true,
  category: true,
  severity: true,
  status: true,
  aiState: true,
  aiError: true,
  aiAttempts: true,
  projectId: true,
  lastMessageAt: true,
  lastMessageBy: true,
  createdAt: true,
} as const

function refOf(t: { id: string; caseNumber: number; subject: string; severity: string; category: string }): TicketRef {
  return { id: t.id, caseNumber: t.caseNumber, subject: t.subject, severity: t.severity, category: t.category }
}

// ─── Customer side ────────────────────────────────────────────────────────────

export interface CreateTicketInput {
  userId: string
  userEmail: string
  subject: string
  message: string
  category: string
  severity: string
  projectId?: string | null
}

export async function createTicket(input: CreateTicketInput) {
  assertCloudEdition('Support cases')

  const subject = input.subject?.trim() ?? ''
  const message = input.message?.trim() ?? ''
  if (!subject || subject.length > TICKET_SUBJECT_MAX) {
    throw new SupportError(400, 'INVALID_SUBJECT', `Subject is required, at most ${TICKET_SUBJECT_MAX} characters.`)
  }
  if (message.length < TICKET_BODY_MIN || message.length > TICKET_BODY_MAX) {
    throw new SupportError(
      400,
      'INVALID_MESSAGE',
      `Describe the issue in ${TICKET_BODY_MIN} to ${TICKET_BODY_MAX} characters.`
    )
  }
  if (!isSupportCategory(input.category)) {
    throw new SupportError(400, 'INVALID_CATEGORY', 'Unknown category.')
  }
  if (!isSupportSeverity(input.severity)) {
    throw new SupportError(400, 'INVALID_SEVERITY', 'Unknown severity.')
  }

  const ent = await getUserEntitlements(input.userId)
  if (!severityAllowedOnPlan(ent, input.severity)) {
    throw new SupportError(
      403,
      'SEVERITY_NEEDS_PAID_PLAN',
      'Production severities are available on paid plans. File as "System impaired" or upgrade.'
    )
  }

  let projectId: string | null = null
  if (input.projectId) {
    if (!(await canAccessProject(input.userId, input.projectId))) {
      throw new SupportError(404, 'PROJECT_NOT_FOUND', 'Project not found or access denied.')
    }
    projectId = input.projectId
  }

  const ticket = await prisma.supportTicket.create({
    data: {
      userId: input.userId,
      subject,
      message,
      category: input.category,
      severity: input.severity,
      projectId,
    },
  })

  await notifyOperatorsOfCustomerMessage(refOf(ticket), input.userEmail, message, 'created')
  return ticket
}

export async function listTickets(userId: string, opts: { status?: 'open' | 'resolved' | 'all' } = {}) {
  assertCloudEdition('Support cases')
  const where =
    opts.status === 'open'
      ? { userId, status: { in: ['open', 'waiting_on_customer'] } }
      : opts.status === 'resolved'
        ? { userId, status: { in: ['resolved', 'closed'] } }
        : { userId }
  const [tickets, ent] = await Promise.all([
    prisma.supportTicket.findMany({ where, orderBy: { lastMessageAt: 'desc' }, take: 100, select: ticketListSelect }),
    getUserEntitlements(userId),
  ])
  return { tickets, level: supportLevelOf(ent) }
}

/** The account's support level, for the case page's own summary. */
export async function getSupportLevel(userId: string): Promise<SupportLevel> {
  assertCloudEdition('Support cases')
  return supportLevelOf(await getUserEntitlements(userId))
}

export async function getTicket(userId: string, ticketId: string) {
  assertCloudEdition('Support cases')
  return prisma.supportTicket.findFirst({
    where: { id: ticketId, userId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      project: { select: { id: true, name: true } },
    },
  })
}

export async function addCustomerReply(userId: string, userEmail: string, ticketId: string, body: string) {
  assertCloudEdition('Support cases')
  const text = body?.trim() ?? ''
  if (text.length < 1 || text.length > TICKET_BODY_MAX) {
    throw new SupportError(400, 'INVALID_MESSAGE', `A reply is at most ${TICKET_BODY_MAX} characters.`)
  }
  const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, userId } })
  if (!ticket) throw new SupportError(404, 'CASE_NOT_FOUND', 'Case not found.')
  if (ticket.status === 'closed') {
    throw new SupportError(409, 'CASE_CLOSED', 'This case is closed. Open a new case instead.')
  }

  const now = new Date()
  const [message] = await prisma.$transaction([
    prisma.supportMessage.create({
      data: { ticketId: ticket.id, author: 'user', authorUserId: userId, body: text },
    }),
    // A reply puts the case back in the team's queue; replying to a resolved
    // case reopens it, like AWS correspondence does.
    prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'open', lastMessageAt: now, lastMessageBy: 'user', resolvedAt: null, resolvedBy: null },
    }),
  ])

  await notifyOperatorsOfCustomerMessage(refOf(ticket), userEmail, text, 'replied')
  return message
}

export async function resolveTicket(userId: string, ticketId: string) {
  assertCloudEdition('Support cases')
  const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, userId } })
  if (!ticket) throw new SupportError(404, 'CASE_NOT_FOUND', 'Case not found.')
  if (ticket.status === 'closed') throw new SupportError(409, 'CASE_CLOSED', 'This case is already closed.')
  if (ticket.status === 'resolved') return ticket
  return prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'user' },
  })
}

export async function reopenTicket(userId: string, ticketId: string) {
  assertCloudEdition('Support cases')
  const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, userId } })
  if (!ticket) throw new SupportError(404, 'CASE_NOT_FOUND', 'Case not found.')
  if (ticket.status !== 'resolved') {
    throw new SupportError(409, 'NOT_RESOLVED', 'Only a resolved case can be reopened.')
  }
  return prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { status: 'open', resolvedAt: null, resolvedBy: null, lastMessageAt: new Date() },
  })
}

/**
 * The customer asks for the instant answer again after the AI first responder
 * gave up. Only a failure a later attempt can get past qualifies, within the
 * case's attempt cap (supportAiRetryAllowed); the route dispatches the attempt.
 * The update is conditional on the row as read, so a double click queues one
 * attempt, not two.
 */
export async function retryAiAnswer(userId: string, ticketId: string) {
  assertCloudEdition('Support cases')
  const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, userId } })
  if (!ticket) throw new SupportError(404, 'CASE_NOT_FOUND', 'Case not found.')
  if (!supportAiRetryAllowed(ticket)) {
    throw new SupportError(409, 'AI_RETRY_UNAVAILABLE', 'The instant answer cannot be retried on this case. The team has it and replies here.')
  }
  // The old reason goes: this is a fresh attempt, and the next outcome records its own.
  const moved = await prisma.supportTicket.updateMany({
    where: { id: ticket.id, aiState: 'failed', aiAttempts: ticket.aiAttempts },
    data: { aiState: 'none', aiNextAttemptAt: null, aiError: null },
  })
  if (moved.count === 0) {
    throw new SupportError(409, 'AI_RETRY_UNAVAILABLE', 'An answer is already being written for this case.')
  }
  return prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })
}

// ─── Staff side (Cloud admin; the overlay's routes call these) ────────────────

export async function listAllTickets(opts: { status?: TicketStatus | 'all'; severity?: SupportSeverity } = {}) {
  assertCloudEdition('Support cases')
  const where: Record<string, unknown> = {}
  if (opts.status && opts.status !== 'all') where.status = opts.status
  if (opts.severity) where.severity = opts.severity
  return prisma.supportTicket.findMany({
    where,
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
    select: {
      ...ticketListSelect,
      firstStaffReplyAt: true,
      user: { select: { id: true, email: true, name: true } },
      project: { select: { id: true, name: true } },
    },
  })
}

export async function getTicketForStaff(ticketId: string) {
  assertCloudEdition('Support cases')
  return prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      user: { select: { id: true, email: true, name: true } },
      project: { select: { id: true, name: true } },
    },
  })
}

export async function staffReply(ticketId: string, staffUserId: string, body: string) {
  assertCloudEdition('Support cases')
  const text = body?.trim() ?? ''
  if (text.length < 1 || text.length > TICKET_BODY_MAX) {
    throw new SupportError(400, 'INVALID_MESSAGE', `A reply is at most ${TICKET_BODY_MAX} characters.`)
  }
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } })
  if (!ticket) throw new SupportError(404, 'CASE_NOT_FOUND', 'Case not found.')
  if (ticket.status === 'closed') {
    throw new SupportError(409, 'CASE_CLOSED', 'This case is closed.')
  }

  const now = new Date()
  const [message] = await prisma.$transaction([
    prisma.supportMessage.create({
      data: { ticketId: ticket.id, author: 'staff', authorUserId: staffUserId, body: text },
    }),
    prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: 'waiting_on_customer',
        lastMessageAt: now,
        lastMessageBy: 'staff',
        firstStaffReplyAt: ticket.firstStaffReplyAt ?? now,
        resolvedAt: null,
        resolvedBy: null,
      },
    }),
  ])

  await notifyCustomerOfCaseUpdate(
    ticket.userId,
    refOf(ticket),
    'Backenly Support replied to your case',
    text.length > 600 ? `${text.slice(0, 600)}…` : text
  )
  return message
}

export async function setTicketStatus(ticketId: string, status: TicketStatus) {
  assertCloudEdition('Support cases')
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } })
  if (!ticket) throw new SupportError(404, 'CASE_NOT_FOUND', 'Case not found.')
  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data:
      status === 'resolved'
        ? { status, resolvedAt: new Date(), resolvedBy: 'staff' }
        : status === 'open'
          ? { status, resolvedAt: null, resolvedBy: null }
          : { status },
  })
  if (status === 'resolved' && ticket.status !== 'resolved') {
    await notifyCustomerOfCaseUpdate(
      ticket.userId,
      refOf(ticket),
      'Your support case was resolved',
      `Case #${ticket.caseNumber} (“${ticket.subject}”) was marked resolved by the team. Reply on the case if the problem is not gone.`
    )
  }
  return updated
}
