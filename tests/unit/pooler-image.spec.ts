/**
 * THE CONNECTION POOLER IMAGE, READ AS TEXT, AND ITS ENTRYPOINT, RUN
 * ==================================================================
 * services/pooler is the one way customers connect PostgreSQL clients to
 * their project's own database. What can be checked without Docker or a
 * database is checked here, in seconds:
 *
 *   the Dockerfile pins its base by digest and PgBouncer to 1.26.1 or later,
 *     runs as a user that is not root, bakes in no secret, and trusts exactly
 *     the Cloud regions' pinned RDS roots, joined as the other images join them;
 *   the entrypoint, in `check` mode, renders the configuration the README
 *     documents for both modes, and refuses every missing, empty, malformed or
 *     unknown setting without printing a secret.
 *
 * scripts/test/pooler-image.sh runs the built image against PostgreSQL in CI.
 */

import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { CLOUD_REGIONS } from '@/lib/regions'

const ROOT = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const DOCKERFILE = 'services/pooler/Dockerfile'
const ENTRYPOINT = 'services/pooler/entrypoint.sh'
const IMAGE_CA = '/etc/ssl/rds/rds-ca-cloud-regions.pem'

describe('the pooler Dockerfile', () => {
  const docker = read(DOCKERFILE)

  it('starts from Debian bookworm slim pinned by digest', () => {
    expect(docker).toMatch(/^FROM debian:bookworm-\d{8}-slim@sha256:[0-9a-f]{64}$/m)
    expect(docker.match(/^FROM /gm)).toHaveLength(1)
  })

  it('pins PgBouncer 1.26.1 or later from the PostgreSQL apt repository, and asserts what it installed', () => {
    const pin = /^ARG PGBOUNCER_VERSION=(\d+)\.(\d+)\.(\d+)-\d+\.pgdg12\+\d+$/m.exec(docker)
    expect(pin).not.toBeNull()
    const [major, minor, patch] = pin!.slice(1).map(Number)
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(1 * 1e6 + 26 * 1e3 + 1)
    expect(docker).toContain('"pgbouncer=${PGBOUNCER_VERSION}"')
    expect(docker).toContain('https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main')
    expect(docker).toMatch(/^ARG PGDG_KEY_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8$/m)
    expect(docker).toContain(`dpkg-query -W -f '\${Version}' pgbouncer | grep -qxF "\${PGBOUNCER_VERSION}"`)
  })

  it('runs as uid 10001, exposes the two ports, and stops with PgBouncer’s safe shutdown', () => {
    expect(docker).toMatch(/^USER 10001$/m)
    expect(docker).toMatch(/^EXPOSE 5432 6543$/m)
    expect(docker).toMatch(/^STOPSIGNAL SIGINT$/m)
    expect(docker).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/pooler-entrypoint"\]$/m)
  })

  it('bakes in no secret and copies only the roots and the entrypoint', () => {
    expect(docker).not.toMatch(/^ENV /m)
    expect(docker).not.toMatch(/^ARG .*(PASSWORD|SECRET|KEY_PEM|CERT_PEM)/im)
    const copies = docker.split('\n').filter((line) => line.startsWith('COPY ') || line.startsWith('ADD '))
    expect(copies).toEqual([
      expect.stringMatching(/^COPY docker\/certs\/rds-ca-/),
      'COPY services/pooler/entrypoint.sh /usr/local/bin/pooler-entrypoint',
    ])
  })

  it('trusts the RDS roots of every Cloud region, joined byte for byte as the published bundle', () => {
    const ids = CLOUD_REGIONS.map((region) => region.id)
    const copy = docker.split('\n').find((line) => line.startsWith('COPY docker/certs/'))!
    expect(copy.trim().split(/\s+/).slice(1, -1).sort()).toEqual(ids.map((id) => `docker/certs/rds-ca-${id}.pem`).sort())
    expect(copy.trim().endsWith(' /etc/ssl/rds/')).toBe(true)

    const join = docker.split('\n').find((line) => line.startsWith('RUN cat /etc/ssl/rds/'))!
    const [inputs, rest] = join.replace(/^RUN cat /, '').split(' > ')
    const output = rest.replace(/\s*\\$/, '').trim()
    expect(output).toBe(IMAGE_CA)
    const files = inputs.trim().split(/\s+/)
    expect([...files].sort()).toEqual(ids.map((id) => `/etc/ssl/rds/rds-ca-${id}.pem`).sort())
    const built = files.map((file) => read(`docker/certs/${path.basename(file)}`)).join('')
    expect(built).toBe(read('public/certs/rds-ca-cloud-regions.pem'))

    // The entrypoint's default is that file.
    expect(read(ENTRYPOINT)).toContain(`readonly IMAGE_SERVER_CA=${IMAGE_CA}`)
  })
})

