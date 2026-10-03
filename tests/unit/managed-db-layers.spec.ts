/**
 * The five-layer ownership contract, enforced rather than described.
 *
 * The rule under test is the one the whole baseline project rests on: the
 * baseline owns the canonical schema and nothing else. These cases are the ways
 * that rule gets broken quietly — an extension slipped into a migration, a grant,
 * an event trigger, a tenant schema — and each has to fail on its own.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertBaselineOwnsOnlyCanonicalSchema,
  auditBaselineSql,
  classifyObject,
  LAYER_OWNERSHIP,
  type ManagedDbLayer,
} from '../../tools/managed-db/layers'
import { REQUIRED_EXTENSIONS, REQUIRED_EXTENSION_NAMES } from '../../tools/managed-db/extension-spec'
import { PLATFORM_EXTENSIONS } from '../../tools/migration-lineage/probe/capabilities'

const ROOT = join(__dirname, '..', '..')

describe('layer ownership', () => {
  it('lets the baseline mutate the canonical schema and nothing else', () => {
    const mutable = (Object.keys(LAYER_OWNERSHIP) as ManagedDbLayer[]).filter(l => LAYER_OWNERSHIP[l].baselineMayMutate)
    expect(mutable).toEqual(['canonical_schema'])
  })

  it('marks tenant state as never, which is stronger than no', () => {
    expect(LAYER_OWNERSHIP.tenant_state.strength).toBe('never')
    expect(LAYER_OWNERSHIP.tenant_state.baselineMayMutate).toBe(false)
  })

  it.each([
    ['extension vector', 'extensions'],
    ['extension pg_stat_statements', 'extensions'],
    ['schema workspace_07339e54', 'tenant_state'],
    ['table workspace_07339e54.todos', 'tenant_state'],
    ['policy workspace_07339e54.todos.own_rows', 'tenant_state'],
    ['event_trigger backenly_pgrst_ddl_sync', 'managed_provisioning'],
    ['event_trigger backenly_ddl_watch', 'managed_provisioning'],
    ['routine postgrest.pre_config()', 'managed_provisioning'],
    ['schema backenly_pgrst_idle', 'managed_provisioning'],
    ['table public.backenly_pgrst_schema_registry', 'managed_provisioning'],
    ['routine public.backenly_direct_create_role(p_role text)', 'managed_provisioning'],
    ['table public.projects', 'canonical_schema'],
    ['column public.users.email', 'canonical_schema'],
    ['index public.users.users_email_key', 'canonical_schema'],
  ])('classifies %s as %s', (key, layer) => {
    expect(classifyObject(key)).toBe(layer)
  })
})

describe('baseline audit', () => {
  it('accepts ordinary canonical schema', () => {
    const sql = `
      CREATE TYPE "ProjectStatus" AS ENUM ('PRIVATE', 'LIVE');
      CREATE TABLE "projects" ("id" TEXT NOT NULL, "name" TEXT NOT NULL, CONSTRAINT "projects_pkey" PRIMARY KEY ("id"));
      CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");
      ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;`
    expect(auditBaselineSql(sql)).toEqual([])
    expect(() => assertBaselineOwnsOnlyCanonicalSchema(sql)).not.toThrow()
  })

  it.each([
    ['an extension', 'CREATE EXTENSION IF NOT EXISTS vector;', 'extensions'],
    ['server configuration', "ALTER SYSTEM SET shared_preload_libraries = 'x';", 'server_config'],
    ['a role', 'CREATE ROLE anon NOLOGIN;', 'managed_provisioning'],
    ['a grant', 'GRANT SELECT ON "projects" TO anon;', 'managed_provisioning'],
    ['an event trigger', 'CREATE EVENT TRIGGER t ON ddl_command_end EXECUTE FUNCTION f();', 'managed_provisioning'],
    ['default privileges', 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;', 'managed_provisioning'],
    ['a tenant schema', 'CREATE TABLE workspace_07339e54.todos (id int);', 'tenant_state'],
    ['a provisioning object', 'CREATE TABLE public.backenly_pgrst_schema_registry (schema_name text);', 'managed_provisioning'],
    ['a provisioning schema', 'CREATE SCHEMA IF NOT EXISTS "postgrest";', 'managed_provisioning'],
  ])('refuses %s', (_label, sql, layer) => {
    expect(auditBaselineSql(sql).map(f => f.layer)).toContain(layer)
    expect(() => assertBaselineOwnsOnlyCanonicalSchema(sql)).toThrow(/outside the canonical schema/)
  })

  it('does not mistake canonical tables for tenant schemas', () => {
    // `workspace_files` and `workspace_backups` are platform tables in public.
    // They begin with hex letters, which an imprecise tenant pattern reads as a
    // workspace id — measured, not hypothetical: it blocked the first generated
    // baseline.
    const sql = `
      CREATE TABLE "workspace_files" ("id" TEXT NOT NULL, "projectId" TEXT NOT NULL);
      CREATE TABLE "workspace_backups" ("id" TEXT NOT NULL);
      CREATE TABLE "workspace_schema_snapshots" ("id" TEXT NOT NULL);
      CREATE TABLE "workspaces" ("id" TEXT NOT NULL);`
    expect(auditBaselineSql(sql)).toEqual([])
  })

  it('still catches a real tenant schema', () => {
    expect(auditBaselineSql('CREATE TABLE workspace_07339e54.todos (id int);').map(f => f.layer)).toEqual(['tenant_state'])
    expect(auditBaselineSql('GRANT SELECT ON workspace_1bd84a95.users TO anon;').map(f => f.layer)).toContain('tenant_state')
  })

  it('reports every violation at once, not the first', () => {
    const sql = 'CREATE EXTENSION vector; GRANT SELECT ON t TO anon; CREATE TABLE workspace_07339e54.x (id int);'
    expect(auditBaselineSql(sql).map(f => f.layer).sort()).toEqual(['extensions', 'managed_provisioning', 'tenant_state'])
  })
})

describe('the extension spec is a single source', () => {
  it('is what the capability capture uses', () => {
    expect(PLATFORM_EXTENSIONS).toBe(REQUIRED_EXTENSION_NAMES)
    expect(REQUIRED_EXTENSION_NAMES).toEqual(['pg_stat_statements', 'pgstattuple', 'vector'])
  })

  it('only ever probes with reads', () => {
    for (const spec of REQUIRED_EXTENSIONS) {
      expect(spec.operationalProbe).toMatch(/^SELECT\b/i)
      expect(spec.operationalProbe).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT)\b/i)
    }
  })

  it('carries no provisioning statement, because it ships inside the read-only probe', () => {
    // The production capture bundle is audited for mutation primitives. A spec
    // that carried CREATE EXTENSION would fail that audit, correctly.
    const source = readFileSync(join(ROOT, 'tools', 'managed-db', 'extension-spec.ts'), 'utf8')
    expect(source).not.toMatch(/CREATE\s+EXTENSION\s+(IF|["\w])/i)
  })

  it('says which extension needs a preload, because that decides who fixes it', () => {
    expect(REQUIRED_EXTENSIONS.filter(e => e.requiresPreload).map(e => e.name)).toEqual(['pg_stat_statements'])
  })
})
