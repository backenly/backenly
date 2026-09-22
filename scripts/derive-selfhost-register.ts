/**
 * THE SELF-HOST CAPABILITY REGISTER, DERIVED FROM THE TREE
 * =======================================================
 *
 *   npx tsx scripts/derive-selfhost-register.ts            # print
 *   npx tsx scripts/derive-selfhost-register.ts --write    # regenerate the doc section
 *   npx tsx scripts/derive-selfhost-register.ts --check    # fail if the doc is stale
 *
 * WHY
 * ---
 * `docs/supabase-selfhosted-comparison.md` was hand-maintained and went stale
 * exactly the way hand-maintained inventories do. At the time this was written
 * it still described the one-command install, the FK/constraint controls, the
 * logs explorer, the read-only SQL workspace and migration history as "not
 * started", months after each had landed. Anyone using it as a build queue
 * would have rebuilt work that already existed.
 *
 * `docs/mcp-catalog-truth-architecture.md` records the same failure in another
 * form: "what exists" lived in four hand-synced places, they drifted, and
 * `list_tables` reported tables the schema did not have. The fix there was to
 * derive from the catalog. This is that fix, for the capability register.
 *
 * WHAT IS DECLARED AND WHAT IS DERIVED
 * ------------------------------------
 * The CAPABILITY LIST is declared here, because "which capabilities matter" is
 * a product judgement no script can make. Everything else — whether a backend
 * exists, whether a UI exists, whether the UI actually calls that backend, and
 * therefore the verdict — is derived from files on disk at the current commit.
 *
 * So a capability cannot be marked done by editing prose. It is done when the
 * evidence is there, and the register says which commit it describes.
 *
 * VERDICTS
 * --------
 *   DONE          backend and UI both present, and the UI references the backend
 *   BACKEND_ONLY  backend present, no UI calls it — the class this program was
 *                 created to find, and the class that hid two IDORs
 *   CLOUD_ONLY    deliberately not in the self-host edition
 *   INTENTIONAL   deliberately absent everywhere, with a recorded reason
 *   REAL_GAP      declared as wanted, nothing implements it
 *   NEEDS_REVIEW  evidence is contradictory and a human must look
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const DOC = join(ROOT, 'docs', 'supabase-selfhosted-comparison.md')
const BEGIN = '<!-- BEGIN DERIVED REGISTER -->'
const END = '<!-- END DERIVED REGISTER -->'

type Verdict = 'DONE' | 'PARTIAL' | 'BACKEND_ONLY' | 'CLOUD_ONLY' | 'INTENTIONAL' | 'REAL_GAP' | 'NEEDS_REVIEW'

interface Capability {
  area: string
  name: string
  /** Files that must exist for the backend to be considered present. */
  backend?: string[]
  /** Files that must exist for a user-facing surface to be considered present. */
  ui?: string[]
  /** The UI must mention this string, proving it calls the backend rather than
   *  merely existing. A page that renders without ever calling its API is the
   *  "looks built" failure this register exists to prevent. */
  uiMentions?: string
  /** Deliberately not in the self-host edition. */
  cloudOnly?: string
  /** Deliberately absent everywhere. */
  intentional?: string
  /**
   * Something exists but does not meet the declared capability.
   *
   * Added because SMTP and email templates are neither done nor absent: a
   * transport reads deployment-wide env vars and the templates are hard-coded
   * in TypeScript. Recording that as REAL_GAP would have sent someone to build
   * what already exists; recording it as DONE would have been a false claim.
   */
  partial?: string
}

/**
 * The declared scope of a self-hosted Backenly.
 *
 * Supabase is a reference point, not the finish line: an entry exists here
 * because Backenly's own architecture calls for it, and several entries are
 * deliberately NOT what Supabase does.
 */
