/**
 * THE PRIVILEGE GRANT STAYS NARROW
 * ================================
 *
 * `tools/managed-db/sql/grant-workspace-create.sql` is the only SQL in this
 * repository that runs as an administrative role. It grants one privilege to
 * one role, and the danger is not what it does — it is what a later edit could
 * make it do while it keeps its reassuring name.
 *
 * So the audit runs over the FILE, and these tests run the audit over the file
 * that ships. A test asserting what the audit would say about a hypothetical
 * string would pass happily while the real script granted SUPERUSER.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  auditGrantSql,
  GRANT_SQL_PATH,
  REQUIRED_ROLE_PRIVILEGES,
} from '../../tools/managed-db/role-privilege-spec'

const ROOT = join(__dirname, '..', '..')
const SQL = readFileSync(join(ROOT, GRANT_SQL_PATH), 'utf8')

describe('the manifest', () => {
  it('asks for exactly one privilege, for one role', () => {
    expect(REQUIRED_ROLE_PRIVILEGES).toHaveLength(1)
    expect(REQUIRED_ROLE_PRIVILEGES[0]).toMatchObject({ role: 'backenly_user', privilege: 'CREATE' })
  })

  it('records what breaks without it, with repository evidence', () => {
    const entry = REQUIRED_ROLE_PRIVILEGES[0]
    expect(entry.requiredBy).toMatch(/42501|project creation throws/)
    expect(entry.evidence).toContain('lib/projects/provision.ts')
  })
})

describe('the shipped SQL passes its own audit', () => {
  it('has no findings', () => {
    expect(auditGrantSql(SQL)).toEqual([])
  })

  it('grants CREATE on the database to the named role, and nothing else', () => {
    const grants = SQL.split(/\r?\n/).filter(l => /^\s*GRANT\b/i.test(l))
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/GRANT CREATE ON DATABASE :"dbname" TO backenly_user;/)
  })

  it('verifies the grant took effect rather than trusting silence', () => {
    // The staging bootstrap issued this same GRANT with `>/dev/null 2>&1` and
    // never checked it, which is why a failure there would have been invisible.
    expect(SQL).toMatch(/the GRANT reported success but the privilege is still absent/)
    expect(SQL).toMatch(/ON_ERROR_STOP on/)
  })

  it('refuses to proceed if the role has been widened elsewhere', () => {
    expect(SQL).toMatch(/rolsuper OR r\.rolcreatedb OR r\.rolcreaterole OR r\.rolbypassrls/)
    expect(SQL).toMatch(/broader than intended/)
  })

  it('records the before and after readings', () => {
    expect(SQL).toMatch(/before: has_database_privilege/)
    expect(SQL).toMatch(/after:  has_database_privilege/)
  })
})

describe('the audit actually rejects things', () => {
  // Non-vacuity. An audit that passes everything would also pass the file above.
  it.each([
    ['ALTER ROLE backenly_user SUPERUSER;', /never|role attributes/],
    ['ALTER ROLE backenly_user CREATEDB;', /databases|role attributes/],
    ['ALTER ROLE backenly_user BYPASSRLS;', /RLS|role attributes/],
    ['ALTER DATABASE backenly OWNER TO backenly_user;', /ownership/],
    ['GRANT ALL ON DATABASE :"dbname" TO backenly_user;', /exactly one privilege/],
    ['GRANT CREATE ON DATABASE :"dbname" TO PUBLIC;', /one named role/],
    ['DROP SCHEMA public CASCADE;', /only grants/],
  ])('rejects %s', (statement, why) => {
    const findings = auditGrantSql(statement)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.map(f => f.why).join(' ')).toMatch(why)
  })

  it('rejects a grant to a different role', () => {
    const findings = auditGrantSql('GRANT CREATE ON DATABASE :"dbname" TO someone_else;')
    expect(findings.length).toBeGreaterThan(0)
  })

  it('rejects an UPDATE hidden among permitted statements', () => {
    const findings = auditGrantSql(
      'SELECT 1;\nGRANT CREATE ON DATABASE :"dbname" TO backenly_user;\nUPDATE users SET admin = true;',
    )
    expect(findings.length).toBeGreaterThan(0)
  })

  it('is not fooled by the file\'s own comments naming forbidden words', () => {
    // The script's header explains it does NOT grant SUPERUSER. An audit that
    // searched comments would refuse the very file it exists to approve.
    expect(SQL).toMatch(/does not grant SUPERUSER/)
    expect(auditGrantSql(SQL)).toEqual([])
  })
})
