export const dynamic = 'force-dynamic'

/**
 * POST /api/contact: the contact page's message form (app/contact).
 *
 * Anonymous by nature, so it is held the way sign-up is: the same bot check
 * (Turnstile, once configured), hourly budgets per network and per address,
 * and a hidden field that only bots fill in. The message goes to the team's
 * one inbox (lib/auth/email.ts sendContactMessageEmail), never to an address
 * the sender typed, so the form cannot mail anyone else.
 *
 * Backenly Cloud only: a self-hosted deployment is not Backenly the company,
 * so off Cloud this answers 404, like the support routes (lib/support/http.ts).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sendContactMessageEmail } from '@/lib/auth/email'
import { CONTACT_EMAIL, CONTACT_LIMITS, CONTACT_TOPICS } from '@/lib/contact'
import { isCloudEdition } from '@/lib/edition/cloud-only'
import { isDeliverableAddress } from '@/lib/email/address'
import { deliverPlatformEmail, EmailDeliveryUnavailableError } from '@/lib/email/platform-delivery'
import { verifySignupChallenge } from '@/lib/platform-signals'
import { clientIp, consume } from '@/lib/security/auth-rate-limit'
import { rateLimitHeaders } from '@/lib/security/rate-limit-decision'

const HOUR = 60 * 60 * 1000
const PER_NETWORK = 5
const PER_ADDRESS = 3

/** A one-line field stays one line, so nothing typed can start a line of its own in the mail. */
const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ').trim()

const contactSchema = z.object({
  name: z.string().trim().max(CONTACT_LIMITS.name, 'Keep the name under 100 characters.').default('').transform(oneLine),
  // The plain form every address Backenly sends to or from must have (lib/email/address.ts),
  // checked here so a sender hears "check the address" rather than "we could not send".
  email: z
    .string()
    .trim()
    .max(CONTACT_LIMITS.email)
    .email('Enter an email address we can reply to.')
    .refine(isDeliverableAddress, 'Enter an email address we can reply to.'),
  company: z.string().trim().max(CONTACT_LIMITS.company, 'Keep the company under 120 characters.').default('').transform(oneLine),
  topic: z.enum(CONTACT_TOPICS),
  message: z
    .string()
    .trim()
    .min(CONTACT_LIMITS.messageMin, 'Tell us a little more, at least a sentence.')
    .max(CONTACT_LIMITS.messageMax, 'Keep the message under 5,000 characters.'),
  turnstileToken: z.string().max(4096).optional(),
  // Hidden on the page; a person never fills it in.
  website: z.string().max(500).optional(),
})

const SEND_INSTEAD = `Email ${CONTACT_EMAIL} instead.`

export async function POST(request: NextRequest) {
  if (!isCloudEdition()) {
    return NextResponse.json({ error: 'Not found', code: 'CLOUD_ONLY_FEATURE' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = contactSchema.safeParse(body)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form')
      if (!fields[key]) fields[key] = issue.message
    }
    return NextResponse.json({ error: 'Check the highlighted fields.', code: 'INVALID_INPUT', fields }, { status: 400 })
  }
  const input = parsed.data

  // A bot that filled the hidden field is told it worked, and nothing is sent.
  if (input.website) return NextResponse.json({ ok: true })

  const ip = clientIp(request)
  for (const [key, limit] of [
    [`contact:ip:${ip}`, PER_NETWORK],
    [`contact:email:${input.email.toLowerCase()}`, PER_ADDRESS],
  ] as const) {
    const result = await consume(key, limit, HOUR)
    if (result.allowed) continue
    if (result.outcome === 'store_unavailable') {
      return NextResponse.json(
        { error: `The form is unavailable for a moment. ${SEND_INSTEAD}`, code: 'RATE_LIMITER_UNAVAILABLE' },
        { status: 503, headers: { ...rateLimitHeaders(result), 'Cache-Control': 'no-store' } },
      )
    }
    return NextResponse.json(
      { error: `Too many messages in the last hour. ${SEND_INSTEAD}`, code: 'RATE_LIMITED' },
      { status: 429, headers: rateLimitHeaders(result) },
    )
  }

  const check = await verifySignupChallenge({ token: input.turnstileToken, ip })
  if (!check.ok) {
    return NextResponse.json(
      { error: 'The verification check did not pass. Complete it again, then send.', code: 'CHALLENGE_FAILED' },
      { status: 403 },
    )
  }

  const inbox = process.env.CONTACT_INBOX || CONTACT_EMAIL
  try {
    const outcome = await deliverPlatformEmail(inbox, () =>
      sendContactMessageEmail({
        name: input.name,
        email: input.email,
        company: input.company,
        topic: input.topic,
        message: input.message,
      }),
    )
    // The inbox is ours, so a refusal of it is our failure, said the same way.
    if (outcome !== 'sent') throw new EmailDeliveryUnavailableError('recipient_rejected')
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (!(err instanceof EmailDeliveryUnavailableError)) console.error('[Contact] send failed:', err)
    return NextResponse.json(
      { error: `We could not send your message just now. ${SEND_INSTEAD}`, code: 'EMAIL_DELIVERY_UNAVAILABLE' },
      { status: 503 },
    )
  }
}
