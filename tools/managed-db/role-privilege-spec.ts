/**
 * LAYER 1 — the role privileges the platform depends on
 * =====================================================
 *
 * The managed-provisioning counterpart to `extension-spec.ts`. That file says
 * which extensions a managed database must have; this one says which role
 * privileges it must have, and for the same reason: neither is expressible in
 * `schema.prisma`, so neither can ever arrive through a migration.
 *
 * Exactly one entry today. It is deliberately not a general privilege framework:
 * a closed manifest of one is auditable at a glance, and the moment this grows
 * an "apply whatever the manifest says" loop it becomes a way to grant anything.
 *
 * ── Why this is not in the canonical baseline ──────────────────────────────
 *
 * `prisma/migrations-canonical` owns Layer 3, the canonical schema. A GRANT on
 * a DATABASE is Layer 1 state that exists before any schema does and survives
 * every migration. Putting it in the baseline would make a role privilege a
 * property of the application schema, and a rebuilt environment that had not yet
 * run migrations would have no way to create the workspace schemas the product
 * needs in order to function.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const GRANT_SQL_PATH = join('tools', 'managed-db', 'sql', 'grant-workspace-create.sql')

export interface RolePrivilege {
  role: string
  privilege: 'CREATE'
  /** What breaks without it. */
  requiredBy: string
  evidence: string[]
}

/**
 * What a managed database must grant, and why.
 *
 * `observed` is deliberately absent: whether an environment HAS the privilege is
 * a fact about that environment, measured at run time, never asserted here.
 */
export const REQUIRED_ROLE_PRIVILEGES: readonly RolePrivilege[] = [
  {
    role: 'backenly_user',
    privilege: 'CREATE',
    requiredBy:
      'Creating a project creates workspace_<projectId> as the application role. Without CREATE on ' +
      'the database that fails with 42501, and lib/projects/provision.ts does it outside a ' +
      'transaction with no error handling, so project creation throws.',
    evidence: [
      'lib/projects/provision.ts',
      'lib/services/workspaceDatabase.ts',
      'lib/execution/migration-runner.ts',
      'lib/branches/engine.ts',
    ],
  },
]

/**
 * Statements this SQL is permitted to contain.
 *
 * The inverse of `provisioner-audit.ts`: rather than listing what is forbidden
 * and hoping the list is complete, every statement must match one of these.
 */
const ALLOWED_STATEMENT = [
  /^GRANT\s+CREATE\s+ON\s+DATABASE\s+:"dbname"\s+TO\s+backenly_user$/i,
  /^SELECT\b/i,
  /^DO\s+\$\$/i,
]

const FORBIDDEN = [
  { pattern: /\bALTER\s+ROLE\b/i, why: 'role attributes are not granted here' },
  { pattern: /\bSUPERUSER\b/i, why: 'never' },
  { pattern: /\bCREATEDB\b/i, why: 'the role creates schemas, not databases' },
  { pattern: /\bCREATEROLE\b/i, why: 'never' },
  { pattern: /\bBYPASSRLS\b/i, why: 'RLS is the tenant boundary' },
  { pattern: /\bOWNER\s+TO\b/i, why: 'ownership is not transferred' },
  { pattern: /\bDROP\b/i, why: 'this script only grants' },
  { pattern: /\bGRANT\s+ALL\b/i, why: 'exactly one privilege, named' },
  { pattern: /\bTO\s+PUBLIC\b/i, why: 'granted to one named role' },
]

export interface AuditFinding {
  statement: string
  why: string
}

/**
 * Does the grant script do only what this module claims?
 *
 * Read the file, not a copy of it: the thing that runs against a production
 * database is the file, and an audit of anything else is an audit of a
 * different artifact.
 */
export function auditGrantSql(sql: string): AuditFinding[] {
  const findings: AuditFinding[] = []

  // Comments explain what the script refuses to do and name those very words,
  // and the DO block's RAISE messages quote them back. Neither is executable,
  // so both are removed before the forbidden sweep — otherwise the audit would
  // refuse the very file it exists to approve.
  const withoutComments = sql
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
  const executable = withoutComments.replace(/'(?:[^']|'')*'/g, "''")

  for (const { pattern, why } of FORBIDDEN) {
    const m = executable.match(pattern)
    if (m) findings.push({ statement: m[0], why })
  }

  // A DO block is ONE statement whose body is full of semicolons. Lifted out
  // before splitting, or every `IF` inside it reads as an unknown statement.
  const blocks: string[] = []
  const withoutBlocks = withoutComments.replace(/DO\s+\$\$[\s\S]*?\$\$/gi, m => {
    blocks.push(m)
    return '__DO_BLOCK__'
  })

  const statements = withoutBlocks
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('\\'))
    .join('\n')
    .split(/;\s*(?=\n|$)/)
    .map(s => s.trim())
    .filter(Boolean)

  for (const statement of statements) {
    // The block's contents were checked by the forbidden sweep above, which is
    // the right check for it: its job is assertions, not a fixed statement shape.
    if (statement === '__DO_BLOCK__') continue
    if (!ALLOWED_STATEMENT.some(p => p.test(statement))) {
      findings.push({ statement: statement.slice(0, 120), why: 'not in the allowed statement vocabulary' })
    }
  }

  return findings
}

export function readGrantSql(root: string): string {
  return readFileSync(join(root, GRANT_SQL_PATH), 'utf8')
}
