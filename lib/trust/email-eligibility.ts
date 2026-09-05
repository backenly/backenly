/**
 * Platform signup email eligibility.
 *
 * The goal is not to maintain a perfect global email reputation database.
 * This catches the high-signal cases that produce low-quality Backenly users:
 * disposable mailbox domains, reserved/example domains, and obvious burner
 * local-parts even when the attacker uses a trusted mailbox provider.
 */

export interface EmailEligibilityResult {
  ok: boolean
  reason?: string
  code?:
    | 'INVALID_EMAIL'
    | 'RESERVED_DOMAIN'
    | 'DISPOSABLE_DOMAIN'
    | 'BURNER_LOCAL_PART'
}

export const SIGNUP_EMAIL_REJECTION_MESSAGE =
  'Please use a real personal or work email. Temporary, disposable, or burner emails are not allowed.'

const RESERVED_DOMAINS = new Set([
  'example.com',
  'example.net',
  'example.org',
  'invalid',
  'localhost',
  'local',
  'test',
  'test.com',
])

const DISPOSABLE_DOMAINS = new Set([
  '0-mail.com',
  '0815.ru',
  '10mail.org',
  '10minemail.com',
  '10minut.com',
  '10minutemail.co',
  '10minutemail.com',
  '10minutemail.net',
  '10minutemail.org',
  '20minutemail.com',
  '33mail.com',
  'anonbox.net',
  'burnermail.io',
  'byom.de',
  'dispostable.com',
  'dropmail.me',
  'emailondeck.com',
  'fakeinbox.com',
  'fakemail.net',
  'getnada.com',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'inboxkitten.com',
  'mail-temp.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'minuteinbox.com',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'my10minutemail.com',
  'sharklasers.com',
  'spam4.me',
  'spamgourmet.com',
  'temp-mail.io',
  'temp-mail.org',
  'tempmail.com',
  'tempmail.io',
  'tempmail.net',
  'tempmailo.com',
  'temporary-mail.net',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.net',
  'yopmail.com',
])

const SUSPICIOUS_DOMAIN_TOKENS = [
  '10minute',
  'burner',
  'disposable',
  'fakeinbox',
  'fakemail',
  'guerrilla',
  'mailinator',
  'mohmal',
  'spamgourmet',
  'tempmail',
  'throwaway',
  'trashmail',
  'yopmail',
]

const SUSPICIOUS_LOCAL_PATTERNS = [
  /^burner\d*$/,
  /^disposable\d*$/,
  /^fake\d*$/,
  /^noreply\d*$/,
  /^no?reply\d*$/,
  /^qwerty\d*$/,
  /^spam\d*$/,
  /^test\d*$/,
  /^testing\d*$/,
  /^throwaway\d*$/,
  /^trash\d*$/,
  /^user\d{0,6}$/,
  /10minutemail/,
  /burner/,
  /disposable/,
  /fakeemail/,
  /fakemail/,
  /guerrillamail/,
  /mailinator/,
  /spamaccount/,
  /spamemail/,
  /tempemail/,
  /tempmail/,
  /temporaryemail/,
  /throwaway/,
  /trashmail/,
  /yopmail/,
]

export function checkSignupEmailEligibility(email: string): EmailEligibilityResult {
  const parsed = parseEmail(email)
  if (!parsed) {
    return { ok: false, code: 'INVALID_EMAIL', reason: 'Invalid email address.' }
  }

  const { domain, local } = parsed
  if (RESERVED_DOMAINS.has(domain)) {
    return { ok: false, code: 'RESERVED_DOMAIN', reason: SIGNUP_EMAIL_REJECTION_MESSAGE }
  }

  if (isDisposableDomain(domain)) {
    return { ok: false, code: 'DISPOSABLE_DOMAIN', reason: SIGNUP_EMAIL_REJECTION_MESSAGE }
  }

  if (hasBurnerLocalPart(local)) {
    return { ok: false, code: 'BURNER_LOCAL_PART', reason: SIGNUP_EMAIL_REJECTION_MESSAGE }
  }

  return { ok: true }
}

function parseEmail(email: string): { local: string; domain: string } | null {
  const normalized = email.trim().toLowerCase()
  const parts = normalized.split('@')
  if (parts.length !== 2) return null

  const [local, rawDomain] = parts
  const domain = rawDomain.replace(/\.$/, '')

  if (!local || !domain) return null
  if (/\s/.test(normalized)) return null
  if (!domain.includes('.')) return null
  if (domain.startsWith('.') || domain.endsWith('.')) return null

  return { local, domain }
}

function isDisposableDomain(domain: string): boolean {
  if (DISPOSABLE_DOMAINS.has(domain)) return true

  for (const blocked of DISPOSABLE_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) return true
  }

  const compactDomain = domain.replace(/[^a-z0-9]/g, '')
  return SUSPICIOUS_DOMAIN_TOKENS.some((token) => compactDomain.includes(token))
}

function hasBurnerLocalPart(local: string): boolean {
  const baseLocal = local.split('+')[0]
  const compactLocal = baseLocal.replace(/[^a-z0-9]/g, '')
  if (!compactLocal) return true

  return SUSPICIOUS_LOCAL_PATTERNS.some((pattern) => pattern.test(compactLocal))
}
