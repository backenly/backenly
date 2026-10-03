/**
 * The database-free parts of the lineage probe: the result protocol, the
 * connection rules that keep TLS verified, scratch naming, and the carried input.
 */

import { createHash, X509Certificate } from 'node:crypto'
import * as tls from 'node:tls'
import { bodyDigest, normaliseBody } from '../../tools/migration-lineage/probe/capture'
import { clientConfig, parseDatabaseUrl } from '../../tools/migration-lineage/probe/connect'
import { decodeInput, encodeInput } from '../../tools/migration-lineage/probe/input'
import { decodeResult, encodeResult, hasCompleteResult } from '../../tools/migration-lineage/probe/output'
import { loadRdsCa, RDS_CA_PIN_SHA256_BASE64 } from '../../tools/migration-lineage/probe/rds-ca'
import { assertScratchName, scratchName } from '../../tools/migration-lineage/probe/scratch'

describe('result protocol', () => {
  const big = { rows: Array.from({ length: 4000 }, (_, i) => ({ i, text: createHash('sha256').update(String(i)).digest('base64') })) }

  it('round-trips a result that needs several chunks', () => {
    const lines = encodeResult(big)
    expect(lines.filter(l => l.startsWith('LINEAGE-CHUNK ')).length).toBeGreaterThan(1)
    expect(hasCompleteResult(lines)).toBe(true)
    expect(decodeResult(['noise before', ...lines, 'noise after'])).toEqual(big)
  })

  it('refuses a missing chunk', () => {
    const lines = encodeResult(big)
    const i = lines.findIndex(l => l.startsWith('LINEAGE-CHUNK 2/'))
    expect(() => decodeResult([...lines.slice(0, i), ...lines.slice(i + 1)])).toThrow(/chunk 2 of \d+ is missing/)
  })

  it('refuses a duplicated chunk', () => {
    const lines = encodeResult(big)
    const i = lines.findIndex(l => l.startsWith('LINEAGE-CHUNK 1/'))
    expect(() => decodeResult([...lines.slice(0, i + 1), lines[i], ...lines.slice(i + 1)])).toThrow(/appears twice/)
  })

  it('refuses a corrupted chunk by digest', () => {
    const lines = encodeResult(big)
    const i = lines.findIndex(l => l.startsWith('LINEAGE-CHUNK 1/'))
    const corrupted = [...lines]
    corrupted[i] = corrupted[i].replace(/[A-Za-z](?=[A-Za-z0-9+/=]{5}$)/, c => (c === 'A' ? 'B' : 'A'))
    expect(() => decodeResult(corrupted)).toThrow(/digest/)
  })

  it('refuses truncated output', () => {
    const lines = encodeResult({ ok: true })
    expect(hasCompleteResult(lines.slice(0, -1))).toBe(false)
    expect(() => decodeResult(lines.slice(0, -1))).toThrow(/truncated/)
  })
})

