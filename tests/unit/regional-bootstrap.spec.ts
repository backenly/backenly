/**
 * THE REGIONAL DATABASE PROCEDURE, READ AS TEXT
 * =============================================
 * What can be checked without a database is checked here, so it fails in the
 * unit job in seconds rather than in the rehearsal, or in a region:
 *
 *   the extension lists in the SQL are tools/managed-db/extension-spec.ts,
 *     names, preload and probes alike;
 *   roles.sql never names an attribute the RDS master may not set, never
 *     widens an existing role, and never carries a password;
 *   the steps bootstrap.sh records are the steps verify.sql requires;
 *   the image carries every file the procedure reads, and trusts only the
 *     region's own RDS roots, from a pinned copy in the repository;
 *   the SCRAM verifier is byte for byte the one PostgreSQL computes.
 *
 * tests/integration/regional-bootstrap.spec.ts runs the procedure itself.
 */

import { createHash, X509Certificate } from 'crypto'
import fs from 'fs'
import path from 'path'

import { REQUIRED_EXTENSIONS } from '@/tools/managed-db/extension-spec'
import { generatePassword, scramSha256Verifier } from '@/tools/managed-db/regional/scram'

const ROOT = process.cwd()
const DIR = 'tools/managed-db/regional'
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, '')

/** The text of `sql` between two section markers. */
function section(sql: string, from: string, to: string): string {
  const start = sql.indexOf(from)
  const end = sql.indexOf(to, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return sql.slice(start, end)
}

describe('the extensions are the managed-database spec', () => {
  it('installs exactly the required extensions, with their preload requirements', () => {
    const rows = [...withoutComments(read(`${DIR}/sql/extensions.sql`)).matchAll(/\('([a-z_]+)',\s*(true|false)\s*\)/g)]
      .map((m) => ({ name: m[1], requiresPreload: m[2] === 'true' }))
    expect(rows).toEqual(REQUIRED_EXTENSIONS.map((e) => ({ name: e.name, requiresPreload: e.requiresPreload })))
  })

  it.each(['verify.sql', 'verify-project-db.sql'])('%s verifies each one with the spec’s own operational probe', (file) => {
    const block = section(read(`${DIR}/sql/${file}`), '── Extensions', '── Every step recorded')
    const rows = [...block.matchAll(/\('([a-z_]+)',\s*'((?:[^']|'')*)'\)/g)]
      .map((m) => ({ name: m[1], probe: m[2].replace(/''/g, "'") }))
    expect(rows).toEqual(REQUIRED_EXTENSIONS.map((e) => ({ name: e.name, probe: e.operationalProbe })))
  })

  it('lands them where the spec says', () => {
    expect(new Set(REQUIRED_EXTENSIONS.map((e) => e.expectedSchema))).toEqual(new Set(['public']))
    expect(read(`${DIR}/sql/extensions.sql`)).toContain("CREATE EXTENSION IF NOT EXISTS %I SCHEMA public")
  })
})

describe('roles.sql', () => {
  const code = withoutComments(read(`${DIR}/sql/roles.sql`))

  it('never names an attribute the RDS master may not set', () => {
    // PostgreSQL refuses a non-superuser that mentions SUPERUSER at all, even
    // NOSUPERUSER, and only a role holding REPLICATION may grant it.
    expect(code).not.toMatch(/\b(NO)?SUPERUSER\b/i)
    expect(code).not.toMatch(/\b(NO)?REPLICATION\b/i)
    // BYPASSRLS exactly once: the backup role, at creation.
    expect(code.match(/\bBYPASSRLS\b/gi)).toEqual(['BYPASSRLS'])
    expect(code).toMatch(/CREATE ROLE backenly_backup LOGIN NOINHERIT BYPASSRLS;/)
  })

  it('only ever narrows an existing role', () => {
    const alters = [...code.matchAll(/ALTER ROLE\s+(\S+)\s+(WITH\s+[A-Z][A-Z ]*[A-Z]|PASSWORD|SET|IN DATABASE)/g)]
    const total = code.match(/ALTER ROLE/g)?.length ?? 0
    expect(alters).toHaveLength(total)
    const widening = alters
      .filter((m) => m[2].startsWith('WITH'))
      .flatMap((m) => m[2].replace(/^WITH\s+/, '').split(/\s+/))
      .filter((attr) => !['NOINHERIT', 'NOCREATEDB', 'NOCREATEROLE', 'NOLOGIN'].includes(attr))
    expect(widening).toEqual([])
    expect(alters.filter((m) => m[2].startsWith('WITH')).length).toBeGreaterThanOrEqual(4)
  })

  it('carries no password, only verifiers read from the environment bootstrap.sh exports', () => {
    expect(code).not.toMatch(/PASSWORD\s+'/i)
    const read_ = [...code.matchAll(/^\\getenv\s+\S+\s+(\S+)$/gm)].map((m) => m[1]).sort()
    const exported = [...read(`${DIR}/bootstrap.sh`).matchAll(/^export (\w+)=/gm)].map((m) => m[1]).sort()
    expect(read_).toEqual(exported)
    expect(read_).toEqual([
      'BACKENLY_APP_VERIFIER',
      'BACKENLY_AUTHENTICATOR_VERIFIER',
      'BACKENLY_BACKUP_VERIFIER',
      'BACKENLY_DBCREATOR_VERIFIER',
      'BOOTSTRAP_ROTATE',
    ])
  })

  it('makes the database creator able to create databases and nothing else, and never grants it', () => {
    expect(code).toMatch(/CREATE ROLE backenly_dbcreator LOGIN NOINHERIT CREATEDB;/)
    expect(code.match(/CREATE ROLE backenly_dbcreator/g)).toHaveLength(1)
    // Granted to no role, and no role granted to it, anywhere the procedure or
    // the helpers it installs could do it.
    const everySql = [
      ...['roles.sql', 'project-db.sql', 'verify.sql', 'verify-project-db.sql'].map((f) => read(`${DIR}/sql/${f}`)),
      read('scripts/setup-direct-access.sql'),
      read('scripts/sql/function-roles.sql'),
      read('scripts/sql/postgrest-schema-registry.sql'),
      read('scripts/sql/project-database-acl.sql'),
    ].map(withoutComments)
    for (const sql of everySql) {
      expect(sql).not.toMatch(/GRANT\s+backenly_dbcreator\b/i)
      expect(sql).not.toMatch(/\bTO\s+backenly_dbcreator\b/i)
    }
  })

  it('sets the application role’s createrole_self_grant for the role, which a clone keeps', () => {
    expect(code).toContain(`ALTER ROLE backenly_app SET createrole_self_grant = 'set, inherit';`)
    expect(code).not.toMatch(/IN DATABASE[^;]*createrole_self_grant/)
  })
})

describe('bootstrap.sh and verify.sql agree', () => {
  it('requires every step the procedure records, and no other', () => {
    const steps = [...read(`${DIR}/bootstrap.sh`).matchAll(/^step ([a-z-]+) /gm)].map((m) => m[1])
    const block = section(read(`${DIR}/sql/verify.sql`), '── Every step recorded', 'IF array_length')
    const required = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    expect(steps).toEqual(['roles', 'postgrest', 'drift-events', 'regional-bodies', 'auth-projection', 'direct-access', 'extensions'])
    expect(required).toEqual(steps)
  })

  it('requires every step a project database records, and no other', () => {
    const declared = /^PROJECT_STEPS=\(([a-z -]+)\)$/m.exec(read(`${DIR}/bootstrap.sh`))
    expect(declared).not.toBeNull()
    const steps = declared![1].trim().split(/\s+/)
    const block = section(read(`${DIR}/sql/verify-project-db.sql`), '── Every step recorded', 'IF array_length')
    const required = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    expect(steps).toEqual(['project-db', 'postgrest', 'drift-events', 'direct-access', 'extensions'])
    expect(required).toEqual(steps)
    // Each has its files, and the PostgREST one is the region's step, file for file.
    const script = read(`${DIR}/bootstrap.sh`)
    for (const id of steps) expect(script).toMatch(new RegExp(`^    ${id}\\) printf '%s' "\\$`, 'm'))
    expect(script).toContain('step postgrest "$POSTGREST_FILES" postgrest_install')
    expect(script).toContain(`postgrest) printf '%s' "$POSTGREST_FILES" ;;`)
  })

  it('checks a project database for the same helpers it checks the region’s database for, and their own', () => {
    const signatures = (file: string) =>
      [...section(read(file), '── The definer functions', 'AS f(signature, app_calls)').matchAll(/\('(public\.[a-z_]+\([a-z,]*\))',\s*(true|false)\)/g)].map((m) => `${m[1]} ${m[2]}`)
    const region = signatures(`${DIR}/sql/verify.sql`)
    expect(region.length).toBeGreaterThan(20)
    expect(signatures(`${DIR}/sql/verify-project-db.sql`)).toEqual(region)
    expect(region).toContain('public.backenly_direct_login_elsewhere(text) false')
  })

  it('reaches a project database only by name, never the region’s through the project steps', () => {
    const projectDb = withoutComments(read(`${DIR}/sql/project-db.sql`))
    expect(projectDb).toContain(`IF db <> 'backenly_project_template' AND db !~ '^p_[0-9a-f]{32}$' THEN`)
    const preflight = withoutComments(read(`${DIR}/sql/preflight.sql`))
    expect(preflight).toContain(`current_database() = 'backenly_project_template' OR current_database() ~ '^p_[0-9a-f]{32}$'`)
  })

  it('gives a clone its database grants in plain SQL a driver can send, with its inputs documented', () => {
    const acl = read('scripts/sql/project-database-acl.sql')
    expect(acl.split('\n').filter((l) => l.startsWith('\\'))).toEqual([])
    expect(acl).toContain('── Inputs')
    expect(acl).toContain("current_setting('backenly.project_database', true)")
    expect(withoutComments(acl)).toMatch(/REVOKE CONNECT, TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC/)
  })

  it('passes psql the URL as -d, which psql on Windows still reads options after', () => {
    expect(read(`${DIR}/bootstrap.sh`)).toMatch(/^PSQL=\(psql .* -d "\$DATABASE_URL"\)$/m)
    expect(read('scripts/lib/db-admin.sh')).toContain('psql -d "$BACKENLY_ADMIN_DATABASE_URL" "$@"')
  })
})

describe('the image', () => {
  const listed = read(`${DIR}/image-files.txt`)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  it('lists only files that exist', () => {
    expect(listed.filter((f) => !fs.existsSync(path.join(ROOT, f)))).toEqual([])
  })

  it('carries every file bootstrap.sh and the PostgREST installer read', () => {
    const script = read(`${DIR}/bootstrap.sh`)
    const fromHere = [...script.matchAll(/\$HERE\/([\w./-]+)/g)]
      .filter((m) => !m[1].startsWith('..'))
      .map((m) => `${DIR}/${m[1]}`)
    const fromRoot = [...script.matchAll(/\$ROOT\/([\w./-]+)/g)].map((m) => m[1])
    const installer = read('scripts/postgrest-install.sh')
    const installed = [...installer.matchAll(/\b([\w-]+\.sql)\b/g)].map((m) => `scripts/sql/${m[1]}`)
    const sourced = [...installer.matchAll(/\$DIR\/(lib\/[\w.-]+\.sh)/g)].map((m) => `scripts/${m[1]}`)
    const needed = new Set([`${DIR}/bootstrap.sh`, ...fromHere, ...fromRoot, ...installed, ...sourced])
    expect([...needed].filter((f) => !listed.includes(f))).toEqual([])
  })

  it('is built from a dated base and runs as a user that is not root', () => {
    const docker = read(`${DIR}/Dockerfile.bootstrap`)
    expect(docker).toMatch(/^FROM debian:bookworm-\d{8}-slim$/m)
    expect(docker).toMatch(/^USER 10001$/m)
  })

  it('trusts the region’s committed RDS roots and nothing it downloads', () => {
    const docker = read(`${DIR}/Dockerfile.bootstrap`)
    expect(docker).toContain('COPY rds-ca.pem /etc/ssl/rds/rds-ca.pem')
    expect(docker).toMatch(/PGSSLROOTCERT=\/etc\/ssl\/rds\/rds-ca\.pem/)
    expect(docker).not.toMatch(/truststore\.pki\.rds\.amazonaws\.com/)
    const build = read(`${DIR}/build-and-push.sh`)
    expect(build).toContain('CA="docker/certs/rds-ca-${REGION}.pem"')
    expect(build).toContain('cp "$ROOT/$CA" "$CTX/rds-ca.pem"')
  })
})

describe('the RDS roots a regional image trusts', () => {
  // Fetched 2026-10-16 from https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem
  // and committed, so an edit is a reviewed change rather than whatever the
  // network served at build time. ap-south-1, the home region, has its own pin
  // in tests/unit/rds-ca-bundle-is-pinned.spec.ts.
  const PINNED: Record<string, string> = {
    'us-east-1': 'sXEdErrlGDhYEoHiO2y5exB0AWhztNr8gO0UACRi3Xc=',
    'us-west-2': 'cztS5LWJWGN34+APfEYlth4Uy/C14Iys4otPiuzCfGY=',
    'eu-central-1': 'VqDK4ES2zEM5cdlkNHQBaSqS6gKU45J1Oj69ruVNi4Q=',
    'ap-southeast-1': 'PGlgIKO3xnIQhdGCIRwoAkqwGHOt413Mfu67icIO6Xk=',
  }

  it.each(Object.entries(PINNED))('%s is the pinned bundle, byte for byte', (region, sha256) => {
    const pem = fs.readFileSync(path.join(ROOT, `docker/certs/rds-ca-${region}.pem`))
    expect(createHash('sha256').update(pem).digest('base64')).toBe(sha256)
  })

  it.each(Object.keys(PINNED))('%s holds that region’s three roots and nothing else', (region) => {
    const pem = read(`docker/certs/rds-ca-${region}.pem`)
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
    const subjects = certificates.map((c) => new X509Certificate(c).subject.match(/CN=(.+)/)?.[1]).sort()
    expect(subjects).toEqual(
      ['ECC384 G1', 'RSA2048 G1', 'RSA4096 G1'].map((kind) => `Amazon RDS ${region} Root CA ${kind}`),
    )
  })

  it('exists for every region an image may be built for, and only those', () => {
    const committed = fs
      .readdirSync(path.join(ROOT, 'docker/certs'))
      .map((f) => f.match(/^rds-ca-(.+)\.pem$/)?.[1])
      .filter((r): r is string => Boolean(r) && r !== 'ap-south-1')
      .sort()
    expect(committed).toEqual(Object.keys(PINNED).sort())
  })
})

describe('scramSha256Verifier', () => {
  // Produced by PostgreSQL 16 itself (CREATE ROLE ... PASSWORD with
  // password_encryption = scram-sha-256, read back from pg_authid).
  const POSTGRES_COMPUTED =
    'SCRAM-SHA-256$4096:l1q1LM5wulE09eK5ch5D1Q==$UsgAQStG1CcCMWs28EHHX+0CuWgtlMCFF1FG5Evjv8o=:f7pMc9/OFuRTZPys2pz7heAXtNgsi8BlcjouNjQOquw='

  it('is the verifier PostgreSQL computes for the same password and salt', () => {
    const salt = Buffer.from('l1q1LM5wulE09eK5ch5D1Q==', 'base64')
    expect(scramSha256Verifier('correct-horse-battery-staple', { salt })).toBe(POSTGRES_COMPUTED)
  })

  it('salts every verifier afresh, so equal passwords never share one', () => {
    const password = generatePassword()
    expect(password).toMatch(/^[0-9a-f]{64}$/)
    const a = scramSha256Verifier(password)
    const b = scramSha256Verifier(password)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
  })

  it('refuses what PostgreSQL would hash differently, and weak iteration counts', () => {
    expect(() => scramSha256Verifier('has a space')).toThrow(/printable ASCII/)
    expect(() => scramSha256Verifier('pässword')).toThrow(/printable ASCII/)
    expect(() => scramSha256Verifier('x'.repeat(32), { iterations: 1000 })).toThrow(/at least 4096/)
  })
})
