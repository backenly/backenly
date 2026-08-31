/**
 * Purge target safety.
 *
 * Two destructive primitives are involved in project deletion: a recursive
 * directory delete and an S3 prefix delete. Both take a target derived from a
 * project id, and a bug that widened either one would destroy other customers'
 * data. These tests are the guard rail on that arithmetic.
 *
 * Also covers the schema allowlist, which decides which PostgreSQL schemas a
 * DROP is permitted to name.
 */

import * as path from 'path'
import { promises as fs } from 'fs'
import * as os from 'os'
import {
  assertSafeChildPath,
  projectStoragePrefix,
  purgeProjectExternals,
  UnsafePurgeTargetError,
} from '@/lib/projects/purge'
import { isProjectOwnedSchema, InvalidProjectIdError } from '@/lib/security/workspace-schema'

const PROJECT = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-8888-4777-8666-555555555555'

describe('assertSafeChildPath', () => {
  const root = path.join(os.tmpdir(), 'backenly-purge-root')

  it('accepts a direct child', () => {
    expect(() => assertSafeChildPath(root, path.join(root, PROJECT))).not.toThrow()
  })

  it('refuses the root itself', () => {
    // The bug that deletes every project's data in one call.
    expect(() => assertSafeChildPath(root, root)).toThrow(UnsafePurgeTargetError)
  })

  it('refuses an empty root', () => {
    // An unset BACKUP_DIR collapsing to '' must not resolve to the CWD.
    expect(() => assertSafeChildPath('', path.join(root, PROJECT))).toThrow(UnsafePurgeTargetError)
  })

  it('refuses an empty target', () => {
    expect(() => assertSafeChildPath(root, '')).toThrow(UnsafePurgeTargetError)
  })

  it('refuses a filesystem root', () => {
    expect(() => assertSafeChildPath(root, path.parse(process.cwd()).root)).toThrow(
      UnsafePurgeTargetError,
    )
  })

  it('refuses parent traversal out of the root', () => {
    expect(() => assertSafeChildPath(root, path.join(root, '..', 'elsewhere'))).toThrow(
      UnsafePurgeTargetError,
    )
  })

  it('refuses traversal that lands on a sibling sharing a name prefix', () => {
    // `<root>-other` startsWith `<root>` textually. A naive startsWith check
    // passes this; path.relative does not.
    expect(() => assertSafeChildPath(root, `${root}-other`)).toThrow(UnsafePurgeTargetError)
  })

  it('refuses an absolute target outside the root', () => {
    expect(() => assertSafeChildPath(root, path.join(os.tmpdir(), 'unrelated'))).toThrow(
      UnsafePurgeTargetError,
    )
  })
})

describe('projectStoragePrefix', () => {
  it('is the project id followed by a slash', () => {
    expect(projectStoragePrefix(PROJECT)).toBe(`${PROJECT}/`)
  })

  it('cannot be produced for a non-uuid', () => {
    // Without this, a caller could pass '' and produce the prefix '/', which
    // matches every object in the bucket.
    expect(() => projectStoragePrefix('')).toThrow(InvalidProjectIdError)
    expect(() => projectStoragePrefix('../')).toThrow(InvalidProjectIdError)
    expect(() => projectStoragePrefix('all')).toThrow(InvalidProjectIdError)
  })
})

