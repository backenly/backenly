/**
 * The receipt for a plan payment: what was paid, for which plan and period,
 * how, and where the invoice is.
 *
 * It is the email of a `payment_success` notification (notifyPaymentSuccess in
 * ./platform), so the person's Receipts setting decides whether it is sent.
 * What it says comes from the payment provider: Backenly Cloud passes what the
 * paid invoice states, and the receipt shows only what it was given. A row it
 * has no fact for is left out rather than guessed. A self-hosted install bills
 * nobody and never sends one.
 *
 * ── How it is built ──────────────────────────────────────────────────────────
 *
 * The site's own design carried into a mail client, as Backenly's other
 * platform mail is: the landing page's near-black ground, a white primary
 * action, violet only for links in prose, sentence case, and no emoji. Built
 * the way mail clients need it:
 *
 *   - tables and inline styles, because some clients drop a <style> block and
 *     Outlook for Windows lays mail out with Word;
 *   - one column, 600px at most, with padding that tightens on a phone;
 *   - buttons made of padded links, so they still work with images off;
 *   - the mark carried inside the message (lib/email/backenly-mark.ts);
 *   - colors declared dark (`color-scheme`), so Apple Mail shows them as
 *     designed instead of inverting them, and every word at 4.5:1 or better
 *     against its background;
 *   - a plain-text part that says everything the HTML does.
 *
 * Amounts and dates are written out in full ("$25.00", "November 25, 2026"),
 * in UTC: "11/25/2026" reads as a different day in most of the world.
 */
import { BACKENLY_MARK_CID } from '@/lib/email/backenly-mark'

/**
 * What a paid invoice states, as far as it is known. Every field is optional:
 * the receipt names what it is given and leaves out the rest.
 */
export interface PaymentReceipt {
  /** True when this payment renewed the plan; absent or false for the payment that started it. */
  renewal?: boolean
  /** False when a cancellation is scheduled, so the period end is when the plan stops, not when it renews. */
  renews?: boolean
  interval?: 'monthly' | 'annual' | null
  /** In the currency's minor unit (cents for USD), as payment providers state amounts. */
  amountPaid?: number | null
  /** ISO 4217, either case. */
  currency?: string | null
  paidAt?: Date | null
  periodStart?: Date | null
  /** Already worded for a person: "Visa ending in 4242". */
  paymentMethod?: string | null
  invoiceNumber?: string | null
  /** The provider's page for the invoice, where it and its receipt can be downloaded. */
  invoiceUrl?: string | null
  invoicePdfUrl?: string | null
  /** The organization the plan is for, when it is one. */
  organization?: string | null
  /** Where this plan's billing is managed. */
  billingUrl?: string | null
}

export interface PaymentReceiptEmailInput extends PaymentReceipt {
  /** The plan as customers know it ("Pro"), never its code. */
  plan: string
  periodEnd?: Date | null
  /** The origin every Backenly link points at. */
  appUrl: string
}

export interface PaymentReceiptEmail {
  subject: string
  html: string
  text: string
}

/** Where a reply lands. The From address may be a no-reply sender. */
export const RECEIPT_REPLY_TO = 'Backenly <support@backenly.com>'

/**
 * The palette, from components/console/tokens.ts and the landing page. Solid
 * hex throughout, because Outlook for Windows draws no rgba().
 */
const C = {
  ground: '#08090a', // the landing page ground, the console's chrome
  panel: '#0e0f11', // a raised panel, like the landing's BentoCell
  edge: '#1c1d20', // a panel's outline and the section rules
  control: '#27272a', // a secondary button's outline (zinc-800)
  heading: '#fafafa', // zinc-50
  strong: '#e4e4e7', // zinc-200
  body: '#a1a1aa', // zinc-400, supporting copy
  faint: '#8b8b94', // text-faint, labels and meta
  link: '#a78bfa', // violet-400, links in prose
  action: '#fafafa', // the white primary action
  onAction: '#09090b',
} as const

/**
 * Geist where it is installed, the platform's own face everywhere else. Mail
 * clients do not load the site's web font, and loading one would hand the
 * reader's address and IP to a font host when they open the message.
 */
const SANS = "Geist,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
/** An invoice number is an identifier, and identifiers are set in mono. */
const MONO = "'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A link the receipt may print: https only, whatever a provider sent. */
function safeUrl(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null
}

