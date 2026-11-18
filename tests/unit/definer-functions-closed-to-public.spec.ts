/**
 * Every SECURITY DEFINER function Backenly installs is closed to PUBLIC.
 *
 * PostgreSQL grants EXECUTE on a new function to PUBLIC. A SECURITY DEFINER
 * function runs as its owner, so one left with that default lets any role that
 * can run SQL (a function's own role, a direct login) act as the owner. Each
 * file that defines such a function therefore revokes it from PUBLIC and grants
 * it to the roles that call it. Two schema-registry functions had been left out
 * of that list; this reads every installed SQL file so the next one cannot be.
 *
 * Trigger and event-trigger functions are left out: they cannot be called
 * directly.
 */

import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const SOURCES = ['scripts', 'tools/managed-db']

function sqlFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sqlFiles(full))
    else if (entry.name.endsWith('.sql')) out.push(full)
  }
  return out
}

type Definer = { file: string; name: string }

function definers(file: string, text: string): Definer[] {
  const found: Definer[] = []
  const header = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(([^)]*)\)([\s\S]*?)AS\s+\$\w*\$/gi
  for (const m of text.matchAll(header)) {
    const [, name, , rest] = m
    if (!/SECURITY\s+DEFINER/i.test(rest)) continue
    if (/RETURNS\s+(event_)?trigger\b/i.test(rest)) continue
    found.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), name })
  }
  return found
}

function revokedFromPublic(text: string, name: string): boolean {
  const bare = name.includes('.') ? name.split('.').pop()! : name
  const qualified = name.includes('.') ? name : 'public.' + name
  const pattern = new RegExp(
    String.raw`REVOKE\s+(?:ALL|EXECUTE)\s+ON\s+FUNCTION\s+(?:${escape(qualified)}|${escape(bare)})\s*\([^)]*\)\s+FROM\s+PUBLIC`,
    'i',
  )
  return pattern.test(text)
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('SECURITY DEFINER functions are closed to PUBLIC', () => {
  const files = SOURCES.flatMap((d) => sqlFiles(path.join(ROOT, d)))
  const all = files.flatMap((file) => definers(file, fs.readFileSync(file, 'utf8')).map((d) => ({ ...d, text: fs.readFileSync(file, 'utf8') })))

  it('finds the definer functions it is meant to check', () => {
    const names = all.map((d) => d.name)
    expect(names).toEqual(expect.arrayContaining([
      'public.backenly_pgrst_apply_soft_delete',
      'public.backenly_pgrst_cutover_blockers',
      'public.backenly_direct_set_connection_limit',
      'postgrest.pre_config',
    ]))
  })

  it('revokes every one of them from PUBLIC in the file that defines it', () => {
    const open = all.filter((d) => !revokedFromPublic(d.text, d.name)).map((d) => `${d.file}: ${d.name}`)
    expect(open).toEqual([])
  })

  it('names both schema-registry functions in the regional verification', () => {
    const verify = fs.readFileSync(path.join(ROOT, 'tools/managed-db/regional/sql/verify.sql'), 'utf8')
    for (const signature of ['public.backenly_pgrst_apply_soft_delete(text)', 'public.backenly_pgrst_cutover_blockers(text)']) {
      expect(verify).toContain(`('${signature}',`)
    }
  })
})