const CAPABILITIES: Capability[] = [
  // ── Install and operate ────────────────────────────────────────────────
  { area: 'Install', name: 'One-command install',
    backend: ['scripts/selfhost.ts'], ui: ['README.md'], uiMentions: 'npm run selfhost' },
  { area: 'Install', name: 'Non-superuser application role',
    backend: ['scripts/setup-app-role.ts'], ui: ['README.md'], uiMentions: 'backenly_app' },
  // The surface is the signup page, not the README. The token is consumed by an
  // HTTP route a browser form must send it to, and this row once graded DONE on
  // the README alone while no page could send it: every browser signup on a
  // fresh install was refused.
  { area: 'Install', name: 'First-owner claim token',
    backend: ['lib/auth/setup-token.ts', 'app/api/auth/register/route.ts'],
    ui: ['app/auth/signup/page.tsx'], uiMentions: 'setupToken' },

  // ── Database ───────────────────────────────────────────────────────────
  { area: 'Database', name: 'Table editor',
    backend: ['app/api/database/tables/route.ts'], ui: ['app/app/projects/[id]/database/page.tsx'],
    uiMentions: 'getTables' },
  { area: 'Database', name: 'Foreign keys and constraints',
    backend: ['app/api/database/schema/constraints/route.ts', 'lib/db/fk-shape.ts'],
    ui: ['app/app/projects/[id]/database/page.tsx'], uiMentions: 'addConstraint' },
  { area: 'Database', name: 'Read-only SQL workspace',
    backend: ['app/api/database/query/route.ts', 'lib/mcp/read-query.ts'],
    ui: ['components/database/SqlWorkspace.tsx'], uiMentions: '/api/database/query' },
  { area: 'Database', name: 'Migration / schema history',
    backend: ['app/api/projects/[id]/schema-versions/route.ts'],
    ui: ['components/database/SchemaHistory.tsx'], uiMentions: 'schema-versions' },
  { area: 'Database', name: 'Schema graph',
    backend: ['app/api/database/relationships/route.ts'],
    ui: ['components/database/EnhancedSchemaVisualizer.tsx'], uiMentions: 'relationships' },
  { area: 'Database', name: 'Dashboard SQL writes / DDL',
    intentional: 'AGENTS.md: mutations go through typed governed actions so they can be planned, approved, verified and reversed. A SQL parser must never be the tenant boundary.' },

  // ── Observability ──────────────────────────────────────────────────────
  { area: 'Observability', name: 'Logs explorer',
    backend: ['app/api/logs/route.ts'], ui: ['components/monitoring/LogsExplorer.tsx'],
    uiMentions: '/api/logs' },
  { area: 'Observability', name: 'Monitoring workbench',
    backend: ['app/api/monitoring/request-logs/route.ts'],
    ui: ['components/monitoring/MonitoringWorkbench.tsx'], uiMentions: '/api/monitoring' },

  // ── Data protection ────────────────────────────────────────────────────
  { area: 'Data protection', name: 'Project database snapshot',
    backend: ['lib/services/workspace-backup.ts', 'app/api/projects/[id]/backup/route.ts'],
    ui: ['components/database/DatabaseSnapshots.tsx'], uiMentions: '/backup' },
  { area: 'Data protection', name: 'Deployment recovery',
    backend: ['lib/recovery/export.ts', 'lib/recovery/restore.ts', 'scripts/recovery.ts'],
    ui: ['components/app/DeploymentRecoverySection.tsx'], uiMentions: '/api/deployment/recovery' },

  // ── Integrations ───────────────────────────────────────────────────────
  { area: 'Integrations', name: 'Webhooks',
    backend: ['app/api/projects/[id]/webhooks/route.ts', 'lib/webhooks/index.ts'],
    ui: ['components/integrations/WebhooksPanel.tsx'], uiMentions: 'webhooks' },

  // ── Auth ───────────────────────────────────────────────────────────────
  { area: 'Auth', name: 'End-user auth runtime',
    backend: ['app/api/v1/[projectId]/auth/signin/route.ts'],
    ui: ['app/app/projects/[id]/auth/page.tsx'], uiMentions: 'auth' },
  { area: 'Auth', name: 'SMTP configuration',
    backend: ['lib/email/project-smtp.ts', 'app/api/projects/[id]/email/smtp/route.ts'],
    ui: ['components/auth/EmailSettingsPanel.tsx'], uiMentions: 'email/smtp' },
  { area: 'Auth', name: 'Email template editing',
    backend: ['lib/email/template-kinds.ts', 'app/api/projects/[id]/email/templates/[kind]/route.ts'],
    ui: ['components/auth/EmailSettingsPanel.tsx'], uiMentions: 'email/templates' },

  // ── Storage ────────────────────────────────────────────────────────────
  { area: 'Storage', name: 'Buckets and objects',
    backend: ['app/api/v1/[projectId]/storage/upload/route.ts', 'lib/services/storage.ts'],
    ui: ['components/storage/StorageWorkbench.tsx'], uiMentions: 'createBucket' },
  { area: 'Storage', name: 'Per-bucket access policies',
    backend: ['lib/storage/access-policy.ts', 'app/api/storage/files/[fileId]/download/route.ts'],
    ui: ['components/storage/BucketPolicyDialog.tsx', 'components/storage/StorageWorkbench.tsx'],
    uiMentions: 'updateBucketPolicy' },

  // ── PostgreSQL administration ──────────────────────────────────────────
  { area: 'Postgres admin', name: 'Index management',
    backend: ['app/api/database/indexes/route.ts'],
    ui: ['app/app/projects/[id]/database/page.tsx'], uiMentions: 'getIndexes' },
  { area: 'Postgres admin', name: 'Extension allowlist provisioning',
    backend: ['lib/services/extensions.ts', 'app/api/projects/[id]/database/extensions/route.ts'],
    ui: ['components/database/ExtensionsPanel.tsx'], uiMentions: 'database/extensions' },
  { area: 'Postgres admin', name: 'Enums and domains',
    backend: ['lib/services/enums.ts', 'app/api/projects/[id]/database/types/route.ts'],
    ui: ['components/database/EnumsPanel.tsx'], uiMentions: 'database/types' },
  { area: 'Postgres admin', name: 'Arbitrary roles and grants',
    intentional: 'Deliberate. Roles are cluster-global and the platform issues scoped credentials through governed actions; hand-editing grants would let a dashboard user dismantle the tenant boundary the platform relies on.' },
]

