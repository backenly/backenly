/**
 * The email that tells a project's owner about a critical issue Backenly
 * cannot fix without them.
 *
 * It is the email of a `health_alert` notification (notifyCritical in
 * lib/services/workspace-observer.ts), so the owner's "Backend health alerts"
 * setting decides whether it is sent. It names what is wrong in the words the
 * Autonomy page uses, one row per root cause as the review queue folds them
 * (lib/autonomy/critical-alert.ts), says under each why it waits for a person,
 * and links to the queue where it is decided.
 *
 * ── How it is built ──────────────────────────────────────────────────────────
 *
 * Built the way the receipt is (./payment-receipt-email.ts), in the design of
 * Backenly's other platform mail: the landing page's near-black ground, a
 * white primary action, violet only for links in prose, sentence case, and no
 * emoji. Severity is said in words, not in red. Built the way mail clients
 * need it:
 *
 *   - tables and inline styles, because some clients drop a <style> block and
 *     Outlook for Windows lays mail out with Word;
 *   - one column, 600px at most, with padding that tightens on a phone;
 *   - a button made of a padded link, so it still works with images off;
 *   - the mark carried inside the message (lib/email/backenly-mark.ts);
 *   - colors declared dark (`color-scheme`), so Apple Mail shows them as
 *     designed instead of inverting them, and every word at 4.5:1 or better
 *     against its background;
 *   - a plain-text part that says everything the HTML does.
 *
 * Names in backticks (`orders`) are machine names, set in mono as the console
 * sets them (TextWithCode); the plain-text part drops the backticks.
 */
import { BACKENLY_MARK_CID } from '@/lib/email/backenly-mark'
import { formatLongDate } from './payment-receipt-email'

/** One row of the email: one root cause, as the review queue shows it. */
export interface HealthAlertIssue {
  /** The queue's own sentence for it. Backticks mark machine names. */
  title: string
  /** The tables or resources it covers, when it covers more than one. */
  subjects?: string[]
  /** How many findings the row folds. */
  findings?: number
  /** Why it waits for a person, when that is known. */
  explanation?: string | null
}

export interface HealthAlertEmailInput {
  /** The project's name, or null when it is not known. */
  project: string | null
  /** Most severe first, as the queue orders them. */
  issues: HealthAlertIssue[]
  /** Findings in all, which the queue counts too; rows can fold several. */
  count: number
  /** When the oldest of them was first seen. */
  firstSeen?: Date | null
  /** The project's Autonomy page. */
  actionUrl: string
  /** The origin every other Backenly link points at. */
  appUrl: string
  /**
   * True on Backenly Cloud, where a reply reaches Backenly's team and the
   * footer names the company. A self-hosted install sends this alert too, and
   * its mail promises neither: its operator is not Backenly.
   */
  cloud: boolean
  /** The moment of sending; the clock unless a test sets it. */
  now?: Date
}

export interface HealthAlertEmail {
  subject: string
  html: string
  text: string
}

/** Where a reply lands. The From address may be a no-reply sender. */
export const HEALTH_ALERT_REPLY_TO = 'Backenly <support@backenly.com>'

/** Rows shown in the message. The rest are counted, and the queue has them all. */
export const HEALTH_ALERT_MAX_ROWS = 5

/** Names listed under a row that folds several. */
const MAX_SUBJECTS = 6

/** A critical older than this is a reminder, and the message says since when it has waited. */
const REMINDER_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * The palette, from components/console/tokens.ts and the landing page, as the
 * receipt uses it. Solid hex throughout, because Outlook for Windows draws no
 * rgba().
 */
