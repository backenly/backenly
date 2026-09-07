/**
 * Two backups of one project in the same second must not share a path.
 *
 * The filename was minute-precision, so a second backup inside the same minute
 * wrote to the SAME file. The first dump was overwritten and its
 * `workspace_backups` row was left describing bytes that no longer existed.
 *
 * Observed on production 2026-09-07: an on-demand verification backup landed in
 * the same minute as the scheduled one, leaving two rows for project
 * 07339e54 — 5419 and 5423 bytes — pointing at a single 5423-byte file. Harmless
 * once, and guaranteed to recur the moment anything drives backups more often
 * than daily.
 *
 * Seconds alone are not enough: a retry inside one second still collides. These
 * tests pin uniqueness that does not depend on how often backups run.
 */
import * as path from 'path'

import { getBackupFilename } from '@/lib/services/workspace-backup'

const NAME = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[0-9a-f]{8}\.sql\.gz$/

describe('getBackupFilename', () => {
  it('matches the documented shape', () => {
    expect(getBackupFilename()).toMatch(NAME)
  })

  it('never repeats, even called in a tight loop inside one second', () => {
    const before = Date.now()
    const names = Array.from({ length: 2000 }, () => getBackupFilename())
    const elapsed = Date.now() - before

    expect(new Set(names).size).toBe(names.length)
    // Guard the guard: if this took long enough to cross many seconds, the
    // uniqueness above could be coming from the clock rather than the suffix.
    expect(elapsed).toBeLessThan(2000)
  })

  it('is unique even when the clock is frozen to a single instant', () => {
    const frozen = new Date('2026-09-07T18:41:33.000Z')
    const spy = jest.spyOn(global, 'Date').mockImplementation(() => frozen as any)
    try {
      const names = Array.from({ length: 500 }, () => getBackupFilename())
      expect(new Set(names).size).toBe(500)
      // Same instant, so every name must carry the identical timestamp and
      // differ ONLY in the random suffix.
      const stamps = new Set(names.map((n) => n.slice(0, 'YYYY-MM-DD-HH-mm-ss'.length)))
      expect(stamps).toEqual(new Set(['2026-09-07-18-41-33']))
    } finally {
      spy.mockRestore()
    }
  })

  it('carries seconds, which the old minute-precision name did not', () => {
    const name = getBackupFilename()
    const stamp = name.slice(0, 'YYYY-MM-DD-HH-mm-ss'.length)
    expect(stamp.split('-')).toHaveLength(6)
  })

  it('produces distinct on-disk paths for one project in the same second', () => {
    const dir = path.join('/var/backups/backenly/workspace-backups', 'proj')
    const frozen = new Date('2026-09-07T18:41:33.000Z')
    const spy = jest.spyOn(global, 'Date').mockImplementation(() => frozen as any)
    try {
      const paths = Array.from({ length: 100 }, () => path.join(dir, getBackupFilename()))
      expect(new Set(paths).size).toBe(100)
    } finally {
      spy.mockRestore()
    }
  })

  it('still yields a distinct uncompressed intermediate path', () => {
    // backupWorkspace derives the .sql path with filename.replace('.gz', ''),
    // so two concurrent dumps must not share that either.
    const a = getBackupFilename().replace('.gz', '')
    const b = getBackupFilename().replace('.gz', '')
    expect(a).not.toBe(b)
    expect(a.endsWith('.sql')).toBe(true)
  })
})
