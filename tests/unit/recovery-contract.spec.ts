/**
 * THE RECOVERY CONTRACT, PINNED BEFORE ANYTHING IMPLEMENTS IT
 * ==========================================================
 * These assert the promises the two recovery products make, so the promises
 * cannot drift once code starts depending on them. They are deliberately
 * written first: this is the tranche where a platform accidentally claims to
 * restore far more than it does, and the claim is easiest to pin down before
 * there is an implementation arguing for its own convenience.
 */

import {
  assertRestorable,
  BUNDLE_FORMAT_VERSION,
  ENCRYPTED_COMPONENTS,
  PLAINTEXT_COMPONENTS,
  missingComponents,
  mutatesTarget,
  RECOVERY_COMPONENTS,
  RecoveryContractError,
  RESTORE_ORDER,
  VALIDATION_STEPS,
  DURABLE_CREDENTIALS,
  EPHEMERAL_CREDENTIALS,
  isEphemeral,
  dispositionOf,
  droppedTableData,
  PLATFORM_CREDENTIAL_TABLES,
  QUIESCED_SUBSYSTEMS,
  subsystemMayRun,
  type RecoveryManifest,
} from '@/lib/recovery/contract'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function manifest(overrides: Partial<RecoveryManifest> = {}): RecoveryManifest {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    createdAt: '2026-09-19T00:00:00.000Z',
    backenlyVersion: 'test',
    schemaVersion: '20260919000000_test',
    postgresVersion: '16.4',
    requiredExtensions: ['pgcrypto'],
    components: [],
    wrappedDataKey: null,
    ...overrides,
  }
}

describe('what a deployment recovery bundle must be able to carry', () => {
  it('covers every category needed to rebuild a deployment', () => {
    // Pinned as a list, so adding a new kind of deployment state forces a
    // decision about whether recovery includes it rather than letting it be
    // forgotten.
    expect([...RECOVERY_COMPONENTS].sort()).toEqual([
      'deployment-metadata',
      'function-definitions',
      'operator-ownership',
      'platform-database',
      'project-secrets',
      'storage-objects',
      'workspace-schemas',
    ])
  })

  it('encrypts the dumps too, not just the component labelled secrets', () => {
    // The correction that matters here. Encrypting `project-secrets` alone was
    // theatre: the platform dump beside it carries Project.jwtSecret, every
    // password hash and every stored provider credential in the clear, and the
    // workspace dumps carry end-user password hashes.
    expect(ENCRYPTED_COMPONENTS).toContain('project-secrets')
    expect(ENCRYPTED_COMPONENTS).toContain('platform-database')
    expect(ENCRYPTED_COMPONENTS).toContain('workspace-schemas')
    expect(ENCRYPTED_COMPONENTS).toContain('function-definitions')
    expect(ENCRYPTED_COMPONENTS).toContain('storage-objects')
  })

  it('leaves exactly enough readable to identify the bundle', () => {
    // A reader must be able to answer "is this the right bundle, and can this
    // build restore it?" before anyone goes and fetches the credential.
    expect(PLAINTEXT_COMPONENTS).toEqual(['deployment-metadata'])
  })

  it('covers every component, with none left unclassified', () => {
    // The two lists are complements by construction. Asserted anyway, because a
    // component that fell through would be written in the clear by default -
    // and defaulting to plaintext is the failure worth catching.
    const covered = [...ENCRYPTED_COMPONENTS, ...PLAINTEXT_COMPONENTS].sort()
    expect(covered).toEqual([...RECOVERY_COMPONENTS].sort())
  })
})

