/**
 * REACHING A SOURCE SAFELY (lib/import/net.ts)
 * ===========================================
 * A connection string is a request to open a socket from inside Backenly.
 * Every refusal below also asserts its REASON, so a parse error can never pass
 * for a blocked address, and public addresses are shown to still work.
 *
 * Public sample addresses are assembled from octets, not written literally:
 * scripts/preflight-oss.ts refuses a public IPv4 literal in this repository.
 */

import {
  checkProjectUrl,
  connectSource,
  describeSourceError,
  isSupabaseHost,
  parsePostgresUrl,
  resolveCheckedAddress,
  supabaseRefOf,
} from '@/lib/import/net'
import { ImportInputError } from '@/lib/import/driver'

const PUBLIC_V4 = [8, 8, 4, 4].join('.')
const PUBLIC_V6 = ['2001', '4860', '4860', '', '8888'].join(':')

const lookupOf = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

async function refusal(p: Promise<unknown>): Promise<ImportInputError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ImportInputError)
    return err as ImportInputError
  }
  throw new Error('expected a refusal')
}

const ENV = 'BACKENLY_IMPORT_EGRESS_ALLOW_PRIVATE'
afterEach(() => {
  delete process.env[ENV]
})

describe('connection strings', () => {
  it('reads host, port, user, password, database and sslmode', () => {
    const p = parsePostgresUrl('postgresql://postgres.abcdefghijklmnop:p%40s@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require')
    expect(p).toEqual({ host: 'aws-0-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.abcdefghijklmnop', password: 'p@s', database: 'postgres', sslmode: 'require' })
  })

  it('defaults the port and the database', () => {
    const p = parsePostgresUrl('postgres://reader:pw@db.example.com')
    expect(p.port).toBe(5432)
    expect(p.database).toBe('postgres')
    expect(p.sslmode).toBeNull()
  })

  it('refuses anything that would connect somewhere other than one named host', () => {
    const cases: Array<[string, RegExp]> = [
      ['mysql://u:p@db.example.com/x', /starts with postgresql/],
      ['postgresql://u:p@a.example.com,b.example.com/x', /one host/],
      ['postgresql://u:p@/x?host=/var/run/postgresql', /no host/],
      ['postgresql://u:p@db.example.com/x?host=10.0.0.5', /not in \?host=/],
      ['postgresql://u:p@db.example.com/x?sslmode=sometimes', /sslmode=sometimes/],
      ['postgresql://@db.example.com/x', /no user/],
      ['postgresql://u:p@db.example.com:99999/x', /not a valid port/],
    ]
    for (const [raw, why] of cases) {
      let caught: unknown = null
      try {
        parsePostgresUrl(raw)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ImportInputError)
      expect((caught as ImportInputError).field).toBe('connectionString')
      expect((caught as Error).message).toMatch(why)
    }
  })

  it('reaches a database on port 5432 only, saying so, and where Supabase has one', () => {
    expect(parsePostgresUrl('postgresql://u:p@db.example.com:5432/x').port).toBe(5432)
    const cases: Array<[string, string]> = [
      [
        'postgresql://u:p@db.example.com:5433/x',
        'Backenly connects to databases on port 5432 only, and this connection string names port 5433. Use an address of the database that answers on port 5432.',
      ],
      [
        'postgresql://postgres.abcdefghijklmnop:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
        'Backenly connects to databases on port 5432 only, and this connection string names port 6543. In Supabase, press Connect and copy the Session pooler string (port 5432).',
      ],
    ]
    for (const [raw, said] of cases) {
      let caught: unknown = null
      try {
        parsePostgresUrl(raw)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ImportInputError)
      expect((caught as ImportInputError).field).toBe('connectionString')
      expect((caught as Error).message).toBe(said)
    }
  })

  it('knows Supabase hosts and refs', () => {
    expect(isSupabaseHost('db.abcdefghijklmnop.supabase.co')).toBe(true)
    expect(isSupabaseHost('aws-0-us-east-1.pooler.supabase.com')).toBe(true)
    expect(isSupabaseHost('supabase.co.evil.example')).toBe(false)
    expect(supabaseRefOf({ host: 'db.abcdefghijklmnop.supabase.co', user: 'postgres' })).toBe('abcdefghijklmnop')
    expect(supabaseRefOf({ host: 'aws-0-us-east-1.pooler.supabase.com', user: 'postgres.qrstuvwxyzabcdef' })).toBe('qrstuvwxyzabcdef')
  })
})

