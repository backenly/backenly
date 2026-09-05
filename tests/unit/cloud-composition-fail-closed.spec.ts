/**
 * Cloud without its private half must refuse to run.
 *
 * Backenly Cloud is the public repository plus a private add-only overlay. If a
 * process asked to be `cloud` cannot find that overlay, the one thing it must
 * never do is carry on. The single-tenant resolver treats every authenticated
 * account as the operator of whatever project it names, so falling back would
 * turn a missing file into a cross-tenant breach on a multi-tenant database.
 * "Warn and continue" is the same bug with a log line.
 *
 * These tests also pin the part that is easy to get wrong in the other
 * direction: single-tenant must never look for the overlay at all, or a
 * self-host install would be broken by the absence of a repository it is not
 * entitled to and does not need.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  CLOUD_MANIFEST_PATH,
  CloudCompositionError,
  assertEditionComposition,
  editionIsExplicit,
  findRepoRoot,
  loadCloudExtension,
  requiresCloudComposition,
} from '@/lib/edition/cloud-extension'

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION

function setEdition(value: string | undefined): void {
  if (value === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = value
}

afterEach(() => setEdition(ORIGINAL_EDITION))

/** A throwaway repo root. Nothing here touches the real working tree. */
function makeRoot(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backenly-root-'))
  // The marker findRepoRoot looks for. Present in both editions, only at root.
  fs.writeFileSync(path.join(root, 'overlay-allowlist.json'), '{"version":1,"private":[]}')
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  return root
}

const VALID_MANIFEST = JSON.stringify({
  schema: 1,
  publicBaseSha: 'aee9214fe8b3057ce74576c1db68038d29ae0708',
  extension: 'lib/cloud/extension.ts',
  capabilities: ['presence'],
})

function composedRoot(manifest: string = VALID_MANIFEST): string {
  return makeRoot({
    [CLOUD_MANIFEST_PATH]: manifest,
    'lib/cloud/extension.ts': 'export const CLOUD = true\n',
  })
}

// ---------------------------------------------------------------------------

describe('which processes must have the private overlay', () => {
  it('an explicit cloud edition requires it', () => {
    setEdition('cloud')
    expect(editionIsExplicit()).toBe(true)
    expect(requiresCloudComposition()).toBe(true)
  })

  it('an explicit single-tenant edition never requires it', () => {
    setEdition('single-tenant')
    expect(requiresCloudComposition()).toBe(false)
  })

  it('an unset edition does not require it, because the default is still legacy', () => {
    // DEFAULT_EDITION is `cloud` until Phase 8, so an unset variable resolves to
    // cloud in CI, in local development and in every OSS build. Requiring the
    // overlay for that case would break all three, and the only ways out would
    // be flipping the default early or weakening the guarantee. The requirement
    // is attached to an EXPLICIT request instead. When the default flips,
    // explicit becomes the only route to cloud and this tightens by itself.
    setEdition(undefined)
    expect(editionIsExplicit()).toBe(false)
    expect(requiresCloudComposition()).toBe(false)
  })

  it('whitespace is not an explicit request', () => {
    setEdition('   ')
    expect(editionIsExplicit()).toBe(false)
  })
})

describe('reading the private manifest', () => {
  it('reports absent when the overlay was never applied', () => {
    const root = makeRoot()
    expect(loadCloudExtension(root).status).toBe('absent')
  })

  it('reports present for a well-formed overlay', () => {
    const state = loadCloudExtension(composedRoot())
    expect(state.status).toBe('present')
    if (state.status !== 'present') throw new Error('unreachable')
    expect(state.manifest.publicBaseSha).toBe('aee9214fe8b3057ce74576c1db68038d29ae0708')
  })

  it.each([
    ['unparseable JSON', 'not json at all', /not valid JSON/],
    ['a wrong schema version', JSON.stringify({ schema: 2 }), /unsupported manifest schema/],
    ['a JSON array', '[]', /not a JSON object/],
    [
      'a short sha',
      JSON.stringify({ schema: 1, publicBaseSha: 'abc123', extension: 'x', capabilities: [] }),
      /full 40-character commit sha/,
    ],
    [
      'no extension entry',
      JSON.stringify({ schema: 1, publicBaseSha: 'a'.repeat(40), extension: '', capabilities: [] }),
      /must name the private entry module/,
    ],
    [
      'non-string capabilities',
      JSON.stringify({ schema: 1, publicBaseSha: 'a'.repeat(40), extension: 'x', capabilities: [1] }),
      /capabilities must be an array of strings/,
    ],
  ])('reports invalid, not absent, for %s', (_label, body, expected) => {
    const state = loadCloudExtension(makeRoot({ [CLOUD_MANIFEST_PATH]: body }))
    expect(state.status).toBe('invalid')
    if (state.status !== 'invalid') throw new Error('unreachable')
    expect(state.reason).toMatch(expected)
  })

  it('reports invalid when the manifest names an entry module it did not deliver', () => {
    // A half-applied overlay. apply-overlay.sh makes this state unreachable, so
    // finding it means something bypassed the composition script.
    const state = loadCloudExtension(makeRoot({ [CLOUD_MANIFEST_PATH]: VALID_MANIFEST }))
    expect(state.status).toBe('invalid')
    if (state.status !== 'invalid') throw new Error('unreachable')
    expect(state.reason).toMatch(/lib\/cloud\/extension\.ts, which is not present/)
  })

  it('distinguishes absent from invalid, so the operator is told the truth', () => {
    // Two different problems: one means the overlay was never applied, the other
    // that it was applied and is wrong. Collapsing them would send someone to
    // re-run a deployment step that already succeeded.
    expect(loadCloudExtension(makeRoot()).status).toBe('absent')
    expect(loadCloudExtension(makeRoot({ [CLOUD_MANIFEST_PATH]: 'broken' })).status).toBe('invalid')
  })
})

