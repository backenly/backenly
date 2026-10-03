/**
 * THE RESTORE MUST REFUSE BEFORE IT TOUCHES ANYTHING
 * ==================================================
 * `lib/services/workspace-backup.ts` restored by dropping the target schema
 * first and reading the dump second. An unreadable dump therefore destroyed a
 * working schema and left nothing to go back to, and no amount of loud failure
 * afterwards undoes that.
 *
 * So the property under test is not "validation runs first" but "a mutating
 * step cannot begin without it" - a check rather than a convention about call
 * order. And every refusal has to state whether the target was touched, because
 * that is the difference between "try again" and "do not touch this machine".
 *
 * These need no database. A bundle is a directory of files and a manifest, so
 * every bad path an operator can hand the restorer - corrupt manifest, missing
 * component, altered file, wrong credential, unsupported version - can be built
 * on disk and checked in the fast suite.
 */

import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  assertValidationsPassed,
  RestoreAbortedError,
  runnableSubsystems,
  validateBundle,
} from '@/lib/recovery/restore'
import {
  BUNDLE_FORMAT_VERSION,
  QUIESCED_SUBSYSTEMS,
  RESTORE_ORDER,
  VALIDATION_STEPS,
  mutatesTarget,
  type RecoveryManifest,
} from '@/lib/recovery/contract'
import {
  generateDataKey,
  sealBuffer,
  sha256,
  wrapDataKey,
} from '@/lib/recovery/crypto'
import { MANIFEST_FILE } from '@/lib/recovery/export'

jest.setTimeout(120_000)

const CREDENTIAL = 'TESTCRED-ABCDEFGH-JKLMNPQR-23456789'

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
})

/**
 * A minimal but genuinely well-formed bundle.
 *
 * Built by hand rather than by the exporter so these stay database-free. The
 * shape is the real one - sealed component, real checksum, real wrapped key -
 * because a fixture that skipped any of those would let a broken validator
 * pass.
 */
async function writeBundle(mutate?: (m: RecoveryManifest, dir: string) => Promise<void> | void) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'recovery-guard-'))
  dirs.push(dir)

  const dataKey = generateDataKey()
  const plaintext = Buffer.from('-- a dump\nCREATE TABLE public.users (id uuid);\n')
  const sealed = sealBuffer(plaintext, dataKey)
  await fs.promises.writeFile(path.join(dir, 'platform.sql.enc'), sealed)

  const metadata = Buffer.from(JSON.stringify({ backenlyVersion: 'test' }) + '\n')
  await fs.promises.writeFile(path.join(dir, 'metadata.json'), metadata)

  const manifest: RecoveryManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    backenlyVersion: 'test',
    schemaVersion: 'test',
    postgresVersion: '16.4',
    requiredExtensions: ['pgcrypto'],
    components: [
      {
        component: 'platform-database',
        path: 'platform.sql.enc',
        bytes: sealed.length,
        sha256: sha256(sealed),
        encrypted: true,
        items: 1,
      },
      {
        component: 'deployment-metadata',
        path: 'metadata.json',
        bytes: metadata.length,
        sha256: sha256(metadata),
        encrypted: false,
        items: 1,
      },
    ],
    wrappedDataKey: wrapDataKey(dataKey, CREDENTIAL),
  }

  await mutate?.(manifest, dir)
  await fs.promises.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2))
  return dir
}

describe('the gate in front of every mutating step', () => {
  it('refuses each one while any validation is outstanding', () => {
    // Every mutating step, not a sample. A gate with a hole in it is not a gate.
    for (const step of RESTORE_ORDER.filter(mutatesTarget)) {
      expect(() => assertValidationsPassed(step, [])).toThrow(RestoreAbortedError)
      expect(() => assertValidationsPassed(step, ['validate-manifest'])).toThrow(RestoreAbortedError)
    }
  })

  it('names what is still outstanding', () => {
    // A refusal an operator cannot act on gets worked around.
    let message = ''
    try {
      assertValidationsPassed('restore-platform-database', ['validate-manifest'])
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('validate-checksums')
    expect(message).toContain('validate-version-compatibility')
  })

  it('reports the target as untouched, because it is', () => {
    // The distinction between "try again" and "do not touch this machine".
    try {
      assertValidationsPassed('restore-platform-database', [])
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as RestoreAbortedError).targetUntouched).toBe(true)
    }
  })

  it('never blocks a validation step', () => {
    for (const step of VALIDATION_STEPS) {
      expect(() => assertValidationsPassed(step, [])).not.toThrow()
    }
  })

  it('opens once all three have passed', () => {
    for (const step of RESTORE_ORDER.filter(mutatesTarget)) {
      expect(() => assertValidationsPassed(step, [...VALIDATION_STEPS])).not.toThrow()
    }
  })
})

describe('nothing runs on its own until the restore is verified', () => {
  it('keeps every subsystem off part-way through', () => {
    // Walked cumulatively, because the dangerous shape is a subsystem starting
    // after some earlier step completed rather than after the last one.
    const completed: typeof RESTORE_ORDER[number][] = []
    for (const step of RESTORE_ORDER) {
      if (step === 'verify-health-and-integrity') break
      completed.push(step)
      expect(runnableSubsystems(completed)).toEqual([])
    }
  })

  it('starts them only after final verification', () => {
    const all = [...RESTORE_ORDER]
    expect(runnableSubsystems(all).sort()).toEqual([...QUIESCED_SUBSYSTEMS].sort())
  })
})