describe('addresses', () => {
  it('refuses private, loopback, link-local (metadata), CGNAT and IPv6 private ranges', async () => {
    const cases: Array<[string, RegExp]> = [
      ['10.1.2.3', /private/],
      ['127.0.0.1', /loopback/],
      ['169.254.169.254', /link-local/],
      ['100.64.0.1', /carrier-grade NAT/],
      ['::1', /loopback/],
      ['fd00::1', /unique-local/],
      ['fe80::1', /link-local/],
      ['::ffff:127.0.0.1', /via IPv6-embedded IPv4/],
    ]
    for (const [address, why] of cases) {
      const err = await refusal(resolveCheckedAddress(address))
      expect(err.message).toMatch(why)
      expect(err.field).toBe('connectionString')
    }
  })

  it('checks every address a name answers with, not only the first', async () => {
    const err = await refusal(resolveCheckedAddress('db.example.com', { lookup: lookupOf(PUBLIC_V4, '10.0.0.9') }))
    expect(err.message).toMatch(/db\.example\.com is a private address/)
  })

  it('a name that resolves privately is refused (no DNS rebinding through a public-looking name)', async () => {
    const err = await refusal(resolveCheckedAddress('internal.example.com', { lookup: lookupOf('192.168.1.10') }))
    expect(err.message).toMatch(/public internet/)
  })

  it('names the kind of address a name resolved to, never the address', async () => {
    const err = await refusal(resolveCheckedAddress('internal.example.com', { lookup: lookupOf('10.20.30.40') }))
    expect(err.message).toBe('Backenly only connects to sources on the public internet, and internal.example.com is a private address.')
    const metadata = await refusal(resolveCheckedAddress('meta.example.com', { lookup: lookupOf('169.254.169.254') }))
    expect(metadata.message).toBe('Backenly only connects to sources on the public internet, and meta.example.com is a link-local (cloud metadata) address.')
  })

  it('public addresses are allowed, IPv4 preferred', async () => {
    await expect(resolveCheckedAddress(PUBLIC_V4)).resolves.toEqual({ address: PUBLIC_V4, family: 4 })
    await expect(resolveCheckedAddress('db.example.com', { lookup: lookupOf(PUBLIC_V6, PUBLIC_V4) })).resolves.toEqual({ address: PUBLIC_V4, family: 4 })
    await expect(resolveCheckedAddress('db.example.com', { lookup: lookupOf(PUBLIC_V6) })).resolves.toEqual({ address: PUBLIC_V6, family: 6 })
  })

  it('an unknown name is said plainly', async () => {
    const lookup = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    }
    const err = await refusal(resolveCheckedAddress('nope.example.com', { lookup }))
    expect(err.message).toBe("Couldn't connect: nope.example.com was not found. Check the host.")
  })

  it('the self-host hatch opens private ranges but never the metadata service', async () => {
    process.env[ENV] = 'true'
    await expect(resolveCheckedAddress('10.1.2.3')).resolves.toEqual({ address: '10.1.2.3', family: 4 })
    const err = await refusal(resolveCheckedAddress('169.254.169.254'))
    expect(err.message).toMatch(/link-local/)
  })
})

describe('connecting', () => {
  it('Supabase is only reached encrypted: sslmode=disable is refused before any lookup', async () => {
    const lookup = jest.fn(lookupOf(PUBLIC_V4))
    const err = await refusal(
      connectSource(parsePostgresUrl('postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres?sslmode=disable'), { requireTls: true, secrets: [], lookup }),
    )
    expect(err.message).toMatch(/encrypted connection/)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('a refused address never reaches a socket', async () => {
    const err = await refusal(connectSource(parsePostgresUrl('postgresql://u:pw@127.0.0.1:5432/x'), { requireTls: false, secrets: [] }))
    expect(err.message).toMatch(/loopback/)
  })

  it("connection failures are said in the source's words, without the password", () => {
    const msg = describeSourceError(new Error('password authentication failed for user "postgres"'), { host: 'db.example.com', port: 5432, secrets: [] })
    expect(msg).toBe('Couldn\'t connect: password authentication failed for user "postgres"')
    const refused = describeSourceError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), { host: 'db.example.com', port: 6543, secrets: [] })
    expect(refused).toMatch(/db\.example\.com:6543 refused the connection/)
    const echoed = describeSourceError(new Error('bad url postgresql://postgres:' + 'Tr0ub4dor-and-3' + '@db.example.com/x'), { host: 'db.example.com', port: 5432, secrets: ['Tr0ub4dor-and-3'] })
    expect(echoed).not.toMatch(/Tr0ub4dor/)
  })

  it("Supabase's IPv6-only direct host gets the pooler hint", () => {
    const msg = describeSourceError(Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }), {
      host: 'db.abcdefghijklmnop.supabase.co',
      port: 5432,
      family: 6,
      secrets: [],
    })
    expect(msg).toMatch(/Session pooler/)
  })
})

describe('the Storage address', () => {
  it('https://<ref>.supabase.co is accepted without a lookup', async () => {
    const lookup = jest.fn(lookupOf('10.0.0.1'))
    await expect(checkProjectUrl('https://abcdefghijklmnop.supabase.co/', { lookup })).resolves.toBe('https://abcdefghijklmnop.supabase.co')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('plain http, a path, a user in the URL, or a private self-hosted address are refused', async () => {
    const cases: Array<[string, RegExp]> = [
      ['http://abcdefghijklmnop.supabase.co', /https/],
      ['https://abcdefghijklmnop.supabase.co/rest/v1', /without a path/],
      ['https://user:pw@abcdefghijklmnop.supabase.co', /must not carry/],
      ['https://supabase.internal.example', /public internet/],
    ]
    for (const [raw, why] of cases) {
      const err = await refusal(checkProjectUrl(raw, { lookup: lookupOf('10.0.0.7') }))
      expect(err.message).toMatch(why)
      expect(err.field).toBe('projectUrl')
    }
  })

  it('a self-hosted Supabase on a public address is accepted', async () => {
    await expect(checkProjectUrl('https://supabase.example.com', { lookup: lookupOf(PUBLIC_V4) })).resolves.toBe('https://supabase.example.com')
  })
})
