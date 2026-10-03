/**
 * UN-GATING A FEATURE MUST NOT QUIETLY START A DAILY JOB
 * =====================================================
 * Project database snapshots are available in every edition now. The scheduled
 * ones are not, unless the operator asks.
 *
 * The distinction is not about which edition deserves the feature. It is that
 * enabling the schedule would start writing a pg_dump of every project to
 * BACKUP_DIR every day, on every existing install, the moment they upgrade -
 * seven days of retention against a disk nobody measured. That is a change to
 * make on purpose, not one to inherit from a release note.
 *
 * The opposite failure is just as real, so the panel states whether the
 * schedule is on rather than leaving it to be discovered. A backup schedule
 * nobody knows about is the same problem pointing the other way.
 */

import { scheduledSnapshotsEnabled } from '@/lib/services/workspace-backup'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const ORIGINAL_FLAG = process.env.BACKENLY_SCHEDULED_SNAPSHOTS

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  if (ORIGINAL_FLAG === undefined) delete process.env.BACKENLY_SCHEDULED_SNAPSHOTS
  else process.env.BACKENLY_SCHEDULED_SNAPSHOTS = ORIGINAL_FLAG
})

describe('who gets scheduled snapshots', () => {
  it('does NOT schedule them on a self-hosted install by default', () => {
    // The property that keeps an upgrade from filling somebody's disk.
    delete process.env.BACKENLY_EDITION
    delete process.env.BACKENLY_SCHEDULED_SNAPSHOTS
    expect(scheduledSnapshotsEnabled()).toBe(false)
  })

  it('schedules them when the operator opts in', () => {
    delete process.env.BACKENLY_EDITION
    process.env.BACKENLY_SCHEDULED_SNAPSHOTS = 'true'
    expect(scheduledSnapshotsEnabled()).toBe(true)
  })

  it('accepts the two spellings people actually type', () => {
    delete process.env.BACKENLY_EDITION
    for (const value of ['true', 'TRUE', ' true ', '1']) {
      process.env.BACKENLY_SCHEDULED_SNAPSHOTS = value
      expect(scheduledSnapshotsEnabled()).toBe(true)
    }
  })

  it('treats anything else as off rather than guessing', () => {
    // Including "yes" and "on". Guessing at intent here means a daily job runs
    // because somebody typed something plausible, and the conservative reading
    // is the one that cannot surprise a disk.
    delete process.env.BACKENLY_EDITION
    for (const value of ['yes', 'on', 'false', '0', '', 'maybe']) {
      process.env.BACKENLY_SCHEDULED_SNAPSHOTS = value
      expect(scheduledSnapshotsEnabled()).toBe(false)
    }
  })

  it('schedules them in Cloud, where they are part of the service', () => {
    process.env.BACKENLY_EDITION = 'cloud'
    delete process.env.BACKENLY_SCHEDULED_SNAPSHOTS
    expect(scheduledSnapshotsEnabled()).toBe(true)
  })

  it('does not let the flag turn them OFF in Cloud', () => {
    // Cloud customers are not the ones who decide whether Cloud takes backups,
    // and a stray env var must not be able to stop them.
    process.env.BACKENLY_EDITION = 'cloud'
    process.env.BACKENLY_SCHEDULED_SNAPSHOTS = 'false'
    expect(scheduledSnapshotsEnabled()).toBe(true)
  })
})