describe('isProjectOwnedSchema — the tenant boundary', () => {
  /**
   * ACCEPTED GRAMMAR
   *
   *   schema := "workspace_" uuid [ "_" suffix ]
   *   uuid   := RFC-4122 layout, 8-4-4-4-12 lowercase-or-uppercase hex with
   *             hyphens, enforced by assertValidProjectId before anything else
   *   suffix := [A-Za-z0-9_]+
   *
   * WHY THE BOUNDARY HOLDS
   *
   * A UUID in this form is exactly 36 characters and contains no underscore.
   * So for two distinct project ids A and B, `workspace_A` can never be a
   * prefix of `workspace_B` (equal length forces A == B), and `workspace_A_...`
   * can never collide with `workspace_B...` because the 47th character is `_`
   * for one and a hex digit or hyphen for the other. Fixed-length validated
   * ids are what make the prefix safe; a bare startsWith on an unvalidated id
   * would not be.
   *
   * WHY THE SUFFIX IS A CHARACTER CLASS RATHER THAN THE THREE KNOWN FORMS
   *
   * Narrowing to `_staging` and `_br_<name>` would reject any schema a future
   * (or forgotten) code path created, and rejection aborts the deletion — so a
   * narrower rule would leave customer data behind rather than remove it. The
   * character class keeps the tenant boundary absolute while still covering
   * historical branch and staging schemas, and anything containing a quote,
   * space, semicolon or hyphen is refused so it can never reach a DROP.
   */

  it('accepts the exact live schema', () => {
    expect(isProjectOwnedSchema(PROJECT, `workspace_${PROJECT}`)).toBe(true)
  })

  it('accepts a valid branch schema', () => {
    expect(isProjectOwnedSchema(PROJECT, `workspace_${PROJECT}_br_add_payments`)).toBe(true)
    expect(isProjectOwnedSchema(PROJECT, `workspace_${PROJECT}_br_Feature2`)).toBe(true)
  })

  it('accepts a valid staging schema', () => {
    expect(isProjectOwnedSchema(PROJECT, `workspace_${PROJECT}_staging`)).toBe(true)
  })

  it("refuses another project's live schema", () => {
    expect(isProjectOwnedSchema(PROJECT, `workspace_${OTHER}`)).toBe(false)
  })

  it("refuses another project's branch schema", () => {
    expect(isProjectOwnedSchema(PROJECT, `workspace_${OTHER}_br_x`)).toBe(false)
    expect(isProjectOwnedSchema(PROJECT, `workspace_${OTHER}_staging`)).toBe(false)
  })

  it('refuses a textual prefix or suffix trick on the project id', () => {
    // A UUID is fixed length and underscore-free, so neither of these can be a
    // real sibling id — but the check must reject them regardless of that.
    expect(isProjectOwnedSchema(PROJECT, `workspace_${PROJECT.slice(0, 30)}`)).toBe(false)
    expect(isProjectOwnedSchema(PROJECT, `workspace_${PROJECT}0`)).toBe(false)
    expect(isProjectOwnedSchema(PROJECT, `workspace_x${PROJECT}`)).toBe(false)
    expect(isProjectOwnedSchema(PROJECT, `workspace_${PROJECT}-extra`)).toBe(false)
    expect(isProjectOwnedSchema(PROJECT, `xworkspace_${PROJECT}`)).toBe(false)
  })

  it('rejects a malformed project id outright rather than guessing', () => {
    for (const bad of ['', 'not-a-uuid', '../etc', PROJECT.slice(0, 35), `${PROJECT} `]) {
      expect(() => isProjectOwnedSchema(bad, `workspace_${bad}`)).toThrow(InvalidProjectIdError)
    }
  })

  it('refuses a valid project id followed by an unexpected delimiter', () => {
    for (const delim of ['-', '.', ' ', ':', '$', '/', '%']) {
      expect(isProjectOwnedSchema(PROJECT, `workspace_${PROJECT}${delim}staging`)).toBe(false)
    }
  })

  it('refuses a name carrying a quote, semicolon, or whitespace', () => {
    // Branch names are user-supplied upstream, so the catalog could in
    // principle hold one of these. Refusing means the deletion aborts rather
    // than interpolating it into a DROP.
    for (const suffix of ['_br_a"b', "_br_a'b", '_br_a b', '_br_a;drop', '_br_a	b', '_br_a-b']) {
      expect(isProjectOwnedSchema(PROJECT, `workspace_${PROJECT}${suffix}`)).toBe(false)
    }
  })

  it('refuses a similarly named non-Backenly schema', () => {
    for (const schema of [
      'public',
      'pg_catalog',
      'information_schema',
      'workspace_',
      'workspaces',
      'workspace_admin',
      `workspace${PROJECT}`,
      `my_workspace_${PROJECT}`,
      '',
    ]) {
      expect(isProjectOwnedSchema(PROJECT, schema)).toBe(false)
    }
  })

  it('refuses a non-string schema name', () => {
    for (const value of [null, undefined, 42, {}]) {
      expect(isProjectOwnedSchema(PROJECT, value as any)).toBe(false)
    }
  })
})

