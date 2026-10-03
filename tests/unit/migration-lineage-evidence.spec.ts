/**
 * The recovered migration corpus is evidence, so its value is that it cannot
 * drift. These checks make a changed byte, an unlisted file, or a quiet move
 * back into the active migration path fail loudly.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const EVIDENCE = join(ROOT, 'tools', 'migration-lineage', 'evidence')
const META = new Set(['.gitattributes', 'SHA256SUMS', 'provenance.json', 'README.md'])

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function evidenceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (!(dir === EVIDENCE && META.has(name))) out.push(relative(EVIDENCE, p).split(sep).join('/'))
    }
  }
  walk(EVIDENCE)
  return out.sort()
}

function sums(): Map<string, string> {
  const lines = readFileSync(join(EVIDENCE, 'SHA256SUMS'), 'utf8').trim().split('\n')
  return new Map(
    lines.map(line => {
      const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/)
      if (!m) throw new Error(`malformed SHA256SUMS line: ${line}`)
      return [m[2], m[1]]
    }),
  )
}

describe('migration lineage evidence', () => {
  it('every file matches SHA256SUMS byte for byte', () => {
    for (const [path, expected] of sums()) {
      expect({ path, sha256: sha256(join(EVIDENCE, path)) }).toEqual({ path, sha256: expected })
    }
  })

  it('SHA256SUMS lists exactly the files present', () => {
    expect([...sums().keys()].sort()).toEqual(evidenceFiles())
  })

  it('holds the 18-migration chain and the 6 loose files', () => {
    const files = evidenceFiles()
    expect(files.filter(f => /^legacy-prisma-chain\/[^/]+\/migration\.sql$/.test(f))).toHaveLength(18)
    expect(files.filter(f => /^legacy-loose-sql\/[^/]+\.sql$/.test(f))).toHaveLength(6)
  })

  it('provenance declares it non-executable and describes the same files', () => {
    const prov = JSON.parse(readFileSync(join(EVIDENCE, 'provenance.json'), 'utf8'))
    expect(prov.status).toBe('evidence_only')
    expect(prov.executable).toBe(false)
    expect(prov.secret_review.withheld).toEqual([])
    expect(prov.files.map((f: { path: string }) => f.path).sort()).toEqual([...sums().keys()].sort())
    // One hash authority. A second copy is a second thing to drift.
    for (const f of prov.files) expect(f).not.toHaveProperty('sha256')
  })

  it('disables line-ending normalisation, or the hashes stop describing the files', () => {
    expect(readFileSync(join(EVIDENCE, '.gitattributes'), 'utf8')).toMatch(/^\* -text$/m)
  })

  it('keeps prisma/migrations ignored while the corpus is evidence only', () => {
    // Deliberately a tripwire. Reactivating that path is a decision, and it has
    // to update docs/managed-db-migration-findings.md along with this test.
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/)
    expect(ignore).toContain('/prisma/migrations')
  })
})
