/**
 * CREDENTIALS NEVER REPEATED (lib/import/redact.ts)
 * ================================================
 * Every message on its way to a job row, an HTTP answer or a log line is
 * redacted with the job's own secrets named, and credential-shaped tokens are
 * removed even when nobody named them. Secrets are assembled at run time:
 * scripts/preflight-oss.ts refuses credential-shaped literals in the repo.
 */

import { redact, redactedMessage, secretsOf } from '@/lib/import/redact'

const PASSWORD = ['Tr0ub4dor', '&3', '-horse'].join('')
const URL_PASSWORD = encodeURIComponent(PASSWORD)
const CONNECTION = 'postgresql://postgres:' + URL_PASSWORD + '@db.abcdefghijklmnop.supabase.co:5432/postgres'
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ', 'c2lnbmF0dXJlLXZhbHVlLWhlcmU'].join('.')
const PEM = ['-----BEGIN', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END', 'PRIVATE KEY-----'].join(' ')

describe('secretsOf', () => {
  it('names the connection string, its password raw and decoded, and the service key', () => {
    const s = secretsOf({ source: 'supabase', connectionString: CONNECTION, projectUrl: 'https://abcdefghijklmnop.supabase.co', serviceRoleKey: JWT })
    expect(s).toEqual(expect.arrayContaining([CONNECTION, URL_PASSWORD, PASSWORD, JWT]))
    // longest first, so a key is never half-removed
    expect(s[0].length).toBeGreaterThanOrEqual(s[s.length - 1].length)
  })

  it("names a Firebase key's private key", () => {
    const json = JSON.stringify({ type: 'service_account', project_id: 'demo', private_key_id: 'abc123def456', private_key: PEM, client_email: 'svc@demo.iam.gserviceaccount.com' })
    const s = secretsOf({ source: 'firebase', serviceAccountJson: json })
    expect(s).toEqual(expect.arrayContaining([json, PEM, 'abc123def456']))
  })

  it('nothing to name for no connection', () => {
    expect(secretsOf(null)).toEqual([])
  })
})

describe('redact', () => {
  const secrets = secretsOf({ source: 'supabase', connectionString: CONNECTION, serviceRoleKey: JWT })

  it('removes every named secret, in any encoding it was printed in', () => {
    const out = redact(`failed: ${CONNECTION} with ${PASSWORD} and ${URL_PASSWORD} and key ${JWT}`, secrets)
    expect(out).not.toContain(PASSWORD)
    expect(out).not.toContain(URL_PASSWORD)
    expect(out).not.toContain(JWT)
    expect(out).toMatch(/failed: /)
  })

  it('removes credential shapes nobody named', () => {
    const other = ['an', 'other', 'secret'].join('-')
    const text = [
      'postgres://admin:' + other + '@10.0.0.1:5432/db',
      `password=${other}`,
      `Authorization: Bearer ${other}${other}`,
      JWT,
      PEM,
    ].join(' | ')
    const out = redact(text)
    expect(out).not.toContain(other)
    expect(out).not.toContain(JWT)
    expect(out).not.toContain('MIIEvQ')
    expect(out).toContain('postgres://…@10.0.0.1')
  })

  it('leaves ordinary words alone', () => {
    expect(redact('Couldn\'t connect: password authentication failed for user "postgres"', secrets)).toBe(
      'Couldn\'t connect: password authentication failed for user "postgres"',
    )
  })

  it('redactedMessage reads an Error and cuts it to length', () => {
    const msg = redactedMessage(new Error(`${'x'.repeat(500)} ${PASSWORD}`), secrets, 100)
    expect(msg.length).toBeLessThanOrEqual(100)
    expect(msg).not.toContain(PASSWORD)
  })
})
