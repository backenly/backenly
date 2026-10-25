/**
 * A PAYMENT RECEIPT SAYS WHAT WAS PAID, IN WORDS A CUSTOMER USES
 * ============================================================
 * The email for a plan payment used to read "🎉 Payment successful. Your
 * BUILDER subscription is active until 11/25/2026", under the subject
 * "✅ Payment successful — Backenly": the plan's internal code instead of the
 * plan people buy (Pro), a date in the server's locale that reads as a
 * different day outside the US, the same two facts twice, and none of what a
 * receipt is for: the amount, how it was paid, the invoice.
 *
 * Now notifyPaymentSuccess takes what the paid invoice states, and the receipt
 * (lib/notifications/payment-receipt-email.ts):
 *   - names the plan as customers know it, in the notification and the email;
 *   - writes amounts in the currency's own minor unit, and dates in full, in UTC;
 *   - leaves out a row it has no fact for, rather than guessing one, and links
 *     to Billing when there is no invoice to link to;
 *   - escapes what people and providers wrote, and links only to https;
 *   - says a renewal is one, and does not promise a renewal when a
 *     cancellation is scheduled;
 *   - carries a plain-text part, replies to support, and the site's own mark.
 *
 * Database-free: the platform client is a recorder, and the mail transport
 * keeps what it was asked to send.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const mockNotifications: any[] = []
const mockSent: any[] = []

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    notificationPreference: { findUnique: async () => null },
    platformNotification: { create: async ({ data }: any) => mockNotifications.push(data) },
    user: { findUnique: async () => ({ email: 'payer@example.com' }) },
  },
}))

jest.mock('@/lib/email/smtp-transport', () => ({
  buildEnvSmtpTransport: () => ({ sendMail: async (mail: any) => mockSent.push(mail) }),
}))

import { notifyPaymentSuccess } from '@/lib/notifications/platform'
import { buildNotificationEmail } from '@/lib/notifications/email-templates'
import {
  formatAmount,
  formatPeriod,
  formatShortDate,
  renderPaymentReceiptEmail,
  type PaymentReceipt,
} from '@/lib/notifications/payment-receipt-email'
import { BACKENLY_MARK_CID, BACKENLY_MARK_PNG_BASE64 } from '@/lib/email/backenly-mark'

const EMOJI = new RegExp('\\p{Extended_Pictographic}', 'u')

const PERIOD_END = new Date('2026-11-25T02:14:00Z')

/** What Cloud's webhook passes for a first Pro payment, from the paid invoice. */
const PAID: PaymentReceipt = {
  renewal: false,
  renews: true,
  interval: 'monthly',
  amountPaid: 2500,
  currency: 'usd',
  paidAt: new Date('2026-10-25T02:14:09Z'),
  periodStart: new Date('2026-10-25T02:14:00Z'),
  paymentMethod: 'Visa ending in 4242',
  invoiceNumber: '8F3A2C1D-0001',
  invoiceUrl: 'https://invoice.stripe.com/i/acct_1Example/live_abc',
  invoicePdfUrl: 'https://pay.stripe.com/invoice/acct_1Example/live_abc/pdf',
  organization: 'Acme',
  billingUrl: 'https://backenly.com/app/org/org-1/billing',
}

/**
 * The text a reader sees, near enough for these assertions: every tag (Outlook's
 * conditional comments included) becomes a space, and the entities a reader
 * would see are decoded, `&amp;` last so nothing is decoded twice.
 */
function visible(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
}

beforeEach(() => {
  mockNotifications.length = 0
  mockSent.length = 0
})

describe('a paid plan', () => {
  it('is confirmed in the notification and the receipt by the name customers buy it under', async () => {
    await notifyPaymentSuccess('user-1', 'BUILDER', PERIOD_END, PAID)

    expect(mockNotifications).toHaveLength(1)
    const [notice] = mockNotifications
    expect(notice.title).toBe('Payment received')
    expect(notice.body).toBe('We received $25.00 for your Pro plan. It renews on November 25, 2026.')
    expect(notice.metadata).toMatchObject({
      planName: 'BUILDER',
      periodEnd: '2026-11-25T02:14:00.000Z',
      paidAt: '2026-10-25T02:14:09.000Z',
      amountPaid: 2500,
      invoiceNumber: '8F3A2C1D-0001',
    })

    expect(mockSent).toHaveLength(1)
    const [mail] = mockSent
    expect(mail.to).toBe('payer@example.com')
    expect(mail.subject).toBe('Your receipt from Backenly #8F3A2C1D-0001')
    expect(mail.replyTo).toBe('Backenly <support@backenly.com>')
    expect(mail.attachments).toEqual([expect.objectContaining({ cid: BACKENLY_MARK_CID, contentDisposition: 'inline' })])

    const shown = visible(mail.html)
    expect(shown).toContain('Your Pro plan is active.')
    expect(shown).toContain('Thanks for subscribing. We received your payment of $25.00, and your plan renews on November 25, 2026.')
    for (const fact of ['Amount paid $25.00', 'Plan Pro, billed monthly', 'Billing period Oct 25 – Nov 25, 2026', 'Organization Acme', 'Paid on Oct 25, 2026', 'Payment method Visa ending in 4242', 'Invoice number 8F3A2C1D-0001', 'View invoice', 'Download PDF']) {
      expect(shown).toContain(fact)
    }
    expect(mail.html).toContain(`href="${PAID.invoiceUrl}"`)
    expect(mail.html).toContain(`href="${PAID.invoicePdfUrl}"`)
    expect(mail.html).toContain(`href="${PAID.billingUrl}"`)
    expect(mail.html).toContain(`src="cid:${BACKENLY_MARK_CID}"`)

    for (const part of [mail.subject, mail.html, mail.text, notice.title, notice.body]) {
      expect(part).not.toContain('BUILDER')
      expect(part).not.toContain('11/25/2026')
      expect(part).not.toMatch(EMOJI)
    }
  })

  it('carries everything in its plain-text part too', async () => {
    await notifyPaymentSuccess('user-1', 'BUILDER', PERIOD_END, PAID)
    const { text } = mockSent[0]
    for (const fact of ['Your Pro plan is active.', 'Amount paid:    $25.00', 'Payment method: Visa ending in 4242', 'Invoice number: 8F3A2C1D-0001', `View invoice: ${PAID.invoiceUrl}`, `Download PDF: ${PAID.invoicePdfUrl}`, `Billing: ${PAID.billingUrl}`, 'reply to this email']) {
      expect(text).toContain(fact)
    }
  })

  it('says a renewal is one, and calls the period end an end when a cancellation is scheduled', async () => {
    await notifyPaymentSuccess('user-1', 'BUILDER', PERIOD_END, { ...PAID, renewal: true })
    expect(visible(mockSent[0].html)).toContain('Your Pro plan has renewed.')
    expect(visible(mockSent[0].html)).toContain('Thanks for staying with Backenly.')

    await notifyPaymentSuccess('user-1', 'BUILDER', PERIOD_END, { ...PAID, renewal: true, renews: false })
    expect(mockNotifications[1].body).toBe('We received $25.00 for your Pro plan. It stays active until November 25, 2026.')
    expect(visible(mockSent[1].html)).toContain('your plan stays active until November 25, 2026.')
    expect(visible(mockSent[1].html)).not.toContain('renews')
  })
})

