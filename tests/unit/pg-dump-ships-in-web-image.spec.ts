/**
 * THE WEB IMAGE CAN BACK UP A PROJECT
 * ===================================
 *
 * Project backups (lib/services/workspace-backup.ts) run `pg_dump` from the web
 * process every day, and restores run `psql`. The web image carried neither, so
 * every scheduled backup in staging and production failed with
 * "spawn pg_dump ENOENT" (measured 2026-09-28, both environments, before and
 * after the v11 release). CI never saw it: every job runs on a runner that has a
 * PostgreSQL client installed.
 *
 * A client is not enough on its own: pg_dump refuses a server NEWER than itself,
 * and the server is PostgreSQL 16 (RDS, CI and self-host compose alike) while
 * Debian bookworm's own client is 15. So the final stage installs the matching
 * major from the PostgreSQL project's repository, checks the repository key by
 * fingerprint, and asserts the installed version at build time.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SERVER_MAJOR = 16

function finalStage(file: string): string[] {
  const lines = readFileSync(join(ROOT, 'docker', file), 'utf8').split(/\r?\n/)
  const from = lines.map((l, i) => (/^FROM\s/.test(l) ? i : -1)).filter(i => i >= 0).pop()
  if (from === undefined) throw new Error(`${file} has no FROM`)
  return lines.slice(from)
}

describe('web.Dockerfile final stage', () => {
  const stage = finalStage('web.Dockerfile')
  const text = stage.join('\n')

  it('installs the PostgreSQL client for the server major the platform runs', () => {
    const arg = stage.find(l => /^ARG PG_CLIENT_MAJOR=/.test(l))
    expect(arg).toBe(`ARG PG_CLIENT_MAJOR=${SERVER_MAJOR}`)
    expect(text).toContain('postgresql-client-${PG_CLIENT_MAJOR}')
  })

  it('takes it from the PostgreSQL apt repository, key pinned by fingerprint', () => {
    expect(text).toContain('https://apt.postgresql.org/pub/repos/apt')
    expect(text).toMatch(/signed-by=\/usr\/share\/postgresql-common\/pgdg\/apt\.postgresql\.org\.asc/)
    expect(stage.find(l => /^ARG PGDG_KEY_FINGERPRINT=/.test(l))).toBe(
      'ARG PGDG_KEY_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8',
    )
    expect(text).toMatch(/gpg --show-keys --with-colons .* = "\$PGDG_KEY_FINGERPRINT"/)
  })

  it('asserts pg_dump and psql are that major, after installing them, so a wrong client fails the build', () => {
    const installed = stage.findIndex(l => l.includes('postgresql-client-${PG_CLIENT_MAJOR}'))
    const asserted = stage.findIndex(l => /^RUN pg_dump --version \| grep -E "\^pg_dump \\\(PostgreSQL\\\) \$\{PG_CLIENT_MAJOR\}\\\./.test(l))
    expect(installed).toBeGreaterThan(-1)
    expect(asserted).toBeGreaterThan(installed)
    expect(text).toMatch(/psql --version \| grep -E "\^psql \\\(PostgreSQL\\\) \$\{PG_CLIENT_MAJOR\}\\\./)
  })

  it('does not leave the download tools in the image', () => {
    expect(text).toMatch(/apt-get purge -y curl gnupg/)
  })
})
