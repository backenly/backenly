/**
 * server.json names the version the MCP registry should install.
 *
 * The registry entry has to point at a version that exists on npm, so it
 * trails packages/mcp-server/package.json while a release is unpublished. It
 * must not trail for ever: once the CHANGELOG dates the release, which is the
 * step taken when it is published, server.json must name that version, in both
 * places it appears. This makes the post-publish bump a failing test rather
 * than a thing to remember.
 */

import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
const server = JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'mcp-server', 'package.json'), 'utf8'))
const changelog = fs.readFileSync(path.join(ROOT, 'packages', 'mcp-server', 'CHANGELOG.md'), 'utf8')

const parts = (v: string) => v.split('.').map(Number)
const lower = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}

describe('server.json', () => {
  it('names one version for the server and its npm package', () => {
    const npm = server.packages.find((p: any) => p.registryType === 'npm')
    expect(npm.identifier).toBe(pkg.name)
    expect(npm.version).toBe(server.version)
  })

  it('names the package version once the CHANGELOG dates it, and an earlier one until then', () => {
    const entry = new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\] — (.+)$`, 'm').exec(changelog)
    expect(entry).not.toBeNull()
    if (/unreleased/i.test(entry![1])) expect([server.version, lower(server.version, pkg.version)]).toEqual([server.version, true])
    else expect(server.version).toBe(pkg.version)
  })
})