const C = {
  ground: '#08090a', // the landing page ground, the console's chrome
  panel: '#0e0f11', // a raised panel, like the landing's BentoCell
  edge: '#1c1d20', // a panel's outline and the section rules
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
/** Table and resource names are identifiers, and identifiers are set in mono. */
const MONO = "'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A link the message may print: our own pages, so http(s) only. */
function safeUrl(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(url) ? url : null
}

/** An identifier in a run of text, set as the console sets it. */
function code(name: string, size: number): string {
  return `<span style="font-family:${MONO};font-size:${size}px;color:${C.strong};">${escapeHtml(name)}</span>`
}

/**
 * Prose, escaped, with a short hyphenated word kept on one line: a phone
 * column broke "row-level" into "row-" and "level".
 */
function prose(text: string): string {
  return escapeHtml(text).replace(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g, (word) =>
    word.length <= 20 ? `<span style="white-space:nowrap;">${word}</span>` : word,
  )
}

/**
 * Text with its backtick spans set in mono, everything escaped. An unmatched
 * backtick is printed as written, as TextWithCode does.
 */
function withCode(text: string, codeSize: number): string {
  const parts = text.split('`')
  if (parts.length % 2 === 0) return prose(text)
  return parts.map((part, i) => (i % 2 === 1 ? code(part, codeSize) : prose(part))).join('')
}

/** The same text for the plain-text part. */
function plain(text: string): string {
  const parts = text.split('`')
  return parts.length % 2 === 0 ? text : parts.join('')
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
 * The primary action: a padded link. Outlook for Windows ignores padding on a
 * link, so there its width and height come from the spacers instead.
 */
function button(label: string, href: string): string {
  // Separate borders: a collapsed table draws a cell's outline square.
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>` +
    `<td align="center" bgcolor="${C.action}" style="border-radius:8px;background-color:${C.action};">` +
    `<a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-size:15px;line-height:20px;font-weight:600;letter-spacing:-0.01em;color:${C.onAction};text-decoration:none;border-radius:8px;mso-padding-alt:0;white-space:nowrap;">` +
    `<!--[if mso]><i style="mso-font-width:150%;mso-text-raise:24pt" hidden>&emsp;</i><span style="mso-text-raise:12pt;"><![endif]-->` +
    escapeHtml(label) +
    `<!--[if mso]></span><i style="mso-font-width:150%;" hidden>&emsp;&#8203;</i><![endif]-->` +
    `</a></td></tr></table>`
  )
}

/** "a", "a and b", "a, b and c". */
function list(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** The names a folded row covers, at most MAX_SUBJECTS of them, then how many more. */
function subjectsLine(subjects: string[], render: (name: string) => string): string {
  const shown = subjects.slice(0, MAX_SUBJECTS).map(render)
  const rest = subjects.length - shown.length
  return `On ${list(rest > 0 ? [...shown, `${rest} more`] : shown)}.`
}

/** A headline's last two words kept together, so a phone does not leave one alone on a line. */
function noWidow(html: string): string {
  const at = html.lastIndexOf(' ')
  return at > 0 ? `${html.slice(0, at)}&nbsp;${html.slice(at + 1)}` : html
}

function validDate(value: Date | null | undefined): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null
}

/**
 * The message, rendered. Pure: the same input gives the same message, so it
 * can be previewed and tested without a database or a mail server.
 */
export function renderHealthAlertEmail(input: HealthAlertEmailInput): HealthAlertEmail {
  const e = escapeHtml
  const app = input.appUrl.replace(/\/+$/, '')
  const href = {
    home: app,
    autonomy: safeUrl(input.actionUrl) ?? `${app}/app`,
    settings: `${app}/app/settings?tab=notifications`,
    privacy: `${app}/privacy`,
    terms: `${app}/terms`,
  }

  const project = input.project?.trim() || null
  const issues = input.issues.filter((i) => typeof i.title === 'string' && i.title.trim())
  const count = Math.max(1, Math.floor(input.count) || 0, issues.length)
  const one = count === 1

  const now = validDate(input.now) ?? new Date()
  const firstSeen = validDate(input.firstSeen)
  const since = firstSeen && now.getTime() - firstSeen.getTime() >= REMINDER_AFTER_MS ? formatLongDate(firstSeen) : null

  const headline = one ? 'Your backend has a critical issue' : `Your backend has ${count} critical issues`
  const subject = project
    ? `${one ? 'Critical issue' : `${count} critical issues`} in ${project}`
    : headline

  // Written once, from parts each version renders its own way: the project is
  // brighter in the HTML and the page is a link there.
  const lede = (name: string | null, page: string) => {
    const found = `Backenly found ${one ? 'a problem' : 'problems'}${name ? ` in ${name}` : ''} that it can’t fix without you.`
    const waiting = one
      ? since ? `It has been waiting for you on the ${page} since ${since}.` : `It’s waiting for you on the ${page}.`
      : since ? `They’re waiting for you on the ${page}, the oldest since ${since}.` : `They’re waiting for you on the ${page}.`
    return `${found} ${waiting}`
  }
  const ledeHtml = lede(
    project && `<span style="color:${C.strong};">${e(project)}</span>`,
    `<a href="${e(href.autonomy)}" target="_blank" style="color:${C.link};text-decoration:none;font-weight:500;">Autonomy page</a>`,
  )
  const ledeText = lede(project, 'Autonomy page')

  const shown = issues.slice(0, HEALTH_ALERT_MAX_ROWS)
  const shownFindings = shown.reduce((n, i) => n + Math.max(1, i.findings ?? 1), 0)
  const more = Math.max(0, count - shownFindings)
  const moreLine = more > 0 ? `${more} more ${more === 1 ? 'issue is' : 'issues are'} waiting on the Autonomy page.` : null

  const first = issues[0]
  const preheader = first
    ? `${plain(first.title)}${count > Math.max(1, first.findings ?? 1) ? `, and ${count - Math.max(1, first.findings ?? 1)} more` : ''}. ${one ? 'It’s' : 'They’re'} waiting for you on the Autonomy page.`
    : ledeText

  const rows = shown.map((issue, i) => {
    const subjects = (issue.subjects ?? []).filter((s) => typeof s === 'string' && s)
    const explanation = issue.explanation?.trim() || null
    return (
      `<tr><td class="cell" style="${i === 0 ? '' : `border-top:1px solid ${C.edge};`}padding:16px 20px 18px;">` +
      `<p style="margin:0;font-family:${SANS};font-size:15px;line-height:22px;font-weight:500;letter-spacing:-0.01em;color:${C.heading};">${withCode(issue.title, 14)}</p>` +
      (subjects.length > 1 ? paragraph(subjectsLine(subjects, (s) => code(s, 13)), { size: 14, top: 6 }) : '') +
      (explanation ? paragraph(withCode(explanation, 13), { size: 14, top: 6 }) : '') +
      `</td></tr>`
    )
  })
  if (moreLine) {
    rows.push(
      `<tr><td class="cell" style="border-top:1px solid ${C.edge};padding:14px 20px 16px;">${paragraph(e(moreLine), { size: 14, color: C.faint })}</td></tr>`,
    )
  }
  const panel = rows.length
    ? `<tr><td class="px" style="padding:28px 40px 0;">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.panel}" style="background-color:${C.panel};border:1px solid ${C.edge};border-radius:12px;border-collapse:separate;">` +
      rows.join('\n') +
      `</table></td></tr>`
    : ''

  const action = one ? 'Review the issue' : 'Review the issues'
  const help = input.cloud
    ? 'Once an issue is fixed, Backenly closes it on its next check. If something here looks wrong, reply to this email. It reaches the team that builds Backenly.'
    : 'Once an issue is fixed, Backenly closes it on its next check.'
  const why = (name: string) =>
    `You’re receiving this because you own ${name} on Backenly. We email you about a critical issue only after a second check confirms it, and at most once a day for each project.`
  const whyHtml = why(project ? e(project) : 'this backend')
  const whyText = why(project ?? 'this backend')

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
<h1 class="h1" style="margin:0;font-family:${SANS};font-size:30px;line-height:36px;font-weight:600;letter-spacing:-0.03em;color:${C.heading};">${noWidow(e(headline))}</h1>
<p style="margin:14px 0 0;font-family:${SANS};font-size:15px;line-height:24px;letter-spacing:-0.006em;color:${C.body};word-break:break-word;">${ledeHtml}</p>
</td></tr>

${panel}

<tr><td class="px" style="padding:24px 40px 0;">${button(action, href.autonomy)}</td></tr>

${rule(40)}
<tr><td class="px" style="padding:28px 40px 0;">
${paragraph(e(help))}
</td></tr>

${rule(40)}
<tr><td class="px" style="padding:24px 40px 0;">
${paragraph(`${whyHtml} Choose which emails you get in <a href="${e(href.settings)}" target="_blank" style="color:${C.faint};text-decoration:underline;">notification settings</a>.`, { size: 13, color: C.faint })}
${input.cloud ? paragraph(`Backenly, Inc. &middot; <a href="${e(href.privacy)}" target="_blank" style="color:${C.faint};text-decoration:underline;">Privacy</a> &middot; <a href="${e(href.terms)}" target="_blank" style="color:${C.faint};text-decoration:underline;">Terms</a>`, { size: 13, color: C.faint, top: 8 }) : ''}
</td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</div>
</body>
</html>
`

  const issueText = shown.flatMap((issue) => {
    const subjects = (issue.subjects ?? []).filter((s) => typeof s === 'string' && s)
    const explanation = issue.explanation?.trim() || null
    return [
      `- ${plain(issue.title)}`,
      ...(subjects.length > 1 ? [`  ${subjectsLine(subjects, (s) => s)}`] : []),
      ...(explanation ? [`  ${plain(explanation)}`] : []),
    ]
  })
  const text = [
    headline,
    '',
    ledeText,
    '',
    ...issueText,
    ...(moreLine ? [moreLine] : []),
    ...(issueText.length || moreLine ? [''] : []),
    `${action}: ${href.autonomy}`,
    '',
    help,
    '',
    '--',
    `${whyText} Choose which emails you get in notification settings: ${href.settings}`,
    ...(input.cloud ? [`Backenly, Inc. · Privacy: ${href.privacy} · Terms: ${href.terms}`] : []),
    '',
  ].join('\n')

  return { subject, html, text }
}