describe('connection rules', () => {
  const url = 'postgresql://app:p%40ss@db.example.internal:6543/backenly?sslmode=require&sslrootcert=/x.pem&schema=public'

  it('parses discrete fields and reports, but never applies, query parameters', () => {
    const { target, ignoredParameters } = parseDatabaseUrl(url)
    expect(target).toEqual({ host: 'db.example.internal', port: 6543, user: 'app', password: 'p@ss', database: 'backenly' })
    expect(ignoredParameters).toEqual(['schema', 'sslmode', 'sslrootcert'])
  })

  it('does not echo the URL when it cannot be parsed', () => {
    expect(() => parseDatabaseUrl('not a url with secret-password')).toThrow('database URL could not be parsed')
  })

  it('always verifies: rejectUnauthorized is true and there is no switch for it', () => {
    const { target } = parseDatabaseUrl(url)
    const cfg = clientConfig(target, { mode: 'verify-full', ca: loadRdsCa() })
    expect(cfg.ssl).toMatchObject({ rejectUnauthorized: true })
    expect((cfg.ssl as tls.ConnectionOptions).checkServerIdentity).toBeUndefined()
    expect(cfg).not.toHaveProperty('connectionString')
  })

  it('refuses verify-full without a CA', () => {
    const { target } = parseDatabaseUrl(url)
    expect(() => clientConfig(target, { mode: 'verify-full', ca: '' })).toThrow(/certificate authority/)
  })

  it('allows plaintext only to loopback', () => {
    expect(() => clientConfig(parseDatabaseUrl(url).target, { mode: 'loopback-plaintext' })).toThrow(/loopback/)
    const local = parseDatabaseUrl('postgresql://u:p@localhost:5432/dev').target
    expect(clientConfig(local, { mode: 'loopback-plaintext' }).ssl).toBe(false)
  })

  it('the wrong-identity control really checks a different name', () => {
    const { target } = parseDatabaseUrl(url)
    const ca = loadRdsCa()
    const cert = { subject: { CN: 'db.example.internal' }, subjectaltname: 'DNS:db.example.internal' } as unknown as tls.PeerCertificate

    // The control ignores the host it is called with and verifies the name it
    // was given, so a certificate valid for the real host is rejected.
    const wrong = clientConfig(target, { mode: 'verify-full', ca }, { identityCheckAs: 'wrong.invalid' })
    const rejected = (wrong.ssl as tls.ConnectionOptions).checkServerIdentity!('db.example.internal', cert)
    expect(rejected?.message).toMatch(/altnames|does not match/i)

    // Same certificate, checked against the name it actually carries: no error.
    const right = clientConfig(target, { mode: 'verify-full', ca }, { identityCheckAs: 'db.example.internal' })
    expect((right.ssl as tls.ConnectionOptions).checkServerIdentity!('anything', cert)).toBeUndefined()
  })
})

describe('embedded RDS CA', () => {
  it('matches its pin and holds the three ap-south-1 roots', () => {
    const pem = loadRdsCa()
    expect(createHash('sha256').update(pem).digest('base64')).toBe(RDS_CA_PIN_SHA256_BASE64)
    const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!
    const names = certs.map(c => new X509Certificate(c)).map(x => ({ root: x.subject === x.issuer && x.ca, subject: x.subject }))
    expect(names).toHaveLength(3)
    for (const n of names) {
      expect(n.root).toBe(true)
      expect(n.subject).toMatch(/Amazon RDS ap-south-1 Root CA/)
    }
  })
})

describe('scratch databases', () => {
  it('generates only names the guard accepts', () => {
    for (const p of ['chain', 'push', 'rlsctl'] as const) expect(() => assertScratchName(scratchName(p))).not.toThrow()
  })

  it('refuses anything that is not a lineage scratch name', () => {
    for (const bad of ['backenly', 'postgres', 'template1', 'backenly_lineage_chain_ABCDEF12', 'backenly_lineage_other_0123abcd', 'backenly_lineage_chain_0123abcd; DROP']) {
      expect(() => assertScratchName(bad)).toThrow(/refusing/)
    }
  })
})

describe('carried input', () => {
  it('round-trips and rejects malformed input', () => {
    const input = { purpose: 'chain' as const, source: { kind: 'x' }, files: [{ name: 'a', sql: 'SELECT 1;\r\nSELECT $$;$$;' }] }
    expect(decodeInput(encodeInput(input))).toEqual(input)
    expect(() => decodeInput(undefined)).toThrow(/LINEAGE_INPUT_B64/)
    expect(() => decodeInput(encodeInput({ ...input, purpose: 'rlsctl' as never }))).toThrow(/purpose/)
    expect(() => decodeInput(encodeInput({ ...input, files: [] }))).toThrow(/no files/)
  })
})

describe('routine body normalisation', () => {
  it('ignores line endings and edge whitespace, nothing else', () => {
    expect(normaliseBody('\r\n  BEGIN  \r\n    RETURN 1;\t\r\n  END;\r\n\r\n')).toBe('  BEGIN\n    RETURN 1;\n  END;')
    expect(bodyDigest('BEGIN\r\nRETURN 1;\r\nEND;')).toBe(bodyDigest('BEGIN\nRETURN 1;\nEND;\n'))
    expect(bodyDigest('BEGIN RETURN 1; END;')).not.toBe(bodyDigest('BEGIN RETURN 2; END;'))
    expect(bodyDigest(' BEGIN')).not.toBe(bodyDigest('BEGIN'))
  })
})