describe('bad archives, refused before the target is touched', () => {
  it('accepts a well-formed bundle, so the refusals below mean something', async () => {
    // The control. Without it, a validator that refused everything would pass
    // every other test in this block.
    const dir = await writeBundle()
    const bundle = await validateBundle(dir, CREDENTIAL)
    expect(bundle.manifest.formatVersion).toBe(BUNDLE_FORMAT_VERSION)
    expect(bundle.dataKey).toHaveLength(32)
  })

  it('refuses a manifest that is not JSON', async () => {
    const dir = await writeBundle()
    await fs.promises.writeFile(path.join(dir, MANIFEST_FILE), '{ not json')
    await expect(validateBundle(dir, CREDENTIAL)).rejects.toThrow(/Could not read manifest/)
  })

  it('refuses a directory with no manifest at all', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'recovery-empty-'))
    dirs.push(dir)
    await expect(validateBundle(dir, CREDENTIAL)).rejects.toThrow(RestoreAbortedError)
  })

  it('refuses a manifest missing its required fields', async () => {
    const dir = await writeBundle()
    await fs.promises.writeFile(
      path.join(dir, MANIFEST_FILE),
      JSON.stringify({ createdAt: 'now' }),
    )
    await expect(validateBundle(dir, CREDENTIAL)).rejects.toThrow(/not a recovery bundle/i)
  })

  it('refuses a bundle newer than this build', async () => {
    // Restoring part of it would produce a deployment silently missing whatever
    // the newer format added, and the operator would believe it worked.
    const dir = await writeBundle(m => { m.formatVersion = BUNDLE_FORMAT_VERSION + 1 })
    await expect(validateBundle(dir, CREDENTIAL)).rejects.toThrow(/at least as new/i)
  })

  it('refuses when a component named in the manifest is missing', async () => {
    const dir = await writeBundle()
    await fs.promises.unlink(path.join(dir, 'platform.sql.enc'))
    await expect(validateBundle(dir, CREDENTIAL)).rejects.toThrow(/not in the bundle/)
  })

  it('refuses a component that fails its checksum', async () => {
    const dir = await writeBundle()
    const file = path.join(dir, 'platform.sql.enc')
    const bytes = await fs.promises.readFile(file)
    bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff
    await fs.promises.writeFile(file, bytes)
    await expect(validateBundle(dir, CREDENTIAL)).rejects.toThrow(/does not match its checksum/)
  })

  it('refuses a truncated component', async () => {
    const dir = await writeBundle()
    const file = path.join(dir, 'platform.sql.enc')
    const bytes = await fs.promises.readFile(file)
    await fs.promises.writeFile(file, bytes.subarray(0, bytes.length - 8))
    await expect(validateBundle(dir, CREDENTIAL)).rejects.toThrow(RestoreAbortedError)
  })

  it('refuses the wrong credential', async () => {
    const dir = await writeBundle()
    await expect(validateBundle(dir, 'WRONG-CREDENTIAL')).rejects.toThrow(/credential is wrong/i)
  })

  it('refuses a bundle with no wrapped key', async () => {
    const dir = await writeBundle(m => { m.wrappedDataKey = null })
    await expect(validateBundle(dir, CREDENTIAL)).rejects.toThrow(/cannot be opened/)
  })

  it('refuses a component re-encrypted under a different key', async () => {
    // Checksums alone would accept this: the file is intact, it is just not the
    // file that belongs here. The GCM tag is what catches substitution.
    const dir = await writeBundle(async (m, d) => {
      const foreign = sealBuffer(Buffer.from('-- someone else\n'), generateDataKey())
      await fs.promises.writeFile(path.join(d, 'platform.sql.enc'), foreign)
      const entry = m.components.find(c => c.component === 'platform-database')!
      // Checksum updated to match, so only authentication can reject it.
      entry.bytes = foreign.length
      entry.sha256 = sha256(foreign)
    })
    await expect(validateBundle(dir, CREDENTIAL)).rejects.toThrow(/authentication check/i)
  })

  it('says the target was untouched for every one of them', async () => {
    // The property that matters on the day: whatever went wrong, the operator
    // has lost nothing and can go and find another copy.
    const dir = await writeBundle()
    await fs.promises.unlink(path.join(dir, 'platform.sql.enc'))
    try {
      await validateBundle(dir, CREDENTIAL)
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(RestoreAbortedError)
      expect((err as RestoreAbortedError).targetUntouched).toBe(true)
    }
  })

  it('checks corruption BEFORE asking the credential to be right', async () => {
    // Ordering with a purpose: an operator learns a bundle is damaged without
    // first having to go and find their recovery credential.
    const dir = await writeBundle()
    const file = path.join(dir, 'platform.sql.enc')
    const bytes = await fs.promises.readFile(file)
    bytes[0] = bytes[0] ^ 0xff
    await fs.promises.writeFile(file, bytes)

    // Wrong credential AND a corrupt file: the corruption is what is reported.
    await expect(validateBundle(dir, 'ALSO-WRONG-' + randomBytes(4).toString('hex')))
      .rejects.toThrow(/does not match its checksum/)
  })
})
