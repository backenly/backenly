/**
 * public.backenly_app_role() has one body, wherever it is defined.
 *
 * Several install files define it with CREATE OR REPLACE, and the one
 * installed last wins. scripts/setup-direct-access.sql installs after
 * scripts/postgrest-install.sh and still carried an older body whose final
 * fallback was the literal 'backenly_user'. On a managed database, where no
 * such role exists, reinstalling direct access silently undid the fix the
 * managed-DB cutover made, and every grant routed through the function (the
 * per-project function logins among them) was aimed at a role nothing could
 * receive.
 *
 * Every definition is found by scanning, not listed, so a new file that
 * defines the function cannot slip past this.
 */

import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
const SCAN = ['scripts', 'tools']

function sqlFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sqlFiles(rel)
    return e.name.endsWith('.sql') ? [rel] : []
  })
}

/** The function body, without comments or layout, from each definition in `sql`. */
function bodies(sql: string): string[] {
  const out: string[] = []
  const re = /FUNCTION\s+public\.backenly_app_role\(\)\s+RETURNS\s+text\s+LANGUAGE\s+sql\s+STABLE\s+AS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\1/g
  for (const m of sql.matchAll(re)) {
    out.push(m[2].replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim())
  }
  return out
}

const definitions = SCAN.flatMap(sqlFiles).flatMap((file) =>
  bodies(fs.readFileSync(path.join(ROOT, file), 'utf8')).map((body) => ({ file: file.replace(/\\/g, '/'), body })),
)
const canonical = definitions.find((d) => d.file === 'scripts/sql/postgrest-ddl-sync.sql')

describe('public.backenly_app_role()', () => {
  it('is defined by every file that installs a grant through it', () => {
    expect(definitions.map((d) => d.file).sort()).toEqual([
      'scripts/setup-direct-access.sql',
      'scripts/sql/postgrest-ddl-sync.sql',
      'scripts/sql/postgrest-schema-registry.sql',
      'tools/managed-db/sql/app-role-cutover.sql',
    ])
  })

  it('has the same body everywhere, so install order cannot change what it returns', () => {
    const differing = definitions.filter((d) => d.body !== canonical!.body).map((d) => d.file)
    expect(differing).toEqual([])
  })

  it('ends on a role that exists, never on a name nothing may hold', () => {
    expect(canonical!.body).toMatch(/current_user::text \)$/)
    expect(canonical!.body).not.toMatch(/, 'backenly_user'\s*\)$/)
  })
})
