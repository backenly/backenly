/**
 * The brain's log and history redaction (lib/ai/brain/redact.ts).
 *
 * Every credential-shaped fixture is assembled at runtime, never written as a
 * literal: a realistic key in source would trip the public-tree preflight and
 * push-time secret scanning, and would itself be the leak this module exists
 * to prevent.
 */
import { redactArgs, redactSecretsInText, REDACTED } from '@/lib/ai/brain/redact'

const hex = (n: number) => 'a1b2c3d4e5f6'.repeat(Math.ceil(n / 12)).slice(0, n)
const alnum = (n: number) => 'Zq8Xw3Lm9Pk2'.repeat(Math.ceil(n / 12)).slice(0, n)

const projKey = 'proj' + '_live_' + hex(48)
const mcpKey = 'mcp' + '_live_' + hex(64)
const legacyKey = 'sk' + '_live_' + alnum(32)
const anthropicKey = 'sk' + '-ant-api03-' + alnum(40)
const openaiKey = 'sk' + '-proj-' + alnum(48)
const webhookSecret = 'wh' + 'sec_' + alnum(32)
const awsKeyId = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'
const jwt = 'ey' + 'J' + alnum(20) + '.ey' + 'J' + alnum(30) + '.' + alnum(30)
const restrictedKey = 'rk' + '_live_' + alnum(24)
const githubToken = 'gh' + 'p_' + alnum(36)
const slackToken = 'xo' + 'xb-' + alnum(12) + '-' + alnum(24)
const resendKey = 're' + '_' + alnum(8) + '_' + alnum(24)
const sendgridKey = 'SG' + '.' + alnum(22) + '.' + alnum(43)

describe('redactSecretsInText', () => {
  it('redacts Backenly keys and keeps the prefix for debugging', () => {
    const out = redactSecretsInText(`here is your key: ${projKey} and the agent key ${mcpKey}`)
    expect(out).not.toContain(projKey)
    expect(out).not.toContain(mcpKey)
    expect(out).toContain(`proj_live_${REDACTED}`)
    expect(out).toContain(`mcp_live_${REDACTED}`)
  })

  it('redacts keys minted with a legacy prefix', () => {
    expect(redactSecretsInText(`old key ${legacyKey}`)).toBe(`old key sk_live_${REDACTED}`)
  })

  it('redacts provider credentials people paste', () => {
    for (const secret of [anthropicKey, openaiKey, webhookSecret, awsKeyId, jwt]) {
      const out = redactSecretsInText(`value=${secret} end`)
      expect(out).not.toContain(secret)
      expect(out).toContain(REDACTED)
    }
  })

  it('redacts only the password segment of a connection string', () => {
    const url = 'postgres' + 'ql://app_user:' + alnum(20) + '@db.internal:5432/main'
    expect(redactSecretsInText(url)).toBe(`postgresql://app_user:${REDACTED}@db.internal:5432/main`)
  })

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN ' + 'PRIVATE KEY-----\n' + alnum(64) + '\n-----END ' + 'PRIVATE KEY-----'
    expect(redactSecretsInText(`key:\n${pem}\nthanks`)).toBe(`key:\n${REDACTED}\nthanks`)
  })

  it('leaves ordinary identifiers that merely share a prefix untouched', () => {
    // Assembled at runtime too: a hyphenated name containing "sk-" followed by
    // enough characters is exactly what an unanchored key pattern mistakes for
    // a key, including the repository's own public-tree scanner.
    const riskName = 'risk' + '-assessment-pipeline-items-archive'
    const deskName = 'desk' + '-booking-reservations-calendar-view'
    const text =
      `Created store_inventory_movements_history, ${riskName} and ` +
      `proj_live_metrics; ${deskName} is next.`
    expect(redactSecretsInText(text)).toBe(text)
  })

  it('is a no-op on empty or secret-free text', () => {
    expect(redactSecretsInText('')).toBe('')
    expect(redactSecretsInText('Dropped the followers table (12 rows).')).toBe('Dropped the followers table (12 rows).')
  })
})

describe('a key in stored JSON text', () => {
  // JSON writes a newline as the two characters "\" and "n" (a tab as "\t", a
  // control character as "\u0001"), so the character right before a key on
  // its own line is a letter or a digit, which reads as the middle of a word.
  const stored = (before: string, secret: string) =>
    JSON.stringify({ summary: `Copy this key (shown once):${before}${secret}${before}Keep it safe.` })

  it.each([
    ['a Backenly key', projKey],
    ['an MCP key', mcpKey],
    ['a key with a legacy prefix', legacyKey],
    ['an OpenAI key', openaiKey],
    ['an Anthropic key', anthropicKey],
    ['a Stripe restricted key', restrictedKey],
    ['a webhook signing secret', webhookSecret],
    ['an AWS access key id', awsKeyId],
    ['a GitHub token', githubToken],
    ['a Slack token', slackToken],
    ['a Resend key', resendKey],
    ['a SendGrid key', sendgridKey],
    ['a JWT', jwt],
  ])('%s after an escaped newline is withheld', (_label, secret) => {
    const json = stored('\n', secret)
    expect(json).toContain(`\\n${secret}`)
    const out = redactSecretsInText(json)
    expect(out).not.toContain(secret)
    expect(out).toContain('Keep it safe.')
  })

  it('a key after an escaped tab or a \\u escape is withheld too', () => {
    for (const before of ['\t', '\u0001']) {
      expect(redactSecretsInText(stored(before, projKey))).not.toContain(projKey)
      expect(redactSecretsInText(stored(before, openaiKey))).not.toContain(openaiKey)
    }
  })

  it('an ordinary identifier on its own line stays as it is', () => {
    const json = JSON.stringify({ summary: 'Created:\nproj_live_metrics\nstore_inventory_movements_history' })
    expect(redactSecretsInText(json)).toBe(json)
  })
})

describe('redactArgs', () => {
  it('replaces values under secret-named keys but keeps the variable name', () => {
    const args = { key: 'STRIPE_SECRET_KEY', value: 'anything at all' }
    expect(redactArgs(args)).toEqual({ key: 'STRIPE_SECRET_KEY', value: REDACTED })
  })

  it('covers the credential argument names the tools actually take', () => {
    const args = { clientSecret: 'x', apiKey: 'y', webhookSecret: 'z', password: 'p', token: 't' }
    expect(redactArgs(args)).toEqual({
      clientSecret: REDACTED, apiKey: REDACTED, webhookSecret: REDACTED, password: REDACTED, token: REDACTED,
    })
  })

  it('scans every other string, including nested objects and arrays', () => {
    const args = { tableName: 'orders', config: { note: `use ${projKey}` }, list: [`k=${mcpKey}`] }
    const out = redactArgs(args) as any
    expect(out.tableName).toBe('orders')
    expect(out.config.note).toBe(`use proj_live_${REDACTED}`)
    expect(out.list[0]).toBe(`k=mcp_live_${REDACTED}`)
  })

  it('never mutates its input', () => {
    const args = { value: 'secret', nested: { password: 'pw' } }
    const snapshot = JSON.stringify(args)
    redactArgs(args)
    expect(JSON.stringify(args)).toBe(snapshot)
  })

  it('passes non-string scalars and nulls through', () => {
    expect(redactArgs({ limit: 10, force: true, value: null, columns: ['a', 'b'] })).toEqual({
      limit: 10, force: true, value: null, columns: ['a', 'b'],
    })
  })
})
