/**
 * The template editor starts from the built-in auth emails (Data B4,
 * 2026-11-16). Before, Edit on a template nobody had customised opened two
 * empty boxes, because the list answered null for a built-in: the only way to
 * change one sentence was to rewrite the whole email from memory.
 *
 * The built-in wording now lives once, in lib/email/auth-builtins.ts, and both
 * the send path and the template list read it. These pin the two halves of
 * "starts from the built-in":
 *   - the text the editor receives is a valid template, so saving it
 *     unchanged is accepted;
 *   - rendering that text with a send's values gives exactly the email the
 *     send path builds, so the editor shows what is really sent.
 *
 * Database-free: the template list's one read is stubbed.
 */

import { BUILT_IN_EXPIRY, builtInAuthEmail, builtInAuthTemplate } from '@/lib/email/auth-builtins'
import { TEMPLATE_KINDS, renderSubject, renderTemplate, validateTemplate } from '@/lib/email/template-kinds'

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    projectEmailTemplate: {
      findMany: jest.fn(async () => [
        { kind: 'password_reset', subject: 'Mine', bodyHtml: '<a href="{{ctaUrl}}">Reset</a>', updatedAt: new Date('2026-11-09T10:00:00Z') },
      ]),
    },
  },
}))

import { listProjectTemplates } from '@/lib/email/project-templates'

// No apostrophes in the sample: renderTemplate escapes ' as &#39; and the
// built-in leaves it as is, which a mail client shows the same.
const SAMPLE = { appName: 'Movie Night', email: 'tomas.rivera@example.com', ctaUrl: 'https://movienight.app/reset?token=a1b2&x=1' }

describe.each(TEMPLATE_KINDS)('the built-in %s email', (kind) => {
  const template = builtInAuthTemplate(kind)
  const values = { ...SAMPLE, expiry: BUILT_IN_EXPIRY[kind] }

  it('is a template the editor can save unchanged', () => {
    expect(validateTemplate(template.subject, template.bodyHtml)).toEqual([])
    expect(template.bodyHtml).toContain('{{ctaUrl}}')
  })

  it('renders to exactly the email the send path builds', () => {
    const sent = builtInAuthEmail(kind, values)
    expect(renderSubject(template.subject, values)).toBe(sent.subject)
    expect(renderTemplate(template.bodyHtml, values)).toBe(sent.bodyHtml)
  })

  it('says how long the link lasts, as the send path does', () => {
    expect(builtInAuthEmail(kind, values).bodyHtml).toContain(BUILT_IN_EXPIRY[kind])
  })
})

it('the template list carries each built-in beside the override', async () => {
  const list = await listProjectTemplates('p1')
  expect(list.templates.map((t) => t.kind)).toEqual([...TEMPLATE_KINDS])
  for (const t of list.templates) {
    expect(t.builtIn).toEqual(builtInAuthTemplate(t.kind))
  }
  const reset = list.templates.find((t) => t.kind === 'password_reset')!
  expect(reset.customised).toBe(true)
  expect(reset.subject).toBe('Mine')
  const verification = list.templates.find((t) => t.kind === 'verification')!
  expect(verification.customised).toBe(false)
  expect(verification.subject).toBeNull()
  expect(verification.builtIn.subject).toBe('Verify your {{appName}} email')
})
