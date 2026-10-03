/**
 * Layer 2: the extension provisioner.
 *
 * The cases that matter are the refusals. Only `available_not_installed` is
 * eligible; every other state belongs to somebody else, and an installed
 * extension that does not work must never be "repaired" by dropping it, because
 * an extension can own objects and data.
 */

import { join } from 'node:path'
import type { CapabilityReport, ExtensionCapability } from '../../tools/migration-lineage/probe/capabilities'
import {
  extensionInstallSql,
  planExtensionProvisioning,
  provisionExtensions,
  ProvisionRefusal,
} from '../../tools/managed-db/provision-extensions'
import {
  assertProvisionerBundle,
  assertProvisionerModules,
  auditProvisionerBundle,
  auditProvisionerModules,
} from '../../tools/managed-db/provisioner-audit'
import { checkRepairPreconditions, repairExtensions } from '../../tools/managed-db/repair-extensions'

const ROOT = join(__dirname, '..', '..')

const capability = (name: string, patch: Partial<ExtensionCapability> = {}): ExtensionCapability => ({
  name,
  available: true,
  availableVersion: '1.0',
  installedVersion: null,
  operational: null,
  operationalError: null,
  needsPreload: name === 'pg_stat_statements',
  preloaded: name === 'pg_stat_statements' ? true : null,
  ...patch,
})

const report = (patch: Record<string, Partial<ExtensionCapability>> = {}): CapabilityReport => ({
  sharedPreloadLibraries: { setting: 'rdsutils,pg_stat_statements', source: 'configuration file', context: 'postmaster', pendingRestart: false },
  extensions: ['pg_stat_statements', 'pgstattuple', 'vector'].map(n => capability(n, patch[n] ?? {})),
})

describe('the Layer 2 plan', () => {
  it('installs exactly what is available and not installed', () => {
    const plan = planExtensionProvisioning(report())
    expect(plan.installable).toEqual(['pg_stat_statements', 'pgstattuple', 'vector'])
    expect(plan.refusals).toEqual([])
  })

  it('does nothing for an extension that already works', () => {
    const plan = planExtensionProvisioning(report({ vector: { installedVersion: '0.8.1', operational: true } }))
    expect(plan.installable).toEqual(['pg_stat_statements', 'pgstattuple'])
    expect(plan.steps.find(s => s.name === 'vector')).toMatchObject({ decision: 'already_operational' })
  })

  it.each([
    ['a missing preload', { pg_stat_statements: { preloaded: false } }, 'pg_stat_statements', /Layer 1 owns this/],
    ['an unavailable package', { vector: { available: false, availableVersion: null } }, 'vector', /not available on this server/],
    [
      'an installed extension that does not work',
      { pgstattuple: { installedVersion: '1.5', operational: false, operationalError: 'boom' } },
      'pgstattuple',
      /never dropped and recreated/,
    ],
  ])('refuses on %s', (_label, patch, name, reason) => {
    const plan = planExtensionProvisioning(report(patch as Record<string, Partial<ExtensionCapability>>))
    const step = plan.steps.find(s => s.name === name)!
    expect(step.decision).toBe('refuse')
    expect(step.reason).toMatch(reason)
    expect(plan.refusals).toHaveLength(1)
  })

  it('refuses when an extension has no capability reading at all', () => {
    const plan = planExtensionProvisioning({ sharedPreloadLibraries: null, extensions: [] })
    expect(plan.refusals.map(r => r.name)).toEqual(['pg_stat_statements', 'pgstattuple', 'vector'])
  })
})

describe('the mutation vocabulary', () => {
  it('is exactly one statement, for declared names only', () => {
    expect(extensionInstallSql('vector')).toBe('CREATE EXTENSION IF NOT EXISTS "vector"')
    expect(extensionInstallSql('pg_stat_statements')).toBe('CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"')
  })

  it('refuses anything the platform has not declared', () => {
    expect(() => extensionInstallSql('postgis')).toThrow(ProvisionRefusal)
    // Not a quoting exercise: the name never reaches SQL because it is not declared.
    expect(() => extensionInstallSql('vector"; DROP DATABASE backenly; --')).toThrow(/not declared/)
  })
})