describe('a bundle states what it contains, so absence is meaningful', () => {
  it('reports the components a bundle does not carry', () => {
    const m = manifest({
      components: [
        { component: 'platform-database', path: 'platform.sql', bytes: 10, sha256: 'x', encrypted: false, items: 1 },
      ],
    })
    // The point: a reader can say "this bundle has no storage" rather than
    // guessing whether storage was empty or unsupported.
    expect(missingComponents(m)).toContain('storage-objects')
    expect(missingComponents(m)).not.toContain('platform-database')
  })

  it('distinguishes present-but-empty from absent', () => {
    // A deployment with no files writes the component with zero items. A
    // bundle predating storage support omits it. Only the second is ambiguous,
    // and this is what removes the ambiguity.
    const empty = manifest({
      components: [
        { component: 'storage-objects', path: 'storage/', bytes: 0, sha256: 'x', encrypted: false, items: 0 },
      ],
    })
    expect(missingComponents(empty)).not.toContain('storage-objects')

    const absent = manifest({ components: [] })
    expect(missingComponents(absent)).toContain('storage-objects')
  })
})

describe('refusing a bundle this build cannot honestly restore', () => {
  it('accepts its own format version', () => {
    expect(() => assertRestorable(manifest())).not.toThrow()
  })

  it('refuses a NEWER bundle rather than restoring part of it', () => {
    // Restoring it would produce a deployment silently missing whatever the
    // newer format added, and the operator would believe recovery succeeded.
    // That is worse than refusing.
    expect(() => assertRestorable(manifest({ formatVersion: BUNDLE_FORMAT_VERSION + 1 })))
      .toThrow(RecoveryContractError)
  })

  it('refuses a bundle naming a component it does not understand', () => {
    const m = manifest({
      components: [
        // A component from some future build.
        { component: 'quantum-state' as never, path: 'q', bytes: 1, sha256: 'x', encrypted: false, items: 1 },
      ],
    })
    expect(() => assertRestorable(m)).toThrow(/does not know how to restore/)
  })

  it('says what to do about it', () => {
    let message = ''
    try {
      assertRestorable(manifest({ formatVersion: BUNDLE_FORMAT_VERSION + 1 }))
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/at least as new/i)
  })
})

describe('the restore order', () => {
  it('validates the whole archive before touching the target', () => {
    // The workspace backup path learned this the expensive way: it dropped a
    // schema and then found the dump unreadable, which is terminal however
    // loudly it fails afterwards.
    const firstMutating = RESTORE_ORDER.findIndex(mutatesTarget)
    const lastValidation = RESTORE_ORDER.reduce(
      (acc, step, i) => (VALIDATION_STEPS.includes(step) ? i : acc),
      -1,
    )
    expect(lastValidation).toBeLessThan(firstMutating)
  })

  it('puts every dependency before what needs it', () => {
    const at = (s: string) => RESTORE_ORDER.indexOf(s as never)

    // Schemas need roles and extensions to exist.
    expect(at('provision-database-roles-and-extensions')).toBeLessThan(at('restore-workspace-schemas'))
    // Storage metadata references projects, which live in the platform database.
    expect(at('restore-platform-database')).toBeLessThan(at('restore-storage-objects'))
    // Secrets are re-wrapped under the TARGET's key, so the target must exist.
    expect(at('restore-platform-database')).toBeLessThan(at('rewrap-secrets-for-target'))
    // Derived state can only be reconciled once its inputs are present.
    expect(at('restore-workspace-schemas')).toBeLessThan(at('reconcile-derived-state'))
  })

  it('verifies health LAST, so success is a claim about the restored system', () => {
    // Not a claim about the restore process having exited 0, which is what
    // "command succeeded" would mean and is not the same thing.
    expect(RESTORE_ORDER[RESTORE_ORDER.length - 1]).toBe('verify-health-and-integrity')
  })
})

describe('the recovery credential is not in the bundle', () => {
  it('the manifest carries only a WRAPPED data key', () => {
    // A bundle holding both the ciphertext and the key that opens it is not
    // encrypted; it is a tarball with a lock painted on it.
    const m = manifest({
      wrappedDataKey: {
        algorithm: 'aes-256-gcm',
        kdf: 'scrypt',
        kdfParams: { N: 65536, r: 8, p: 1 },
        salt: 's', iv: 'i', authTag: 't', ciphertext: 'c',
      },
    })
    const serialised = JSON.stringify(m)
    // The shape has nowhere to put an unwrapped key, which is the guarantee -
    // not that some field happens to be empty today.
    expect(serialised).not.toMatch(/"dataKey"/)
    expect(serialised).not.toMatch(/"recoveryKey"/)
    expect(serialised).not.toMatch(/"passphrase"/)
    expect(m.wrappedDataKey).not.toBeNull()
  })
})