function backendPresent(c: Capability): boolean {
  return (c.backend ?? []).length > 0 && (c.backend ?? []).every(f => existsSync(join(ROOT, f)))
}

function uiPresent(c: Capability): boolean {
  const files = c.ui ?? []
  if (files.length === 0) return false
  if (!files.every(f => existsSync(join(ROOT, f)))) return false
  if (!c.uiMentions) return true
  // Presence is not enough: the surface must reference its backend, or it is a
  // page that renders and does nothing.
  return files.some(f => {
    try {
      return readFileSync(join(ROOT, f), 'utf8').includes(c.uiMentions!)
    } catch {
      return false
    }
  })
}

function verdict(c: Capability): { verdict: Verdict; evidence: string } {
  if (c.intentional) return { verdict: 'INTENTIONAL', evidence: c.intentional }
  if (c.partial) {
    const have = (c.backend ?? []).filter(f => existsSync(join(ROOT, f)))
    return { verdict: 'PARTIAL', evidence: `${c.partial} Present: ${have.join(', ') || 'nothing'}.` }
  }
  if (c.cloudOnly) {
    const present = backendPresent(c)
    return {
      verdict: 'CLOUD_ONLY',
      evidence: `${c.cloudOnly}${present ? ' Backend present.' : ' Backend MISSING — verify.'}`,
    }
  }

  const be = backendPresent(c)
  const ui = uiPresent(c)
  const missing = [
    ...(c.backend ?? []).filter(f => !existsSync(join(ROOT, f))).map(f => `backend ${f}`),
    ...(c.ui ?? []).filter(f => !existsSync(join(ROOT, f))).map(f => `ui ${f}`),
  ]

  if (be && ui) return { verdict: 'DONE', evidence: [...(c.backend ?? []), ...(c.ui ?? [])].join(', ') }
  if (be && !ui) {
    return {
      verdict: 'BACKEND_ONLY',
      evidence: `backend: ${(c.backend ?? []).join(', ')}. ` +
        (missing.length ? `absent: ${missing.join(', ')}` : `no surface references ${c.uiMentions}`),
    }
  }
  if (!be && ui) return { verdict: 'NEEDS_REVIEW', evidence: `UI present without its backend: ${missing.join(', ')}` }
  return { verdict: 'REAL_GAP', evidence: missing.length ? `absent: ${missing.join(', ')}` : 'nothing declared' }
}

