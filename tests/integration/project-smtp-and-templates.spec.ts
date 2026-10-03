/**
 * PER-PROJECT SMTP AND OPERATOR TEMPLATES, PROVEN BY MAIL THAT ACTUALLY LEFT
 * =========================================================================
 *
 * Both rows were PARTIAL in the derived register for the same reason: the thing
 * itself was real and there was no way to configure it. A transport read
 * SMTP_HOST/SMTP_USER/SMTP_PASS from deployment env; the subjects and bodies
 * were string literals in TypeScript.
 *
 * "Configured" and "works" are different claims, so this suite refuses to prove
 * the first and report the second. Every delivery assertion is made on the
 * bytes a real SMTP server received after a real STARTTLS handshake — not on a
 * return value, not on a captured nodemailer call.
 *
 * ── The dangerous cases, stated plainly ─────────────────────────────────────
 *
 *  - a stored password must never come back out of any read path
 *  - a row that cannot be decrypted must NOT quietly fall through to the
 *    deployment's SMTP, because sending a project's mail from somewhere the
 *    operator did not choose is worse than not sending it
 *  - a broken template must not break a password reset; the built-in sends and
 *    the failure is reported
 *  - substituted values must not be able to become markup
 *
 * Each of those sits beside a control that shows the mechanism working, because
 * a refusal test passes for free when the positive path is broken.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import nodemailer from 'nodemailer'

import { SmtpSink, trustCertificate } from '../helpers/smtp-sink'
import {
  buildProjectSmtpTransport,
  getSmtpConfigView,
  resolveProjectSmtp,
  saveSmtpConfig,
  validateSmtpConfig,
  deleteSmtpConfig,
} from '@/lib/email/project-smtp'
import {
  renderSubject,
  renderTemplate,
  validateTemplate,
  TEMPLATE_KINDS,
} from '@/lib/email/template-kinds'
import { resolveAuthEmail } from '@/lib/email/auth-template-resolver'

const prisma = new PrismaClient()

const SMTP_USER = 'sink-user'
const SMTP_PASS = 'sink-password-not-real'
const FROM = 'auth@example.test'

let sink: SmtpSink
let ownerId: string
let projectId: string
let otherProjectId: string
/** Restores the default trust store; see the note in the sink helper. */
let untrust: (() => void) | null = null