describe('durable credentials survive recovery, ephemeral ones must not', () => {
  it('keeps the values other people’s code depends on', () => {
    // Baked into client bundles, CI pipelines and other systems. Issuing fresh
    // ones would be "restored" and would break every caller, which is not
    // recovery in any sense the operator meant.
    for (const durable of ['project.jwtSecret', 'project.anonKey', 'api_keys', 'database_credentials']) {
      expect(dispositionOf(durable)).toBe('carry')
      expect(isEphemeral(durable)).toBe(false)
    }
  })

  it('keeps identity, so users still exist after recovery', () => {
    // Including the second factor: the user holds those codes offline and
    // cannot re-issue them without first getting in.
    expect(dispositionOf('users')).toBe('carry')
    expect(dispositionOf('two_factor_backup_codes')).toBe('carry')
  })

  it('drops proof of a past login', () => {
    // Restoring a week-old bundle must not resurrect a session somebody
    // revoked. Identity is durable; having been logged in is not.
    expect(isEphemeral('sessions')).toBe(true)
  })

  it('drops one-time credentials that were already spent or cancelled', () => {
    for (const token of [
      'auth_email_codes',
      'oauth_authorization_codes',
      'mcp_oauth_codes',
      '_magic_links',
      '_password_resets',
      '_email_verifications',
    ]) {
      expect(isEphemeral(token)).toBe(true)
    }
  })

  it('drops the setup token', () => {
    // Its whole purpose is to claim an UNCLAIMED deployment. Restoring it into
    // a claimed one would reintroduce exactly the credential the claim
    // was meant to consume.
    expect(isEphemeral('deployment.setupToken')).toBe(true)
  })

  it('KEEPS the JWT denylist, because dropping it would fail open', () => {
    // The one that goes the other way from everything around it, and the
    // reason an earlier draft of this contract got it wrong.
    //
    // End-user JWTs are stateless and signed with the project secret, which
    // recovery carries - so a token revoked before the bundle was written still
    // verifies afterwards. _token_blacklist is the only thing that refuses it,
    // and the middleware treats a missing table as "not blacklisted". Dropping
    // it silently un-revokes every revoked token.
    expect(dispositionOf('_token_blacklist')).toBe('carry')
    expect(isEphemeral('_token_blacklist')).toBe(false)
  })

  it('refuses to guess about anything unclassified', () => {
    // An exporter that silently carried an unknown credential-shaped table is
    // the bug the classification exists to prevent, so the lookup fails loudly
    // rather than defaulting.
    expect(() => dispositionOf('some_table_added_next_year')).toThrow(RecoveryContractError)
    expect(() => dispositionOf('some_table_added_next_year')).toThrow(/carry.*drop|drop.*carry/)
  })

  it('never classifies the same thing as both', () => {
    const durable = new Set(DURABLE_CREDENTIALS)
    expect(EPHEMERAL_CREDENTIALS.filter(e => durable.has(e))).toEqual([])
  })
})