describe('findRepoRoot', () => {
  it('finds the root from a nested directory', () => {
    // Next's standalone server can run with its own directory as cwd, several
    // levels below the checkout, so the root cannot be assumed to be cwd.
    const root = makeRoot()
    const nested = path.join(root, '.next', 'standalone')
    fs.mkdirSync(nested, { recursive: true })
    expect(findRepoRoot(nested)).toBe(fs.realpathSync(root))
  })

  it('returns null rather than looping when there is no marker', () => {
    expect(findRepoRoot(os.tmpdir())).toBeNull()
  })
})

describe('the startup assertion', () => {
  it('passes for explicit single-tenant with no overlay at all', () => {
    // The self-host case. A public clone must run with no knowledge of the
    // private repository.
    setEdition('single-tenant')
    expect(() => assertEditionComposition(makeRoot())).not.toThrow()
  })

  it('passes for an unset edition with no overlay', () => {
    setEdition(undefined)
    expect(() => assertEditionComposition(makeRoot())).not.toThrow()
  })

  it('THROWS for explicit cloud with no overlay', () => {
    setEdition('cloud')
    expect(() => assertEditionComposition(makeRoot())).toThrow(CloudCompositionError)
  })

  it('THROWS for explicit cloud with a broken overlay', () => {
    setEdition('cloud')
    expect(() => assertEditionComposition(makeRoot({ [CLOUD_MANIFEST_PATH]: 'broken' }))).toThrow(
      CloudCompositionError,
    )
  })

  it('passes for explicit cloud with a valid overlay', () => {
    setEdition('cloud')
    expect(() => assertEditionComposition(composedRoot())).not.toThrow()
  })

  it('never silently degrades to single-tenant', () => {
    // The failure mode this whole module exists to prevent: returning normally
    // and leaving the process to resolve projects with single-tenant rules.
    setEdition('cloud')
    let threw = false
    try {
      assertEditionComposition(makeRoot())
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('says which of the two problems it hit', () => {
    setEdition('cloud')
    const absent = (() => {
      try { assertEditionComposition(makeRoot()); return '' } catch (e) { return (e as Error).message }
    })()
    const invalid = (() => {
      try { assertEditionComposition(makeRoot({ [CLOUD_MANIFEST_PATH]: 'broken' })); return '' } catch (e) { return (e as Error).message }
    })()

    expect(absent).toMatch(/was never applied/)
    expect(invalid).toMatch(/present but unusable/)
    expect(absent).not.toEqual(invalid)
  })

  it('carries the state for diagnostics without leaking file contents', () => {
    setEdition('cloud')
    try {
      assertEditionComposition(makeRoot({ [CLOUD_MANIFEST_PATH]: '{"secret":"do-not-log-me"}' }))
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CloudCompositionError)
      const e = err as CloudCompositionError
      expect(e.state.status).toBe('invalid')
      expect(e.message).not.toMatch(/do-not-log-me/)
    }
  })
})

describe('the startup assertion is wired into every Cloud process', () => {
  // Importing a module in one request path protects nothing in another process.
  // Both PM2 apps in ecosystem.config.js must assert before they accept traffic,
  // and that is a property of those two files, not of the loader.
  it('the Next server asserts in instrumentation, before anything else runs', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'instrumentation.ts'), 'utf8')
    expect(src).toMatch(/assertEditionCompositionOrExit/)
    const assertAt = src.indexOf('assertEditionCompositionOrExit(')
    const sentryAt = src.indexOf("await import('./sentry.server.config')")
    expect(assertAt).toBeGreaterThan(-1)
    expect(sentryAt).toBeGreaterThan(-1)
    expect(assertAt).toBeLessThan(sentryAt)
  })

  it('the runtime server asserts before it opens its socket', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server/index.ts'), 'utf8')
    const assertAt = src.indexOf('assertEditionCompositionOrExit(')
    const listenAt = src.indexOf('app.listen(')
    expect(assertAt).toBeGreaterThan(-1)
    expect(listenAt).toBeGreaterThan(-1)
    expect(assertAt).toBeLessThan(listenAt)
  })

  it('both PM2 apps are accounted for', () => {
    // If a third long-running process is added, this fails and whoever added it
    // has to decide whether it serves Cloud traffic.
    const ecosystem = require(path.join(process.cwd(), 'ecosystem.config.js'))
    const names = ecosystem.apps.map((a: { name: string }) => a.name).sort()
    expect(names).toEqual(['backenly-nextjs', 'backenly-runtime'])
  })
})