describe('what the receipt was not told', () => {
  it('is left out, and Billing stands in for an invoice it has no link to', async () => {
    await notifyPaymentSuccess('user-1', 'BUILDER', PERIOD_END, { interval: 'monthly' })

    expect(mockNotifications[0].body).toBe('We received your payment for the Pro plan. It renews on November 25, 2026.')
    const mail = mockSent[0]
    expect(mail.subject).toBe('Your receipt from Backenly')
    const shown = visible(mail.html)
    expect(shown).toContain('We received your payment, and your plan renews on November 25, 2026.')
    expect(shown).toContain('Plan Pro, billed monthly')
    for (const missing of ['Amount paid', 'Paid on', 'Payment method', 'Invoice number', 'Organization', 'Billing period', 'View invoice', 'Download PDF']) {
      expect(shown).not.toContain(missing)
    }
    expect(shown).toContain('Open billing')
    expect(mail.html).toContain('href="https://backenly.com/app/billing"')
  })

  it('is rendered from metadata stored before receipts carried invoices', () => {
    // A payment_success notification as notifyPaymentSuccess used to store it.
    const { subject, html } = buildNotificationEmail('payment_success', 'Payment successful', 'Your BUILDER subscription is active until 11/25/2026.', {
      planName: 'BUILDER',
      periodEnd: PERIOD_END.toISOString(),
    })
    expect(subject).toBe('Your receipt from Backenly')
    expect(visible(html)).toContain('Your Pro plan is active.')
    expect(html).not.toContain('BUILDER')
  })
})

describe('what people and providers wrote', () => {
  it('is escaped, and only an https link is printed', () => {
    const { html, text } = renderPaymentReceiptEmail({
      plan: 'Pro',
      periodEnd: PERIOD_END,
      appUrl: 'https://backenly.com',
      organization: '<img src=x onerror=alert(1)>',
      invoiceNumber: '"><script>',
      invoiceUrl: 'javascript:alert(1)',
      invoicePdfUrl: 'http://pay.stripe.com/plain-http',
      billingUrl: 'javascript:alert(2)',
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('"><script>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('http://pay.stripe.com')
    expect(visible(html)).toContain('Open billing')
    expect(html).toContain('href="https://backenly.com/app/billing"')
    expect(text).not.toContain('javascript:')
  })
})

describe('amounts and dates', () => {
  it('are written in the currency’s own minor unit', () => {
    expect(formatAmount(2500, 'usd')).toBe('$25.00')
    expect(formatAmount(1999, 'EUR')).toBe('€19.99')
    expect(formatAmount(2500, 'jpy')).toBe('¥2,500')
    expect(formatAmount(24000, 'usd')).toBe('$240.00')
    expect(formatAmount(2500, 'not-a-currency')).toBe('25.00 NOT-A-CURRENCY')
  })

  it('are written in full and in UTC, whatever the server’s clock says', () => {
    expect(formatShortDate(new Date('2026-10-25T23:30:00Z'))).toBe('Oct 25, 2026')
    expect(formatPeriod(new Date('2026-10-25T00:00:00Z'), new Date('2026-11-25T00:00:00Z'))).toBe('Oct 25 – Nov 25, 2026')
    expect(formatPeriod(new Date('2026-12-25T00:00:00Z'), new Date('2027-01-25T00:00:00Z'))).toBe('Dec 25, 2026 – Jan 25, 2027')
  })
})

describe('the mark in the message', () => {
  it('is the site’s own icon, byte for byte', () => {
    const icon = readFileSync(join(process.cwd(), 'public/apple-touch-icon.png'))
    expect(BACKENLY_MARK_PNG_BASE64).toBe(icon.toString('base64'))
  })
})