/**
 * "$25.00" from 2500 and "usd". The currency's own number of decimals decides
 * the minor unit, so ¥2,500 is 2500 and not 25. An unknown code is printed
 * after the amount rather than failing the receipt.
 */
export function formatAmount(minor: number, currency: string): string {
  const code = currency.toUpperCase()
  try {
    const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2
    return format.format(minor / 10 ** digits)
  } catch {
    return `${(minor / 100).toFixed(2)} ${code}`
  }
}

const LONG: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }
const SHORT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
const SHORT_NO_YEAR: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' }

/** "November 25, 2026", in UTC. */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString('en-US', LONG)
}

/** "Nov 25, 2026", in UTC. */
export function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-US', SHORT)
}

/** "Oct 25 – Nov 25, 2026", or with both years when the period crosses one. */
export function formatPeriod(start: Date, end: Date): string {
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear()
  const from = start.toLocaleDateString('en-US', sameYear ? SHORT_NO_YEAR : SHORT)
  return `${from} – ${formatShortDate(end)}`
}

function validDate(value: Date | null | undefined): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null
}

/** A run of text with its own font, as every run in mail has to carry. */
function span(style: string, content: string): string {
  return `<span style="font-family:${SANS};${style}">${content}</span>`
}

function paragraph(content: string, opts: { size?: number; color?: string; top?: number } = {}): string {
  const size = opts.size ?? 15
  return `<p style="margin:${opts.top ?? 0}px 0 0;font-family:${SANS};font-size:${size}px;line-height:${size === 15 ? 24 : 21}px;letter-spacing:-0.006em;color:${opts.color ?? C.body};">${content}</p>`
}

/** A full-width hairline between sections. */
function rule(top: number): string {
  return `<tr><td class="px" style="padding:${top}px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${C.edge};font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td></tr></table></td></tr>`
}

/**
 * A button made of a padded link. Outlook for Windows ignores padding on a
 * link, so there its width and height come from the spacers instead.
 */
function button(label: string, href: string, kind: 'primary' | 'secondary'): string {
  const primary = kind === 'primary'
  const fill = primary ? C.action : C.panel
  const ink = primary ? C.onAction : C.heading
  const outline = primary ? '' : `border:1px solid ${C.control};`
  const pad = primary ? '12px 22px' : '11px 18px'
  // Separate borders: a collapsed table draws a cell's outline square.
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>` +
    `<td align="center" bgcolor="${fill}" style="border-radius:8px;background-color:${fill};${outline}">` +
    `<a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:${pad};font-family:${SANS};font-size:15px;line-height:20px;font-weight:600;letter-spacing:-0.01em;color:${ink};text-decoration:none;border-radius:8px;mso-padding-alt:0;">` +
    `<!--[if mso]><i style="mso-font-width:150%;mso-text-raise:24pt" hidden>&emsp;</i><span style="mso-text-raise:12pt;"><![endif]-->` +
    escapeHtml(label) +
    `<!--[if mso]></span><i style="mso-font-width:150%;" hidden>&emsp;&#8203;</i><![endif]-->` +
    `</a></td></tr></table>`
  )
}

interface Row {
  label: string
  value: string
  /** HTML for the value, already escaped; `value` is what the plain text says. */
  html?: string
}

/** One line of the receipt: a label on the left, its value on the right. */
function detailRow(row: Row, first: boolean): string {
  const top = first ? 0 : 6
  return `<tr>
<td valign="top" style="padding:${top}px 16px 0 0;white-space:nowrap;">${span(`font-size:14px;line-height:22px;color:${C.faint};`, escapeHtml(row.label))}</td>
<td align="right" valign="top" style="padding:${top}px 0 0;">${row.html ?? span(`font-size:14px;line-height:22px;color:${C.strong};font-variant-numeric:tabular-nums;`, escapeHtml(row.value))}</td>
</tr>`
}

/**
 * The receipt, rendered. Pure: the same input gives the same message, so it can
 * be previewed and tested without a database, a provider or a mail server.
 */