describe('purgeProjectExternals — idempotence on the local driver', () => {
  let root: string
  const originalBackup = process.env.BACKUP_DIR
  const originalStorage = process.env.STORAGE_DIR
  const originalDriver = process.env.STORAGE_DRIVER

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'backenly-purge-'))
    process.env.BACKUP_DIR = path.join(root, 'backups')
    process.env.STORAGE_DIR = path.join(root, 'storage')
    process.env.STORAGE_DRIVER = 'local'
    await fs.mkdir(process.env.BACKUP_DIR, { recursive: true })
    await fs.mkdir(process.env.STORAGE_DIR, { recursive: true })
  })

  afterEach(async () => {
    process.env.BACKUP_DIR = originalBackup
    process.env.STORAGE_DIR = originalStorage
    process.env.STORAGE_DRIVER = originalDriver
    await fs.rm(root, { recursive: true, force: true })
  })

  it('removes both the backup and storage directories for the project', async () => {
    const backupDir = path.join(process.env.BACKUP_DIR!, PROJECT)
    const storageDir = path.join(process.env.STORAGE_DIR!, PROJECT, 'avatars')
    await fs.mkdir(backupDir, { recursive: true })
    await fs.mkdir(storageDir, { recursive: true })
    await fs.writeFile(path.join(backupDir, '2026-01-01-02-00.sql.gz'), 'dump')
    await fs.writeFile(path.join(storageDir, 'file.bin'), 'bytes')

    const report = await purgeProjectExternals(PROJECT)

    expect(report.backups).toBe('purged')
    expect(report.storage).toBe('purged')
    await expect(fs.stat(backupDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(process.env.STORAGE_DIR!, PROJECT))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it("leaves another project's data untouched", async () => {
    const mine = path.join(process.env.STORAGE_DIR!, PROJECT)
    const theirs = path.join(process.env.STORAGE_DIR!, OTHER)
    await fs.mkdir(mine, { recursive: true })
    await fs.mkdir(theirs, { recursive: true })
    await fs.writeFile(path.join(theirs, 'keep.bin'), 'theirs')

    await purgeProjectExternals(PROJECT)

    await expect(fs.stat(path.join(theirs, 'keep.bin'))).resolves.toBeDefined()
  })

  it('reports alreadyAbsent when nothing is there', async () => {
    const report = await purgeProjectExternals(PROJECT)
    expect(report.backups).toBe('alreadyAbsent')
    expect(report.storage).toBe('alreadyAbsent')
  })

  it('is safe to run twice', async () => {
    await fs.mkdir(path.join(process.env.BACKUP_DIR!, PROJECT), { recursive: true })
    await purgeProjectExternals(PROJECT)
    // The retry worker will do exactly this.
    await expect(purgeProjectExternals(PROJECT)).resolves.toMatchObject({
      backups: 'alreadyAbsent',
    })
  })

  it('completes a partial purge without treating the missing half as an error', async () => {
    // Backups already gone, storage still present: the state a retry sees after
    // a crash midway through the previous attempt.
    const storageDir = path.join(process.env.STORAGE_DIR!, PROJECT)
    await fs.mkdir(storageDir, { recursive: true })
    await fs.writeFile(path.join(storageDir, 'left.bin'), 'bytes')

    const report = await purgeProjectExternals(PROJECT)

    expect(report.backups).toBe('alreadyAbsent')
    expect(report.storage).toBe('purged')
    await expect(fs.stat(storageDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a non-uuid project id before touching the filesystem', async () => {
    await expect(purgeProjectExternals('..')).rejects.toThrow(InvalidProjectIdError)
    await expect(purgeProjectExternals('')).rejects.toThrow(InvalidProjectIdError)
    // The roots must survive the attempt.
    await expect(fs.stat(process.env.STORAGE_DIR!)).resolves.toBeDefined()
    await expect(fs.stat(process.env.BACKUP_DIR!)).resolves.toBeDefined()
  })
})