describe('the provisioner executes only what it planned', () => {
  const fakeClient = (rows: unknown[] = []) => {
    const queries: string[] = []
    const client = {
      query: jest.fn(async (sql: unknown) => {
        queries.push(typeof sql === 'string' ? sql : String((sql as { text: string }).text))
        return { rows, rowCount: rows.length }
      }),
    }
    return { client: client as never, queries }
  }

  it('issues one CREATE EXTENSION per eligible extension and nothing else', async () => {
    const { client, queries } = fakeClient()
    const after = report({
      pg_stat_statements: { installedVersion: '1.10', operational: true },
      pgstattuple: { installedVersion: '1.5', operational: true },
      vector: { installedVersion: '0.8.1', operational: true },
    })
    const outcome = await provisionExtensions(client, report(), async () => after)

    expect(outcome.executed).toEqual(['pg_stat_statements', 'pgstattuple', 'vector'])
    expect(outcome.failures).toEqual([])
    const mutations = queries.filter(q => !/^SELECT/i.test(q))
    expect(mutations).toEqual([
      'CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"',
      'CREATE EXTENSION IF NOT EXISTS "pgstattuple"',
      'CREATE EXTENSION IF NOT EXISTS "vector"',
    ])
  })

  it('mutates nothing at all when any extension is in a state it does not own', async () => {
    const { client, queries } = fakeClient()
    await expect(
      provisionExtensions(client, report({ pg_stat_statements: { preloaded: false } }), async () => report()),
    ).rejects.toThrow(ProvisionRefusal)
    expect(queries).toEqual([])
  })

  it('reports a failure when an extension lands in the wrong schema', async () => {
    const { client } = fakeClient([
      { name: 'pg_stat_statements', version: '1.10', schema: 'public' },
      { name: 'pgstattuple', version: '1.5', schema: 'extensions' },
      { name: 'vector', version: '0.8.1', schema: 'public' },
    ])
    const after = report({
      pg_stat_statements: { installedVersion: '1.10', operational: true },
      pgstattuple: { installedVersion: '1.5', operational: true },
      vector: { installedVersion: '0.8.1', operational: true },
    })
    const outcome = await provisionExtensions(client, report(), async () => after)
    expect(outcome.failures).toEqual(['pgstattuple is installed in schema extensions, expected public'])
  })

  it('reports a failure when an extension is still not operational afterwards', async () => {
    const { client } = fakeClient()
    const after = report({
      pg_stat_statements: { installedVersion: '1.10', operational: true },
      pgstattuple: { installedVersion: '1.5', operational: false, operationalError: 'boom' },
      vector: { installedVersion: '0.8.1', operational: true },
    })
    const outcome = await provisionExtensions(client, report(), async () => after)
    expect(outcome.failures).toEqual(['pgstattuple is installed_not_operational after provisioning'])
  })
})

