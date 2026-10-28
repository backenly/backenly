/**
 * @jest-environment jsdom
 */

/**
 * THE API BASE URL IS SHOWN, NOT PROMISED
 * =======================================
 * Connect → Direct and Settings → Connection read project.apiUrlProd/Staging/
 * Dev — columns nothing in the product ever writes (the console creates
 * projects with a name only, and no publish flow sets them) — and rendered
 * "Set when the project is first published" forever (T9 / CON-10 / SET-07).
 * The real base has been `{origin}/api/v1/{projectId}` since the project's
 * first request. Docs tell users to copy the value from these rows.
 *
 * Source-level pins: the pages show the live base the server works out for the
 * project's region (`apiBaseUrl`; operator-supplied overrides still win), and
 * the false claim is gone. They must not build it from the console's own
 * origin: a project in another region is not served there, and the address
 * shown is the one customers copy into their apps.
 */

import fs from 'fs'
import path from 'path'

const pages = {
  connect: fs.readFileSync(path.join(process.cwd(), 'app', 'app', 'projects', '[id]', 'connect', 'page.tsx'), 'utf8'),
  settings: fs.readFileSync(path.join(process.cwd(), 'app', 'app', 'projects', '[id]', 'settings', 'page.tsx'), 'utf8'),
}

for (const [name, src] of Object.entries(pages)) {
  describe(`${name} page`, () => {
    it('shows the live base the server gives for the project’s region', () => {
      expect(src).toContain('project?.apiBaseUrl')
      expect(src).not.toContain('window.location.origin}/api/v1/')
    })

    it('still honors an operator-supplied override first', () => {
      expect(src).toMatch(/apiUrlProd \|\| project\?\.apiUrlStaging \|\| project\?\.apiUrlDev \|\|/)
    })

    it('no longer claims publishing will set it', () => {
      expect(src).not.toContain('Set when the project is first published')
    })
  })
}
