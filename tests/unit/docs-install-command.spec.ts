/**
 * The published install command must actually work.
 *
 * This is the test that would have caught the single most damaging defect found
 * on 2026-07-19. `public/llms.txt` told every agent and every user to run:
 *
 *     npx -y @backenly/mcp-server --project <id> --key <scoped-key>
 *
 * while the CLI parsed NO flags in server mode and read credentials only from
 * the environment. The documented command therefore died with
 * "fatal: No Backenly API key configured" before anyone reached a feature.
 *
 * Nothing connected the doc to the parser, so the two drifted silently. This
 * test is that connection: it extracts the command from the docs as published
 * and feeds its flags to the SAME parser the CLI uses. If either side changes
 * without the other, this fails.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { parseServerFlags } from '../../packages/mcp-server/src/config'

const REPO_ROOT = join(__dirname, '..', '..')

/** Split a shell-ish command line into argv, honouring simple quoting. */
function tokenize(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, '')) ?? []
}

/** Every documented invocation of the MCP server across the published docs. */
function documentedInvocations(): Array<{ source: string; line: string }> {
  const sources = ['public/llms.txt', 'packages/mcp-server/README.md']
  const found: Array<{ source: string; line: string }> = []

  for (const source of sources) {
    let text: string
    try {
      text = readFileSync(join(REPO_ROOT, source), 'utf-8')
    } catch {
      continue // README is optional; llms.txt is asserted to exist below
    }
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      // Only invocations that actually pass flags — plain `npx @backenly/mcp-server`
      // is a valid form too and carries nothing to verify.
      if (line.includes('@backenly/mcp-server') && line.includes('--')) {
        found.push({ source, line })
      }
    }
  }
  return found
}

describe('published install command', () => {
  it('llms.txt exists and documents the MCP server', () => {
    const txt = readFileSync(join(REPO_ROOT, 'public/llms.txt'), 'utf-8')
    expect(txt).toContain('@backenly/mcp-server')
  })

  const invocations = documentedInvocations()

  it('finds at least one documented invocation with flags', () => {
    expect(invocations.length).toBeGreaterThan(0)
  })

  describe.each(invocations)('$source: $line', ({ line }) => {
    // Drop everything up to and including the package name, leaving the flags
    // the user is told to pass to OUR binary (not to npx).
    const argv = tokenize(line)
    const pkgIndex = argv.findIndex((a) => a.includes('@backenly/mcp-server'))
    const flags = argv.slice(pkgIndex + 1)

    it('every documented flag is recognised by the CLI parser', () => {
      const parsed = parseServerFlags(flags)

      const documentedFlagNames = flags
        .filter((a) => a.startsWith('--') || /^-[a-z]$/.test(a))
        .map((a) => a.split('=')[0])

      for (const flag of documentedFlagNames) {
        const recognised =
          (['--key', '--api-key', '-k'].includes(flag) && parsed.apiKey !== undefined) ||
          (['--project', '--project-id', '-p'].includes(flag) && parsed.projectId !== undefined) ||
          (['--endpoint', '--api-url', '--url', '-e'].includes(flag) && parsed.endpoint !== undefined)

        expect({ flag, parsed, recognised }).toMatchObject({ recognised: true })
      }
    })

    it('a key passed the documented way satisfies config loading', () => {
      const parsed = parseServerFlags(flags)
      // Only meaningful when the documented command actually carries a key.
      if (parsed.apiKey === undefined) return

      // Placeholders such as <scoped-key> still parse — we are asserting the
      // flag is WIRED, not that the doc contains a live credential.
      expect(typeof parsed.apiKey).toBe('string')
      expect(parsed.apiKey!.length).toBeGreaterThan(0)
    })
  })
})

describe('parseServerFlags', () => {
  it('accepts the exact published form', () => {
    expect(parseServerFlags(['--project', 'proj-1', '--key', 'mcp_live_abc'])).toEqual({
      projectId: 'proj-1',
      apiKey: 'mcp_live_abc',
    })
  })

  it('accepts --flag=value', () => {
    expect(parseServerFlags(['--project=proj-1', '--key=mcp_live_abc'])).toEqual({
      projectId: 'proj-1',
      apiKey: 'mcp_live_abc',
    })
  })

  it('accepts short forms', () => {
    expect(parseServerFlags(['-p', 'proj-1', '-k', 'k', '-e', 'https://x.dev'])).toEqual({
      projectId: 'proj-1',
      apiKey: 'k',
      endpoint: 'https://x.dev',
    })
  })

  it('never swallows the next flag as a value', () => {
    // `--key --project p9` must not read "--project" as the key.
    expect(parseServerFlags(['--key', '--project', 'p9'])).toEqual({ projectId: 'p9' })
  })

  it('ignores unknown flags rather than failing startup', () => {
    expect(parseServerFlags(['--verbose', '--key', 'k'])).toEqual({ apiKey: 'k' })
  })

  it('returns nothing for an empty argv', () => {
    expect(parseServerFlags([])).toEqual({})
  })
})
