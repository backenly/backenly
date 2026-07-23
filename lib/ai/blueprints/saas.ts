/**
 * SAAS BLUEPRINT
 * ==============
 * Full backend for any multi-tenant B2B SaaS — orgs, members, invites,
 * subscriptions, plans, invoices, payment methods, usage, API keys,
 * audit logs, feature flags.
 *
 * Tables (12): organizations, organization_members, organization_invitations,
 *   plans, subscriptions, invoices, payment_methods, usage_records,
 *   api_keys, audit_logs, feature_flags, projects
 * Uses enable_teams for the org-membership scaffolding.
 * Storage: org-assets bucket (private)
 * Realtime: usage_records, audit_logs, invoices
 */

import type { Blueprint, BlueprintColumn } from './types'

const col = (n: string, t: BlueprintColumn['type'], o: Partial<BlueprintColumn> = {}): BlueprintColumn => ({ name: n, type: t, ...o })
const createTable = (label: string, tableName: string, columns: BlueprintColumn[]) => ({ label, tool: 'create_table', args: { tableName, columns } })
const generateApi = (tableName: string) => ({ label: `Generate REST API for ${tableName}`, tool: 'generate_api', args: { tableName } })
const addRls = (tableName: string, policy: string, label?: string) => ({ label: label ?? `Lock down ${tableName} with ${policy} RLS`, tool: 'add_rls', args: { tableName, policy } })
const enableRealtime = (tableName: string) => ({ label: `Stream realtime changes on ${tableName}`, tool: 'enable_realtime', args: { tableName } })

export const SAAS_BLUEPRINT: Blueprint = {
  domain: 'saas',
  title: 'SaaS Backend',
  summary:
    '12 tables (orgs, members, invitations, plans, subscriptions, invoices, ' +
    'payment_methods, usage, api_keys, audit_logs, feature_flags, projects), ' +
    'org-scoped RLS, usage + audit realtime, asset storage.',
  steps: [
    { label: 'Enable end-user authentication (email + password)', tool: 'enable_auth', args: {} },

    // enable_teams creates organizations, organization_members,
    // organization_invitations and wires the /orgs/accept-invite endpoint.
    { label: 'Wire up team multi-tenancy (orgs + members + invitations)', tool: 'enable_teams', args: {} },

    createTable('Create plans (pricing tiers)', 'plans', [
      col('name', 'text', { unique: true }),
      col('description', 'text', { nullable: true }),
      col('monthly_price', 'numeric'),
      col('annual_price', 'numeric', { nullable: true }),
      col('currency', 'text'),
      col('seat_limit', 'int', { nullable: true }),
      col('feature_set', 'jsonb', { nullable: true }),
      col('is_active', 'boolean', { nullable: true }),
    ]),

    createTable('Create subscriptions (org → plan)', 'subscriptions', [
      col('organization_id', 'uuid'),
      col('plan_id', 'uuid', { fkTo: 'plans' }),
      col('status', 'text'),               // trialing | active | past_due | cancelled
      col('provider', 'text'),             // stripe | paddle
      col('provider_subscription_id', 'text', { nullable: true }),
      col('current_period_start', 'timestamp', { nullable: true }),
      col('current_period_end', 'timestamp', { nullable: true }),
      col('cancel_at_period_end', 'boolean', { nullable: true }),
    ]),

    createTable('Create invoices', 'invoices', [
      col('subscription_id', 'uuid', { fkTo: 'subscriptions' }),
      col('organization_id', 'uuid'),
      col('amount', 'numeric'),
      col('currency', 'text'),
      col('status', 'text'),               // open | paid | void | uncollectible
      col('issued_at', 'timestamp', { nullable: true }),
      col('paid_at', 'timestamp', { nullable: true }),
      col('provider_invoice_id', 'text', { nullable: true }),
      col('pdf_url', 'text', { nullable: true }),
    ]),

    createTable('Create payment_methods (cards)', 'payment_methods', [
      col('organization_id', 'uuid'),
      col('provider', 'text'),
      col('provider_method_id', 'text'),
      col('brand', 'text', { nullable: true }),
      col('last4', 'text', { nullable: true }),
      col('exp_month', 'int', { nullable: true }),
      col('exp_year', 'int', { nullable: true }),
      col('is_default', 'boolean', { nullable: true }),
    ]),

    createTable('Create usage_records (metered billing)', 'usage_records', [
      col('organization_id', 'uuid'),
      col('subscription_id', 'uuid', { fkTo: 'subscriptions', nullable: true }),
      col('metric', 'text'),               // api_calls | seats | storage_gb | …
      col('quantity', 'numeric'),
      col('recorded_at', 'timestamp'),
    ]),

    createTable('Create api_keys (org-scoped)', 'api_keys', [
      col('organization_id', 'uuid'),
      col('label', 'text'),
      col('key_hash', 'text', { unique: true }),
      col('last_used_at', 'timestamp', { nullable: true }),
      col('revoked_at', 'timestamp', { nullable: true }),
      col('scopes', 'jsonb', { nullable: true }),
    ]),

    createTable('Create audit_logs (compliance)', 'audit_logs', [
      col('organization_id', 'uuid'),
      col('actor_user_id', 'uuid', { nullable: true }),
      col('action', 'text'),
      col('target_type', 'text', { nullable: true }),
      col('target_id', 'text', { nullable: true }),
      col('metadata', 'jsonb', { nullable: true }),
      col('ip_address', 'text', { nullable: true }),
    ]),

    createTable('Create feature_flags (per-org overrides)', 'feature_flags', [
      col('organization_id', 'uuid'),
      col('flag', 'text'),
      col('enabled', 'boolean'),
      col('rollout', 'numeric', { nullable: true }),
      col('metadata', 'jsonb', { nullable: true }),
    ]),

    createTable('Create projects (per-org workspaces)', 'projects', [
      col('organization_id', 'uuid'),
      col('name', 'text'),
      col('slug', 'text', { unique: true }),
      col('owner_user_id', 'uuid'),
      col('description', 'text', { nullable: true }),
      col('archived_at', 'timestamp', { nullable: true }),
    ]),

    generateApi('plans'),
    generateApi('subscriptions'),
    generateApi('invoices'),
    generateApi('payment_methods'),
    generateApi('usage_records'),
    generateApi('api_keys'),
    generateApi('audit_logs'),
    generateApi('feature_flags'),
    generateApi('projects'),

    addRls('plans', 'public_read', 'Plans are public-read (pricing page)'),
    addRls('subscriptions', 'org_members'),
    addRls('invoices', 'org_members'),
    addRls('payment_methods', 'org_members'),
    addRls('usage_records', 'org_members'),
    addRls('api_keys', 'org_members'),
    addRls('audit_logs', 'org_members'),
    addRls('feature_flags', 'org_members'),
    addRls('projects', 'org_members'),

    enableRealtime('usage_records'),
    enableRealtime('audit_logs'),
    enableRealtime('invoices'),
    enableRealtime('subscriptions'),

    {
      label: 'Create org-assets bucket (private, signed-url access)',
      tool: 'create_bucket',
      args: { bucketName: 'org-assets', isPublic: false },
    },

    {
      label: 'Generate aggregate /stats/summary endpoint (MRR, ARR, churn, active orgs)',
      tool: 'generate_aggregate_api',
      args: { name: 'summary' },
    },
  ],
  warnings: [
    'org_members RLS requires every row to have an organization_id column, and your tables already follow that convention.',
    'Stripe / Paddle integration belongs in the Integrations tab once you have provider keys; the subscription / invoice tables here represent the platform-side mirror.',
  ],
}