describe('the classification is checked against the real schema', () => {
  /**
   * The point of keying this by table name rather than prose: a new
   * credential-shaped model must not quietly inherit whatever the exporter
   * happens to do with it.
   *
   * docs/mcp-catalog-truth-architecture.md records what a hand-maintained
   * parallel copy of "what exists" cost the platform last time. This reads the
   * schema instead.
   */
  const CREDENTIAL_SHAPED =
    /Token|Session|Credential|Secret|Code|Otp|Magic|Verification|Reset|ApiKey|Password|Refresh|OAuth|Auth/i

  function credentialShapedTables(): Array<{ model: string; table: string }> {
    const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8')
    const out: Array<{ model: string; table: string }> = []
    const models = schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)
    for (const m of models) {
      const [, model, body] = m
      if (!CREDENTIAL_SHAPED.test(model)) continue
      const mapped = body.match(/@@map\("([^"]+)"\)/)
      out.push({ model, table: mapped ? mapped[1] : model })
    }
    return out
  }

  it('finds the models it is meant to be checking', () => {
    // A regex that matched nothing would make every assertion below vacuous,
    // which is the way this kind of ratchet usually dies.
    const found = credentialShapedTables()
    expect(found.length).toBeGreaterThan(10)
    expect(found.map(f => f.table)).toContain('sessions')
    expect(found.map(f => f.table)).toContain('api_keys')
  })

  it('classifies every credential-shaped model in the platform schema', () => {
    // A non-empty result names each offender. The fix is to add it to
    // PLATFORM_CREDENTIAL_TABLES in lib/recovery/contract.ts as carry or drop.
    const unclassified = credentialShapedTables()
      .filter(({ table }) => !(table in PLATFORM_CREDENTIAL_TABLES))
      .map(({ model, table }) => `${model} -> ${table} (needs carry|drop)`)

    expect(unclassified).toEqual([])
  })

  it('does not classify tables the schema no longer has', () => {
    // The other direction: a stale entry is dead weight that reads as though a
    // decision still governs something.
    //
    // Checked against EVERY table, not just the credential-shaped ones. Some
    // entries are classified deliberately despite not matching the regex -
    // `users` is the obvious one, and dropping it from the map because a regex
    // did not happen to match "User" is exactly the wrong outcome.
    const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8')
    const allTables = new Set<string>()
    for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const mapped = m[2].match(/@@map\("([^"]+)"\)/)
      allTables.add(mapped ? mapped[1] : m[1])
    }

    const stale = Object.keys(PLATFORM_CREDENTIAL_TABLES).filter(t => !allTables.has(t))
    expect(stale).toEqual([])
  })
})

describe('the classification drives the export, not just the docs', () => {
  it('turns into the set of tables whose data is omitted', () => {
    const dropped = droppedTableData()
    expect(dropped.platform).toContain('sessions')
    expect(dropped.platform).not.toContain('users')
    expect(dropped.workspace).toContain('_magic_links')
    // The correction, asserted where the exporter will read it.
    expect(dropped.workspace).not.toContain('_token_blacklist')
  })

  it('omits DATA, never the tables themselves', () => {
    // A restored deployment missing its sessions table cannot sign anybody in.
    // The distinction lives in the helper's name and is asserted here so a
    // future edit cannot quietly turn it into --exclude-table.
    for (const table of droppedTableData().platform) {
      expect(dispositionOf(table)).toBe('drop')
    }
  })
})

describe('restore runs quiesced', () => {
  it('names every subsystem that can act on its own', () => {
    // A half-restored deployment describes a past state. Anything that acts on
    // state autonomously will act on that description, and the actions reach
    // the outside world where they cannot be taken back.
    expect([...QUIESCED_SUBSYSTEMS].sort()).toEqual([
      'autonomy-reconciler',
      'background-jobs',
      'cron-scheduler',
      'email-delivery',
      'function-invocation',
      'webhook-delivery',
    ])
  })

  it('keeps everything off during every mutating step', () => {
    for (const step of RESTORE_ORDER) {
      expect(subsystemMayRun(step, false)).toBe(false)
    }
  })

  it('keeps everything off even while the final step is still running', () => {
    // "Writing finished" is not "the restore worked". Autonomy starting here
    // would observe a deployment that has not yet been verified.
    expect(subsystemMayRun('verify-health-and-integrity', false)).toBe(false)
  })

  it('starts them only after final verification has COMPLETED', () => {
    expect(subsystemMayRun('verify-health-and-integrity', true)).toBe(true)
  })

  it('does not start them after some earlier step merely completed', () => {
    // The dangerous shape: a step finishes, something concludes the restore is
    // far enough along, and autonomy begins repairing a deliberately partial
    // schema - fighting the restore step by step.
    expect(subsystemMayRun('reconcile-derived-state', true)).toBe(false)
    expect(subsystemMayRun('restore-workspace-schemas', true)).toBe(false)
  })
})