beforeAll(async () => {
  sink = new SmtpSink()
  await sink.start()

  // Trust THIS certificate, rather than turning verification off. Disabling it
  // would apply to every suite sharing the process and could hide a real TLS
  // fault elsewhere in the same CI job. The product's TLS handling is
  // untouched, and the fact that this is needed at all is what tells you the
  // STARTTLS handshake is genuine.
  untrust = trustCertificate(sink.certificate)

  const owner = await prisma.user.create({
    data: {
      email: `smtp-suite-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: 'not-a-real-hash',
      name: 'SMTP Suite',
    },
    select: { id: true },
  })
  ownerId = owner.id

  const mk = async (name: string) =>
    (await prisma.project.create({ data: { name, userId: ownerId }, select: { id: true } })).id
  projectId = await mk('smtp-suite')
  otherProjectId = await mk('smtp-suite-other')
}, 180_000)

afterAll(async () => {
  untrust?.()

  await prisma.projectEmailTemplate.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.projectEmailConfig.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await sink.stop()
  await prisma.$disconnect()
}, 180_000)

beforeEach(async () => {
  sink.received.length = 0
  sink.rejectWith = null
  await prisma.projectEmailConfig.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } })
  await prisma.projectEmailTemplate.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } })
  delete process.env.SMTP_HOST
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASS
  delete process.env.SMTP_PORT
  delete process.env.SMTP_FROM
})

async function configureProjectSmtp(target = projectId, enabled = true) {
  return saveSmtpConfig(target, {
    host: '127.0.0.1',
    port: sink.port,
    username: SMTP_USER,
    password: SMTP_PASS,
    fromAddress: FROM,
    fromName: 'Example Auth',
    enabled,
  })
}

async function sendThroughProject(target: string, subject: string, html: string) {
  const resolved = await buildProjectSmtpTransport(nodemailer, target)
  if (!resolved) throw new Error('no transport was built for this project')
  await resolved.transport.sendMail({
    from: resolved.from,
    to: 'end-user@example.test',
    subject,
    html,
  })
  return resolved
}

// ─────────────────────────────────────────────────────────────────────────────

describe('mail actually leaves, using the project’s own credentials', () => {
  it('delivers through project SMTP, authenticating as the project’s user', async () => {
    await configureProjectSmtp()

    const resolved = await sendThroughProject(projectId, 'Subject under test', '<p>Body under test</p>')
    expect(resolved.source).toBe('project')

    // Asserted on what the SERVER received, after a real STARTTLS upgrade.
    expect(sink.received).toHaveLength(1)
    const mail = sink.received[0]

    expect(mail.username).toBe(SMTP_USER)
    expect(mail.password).toBe(SMTP_PASS)
    expect(mail.mailFrom).toBe(FROM)
    expect(mail.rcptTo).toEqual(['end-user@example.test'])
    expect(mail.raw).toContain('Subject under test')
    expect(mail.raw).toContain('Body under test')
    // The display name travels in the header while the envelope carries the bare
    // address, which is what separates fromName from fromAddress.
    expect(mail.raw).toMatch(/From:.*Example Auth/)
  }, 120_000)

  it('ROTATES: after a new password is saved, the wire carries the new one', async () => {
    // Credential-rotation qualification for SMTP.
    //
    // The resolver-level test below already proves a supplied password replaces
    // the stored one. This proves the half that matters operationally: the next
    // real send AUTHENTICATES with the new credential. A rotation that updated
    // the row but left a cached transport dialling the old password would pass
    // every stored-value assertion and still fail on the first email a user
    // actually needs.
    //
    // Observed on the wire rather than read back from the database, because the
    // database is the thing being changed and cannot witness its own effect.
    const ROTATED = 'rotated-smtp-password-9f2c'
    await configureProjectSmtp()

    await sendThroughProject(projectId, 'Before rotation', '<p>x</p>')
    expect(sink.received).toHaveLength(1)
    // CONTROL: the old credential is genuinely what was in use.
    expect(sink.received[0].password).toBe(SMTP_PASS)

    await saveSmtpConfig(projectId, {
      host: '127.0.0.1',
      port: sink.port,
      username: SMTP_USER,
      password: ROTATED,
      fromAddress: FROM,
      enabled: true,
    })

    sink.received.length = 0
    await sendThroughProject(projectId, 'After rotation', '<p>x</p>')
    expect(sink.received).toHaveLength(1)
    expect(sink.received[0].password).toBe(ROTATED)
    expect(sink.received[0].password).not.toBe(SMTP_PASS)

    // And the rotated secret is no more readable than the first one was.
    const view = await getSmtpConfigView(projectId)
    expect(view.passwordConfigured).toBe(true)
    expect(JSON.stringify(view)).not.toContain(ROTATED)
    expect(JSON.stringify(view)).not.toContain(SMTP_PASS)
  }, 120_000)

  it('reports a rejecting server as a failure rather than a send', async () => {
    await configureProjectSmtp()
    sink.rejectWith = '550'

    // CONTROL for the assertion below: the same call succeeded in the test above
    // under the same configuration, so this rejection is the server's answer and
    // not a broken fixture.
    await expect(sendThroughProject(projectId, 'Rejected', '<p>x</p>')).rejects.toThrow()
    expect(sink.received).toHaveLength(0)
  }, 120_000)
})

describe('precedence: project first, deployment as fallback', () => {
  it('prefers the project’s settings over the deployment environment', async () => {
    process.env.SMTP_HOST = '127.0.0.1'
    process.env.SMTP_PORT = String(sink.port)
    process.env.SMTP_USER = 'deployment-user'
    process.env.SMTP_PASS = 'deployment-password'
    process.env.SMTP_FROM = 'deployment@example.test'

    await configureProjectSmtp()
    await sendThroughProject(projectId, 'Precedence', '<p>x</p>')

    // The project's identity, not the deployment's. Same sink, so the only thing
    // distinguishing them is which credentials arrived.
    expect(sink.received[0].username).toBe(SMTP_USER)
    expect(sink.received[0].mailFrom).toBe(FROM)
  }, 120_000)

  it('falls back to the deployment when the project config is DISABLED, keeping the settings', async () => {
    process.env.SMTP_HOST = '127.0.0.1'
    process.env.SMTP_PORT = String(sink.port)
    process.env.SMTP_USER = 'deployment-user'
    process.env.SMTP_PASS = 'deployment-password'
    process.env.SMTP_FROM = 'deployment@example.test'

    await configureProjectSmtp(projectId, false)

    const resolved = await resolveProjectSmtp(projectId)
    expect(resolved.source).toBe('deployment')

    await sendThroughProject(projectId, 'Fallback', '<p>x</p>')
    expect(sink.received[0].username).toBe('deployment-user')

    // Disabled, not deleted: the settings are still there to switch back on,
    // which is the whole reason the flag exists.
    const view = await getSmtpConfigView(projectId)
    expect(view.configured).toBe(true)
    expect(view.enabled).toBe(false)
    expect(view.host).toBe('127.0.0.1')
    expect(view.passwordConfigured).toBe(true)
  }, 120_000)

  it('reports no source at all when neither is configured', async () => {
    const resolved = await resolveProjectSmtp(projectId)
    expect(resolved.source).toBe('none')
    expect(resolved.credentials).toBeNull()
    expect(await buildProjectSmtpTransport(nodemailer, projectId)).toBeNull()
  }, 60_000)

  it('keeps one project’s settings out of another’s', async () => {
    await configureProjectSmtp(projectId)

    // CONTROL: the configured project resolves to its own settings.
    expect((await resolveProjectSmtp(projectId)).source).toBe('project')
    // The neighbour is unaffected and has nothing.
    expect((await resolveProjectSmtp(otherProjectId)).source).toBe('none')
  }, 60_000)
})

describe('the stored password', () => {
  it('is encrypted at rest, not merely hidden by the API', async () => {
    await configureProjectSmtp()

    const row = await prisma.projectEmailConfig.findUniqueOrThrow({ where: { projectId } })
    // The ciphertext must not be the plaintext, in any encoding anyone would
    // reach for. A "hidden" password sitting in the clear is the defect this
    // asserts against.
    const blob = `${row.passwordCipher}|${row.passwordIv}|${row.passwordTag}`
    expect(blob).not.toContain(SMTP_PASS)
    expect(blob).not.toContain(Buffer.from(SMTP_PASS).toString('base64'))
    expect(blob).not.toContain(Buffer.from(SMTP_PASS).toString('hex'))

    // CONTROL: and it still decrypts to the real value, so the assertion above
    // is about encryption and not about the password having been lost.
    expect((await resolveProjectSmtp(projectId)).credentials?.pass).toBe(SMTP_PASS)
  }, 60_000)

  it('never appears in the view the dashboard receives', async () => {
    await configureProjectSmtp()
    const view = await getSmtpConfigView(projectId)

    expect(JSON.stringify(view)).not.toContain(SMTP_PASS)
    // What it reports instead: that one exists.
    expect(view.passwordConfigured).toBe(true)
  }, 60_000)

  it('is kept when an edit omits it, and replaced when one is supplied', async () => {
    await configureProjectSmtp()

    // Omitted: keep. An operator editing the port should not have to retype a
    // secret they cannot read.
    await saveSmtpConfig(projectId, {
      host: '127.0.0.1',
      port: sink.port,
      username: 'renamed-user',
      fromAddress: FROM,
      enabled: true,
    })
    expect((await resolveProjectSmtp(projectId)).credentials?.pass).toBe(SMTP_PASS)
    expect((await resolveProjectSmtp(projectId)).credentials?.user).toBe('renamed-user')

    // Supplied: replace.
    await saveSmtpConfig(projectId, {
      host: '127.0.0.1',
      port: sink.port,
      username: 'renamed-user',
      password: 'a-different-password',
      fromAddress: FROM,
      enabled: true,
    })
    expect((await resolveProjectSmtp(projectId)).credentials?.pass).toBe('a-different-password')
  }, 60_000)

  it('REFUSES to fall back to the deployment when the stored secret cannot be decrypted', async () => {
    process.env.SMTP_HOST = '127.0.0.1'
    process.env.SMTP_PORT = String(sink.port)
    process.env.SMTP_USER = 'deployment-user'
    process.env.SMTP_PASS = 'deployment-password'
    process.env.SMTP_FROM = 'deployment@example.test'

    await configureProjectSmtp()

    // Corrupt the ciphertext the way a changed MASTER_ENCRYPTION_KEY would.
    await prisma.projectEmailConfig.update({
      where: { projectId },
      data: { passwordCipher: Buffer.from('not the real ciphertext').toString('base64') },
    })

    // The deliberate decision: none, not deployment. Sending this project's mail
    // from an identity the operator did not choose would hide the key rotation
    // AND send from the wrong domain.
    const resolved = await resolveProjectSmtp(projectId)
    expect(resolved.source).toBe('none')
    expect(resolved.credentials).toBeNull()

    // CONTROL: the deployment fallback is genuinely available and reachable, so
    // "none" is a refusal rather than an absence.
    expect((await resolveProjectSmtp(otherProjectId)).source).toBe('deployment')
  }, 60_000)

  it('rejects settings that cannot work, before storing them', async () => {
    const base = {
      host: '127.0.0.1',
      port: 587,
      username: 'u',
      password: 'p',
      fromAddress: 'a@b.co',
      enabled: true,
    }

    // CONTROL: the valid shape passes, so each rejection below is about the one
    // field it changes.
    expect(validateSmtpConfig(base, false)).toEqual([])

    expect(validateSmtpConfig({ ...base, host: '' }, false)).toHaveLength(1)
    expect(validateSmtpConfig({ ...base, port: 0 }, false)).toHaveLength(1)
    expect(validateSmtpConfig({ ...base, port: 99_999 }, false)).toHaveLength(1)
    expect(validateSmtpConfig({ ...base, fromAddress: 'not-an-address' }, false)).toHaveLength(1)

    // No password and none stored would leave a config that looks complete and
    // cannot authenticate.
    expect(validateSmtpConfig({ ...base, password: undefined }, false)).toHaveLength(1)
    expect(validateSmtpConfig({ ...base, password: undefined }, true)).toEqual([])

    // A newline in an address is header injection, which is the one input here
    // that is a security problem rather than a typo.
    expect(validateSmtpConfig({ ...base, fromAddress: 'a@b.co\r\nBcc: x@y.co' }, false).length)
      .toBeGreaterThan(0)
  })

  it('deleting the config falls back rather than breaking mail', async () => {
    process.env.SMTP_HOST = '127.0.0.1'
    process.env.SMTP_PORT = String(sink.port)
    process.env.SMTP_USER = 'deployment-user'
    process.env.SMTP_PASS = 'deployment-password'

    await configureProjectSmtp()
    expect((await resolveProjectSmtp(projectId)).source).toBe('project')

    expect(await deleteSmtpConfig(projectId)).toBe(true)
    expect((await resolveProjectSmtp(projectId)).source).toBe('deployment')
  }, 60_000)
})

describe('operator templates override the built-in, and cannot break a flow', () => {
  const builtIn = { subject: 'Built-in subject', bodyHtml: '<p>Built-in body https://link</p>' }
  const values = {
    appName: 'Example App',
    email: 'end-user@example.test',
    ctaUrl: 'https://example.test/reset?token=abc',
    expiry: '1 hour',
  }

  it('uses the built-in when nothing is stored', async () => {
    const resolved = await resolveAuthEmail(projectId, 'password_reset', values, builtIn)
    expect(resolved.customised).toBe(false)
    expect(resolved.subject).toBe('Built-in subject')
    expect(resolved.fallbackReason).toBeNull()
  }, 60_000)

  it('uses a stored template, and DELIVERS it', async () => {
    await configureProjectSmtp()
    await prisma.projectEmailTemplate.create({
      data: {
        projectId,
        kind: 'password_reset',
        subject: 'Reset your {{appName}} password',
        bodyHtml: '<p>Hello {{email}}, <a href="{{ctaUrl}}">reset</a> within {{expiry}}.</p>',
      },
    })

    const resolved = await resolveAuthEmail(projectId, 'password_reset', values, builtIn)
    expect(resolved.customised).toBe(true)
    expect(resolved.subject).toBe('Reset your Example App password')

    // And it is what actually arrives, not merely what was resolved.
    await sendThroughProject(projectId, resolved.subject, resolved.bodyHtml)
    expect(sink.received).toHaveLength(1)
    expect(sink.received[0].raw).toContain('Reset your Example App password')
    expect(sink.received[0].raw).toContain('end-user@example.test')
    expect(sink.received[0].raw).toContain('within 1 hour')
  }, 120_000)

  it('keeps one project’s template out of another’s', async () => {
    await prisma.projectEmailTemplate.create({
      data: { projectId, kind: 'magic_link', subject: 'Mine', bodyHtml: '<a href="{{ctaUrl}}">x</a>' },
    })

    // CONTROL: the owning project sees it.
    expect((await resolveAuthEmail(projectId, 'magic_link', values, builtIn)).customised).toBe(true)
    // The neighbour gets the built-in, not a stranger's wording.
    const other = await resolveAuthEmail(otherProjectId, 'magic_link', values, builtIn)
    expect(other.customised).toBe(false)
    expect(other.subject).toBe('Built-in subject')
  }, 60_000)

  it('falls back to the built-in, REPORTING why, when a stored template has no link', async () => {
    // Written directly, bypassing validation, which is exactly the case the
    // save-time check cannot cover: a row edited in the database, or stored
    // before a variable was renamed.
    await prisma.projectEmailTemplate.create({
      data: { projectId, kind: 'verification', subject: 'No link here', bodyHtml: '<p>Nothing actionable</p>' },
    })

    const resolved = await resolveAuthEmail(projectId, 'verification', values, builtIn)

    // The flow is not broken: the built-in sends.
    expect(resolved.subject).toBe('Built-in subject')
    expect(resolved.customised).toBe(false)
    // And it is NOT silent. A quiet fallback is how a project sends default
    // wording for months while the dashboard shows a template nobody is using.
    expect(resolved.fallbackReason).toMatch(/no action link/i)
  }, 60_000)

  it('falls back when a stored template renders to nothing', async () => {
    await prisma.projectEmailTemplate.create({
      data: { projectId, kind: 'verification', subject: '{{appName}}', bodyHtml: '{{ctaUrl}}' },
    })

    // Values absent, so both placeholders render empty. A blank email would
    // look delivered and help nobody.
    const resolved = await resolveAuthEmail(projectId, 'verification', {}, builtIn)
    expect(resolved.customised).toBe(false)
    expect(resolved.fallbackReason).toMatch(/empty|no action link/i)
  }, 60_000)
})

describe('template validation refuses what would break or endanger', () => {
  const good = '<p>Hello {{email}}, <a href="{{ctaUrl}}">go</a></p>'

  it('accepts a template that uses the allowed values', () => {
    // CONTROL first: without it, every rejection below could be a validator
    // that refuses everything.
    expect(validateTemplate('Hi {{appName}}', good)).toEqual([])
  })

  it('refuses a placeholder Backenly cannot fill, naming the alternatives', () => {
    const errors = validateTemplate('Hi', '<a href="{{ctaUrl}}">x</a> {{resetToken}}')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/\{\{resetToken\}\} is not a value/)
    // The operator cannot see the allowlist, so the message carries it.
    expect(errors[0].message).toMatch(/\{\{ctaUrl\}\}/)
  })

  it('refuses a body with no action link', () => {
    const errors = validateTemplate('Hi', '<p>no link</p>')
    expect(errors.some(e => e.message.includes('{{ctaUrl}} must appear'))).toBe(true)
  })

  it('refuses a script tag, whose only possible audience is the dashboard preview', () => {
    const errors = validateTemplate('Hi', `${good}<script>alert(1)</script>`)
    expect(errors.some(e => /<script>/.test(e.message))).toBe(true)
  })

  it('refuses empty subject or body', () => {
    expect(validateTemplate('', good).some(e => e.field === 'subject')).toBe(true)
    expect(validateTemplate('Hi', '').some(e => e.field === 'bodyHtml')).toBe(true)
  })

  it('every declared kind is a valid template kind', () => {
    // Guards against a kind being added to the schema and not to the sender.
    expect([...TEMPLATE_KINDS].sort()).toEqual(['magic_link', 'password_reset', 'verification'])
  })
})

describe('substituted values cannot become markup', () => {
  it('escapes a hostile appName in the body', () => {
    const rendered = renderTemplate('<p>{{appName}}</p>', {
      appName: '"><script>alert(1)</script>',
    })
    // The value is escaped, so it renders as text in both the email and the
    // dashboard preview.
    expect(rendered).not.toContain('<script>')
    expect(rendered).toContain('&lt;script&gt;')
  })

  it('escapes a value substituted into an href', () => {
    const rendered = renderTemplate('<a href="{{ctaUrl}}">x</a>', {
      ctaUrl: 'https://x.test/" onmouseover="alert(1)',
    })
    // The quote cannot close the attribute and start a new one.
    expect(rendered).not.toContain('onmouseover="alert(1)"')
    expect(rendered).toContain('&quot;')
  })

  it('strips newlines from a subject, which would be header injection', () => {
    const subject = renderSubject('Hi {{appName}}', {
      appName: 'App\r\nBcc: attacker@example.test',
    })
    expect(subject).not.toMatch(/[\r\n]/)
    expect(subject).toContain('Bcc: attacker@example.test')
  })

  it('does not HTML-escape a subject, which is plain text', () => {
    // `&amp;` in somebody's inbox is a bug, so the subject path deliberately
    // differs from the body path.
    expect(renderSubject('{{appName}} & you', { appName: 'Tom & Jerry' })).toBe('Tom & Jerry & you')
  })

  it('drops an unknown placeholder rather than printing it', () => {
    // Cannot be saved, but could exist from an older allowlist. `{{oldName}}`
    // visible in a user's inbox is worse than nothing.
    expect(renderTemplate('<p>{{nope}}</p>', {})).toBe('<p></p>')
  })
})