function render(): string {
  const sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()
  const when = new Date().toISOString().slice(0, 10)

  const rows = CAPABILITIES.map(c => ({ c, ...verdict(c) }))
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1
    return acc
  }, {})

  const lines: string[] = []
  lines.push(BEGIN)
  lines.push('')
  lines.push('## Capability register')
  lines.push('')
  lines.push(`**Derived from \`${sha}\` on ${when} by \`scripts/derive-selfhost-register.ts\`.**`)
  lines.push('Do not hand-edit this section: it is regenerated, and a capability')
  lines.push('cannot be marked done by editing prose. The previous hand-maintained')
  lines.push('matrix listed five shipped capabilities as "not started".')
  lines.push('')
  lines.push(
    Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join(' · ')
  )
  lines.push('')
  lines.push('| Area | Capability | Verdict | Evidence |')
  lines.push('|---|---|---|---|')
  for (const r of rows) {
    lines.push(`| ${r.c.area} | ${r.c.name} | **${r.verdict}** | ${r.evidence.replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  lines.push('`BACKEND_ONLY` is the class this program exists to find: a working')
  lines.push('backend nothing calls. Both cross-tenant defects found so far lived')
  lines.push('in routes with no UI, because nothing ever exercised them.')
  lines.push('')
  lines.push(END)
  return lines.join('\n')
}

function main(): void {
  const section = render()

  if (process.argv.includes('--write')) {
    const doc = readFileSync(DOC, 'utf8')
    let next: string
    if (doc.includes(BEGIN) && doc.includes(END)) {
      next = doc.slice(0, doc.indexOf(BEGIN)) + section + doc.slice(doc.indexOf(END) + END.length)
    } else {
      // First run: insert after the status header rather than at the end, so
      // the derived truth is the first thing a reader meets.
      const anchor = doc.indexOf('\n---\n')
      next = anchor === -1
        ? `${doc}\n\n${section}\n`
        : `${doc.slice(0, anchor)}\n\n${section}\n${doc.slice(anchor)}`
    }
    writeFileSync(DOC, next, 'utf8')
    console.log(`Wrote the derived register into ${DOC}`)
    return
  }

  if (process.argv.includes('--check')) {
    const doc = readFileSync(DOC, 'utf8')
    if (!doc.includes(BEGIN)) {
      console.error('The register has no derived section. Run --write.')
      process.exit(1)
    }
    const current = doc.slice(doc.indexOf(BEGIN), doc.indexOf(END) + END.length)
    // The SHA line changes every commit, so compare everything else.
    const strip = (t: string) => t.replace(/\*\*Derived from .*$/m, '')
    if (strip(current) !== strip(section)) {
      console.error('The derived register is stale. Run --write and commit the result.')
      process.exit(1)
    }
    console.log('Derived register is current.')
    return
  }

  console.log(section)
}

main()