describe('the parity repair refuses unless the database is what the plan assumed', () => {
  const expectations = {
    availableVersions: { pg_stat_statements: '1.10', pgstattuple: '1.5', vector: '0.8.1' },
  }
  const versioned = (patch: Record<string, Partial<ExtensionCapability>> = {}): CapabilityReport => ({
    sharedPreloadLibraries: { setting: 'rdsutils,pg_stat_statements,rds_casts', source: 'configuration file', context: 'postmaster', pendingRestart: false },
    extensions: [
      capability('pg_stat_statements', { availableVersion: '1.10', ...(patch.pg_stat_statements ?? {}) }),
      capability('pgstattuple', { availableVersion: '1.5', ...(patch.pgstattuple ?? {}) }),
      capability('vector', { availableVersion: '0.8.1', ...(patch.vector ?? {}) }),
    ],
  })

  it('accepts the state discovery measured', () => {
    expect(checkRepairPreconditions(versioned(), expectations)).toEqual([])
  })

  it.each([
    ['an extension already installed', { vector: { installedVersion: '0.8.1', operational: true } }, /vector: expected available_not_installed, measured operational/],
    ['a version that moved', { vector: { availableVersion: '0.9.0' } }, /vector: available version is 0.9.0, parity expects 0.8.1/],
    ['a package that vanished', { pgstattuple: { available: false, availableVersion: null } }, /pgstattuple: expected available_not_installed, measured unavailable/],
    ['a preload that is gone', { pg_stat_statements: { preloaded: false } }, /not preloaded; Layer 1 owns this/],
  ])('refuses on %s', (_label, patch, reason) => {
    const reasons = checkRepairPreconditions(versioned(patch as Record<string, Partial<ExtensionCapability>>), expectations)
    expect(reasons.join(' | ')).toMatch(reason)
  })

  it('refuses while a restart is pending, because the preload is not settled', () => {
    const report = versioned()
    report.sharedPreloadLibraries!.pendingRestart = true
    expect(checkRepairPreconditions(report, expectations).join(' ')).toMatch(/pending restart/)
  })

  it('mutates nothing when it refuses', async () => {
    const queries: string[] = []
    const client = {
      query: jest.fn(async (sql: unknown) => {
        const text = typeof sql === 'string' ? sql : String((sql as { text: string }).text)
        queries.push(text)
        return { rows: [{ database: 'backenly' }], rowCount: 1 }
      }),
    } as never

    const result = await repairExtensions(client, expectations)
    expect(result.verdict).toBe('REFUSED')
    expect(queries.filter(q => /CREATE\s+EXTENSION/i.test(q))).toEqual([])
  })
})

describe('the Layer 2 artifact is only what Layer 2 may be', () => {
  jest.setTimeout(120_000)

  async function bundle(entry: string) {
    const { build } = await import('esbuild')
    const result = await build({
      entryPoints: [join(ROOT, entry)],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      minify: true,
      external: ['pg-native', 'pg-cloudflare', 'cloudflare:sockets'],
      write: false,
      metafile: true,
      logLevel: 'silent',
    })
    return { code: result.outputFiles[0].text, modules: Object.keys(result.metafile?.inputs ?? {}) }
  }

  it('contains the one mutation and reaches nothing it does not own', async () => {
    const { code, modules } = await bundle('tools/managed-db/rehearsal-task.ts')
    expect(auditProvisionerBundle(code)).toEqual([])
    expect(auditProvisionerModules(modules)).toEqual([])
  })

  it.each([
    ['a drop', 'const q = "DROP EXTENSION vector"; const i = "CREATE EXTENSION IF NOT EXISTS x";'],
    ['a role', 'const q = "CREATE ROLE anon"; const i = "CREATE EXTENSION IF NOT EXISTS x";'],
    ['a grant', 'const q = "GRANT SELECT ON t TO anon"; const i = "CREATE EXTENSION IF NOT EXISTS x";'],
    ['server configuration', 'const q = "ALTER SYSTEM SET x = 1"; const i = "CREATE EXTENSION IF NOT EXISTS x";'],
    ['a tenant schema', 'const q = "workspace_07339e54"; const i = "CREATE EXTENSION IF NOT EXISTS x";'],
    ['the migration runner', 'const q = "_prisma_migrations"; const i = "CREATE EXTENSION IF NOT EXISTS x";'],
  ])('refuses a bundle that acquired %s', (_label, code) => {
    expect(() => assertProvisionerBundle(code)).toThrow(/not what Layer 2 may be/)
  })

  it('refuses a bundle that cannot install anything, rather than calling it safe', () => {
    expect(() => assertProvisionerBundle('const x = 1')).toThrow(/cannot do its job/)
  })

  it('refuses reaching the replay path or the staging launcher', () => {
    expect(() => assertProvisionerModules(['tools/migration-lineage/probe/scratch.ts'])).toThrow(/does not own/)
    expect(() => assertProvisionerModules(['scripts/lib/staging-fargate-task.ts'])).toThrow(/does not own/)
    expect(() => assertProvisionerModules(['tools/managed-db/scratch-database.ts'])).not.toThrow()
  })
})
