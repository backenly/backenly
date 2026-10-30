/**
 * A CRITICAL-ISSUE EMAIL SAYS WHAT IS WRONG AND WHY IT WAITS FOR YOU
 * ===================================================================
 * The email for a confirmed critical used to be the old notification shell: a
 * gradient button, the title repeated as subject and headline, finding
 * summaries with their backticks printed raw ("RLS missing on `qual_items`")
 * in a one-item bullet list, and nothing on why Backenly had not fixed it
 * itself. No plain-text part, and no way to reply.
 *
 * Now notifyCritical stores the issues as the Autonomy page's review queue
 * folds them (lib/autonomy/critical-alert.ts), and the email
 * (lib/notifications/health-alert-email.ts):
 *   - counts findings as the queue does, one row per root cause, titled with
 *     the queue's own sentence and its machine names set in mono;
 *   - says under each row why it waits for a person, in the queue's words;
 *   - says since when it has waited when it is a reminder;
 *   - escapes what projects, tables and agents named, and links only to http(s);
 *   - carries a plain-text part and the site's own mark, and on Backenly Cloud
 *     replies reach support. A self-hosted install's alert promises no reply.
 *
 * Database-free: everything here is a pure function of what it is given.
 */
import { renderHealthAlertEmail, type HealthAlertEmailInput } from '@/lib/notifications/health-alert-email'
import { criticalAlertIssues, type AlertFinding } from '@/lib/autonomy/critical-alert'
import { buildNotificationEmail } from '@/lib/notifications/email-templates'
import { BACKENLY_MARK_CID } from '@/lib/email/backenly-mark'

const EMOJI = new RegExp('\\p{Extended_Pictographic}', 'u')
const MONO = "'Geist Mono'"

const NOW = new Date('2026-10-30T05:40:00Z')
const AUTONOMY = 'https://backenly.com/app/projects/p1/autonomy'

/**
 * What a reader sees, near enough: tags become spaces, which a full stop after
 * a link does not have, and entities are decoded, `&amp;` last.
 */
function visible(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,])/g, '$1')
}

function render(overrides: Partial<HealthAlertEmailInput> = {}) {
  return renderHealthAlertEmail({
    project: 'Acme API',
    issues: [{
      title: 'RLS missing on `orders`',
      explanation: 'Backenly has a fix ready, and your autonomy settings hold it for your approval.',
    }],
    count: 1,
    firstSeen: new Date(NOW.getTime() - 40 * 60 * 1000),
    actionUrl: AUTONOMY,
    appUrl: 'https://backenly.com',
    cloud: true,
    now: NOW,
    ...overrides,
  })
}

/** An RLS finding whose owner Backenly could not work out, as detectMissingRls records it. */
function undecidable(tableName: string): AlertFinding {
  return {
    type: 'missing_rls',
    severity: 'critical',
    details: {
      tableName,
      rlsTemplate: null,
      rlsBasis: 'undecidable',
      rlsRationale: `Backenly cannot tell who owns a row in "${tableName}": no column references users(id).`,
    },
  }
}