export function renderPaymentReceiptEmail(input: PaymentReceiptEmailInput): PaymentReceiptEmail {
  const e = escapeHtml
  const app = input.appUrl.replace(/\/+$/, '')
  const href = {
    home: app,
    billing: safeUrl(input.billingUrl) ?? `${app}/app/billing`,
    settings: `${app}/app/settings?tab=notifications`,
    privacy: `${app}/privacy`,
    terms: `${app}/terms`,
    invoice: safeUrl(input.invoiceUrl),
    pdf: safeUrl(input.invoicePdfUrl),
  }

  const plan = input.plan
  const periodEnd = validDate(input.periodEnd)
  const periodStart = validDate(input.periodStart)
  const paidAt = validDate(input.paidAt)
  const amount =
    typeof input.amountPaid === 'number' && Number.isFinite(input.amountPaid) && input.currency
      ? formatAmount(input.amountPaid, input.currency)
      : null
  const invoiceNumber = input.invoiceNumber?.trim() || null
  const organization = input.organization?.trim() || null
  const paymentMethod = input.paymentMethod?.trim() || null

  const headline = input.renewal ? `Your ${plan} plan has renewed.` : `Your ${plan} plan is active.`
  const thanks = input.renewal ? 'Thanks for staying with Backenly.' : 'Thanks for subscribing.'
  const received = amount ? `We received your payment of ${amount}` : 'We received your payment'
  const next = periodEnd
    ? input.renews === false
      ? `, and your plan stays active until ${formatLongDate(periodEnd)}.`
      : `, and your plan renews on ${formatLongDate(periodEnd)}.`
    : '.'
  const lede = `${thanks} ${received}${next}`

  const subject = invoiceNumber ? `Your receipt from Backenly #${invoiceNumber}` : 'Your receipt from Backenly'
  const preheader = `${headline} ${amount ? `${amount} paid` : 'Payment received'}${paidAt ? ` on ${formatShortDate(paidAt)}` : ''}.`

  const billed = input.interval === 'annual' ? 'billed annually' : input.interval === 'monthly' ? 'billed monthly' : null
  const rows: Row[] = [{ label: 'Plan', value: billed ? `${plan}, ${billed}` : plan }]
  if (periodStart && periodEnd) rows.push({ label: 'Billing period', value: formatPeriod(periodStart, periodEnd) })
  if (organization) rows.push({ label: 'Organization', value: organization })
  if (paidAt) rows.push({ label: 'Paid on', value: formatShortDate(paidAt) })
  if (paymentMethod) rows.push({ label: 'Payment method', value: paymentMethod })
  if (invoiceNumber) {
    rows.push({
      label: 'Invoice number',
      value: invoiceNumber,
      html: `<span style="font-family:${MONO};font-size:13px;line-height:22px;color:${C.strong};">${e(invoiceNumber)}</span>`,
    })
  }

  // The total leads the panel, apart from the details under it; with no amount
  // known the panel is the details alone.
  const totalRow = amount
    ? `<tr><td style="padding:16px 20px;" class="cell">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="padding:0;">${span(`font-size:15px;line-height:24px;font-weight:500;color:${C.strong};`, 'Amount paid')}</td>
<td align="right" valign="middle" style="padding:0 0 0 16px;">${span(`font-size:17px;line-height:24px;font-weight:600;letter-spacing:-0.01em;color:${C.heading};font-variant-numeric:tabular-nums;`, e(amount))}</td>
</tr></table>
</td></tr>`
    : ''
  const detailsRow = `<tr><td class="cell" style="${amount ? `border-top:1px solid ${C.edge};` : ''}padding:14px 20px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows.map((r, i) => detailRow(r, i === 0)).join('\n')}
</table>
</td></tr>`
  const panel =
    `<tr><td class="px" style="padding:28px 40px 0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background-color:${C.panel};border:1px solid ${C.edge};border-radius:12px;border-collapse:separate;">` +
    totalRow +
    detailsRow +
    `</table></td></tr>`

  // The invoice when there is one, with its PDF beside it; otherwise Billing.
  const actions = href.invoice
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td valign="top" style="padding:0;">${button('View invoice', href.invoice, 'primary')}</td>` +
      (href.pdf ? `<td valign="top" style="padding:0 0 0 12px;">${button('Download PDF', href.pdf, 'secondary')}</td>` : '') +
      `</tr></table>`
    : button('Open billing', href.billing, 'primary')

  const link = (url: string, label: string) =>
    `<a href="${e(url)}" target="_blank" style="color:${C.link};text-decoration:none;font-weight:500;">${label}</a>`
  const help = href.invoice
    ? `Change your plan or payment method any time in ${link(href.billing, 'Billing')}. If anything about this payment looks wrong, reply to this email. It reaches the team that builds Backenly.`
    : 'If anything about this payment looks wrong, reply to this email. It reaches the team that builds Backenly.'

  const html = `<!DOCTYPE html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${e(subject)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>td, th, p, a, span, h1, h2 { font-family: 'Segoe UI', Arial, sans-serif !important; }</style>
<![endif]-->
<style>
:root { color-scheme: dark; supported-color-schemes: dark; }
body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; font-size: inherit !important; font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important; }
@media only screen and (max-width: 620px) {
  .px { padding-left: 24px !important; padding-right: 24px !important; }
  .frame { padding-top: 32px !important; padding-bottom: 40px !important; }
  .h1 { font-size: 26px !important; line-height: 32px !important; }
  .cell { padding-left: 16px !important; padding-right: 16px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${C.ground};">
<div role="article" aria-roledescription="email" aria-label="${e(subject)}" lang="en" dir="ltr" style="background-color:${C.ground};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.ground};opacity:0;">${e(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(80)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.ground}" style="background-color:${C.ground};">
<tr><td align="center" class="frame" style="padding:48px 0 56px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;">

<tr><td class="px" style="padding:0 40px;">
<a href="${e(href.home)}" target="_blank" style="text-decoration:none;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="padding:0 10px 0 0;"><img src="cid:${BACKENLY_MARK_CID}" width="28" height="28" alt="" style="display:block;width:28px;height:28px;border:0;border-radius:7px;"></td>
<td valign="middle" style="padding:0;">${span(`font-size:17px;line-height:28px;font-weight:600;letter-spacing:-0.012em;color:${C.heading};`, 'Backenly')}</td>
</tr></table>
</a>
</td></tr>

<tr><td class="px" style="padding:40px 40px 0;">
<h1 class="h1" style="margin:0;font-family:${SANS};font-size:30px;line-height:36px;font-weight:600;letter-spacing:-0.03em;color:${C.heading};">${e(headline)}</h1>
${paragraph(e(lede), { top: 14 })}
</td></tr>

${panel}

<tr><td class="px" style="padding:24px 40px 0;">${actions}</td></tr>

${rule(40)}
<tr><td class="px" style="padding:28px 40px 0;">
${paragraph(help)}
${paragraph('The Backenly team', { top: 16, color: C.heading })}
</td></tr>

${rule(40)}
<tr><td class="px" style="padding:24px 40px 0;">
${paragraph(`You’re receiving this receipt because you pay for a Backenly plan. Choose which emails you get in <a href="${e(href.settings)}" target="_blank" style="color:${C.faint};text-decoration:underline;">notification settings</a>.`, { size: 13, color: C.faint })}
${paragraph(`Backenly, Inc. &middot; <a href="${e(href.privacy)}" target="_blank" style="color:${C.faint};text-decoration:underline;">Privacy</a> &middot; <a href="${e(href.terms)}" target="_blank" style="color:${C.faint};text-decoration:underline;">Terms</a>`, { size: 13, color: C.faint, top: 8 })}
</td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</div>
</body>
</html>
`

  const labelWidth = Math.max(...rows.map((r) => r.label.length), amount ? 'Amount paid'.length : 0) + 2
  const line = (label: string, value: string) => `${(label + ':').padEnd(labelWidth)}${value}`
  const text = [
    headline,
    '',
    lede,
    '',
    ...(amount ? [line('Amount paid', amount)] : []),
    ...rows.map((r) => line(r.label, r.value)),
    '',
    ...(href.invoice
      ? [`View invoice: ${href.invoice}`, ...(href.pdf ? [`Download PDF: ${href.pdf}`] : []), '', `Change your plan or payment method any time in Billing: ${href.billing}`]
      : [`Open billing: ${href.billing}`]),
    'If anything about this payment looks wrong, reply to this email. It reaches the team that builds Backenly.',
    '',
    'The Backenly team',
    '',
    '--',
    `You’re receiving this receipt because you pay for a Backenly plan. Choose which emails you get in notification settings: ${href.settings}`,
    `Backenly, Inc. · Privacy: ${href.privacy} · Terms: ${href.terms}`,
    '',
  ].join('\n')

  return { subject, html, text }
}