// ── The entrypoint ────────────────────────────────────────────────────────────

/** bash and openssl are on every CI runner, and in Git for Windows. */
function sh(script: string, args: string[], env: Record<string, string> = {}, cwd = ROOT) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('POOLER_')))
  const result = spawnSync('bash', ['-c', script, 'bash', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...base, ...env } as NodeJS.ProcessEnv,
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

let work = ''
const pem: Record<'cert' | 'key' | 'otherCert' | 'otherKey', string> = { cert: '', key: '', otherCert: '', otherKey: '' }
const PASSWORD = 'pooler-lookup-password-0123456789abcdef'

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'pooler-entrypoint-'))
  const made = sh(
    `set -e
     cd "$1"
     for name in pooler other; do
       openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
         -subj "/CN=$name.localhost" -keyout "$name-key.pem" -out "$name-cert.pem" 2>/dev/null
     done`,
    [work],
    // Git for Windows would otherwise rewrite "/CN=..." into a Windows path.
    { MSYS_NO_PATHCONV: '1' },
  )
  if (made.status !== 0) throw new Error(`openssl could not make test certificates: ${made.stderr}`)
  const file = (name: string) => fs.readFileSync(path.join(work, name), 'utf8')
  pem.cert = file('pooler-cert.pem')
  pem.key = file('pooler-key.pem')
  pem.otherCert = file('other-cert.pem')
  pem.otherKey = file('other-key.pem')
})

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

function valid(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = {
    POOLER_MODE: 'session',
    POOLER_SERVER_HOST: 'db.example.internal',
    POOLER_SERVER_CA_PEM: pem.otherCert,
    POOLER_TLS_CERT_PEM: pem.cert,
    POOLER_TLS_KEY_PEM: pem.key,
    POOLER_AUTH_PASSWORD: PASSWORD,
    ...overrides,
  }
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>
}

function check(env: Record<string, string>) {
  return sh('exec bash "$1" check', [path.join(ROOT, ENTRYPOINT)], env)
}

/** A key = value setting of the rendered pgbouncer.ini. */
function setting(ini: string, key: string): string | undefined {
  const line = ini.split('\n').find((l) => l.startsWith(`${key} =`))
  return line === undefined ? undefined : line.slice(key.length + 2).trim()
}

const SECRETS = () => [PASSWORD, ...[pem.cert, pem.key, pem.otherCert].map((p) => p.split('\n')[1])]

