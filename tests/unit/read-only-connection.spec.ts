/**
 * The read-only SQL connection: encrypted when the platform's own is, and
 * silent about the database's internals when it fails.
 *
 * run_query and the console's SQL tab failed for every project on production
 * from 2026-11-02 to 2026-11-09 with
 *   no pg_hba.conf entry for host "10.0.x.x", user "bkn_ro_…",
 *   database "backenly", no encryption
 * because the client was built from host, port and database with `ssl: false`
 * (a choice made when the database shared the app's machine), while RDS only
 * admits encrypted connections. The same text, with the internal address, the
 * role and the database name, reached customers and their agents verbatim.
 */

import {
  isConnectionFailure,
  ownCodeRefusal,
  readOnlyConnection,
  READ_CONNECTION_FAILED,
  resourceRefusal,
} from '@/lib/mcp/read-query'

// What node-postgres's Client itself derives from a config: host, user, TLS.
const ConnectionParameters = require('pg/lib/connection-parameters')
const parse = (connectionString: string) => new ConnectionParameters({ connectionString })

const CRED = { roleName: 'bkn_ro_0123456789ab', password: 'p@ss:w/rd#1' }

describe('readOnlyConnection — the platform URL, with the read-only role in it', () => {
  it("keeps the URL's sslmode, so the connection is encrypted where the platform's is", () => {
    const { connectionString } = readOnlyConnection('postgresql://backenly_app:secret@db.internal:5432/backenly?sslmode=require', CRED)
    const parsed = parse(connectionString)
    expect(parsed.ssl).toBeTruthy()
    expect(new URL(connectionString).searchParams.get('sslmode')).toBe('require')
  })

  it('connects as the read-only role, never as the platform login', () => {
    const { connectionString } = readOnlyConnection('postgresql://backenly_app:secret@db.internal:5432/backenly?sslmode=require', CRED)
    const parsed = parse(connectionString)
    expect(parsed.user).toBe(CRED.roleName)
    expect(parsed.password).toBe(CRED.password)
    expect(connectionString).not.toContain('backenly_app')
    expect(connectionString).not.toContain('secret')
  })

  it('keeps host, port, database and the other TLS parameters', () => {
    const parsed = parse(readOnlyConnection('postgresql://u:p@db.internal:6543/backenly?sslmode=verify-full', CRED).connectionString)
    expect(parsed.host).toBe('db.internal')
    expect(Number(parsed.port)).toBe(6543)
    expect(parsed.database).toBe('backenly')
    expect(parsed.ssl).toBeTruthy()
    // Read as a URL: node-postgres would open the certificate file to parse it.
    const withCa = readOnlyConnection('postgresql://u:p@db.internal:6543/backenly?sslmode=verify-full&sslrootcert=%2Fapp%2Fcerts%2Frds.pem', CRED)
    expect(new URL(withCa.connectionString).searchParams.get('sslrootcert')).toBe('/app/certs/rds.pem')
  })

  it('sets no TLS of its own where the URL names none, as the platform pool does', () => {
    // node-postgres then reads PGSSLMODE, exactly as for the platform's own pool.
    const { connectionString } = readOnlyConnection('postgresql://u:p@localhost:5432/backenly', CRED)
    expect(parse(connectionString).ssl).toBe(false)
    expect(readOnlyConnection('postgresql://u:p@localhost:5432/backenly', CRED)).not.toHaveProperty('ssl')
  })
})