describe('the critical-issue email', () => {
  it('names the project, the issue in the queue’s words, and why it waits for you', () => {
    const { subject, html } = render()

    expect(subject).toBe('Critical issue in Acme API')
    const shown = visible(html)
    expect(shown).toContain('Your backend has a critical issue')
    expect(shown).toContain('Backenly found a problem in Acme API that it can’t fix without you. It’s waiting for you on the Autonomy page.')
    expect(shown).toContain('RLS missing on orders')
    expect(shown).toContain('Backenly has a fix ready, and your autonomy settings hold it for your approval.')
    expect(shown).toContain('Review the issue')

    // The table is set in mono, as the console sets it; no backtick is printed.
    expect(html).toMatch(new RegExp(`font-family:${MONO}[^"]*">orders</span>`))
    expect(html).not.toContain('`')
    expect(html).toContain(`href="${AUTONOMY}"`)
    expect(html).toContain(`src="cid:${BACKENLY_MARK_CID}"`)

    // None of the old shell: no gradient, no emoji, no title repeated as the subject.
    expect(html).not.toContain('linear-gradient')
    for (const part of [subject, html]) expect(part).not.toMatch(EMOJI)
    expect(subject).not.toContain('— Backenly')
  })

  it('counts findings as the queue does, and folds a shared cause into one row', () => {
    const { subject, html } = render({
      count: 3,
      issues: [
        { title: '2 tables exposing user data have no row-level security', subjects: ['invoices', 'invoice_lines'], findings: 2, explanation: 'Backenly will not enable row-level security on these tables until it knows who owns a row.' },
        { title: 'A webhook is failing to deliver', findings: 1, explanation: 'Webhook repair requires action in an external dashboard (e.g. Stripe, GitHub).' },
      ],
    })
    expect(subject).toBe('3 critical issues in Acme API')
    const shown = visible(html)
    expect(shown).toContain('Your backend has 3 critical issues')
    expect(shown).toContain('Backenly found problems in Acme API that it can’t fix without you. They’re waiting for you on the Autonomy page.')
    expect(shown).toContain('On invoices and invoice_lines.')
    expect(shown).toContain('Review the issues')
    expect(shown).not.toContain('more issue')
  })

  it('shows five rows and counts the rest, which the queue has', () => {
    const issues = Array.from({ length: 8 }, (_, i) => ({ title: `Issue ${i + 1}` }))
    const shown = visible(render({ count: 8, issues }).html)
    expect(shown).toContain('Issue 5')
    expect(shown).not.toContain('Issue 6')
    expect(shown).toContain('3 more issues are waiting on the Autonomy page.')
  })

  it('says since when it has waited, once it is a reminder', () => {
    const reminder = visible(render({ firstSeen: new Date('2026-10-27T09:12:00Z') }).html)
    expect(reminder).toContain('It has been waiting for you on the Autonomy page since October 27, 2026.')

    const fresh = visible(render({ firstSeen: new Date(NOW.getTime() - 3 * 60 * 60 * 1000) }).html)
    expect(fresh).toContain('It’s waiting for you on the Autonomy page.')
    expect(fresh).not.toContain('since')
  })

  it('carries everything in its plain-text part too', () => {
    const { text } = render()
    for (const line of [
      'Your backend has a critical issue',
      'Backenly found a problem in Acme API that it can’t fix without you.',
      '- RLS missing on orders',
      '  Backenly has a fix ready, and your autonomy settings hold it for your approval.',
      `Review the issue: ${AUTONOMY}`,
      'reply to this email',
      'https://backenly.com/app/settings?tab=notifications',
    ]) {
      expect(text).toContain(line)
    }
    expect(text).not.toContain('`')
  })

  it('escapes what projects, tables and agents named, and links only to http(s)', () => {
    const { html, text } = render({
      project: '<img src=x onerror=alert(1)>',
      issues: [{
        title: '`<b>orders</b>` changed "><script>',
        subjects: ['<i>a</i>', 'b'],
        findings: 2,
        explanation: '<script>steal()</script>',
      }],
      count: 2,
      actionUrl: 'javascript:alert(1)',
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>orders</b>')
    expect(html).not.toContain('<i>a</i>')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="https://backenly.com/app"')
    expect(text).not.toContain('javascript:')
  })

  it('promises a reply and names the company only on Backenly Cloud', () => {
    const cloud = render({ cloud: true })
    expect(visible(cloud.html)).toContain('reply to this email. It reaches the team that builds Backenly.')
    expect(visible(cloud.html)).toContain('Backenly, Inc. · Privacy · Terms')

    const selfHosted = render({ cloud: false })
    for (const part of [visible(selfHosted.html), selfHosted.text]) {
      expect(part).toContain('Once an issue is fixed, Backenly closes it on its next check.')
      expect(part).not.toContain('reply to this email')
      expect(part).not.toContain('Backenly, Inc.')
    }
  })
})

describe('what each row says', () => {
  it('says what Backenly will not guess when no repair exists, with the table in mono', () => {
    const [row] = criticalAlertIssues([undecidable('qual_items')])
    expect(row).toEqual({
      title: 'RLS missing on `qual_items`',
      subjects: [],
      findings: 1,
      explanation:
        'Backenly will not enable row-level security on `qual_items` until it knows who owns a row, ' +
        'because a policy that matches nothing makes the table read empty for every user.',
    })
  })

  it('folds one cause on several tables into one row that names them all', () => {
    const rows = criticalAlertIssues([undecidable('invoices'), undecidable('invoice_lines')])
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('2 tables exposing user data have no row-level security')
    expect(rows[0].subjects).toEqual(['invoices', 'invoice_lines'])
    expect(rows[0].findings).toBe(2)
    expect(rows[0].explanation).toContain('row-level security on these tables until')
    expect(rows[0].explanation).not.toContain('invoices')
  })

  it('gives the guardrail’s reason for a repair that always waits for a person', () => {
    const [row] = criticalAlertIssues([{
      type: 'broken_webhook',
      severity: 'critical',
      details: { triggerId: 't1', failureCount: 14, reason: 'Webhook trigger has dead-letter failures in the last 24 hours' },
    }])
    expect(row.title).toBe('A webhook is failing to deliver')
    expect(row.explanation).toBe('Webhook repair requires action in an external dashboard (e.g. Stripe, GitHub).')
  })

  it('says a fix is ready when the autonomy settings hold it back', () => {
    const [row] = criticalAlertIssues([{
      type: 'missing_rls',
      severity: 'critical',
      details: {
        tableName: 'orders',
        rlsTemplate: 'own_rows',
        rlsBasis: 'direct',
        notAppliedBecause: 'The CONSERVATIVE autonomy mode does not apply tier 1 repairs on its own, so this is waiting for you.',
      },
    }])
    expect(row.explanation).toBe('Backenly has a fix ready, and your autonomy settings hold it for your approval.')
  })

  it('says so first when Backenly fixed it before and it came back', () => {
    const [row] = criticalAlertIssues([{
      type: 'broken_webhook',
      severity: 'critical',
      details: {
        triggerId: 't1',
        escalated: true,
        escalationReason: 'Backenly fixed this before and it came back, so it is waiting for you rather than being fixed again.',
      },
    }])
    expect(row.explanation).toBe('Backenly fixed this before and it came back, so it is waiting for you rather than being fixed again.')
  })

  it('leaves the explanation out rather than guess one', () => {
    const [row] = criticalAlertIssues([{
      type: 'missing_fk_index',
      severity: 'critical',
      details: { tableName: 'orders', columnName: 'customer_id' },
    }])
    expect(row.explanation).toBeNull()
  })
})

describe('the email of a health_alert notification', () => {
  const edition = process.env.BACKENLY_EDITION
  afterEach(() => {
    if (edition === undefined) delete process.env.BACKENLY_EDITION
    else process.env.BACKENLY_EDITION = edition
  })

  /** What notifyCritical stores for one undecidable table. */
  const stored = () => ({
    projectId: 'p1',
    projectName: 'v8q-built-20260925043052',
    count: 1,
    types: ['missing_rls'],
    summaries: ['RLS missing on `qual_items`'],
    issues: criticalAlertIssues([undecidable('qual_items')]),
    firstDetectedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    actionUrl: AUTONOMY,
  })

  it('renders what notifyCritical stores, carries the mark, and replies to support on Backenly Cloud', () => {
    process.env.BACKENLY_EDITION = 'cloud'
    const mail = buildNotificationEmail('health_alert', '1 critical issue in "v8q-built-20260925043052"', 'unused', stored())
    expect(mail.subject).toBe('Critical issue in v8q-built-20260925043052')
    expect(mail.replyTo).toBe('Backenly <support@backenly.com>')
    expect(mail.attachments).toEqual([expect.objectContaining({ cid: BACKENLY_MARK_CID, contentDisposition: 'inline' })])
    const shown = visible(mail.html)
    expect(shown).toContain('Backenly found a problem in v8q-built-20260925043052 that it can’t fix without you.')
    expect(shown).toContain('Backenly will not enable row-level security on qual_items until it knows who owns a row')
    expect(mail.text).toContain('- RLS missing on qual_items')
  })

  it('names no reply on a self-hosted install', () => {
    delete process.env.BACKENLY_EDITION
    const mail = buildNotificationEmail('health_alert', '1 critical issue in "v8q-built-20260925043052"', 'unused', stored())
    expect(mail.replyTo).toBeUndefined()
    expect(mail.text).not.toContain('reply to this email')
    expect(mail.attachments).toHaveLength(1)
  })

  it('still renders metadata stored before it carried the issues', () => {
    const { subject, html } = buildNotificationEmail('health_alert', '2 critical issues in "Acme API"', 'unused', {
      projectId: 'p1',
      count: 2,
      types: ['missing_rls', 'broken_webhook'],
      summaries: ['RLS missing on `orders`', 'A webhook is failing to deliver'],
      actionUrl: AUTONOMY,
    })
    expect(subject).toBe('2 critical issues in Acme API')
    const shown = visible(html)
    expect(shown).toContain('Backenly found problems in Acme API')
    expect(shown).toContain('RLS missing on orders')
    expect(shown).toContain('A webhook is failing to deliver')
  })
})