describe('the pooler entrypoint renders', () => {
  it('session pooling on 5432 with every documented setting', () => {
    const result = check(valid())
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const ini = result.stdout
    const expected: Record<string, string> = {
      pool_mode: 'session',
      listen_addr: '0.0.0.0',
      listen_port: '5432',
      unix_socket_dir: '',
      auth_type: 'hba',
      auth_hba_file: '/run/pooler/session/pg_hba.conf',
      auth_file: '/run/pooler/session/userlist.txt',
      auth_user: 'backenly_pooler_auth',
      auth_dbname: 'backenly_pooler',
      auth_query: 'SELECT usename, passwd FROM backenly_pooler.lookup($1)',
      client_tls_sslmode: 'require',
      client_tls_cert_file: '/run/pooler/session/client-tls.crt',
      client_tls_key_file: '/run/pooler/session/client-tls.key',
      client_tls_protocols: 'tlsv1.2,tlsv1.3',
      server_tls_sslmode: 'verify-full',
      server_tls_ca_file: '/run/pooler/session/server-ca.pem',
      server_tls_protocols: 'tlsv1.2,tlsv1.3',
      max_client_conn: '5000',
      default_pool_size: '5',
      min_pool_size: '0',
      reserve_pool_size: '0',
      max_db_connections: '10',
      max_db_client_connections: '0',
      max_prepared_statements: '200',
      query_wait_timeout: '120',
      query_timeout: '900',
      idle_transaction_timeout: '300',
      client_login_timeout: '10',
      server_idle_timeout: '60',
      autodb_idle_timeout: '300',
      ignore_startup_parameters: 'extra_float_digits',
      tcp_keepalive: '1',
      tcp_keepidle: '240',
      tcp_keepintvl: '30',
      tcp_keepcnt: '4',
    }
    for (const [key, value] of Object.entries(expected)) expect([key, setting(ini, key)]).toEqual([key, value])
    expect(ini).toContain('\nbackenly_pooler = host=db.example.internal port=5432 dbname=backenly_pooler\n')
    expect(ini).toContain('\n* = host=db.example.internal port=5432\n')
    // No console users of any kind.
    expect(ini).not.toMatch(/^(admin_users|stats_users)\s*=/m)
    expect(ini).not.toMatch(/^track_extra_parameters\s*=/m)
  })

  it('a pg_hba.conf that admits only TLS logins, and none to the console, the lookup or as the lookup role', () => {
    const { stdout } = check(valid())
    const hba = stdout.slice(stdout.indexOf('# /run/pooler/session/pg_hba.conf'))
    const rules = hba
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'))
      .map((l) => l.trim().split(/\s+/))
    expect(rules).toEqual([
      ['hostssl', 'pgbouncer', 'all', 'all', 'reject'],
      ['hostssl', 'backenly_pooler', 'all', 'all', 'reject'],
      ['hostssl', 'replication', 'all', 'all', 'reject'],
      ['hostssl', 'all', 'backenly_pooler_auth', 'all', 'reject'],
      ['hostssl', 'all', 'all', 'all', 'scram-sha-256'],
    ])
  })

  it('transaction pooling on 6543, and the configurable limits', () => {
    const result = check(
      valid({
        POOLER_MODE: 'transaction',
        POOLER_MAX_CLIENT_CONN: '8000',
        POOLER_DEFAULT_POOL_SIZE: '3',
        POOLER_MAX_DB_CONNECTIONS: '6',
        POOLER_MAX_DB_CLIENT_CONNECTIONS: '400',
        POOLER_QUERY_TIMEOUT: '0',
        POOLER_MAX_PREPARED_STATEMENTS: '0',
        POOLER_SERVER_PORT: '6432',
      }),
    )
    expect(result.status).toBe(0)
    const ini = result.stdout
    expect(setting(ini, 'pool_mode')).toBe('transaction')
    expect(setting(ini, 'listen_port')).toBe('6543')
    expect(setting(ini, 'auth_file')).toBe('/run/pooler/transaction/userlist.txt')
    expect(setting(ini, 'max_client_conn')).toBe('8000')
    expect(setting(ini, 'default_pool_size')).toBe('3')
    expect(setting(ini, 'max_db_connections')).toBe('6')
    expect(setting(ini, 'max_db_client_connections')).toBe('400')
    expect(setting(ini, 'query_timeout')).toBe('0')
    expect(setting(ini, 'max_prepared_statements')).toBe('0')
    expect(ini).toContain('\n* = host=db.example.internal port=6432\n')
  })

  it('the image’s roots when no CA is given, and no server TLS when it is disabled', () => {
    // Outside the image the bundle does not exist, which is itself refused.
    const noCa = check(valid({ POOLER_SERVER_CA_PEM: undefined }))
    expect(noCa.status).toBe(2)
    expect(noCa.stderr).toContain(`${IMAGE_CA} is missing; outside the image, set POOLER_SERVER_CA_PEM`)

    const off = check(valid({ POOLER_SERVER_CA_PEM: undefined, POOLER_SERVER_TLS_MODE: 'disable' }))
    expect(off.status).toBe(0)
    expect(setting(off.stdout, 'server_tls_sslmode')).toBe('disable')
    expect(setting(off.stdout, 'server_tls_ca_file')).toBeUndefined()

    const ca = check(valid({ POOLER_SERVER_TLS_MODE: 'verify-ca' }))
    expect(setting(ca.stdout, 'server_tls_sslmode')).toBe('verify-ca')
  })

  it('PEM values kept on one line with \\n, as some secret stores keep them', () => {
    const oneLine = (value: string) => value.trimEnd().split('\n').join('\\n')
    const result = check(
      valid({ POOLER_TLS_CERT_PEM: oneLine(pem.cert), POOLER_TLS_KEY_PEM: oneLine(pem.key), POOLER_SERVER_CA_PEM: oneLine(pem.otherCert) }),
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('without printing any secret, and keeps no file', () => {
    const before = fs.readdirSync(os.tmpdir()).length
    const result = check(valid())
    for (const secret of SECRETS()) {
      expect(result.stdout).not.toContain(secret)
      expect(result.stderr).not.toContain(secret)
    }
    expect(fs.readdirSync(os.tmpdir()).length).toBeLessThanOrEqual(before)
  })
})

describe('the pooler entrypoint refuses to start', () => {
  const cases: Array<[string, Record<string, string | undefined>, RegExp]> = [
    ['without a mode', { POOLER_MODE: undefined }, /POOLER_MODE is not set/],
    ['with an empty mode', { POOLER_MODE: '' }, /POOLER_MODE is set but empty/],
    ['with an unknown mode', { POOLER_MODE: 'statement' }, /POOLER_MODE must be session or transaction/],
    ['without a server', { POOLER_SERVER_HOST: undefined }, /POOLER_SERVER_HOST is not set/],
    ['with a server that is not a host name', { POOLER_SERVER_HOST: 'db port=1 user=postgres' }, /POOLER_SERVER_HOST must be a host name/],
    ['with a server name ending in a dash', { POOLER_SERVER_HOST: 'db-' }, /POOLER_SERVER_HOST must be a host name/],
    ['with a port that is not a number', { POOLER_LISTEN_PORT: '54a' }, /POOLER_LISTEN_PORT must be a whole number/],
    ['with a port out of range', { POOLER_SERVER_PORT: '70000' }, /POOLER_SERVER_PORT must be from 1 to 65535/],
    ['with port zero', { POOLER_LISTEN_PORT: '0' }, /POOLER_LISTEN_PORT must be from 1 to 65535/],
    ['with a leading zero', { POOLER_MAX_CLIENT_CONN: '05000' }, /POOLER_MAX_CLIENT_CONN must be a whole number/],
    ['with an empty limit', { POOLER_QUERY_TIMEOUT: '' }, /POOLER_QUERY_TIMEOUT must be a whole number/],
    ['with a pool larger than the database cap', { POOLER_DEFAULT_POOL_SIZE: '20' }, /below POOLER_DEFAULT_POOL_SIZE/],
    ['with a client cap below the server cap', { POOLER_MAX_DB_CLIENT_CONNECTIONS: '5' }, /below POOLER_MAX_DB_CONNECTIONS/],
    ['with an unknown server TLS mode', { POOLER_SERVER_TLS_MODE: 'require' }, /verify-full, verify-ca or disable/],
    ['with a CA and server TLS off', { POOLER_SERVER_TLS_MODE: 'disable' }, /POOLER_SERVER_CA_PEM is set, but POOLER_SERVER_TLS_MODE is disable/],
    ['with an unknown POOLER_ setting', { POOLER_MAX_CLIENT_CONNS: '100' }, /POOLER_MAX_CLIENT_CONNS is not a setting the pooler reads/],
    ['without a certificate', { POOLER_TLS_CERT_PEM: undefined }, /POOLER_TLS_CERT_PEM is not set/],
    ['without a key', { POOLER_TLS_KEY_PEM: undefined }, /POOLER_TLS_KEY_PEM is not set/],
    ['without the lookup password', { POOLER_AUTH_PASSWORD: undefined }, /POOLER_AUTH_PASSWORD is not set/],
    ['with a certificate that is not PEM', { POOLER_TLS_CERT_PEM: 'not a certificate' }, /POOLER_TLS_CERT_PEM does not hold a PEM certificate/],
    ['with a key that is not PEM', { POOLER_TLS_KEY_PEM: 'not a key' }, /POOLER_TLS_KEY_PEM does not hold an unencrypted PEM private key/],
    ['with a CA that is not PEM', { POOLER_SERVER_CA_PEM: 'not a CA' }, /POOLER_SERVER_CA_PEM does not hold PEM certificates/],
    ['with a short password', { POOLER_AUTH_PASSWORD: 'short' }, /16 to 1024 characters/],
    ['with a space in the password', { POOLER_AUTH_PASSWORD: 'pooler lookup password 0123' }, /printable ASCII only/],
    ['with a double quote in the password', { POOLER_AUTH_PASSWORD: 'pooler"lookup"password0123' }, /printable ASCII only/],
    ['with a backslash in the password', { POOLER_AUTH_PASSWORD: 'pooler\\lookup\\password0123' }, /printable ASCII only/],
    ['with a non-ASCII password', { POOLER_AUTH_PASSWORD: 'pooler-lookup-pässword-0123' }, /printable ASCII only/],
  ]

  it.each(cases)('%s', (_name, overrides, message) => {
    const env = valid(overrides)
    const result = check(env)
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(message)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    for (const secret of [...SECRETS(), env.POOLER_AUTH_PASSWORD ?? PASSWORD]) expect(result.stderr).not.toContain(secret)
  })

  it('with a key that does not belong to the certificate', () => {
    const result = check(valid({ POOLER_TLS_KEY_PEM: pem.otherKey }))
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/is not the key of the certificate/)
    expect(result.stderr).not.toContain(pem.otherKey.split('\n')[1])
  })

  it('with an argument it does not know', () => {
    const result = sh('exec bash "$1" render', [path.join(ROOT, ENTRYPOINT)], valid())
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/expected no argument, or check/)
  })
})