describe('isConnectionFailure — what is Backenly\'s side, and what is the statement\'s', () => {
  it.each([
    ['28000', 'no pg_hba.conf entry'],
    ['28P01', 'password authentication failed'],
    ['08006', 'connection failure'],
    ['53300', 'too many connections'],
    ['57P01', 'admin shutdown'],
    ['57P03', 'cannot connect now'],
    ['ECONNREFUSED', 'connect ECONNREFUSED'],
    ['ETIMEDOUT', 'connect ETIMEDOUT'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"],
  ])('%s is a connection failure', (code, message) => {
    expect(isConnectionFailure(Object.assign(new Error(message), { code }))).toBe(true)
  })

  it.each([
    ['42P01', 'relation "nope" does not exist'],
    ['42703', 'column "x" does not exist'],
    ['42601', 'syntax error'],
    ['57014', 'canceling statement due to statement timeout'],
    ['42501', 'permission denied for table users'],
    ['53100', 'could not write to file "base/pgsql_tmp/pgsql_tmp1.0": No space left on device'],
    ['53200', 'out of memory'],
    ['53400', 'temporary file size exceeds temp_file_limit (1048576kB)'],
  ])('%s is the statement\'s own error', (code, message) => {
    expect(isConnectionFailure(Object.assign(new Error(message), { code }))).toBe(false)
  })

  it('a connection dropped mid-query is a connection failure', () => {
    expect(isConnectionFailure(new Error('Connection terminated unexpectedly'))).toBe(true)
  })
})

/**
 * Found by the audit: `SELECT g FROM generate_series(1, 2000000000) g` hit
 * temp_file_limit (53400) and the caller was told the database was
 * unavailable, because all of class 53 counted as a lost connection.
 */
describe('resourceRefusal: a statement that ran out of disk, memory or temp_file_limit', () => {
  it.each([['53100'], ['53200'], ['53400']])('%s is QUERY_TOO_EXPENSIVE, the caller\'s to narrow', (code) => {
    const refusal = resourceRefusal(Object.assign(new Error('stopped'), { code }))
    expect(refusal).toMatchObject({ code: 'QUERY_TOO_EXPENSIVE', status: 400 })
    expect(refusal?.hint).toMatch(/generate_series/)
  })

  it.each([['53300'], ['57014'], ['08006'], ['42601']])('%s is not', (code) => {
    expect(resourceRefusal(Object.assign(new Error('x'), { code }))).toBeNull()
  })

  it('does not repeat PostgreSQL\'s text, which names server paths', () => {
    const refusal = resourceRefusal(Object.assign(new Error('could not write to file "base/pgsql_tmp/x"'), { code: '53100' }))
    expect(refusal?.message).not.toMatch(/pgsql_tmp/)
  })
})

/**
 * Found by the audit: search_path reaches the project's own schema, so an
 * operator there (`SELECT ### 1`) or an overload of a listed name (lower(int))
 * ran code that is not PostgreSQL's.
 */
describe('ownCodeRefusal: names the project\'s own schema defines', () => {
  const statement = { calls: ['lower', 'total'], operators: ['=', '<>', '+'] }

  it('refuses a call whose name the schema defines', () => {
    const refusal = ownCodeRefusal([{ kind: 'function', name: 'lower' }], statement)
    expect(refusal).toMatchObject({ code: 'FUNCTION_NOT_ALLOWED' })
    expect(refusal?.message).toMatch(/lower\(\)/)
    expect(refusal?.hint).toMatch(/Rename or drop/)
  })

  it('refuses an operator the schema defines, written or applied by a comparison', () => {
    expect(ownCodeRefusal([{ kind: 'operator', name: '+' }], statement)).toMatchObject({ code: 'OPERATOR_NOT_ALLOWED' })
    expect(ownCodeRefusal([{ kind: 'operator', name: '=' }], statement)).toMatchObject({ code: 'OPERATOR_NOT_ALLOWED' })
  })

  it('refuses every statement while the schema defines a cast through its own function', () => {
    expect(ownCodeRefusal([{ kind: 'cast', name: 'mood_text' }], { calls: [], operators: [] })).toMatchObject({
      code: 'FUNCTION_NOT_ALLOWED',
    })
  })

  it('admits a statement that names none of them', () => {
    const defined = [
      { kind: 'function', name: 'set_updated_at' },
      { kind: 'operator', name: '###' },
    ]
    expect(ownCodeRefusal(defined, statement)).toBeNull()
  })
})

describe('what the caller reads', () => {
  it('names no host, address, role or database', () => {
    expect(READ_CONNECTION_FAILED).not.toMatch(/pg_hba|\d+\.\d+\.\d+\.\d+|bkn_ro|backenly"|host/i)
    expect(READ_CONNECTION_FAILED).toMatch(/didn't run/)
  })
})
