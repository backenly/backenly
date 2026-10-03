/**
 * THE CLASSIFICATION HAS TO REACH pg_dump, OR IT IS A COMMENT
 * ==========================================================
 * `lib/recovery/contract.ts` decides which credentials a bundle carries. That
 * decision only means something if it turns into arguments. A contract that
 * says "sessions are dropped" beside an exporter that dumps them anyway is
 * worse than having no contract, because it reads as a guarantee.
 *
 * These run without a database on purpose. The argument builders are pure so
 * that the security-relevant half of the exporter can be pinned here, in the
 * fast suite, rather than only inside an integration test that needs Postgres
 * and gets skipped on someone's laptop.
 */

import {
  assertWorkspaceSchemaName,
  BUNDLE_FILES,
  platformDumpArgs,
  workspaceDumpArgs,
} from '@/lib/recovery/export'
import {
  droppedTableData,
  ENCRYPTED_COMPONENTS,
  PLAINTEXT_COMPONENTS,
  RECOVERY_COMPONENTS,
} from '@/lib/recovery/contract'

describe('the platform dump', () => {
  it('excludes the data of every credential the contract drops', () => {
    // Derived from the contract rather than a second hand-written list, so the
    // two cannot drift apart. That drift is the whole failure mode.
    const args = platformDumpArgs().join(' ')
    for (const table of droppedTableData().platform) {
      expect(args).toContain(`--exclude-table-data=public.${table}`)
    }
  })

  it('actually drops sessions', () => {
    // Named explicitly as well. A loop over an empty list would pass the test
    // above while dumping everything.
    expect(platformDumpArgs()).toContain('--exclude-table-data=public.sessions')
  })

  it('keeps identity and the keys other people depend on', () => {
    const args = platformDumpArgs().join(' ')
    expect(args).not.toContain('public.users')
    expect(args).not.toContain('public.api_keys')
    expect(args).not.toContain('public.two_factor_backup_codes')
  })

  it('drops DATA and never the tables themselves', () => {
    // A restored deployment missing its sessions table cannot sign anybody in.
    // --exclude-table would produce exactly that, and would look almost
    // identical in a diff.
    for (const arg of platformDumpArgs()) {
      if (arg.startsWith('--exclude-table')) {
        expect(arg.startsWith('--exclude-table-data=')).toBe(true)
      }
    }
  })

  it('drops privileges, because nothing but the application role has any', () => {
    expect(platformDumpArgs()).toContain('--no-privileges')
  })

  it('leaves ownership to the restoring role', () => {
    expect(platformDumpArgs()).toContain('--no-owner')
  })
})

describe('the workspace dump', () => {
  const SCHEMAS = ['workspace_abc123', 'workspace_def456']

  it('covers every schema in one invocation', () => {
    const args = workspaceDumpArgs(SCHEMAS)
    for (const schema of SCHEMAS) {
      expect(args).toContain(schema)
    }
    expect(args.filter(a => a === '--schema')).toHaveLength(2)
  })

  it('KEEPS privileges, unlike the platform dump', () => {
    // The asymmetry that is easy to get silently wrong.
    //
    // scripts/setup-postgrest-roles.ts grants USAGE, SELECT, INSERT, UPDATE,
    // DELETE and EXECUTE to anon, authenticated and service_role, and sets
    // ALTER DEFAULT PRIVILEGES so later tables inherit them. Dumping that with
    // --no-privileges gives a restore that looks complete and whose data plane
    // returns nothing - and whose DEFAULT PRIVILEGES are gone too, so every
    // table created afterwards is invisible to PostgREST as well.
    expect(workspaceDumpArgs(SCHEMAS)).not.toContain('--no-privileges')
  })

  it('excludes the one-time auth tables per schema', () => {
    const args = workspaceDumpArgs(SCHEMAS).join(' ')
    for (const schema of SCHEMAS) {
      expect(args).toContain(`--exclude-table-data=${schema}._magic_links`)
      expect(args).toContain(`--exclude-table-data=${schema}._password_resets`)
      expect(args).toContain(`--exclude-table-data=${schema}._email_verifications`)
    }
  })

  it('CARRIES the JWT denylist', () => {
    // The correction that this whole tranche turned on. End-user JWTs are
    // stateless and signed with the project secret, which recovery keeps - so
    // dropping the denylist would silently un-revoke every revoked token, and
    // the middleware reads a missing table as "not blacklisted".
    const args = workspaceDumpArgs(SCHEMAS).join(' ')
    expect(args).not.toContain('_token_blacklist')
  })

  it('handles a deployment with no projects', () => {
    expect(() => workspaceDumpArgs([])).not.toThrow()
  })
})

describe('schema names reaching the command line', () => {
  it('accepts a real workspace schema', () => {
    expect(() => assertWorkspaceSchemaName('workspace_cm3x9k2p0000108l4h7g2f1d')).not.toThrow()
  })

  it('refuses anything that is not one', () => {
    // These come from pg_namespace rather than from a user, so this is defence
    // in depth - but they are interpolated into an argv, and the cost of
    // checking is nothing.
    for (const bad of [
      'public',
      'workspace_abc; DROP SCHEMA public',
      'workspace_abc"',
      '--jobs=4',
      'workspace_',
      '',
    ]) {
      expect(() => assertWorkspaceSchemaName(bad)).toThrow(/not a workspace schema/)
    }
  })

  it('refuses through the argument builder too', () => {
    // The check has to be on the path the exporter actually takes, not only on
    // a helper somebody might forget to call.
    expect(() => workspaceDumpArgs(['public'])).toThrow(/not a workspace schema/)
  })
})

describe('the bundle layout', () => {
  it('gives every component a file', () => {
    expect(Object.keys(BUNDLE_FILES).sort()).toEqual([...RECOVERY_COMPONENTS].sort())
  })

  it('never writes two components to the same path', () => {
    const paths = Object.values(BUNDLE_FILES)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('names encrypted files so a mistake is visible on disk', () => {
    // An operator listing the bundle should be able to see that the dumps are
    // sealed, without reading the manifest or trusting this code.
    for (const component of ENCRYPTED_COMPONENTS) {
      expect(BUNDLE_FILES[component]).toMatch(/\.enc$/)
    }
    for (const component of PLAINTEXT_COMPONENTS) {
      expect(BUNDLE_FILES[component]).not.toMatch(/\.enc$/)
    }
  })
})
