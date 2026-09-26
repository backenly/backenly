/**
 * Domain tools: one advertised MCP door per dashboard section.
 *
 * The advertised catalog used to cover Auth, Storage, Functions, Realtime,
 * Integrations, Monitoring, Autonomy, Webhooks, Deploy and Connect with at most
 * one single-purpose tool each (enable_auth, create_bucket, …) and send
 * everything else to `backend_chat`. So an agent that needed to roll back a
 * deploy, rotate a key or connect Stripe had to describe it to a language model
 * and hope it was classified correctly, while the operation itself already
 * existed as a typed brain tool.
 *
 * Each section is now one tool with an `action` enum, the shape `branch` and
 * `read_backend_state` already use: choosing a string inside a chosen tool is
 * an easier decision for a model than choosing between many similarly named
 * tools, and every action lands on the same governed brain tool it always did.
 *
 * Two rules keep this a door and not a bypass:
 *   • An action is routed to an EXISTING brain tool. Nothing here implements
 *     behaviour, so the executor, its validation and its audit trail are the
 *     ones every other path uses.
 *   • An action whose target is destructive, or that the executor rates high
 *     risk, is never run from here. It is parked for a human with the exact
 *     call, and runs verbatim once approved (lib/mcp/approvals.ts).
 */

import { BRAIN_TOOLS, READ_ONLY_TOOLS, TOOL_TO_ACTION, isDestructiveTool } from '@/lib/ai/brain/tools'
import { riskLevelForExecutorAction } from '@/lib/operational-memory/ledger'

export interface DomainAction {
  /** The brain tool that performs this action. */
  tool: string
  /** One line for the tool description, after the action name. */
  gloss: string
  /** The line a read-only key sees instead, when `gloss` mentions changing something. */
  readGloss?: string
}

export interface DomainTool {
  name: string
  title: string
  /** What the section is. The action list is appended from `actions`. */
  summary: string
  actions: Record<string, DomainAction>
  /** Some action reaches an outside provider (MCP openWorldHint). */
  openWorld?: boolean
}

export const DOMAIN_TOOLS: DomainTool[] = [
  {
    name: 'auth',
    title: 'End-user auth',
    summary:
      'Authentication for the END-USERS of the app being built, not Backenly accounts. ' +
      'Read the current user list with action "list_users".',
    actions: {
      enable: { tool: 'enable_auth', gloss: 'turn on email + password sign-up with JWT sessions' },
      add_oauth_provider: { tool: 'add_oauth_provider', gloss: 'Google, GitHub, Discord, Facebook or Apple sign-in, with the provider\'s clientId and clientSecret' },
      remove_oauth_provider: { tool: 'disable_oauth_provider', gloss: 'turn a sign-in provider off' },
      list_users: { tool: 'list_end_users', gloss: 'the end-users who have signed up' },
      reset_password: { tool: 'reset_end_user_password', gloss: 'send a password reset to one user (userId or email)' },
      block_user: { tool: 'block_end_user', gloss: 'stop one user from signing in' },
      unblock_user: { tool: 'unblock_end_user', gloss: 'let a blocked user sign in again' },
      enable_teams: { tool: 'enable_teams', gloss: 'organizations with members and roles' },
      email_settings: { tool: 'get_auth_email_settings', gloss: 'how verification and password-reset emails are sent, whether the last test worked, and the templates' },
      set_smtp: { tool: 'set_auth_smtp', gloss: 'the SMTP server auth emails are sent through (the password is stored encrypted and never returned)' },
      test_smtp: { tool: 'test_auth_smtp', gloss: 'send one real test email and record whether it arrived at the server' },
      remove_smtp: { tool: 'remove_auth_smtp', gloss: 'remove the SMTP settings' },
      set_email_template: { tool: 'set_auth_email_template', gloss: 'the app\'s own verification, password_reset or magic_link email; must include {{ctaUrl}}' },
      reset_email_template: { tool: 'reset_auth_email_template', gloss: 'go back to the default for one of them' },
    },
  },
  {
    name: 'storage',
    title: 'File storage',
    summary: 'Buckets and files. Uploads happen from the app through the SDK or REST, not here.',
    actions: {
      create_bucket: { tool: 'create_bucket', gloss: 'a new bucket, private unless isPublic' },
      set_public: { tool: 'set_bucket_public', gloss: 'make a bucket public or private' },
      list_buckets: { tool: 'list_buckets', gloss: 'every bucket with its visibility' },
      list_files: { tool: 'list_files', gloss: 'the files in one bucket' },
      signed_url: { tool: 'generate_signed_url', gloss: 'a time-limited download link for one file' },
      delete_file: { tool: 'delete_file', gloss: 'remove one file' },
      delete_bucket: { tool: 'delete_bucket', gloss: 'remove a bucket and everything in it' },
    },
  },
  {
    name: 'functions',
    title: 'Functions',
    summary:
      'Server-side functions and schedules. "create" has Backenly write a function\'s code from your spec with its ' +
      'own model, which draws AI credits; name the tables and integrations it uses. "deploy_code" stores code you wrote, ' +
      'exactly as written, after the runtime checks it can run.',
    actions: {
      create: { tool: 'generate_function', gloss: 'a function from a plain-English spec, fired by sign-up, a table event, HTTP or manually' },
      deploy_code: { tool: 'deploy_function_code', gloss: 'your own source: a route module for trigger http, a ctx sandbox body for every other trigger; replaces the code of a function with the same name' },
      list: { tool: 'list_ai_functions', gloss: 'every function with its trigger and on/off state' },
      get: { tool: 'get_ai_function', gloss: 'one function in full: its code, trigger, endpoint, state and last error' },
      invoke: { tool: 'invoke_ai_function', gloss: 'run it once now and get its answer, return value and log lines; a failure is reported, never auto-repaired' },
      logs: { tool: 'list_ai_function_logs', gloss: 'recent runs from every trigger, with errors and ctx.log lines' },
      set_active: { tool: 'toggle_ai_function', gloss: 'turn a function on or off' },
      delete: { tool: 'delete_ai_function', gloss: 'remove a function' },
      schedule: { tool: 'create_cron_job', gloss: 'a job on a schedule ("every 15 minutes" or 5-field cron)' },
      list_schedules: { tool: 'list_cron_jobs', gloss: 'every scheduled job' },
      delete_schedule: { tool: 'delete_cron_job', gloss: 'remove a scheduled job' },
    },
  },
  {
    name: 'realtime',
    title: 'Realtime',
    summary: 'Live change events for tables, delivered to the app over SSE.',
    actions: {
      enable: { tool: 'enable_realtime', gloss: 'stream inserts, updates and deletes for one table' },
      status: { tool: 'get_realtime_status', gloss: 'which tables stream changes' },
      disable: { tool: 'disable_realtime', gloss: 'stop streaming a table (live subscribers disconnect)' },
    },
  },
  {
    name: 'integrations',
    title: 'Integrations',
    summary:
      'Third-party providers used from functions as ctx.integrations.<id>: stripe, resend, sendgrid, ' +
      'openai, anthropic, twilio, posthog, onesignal, replicate, runway, stability. A key is verified with ' +
      'the provider before it is stored; the human can also paste it on the Integrations page, which keeps it ' +
      'out of this conversation.',
    openWorld: true,
    actions: {
      list: { tool: 'list_integration_keys', gloss: 'connected providers, masked keys and verification state' },
      capabilities: { tool: 'list_integration_capabilities', gloss: 'the exact ctx.integrations methods each provider gives a function, and for Stripe its receiver URL and signing-secret state' },
      verify: { tool: 'verify_integration_key', gloss: 'ask the provider again whether the stored key works' },
      connect: { tool: 'store_integration_key', gloss: 'store a provider key (Stripe also takes webhookSecret) and wire the first functions' },
      disconnect: { tool: 'remove_integration_key', gloss: 'remove a provider key' },
      send_push: { tool: 'send_push', gloss: 'a push notification through the connected OneSignal app' },
    },
  },
  {
    name: 'monitoring',
    title: 'Monitoring',
    summary: 'How the running backend is behaving, and alerts on it.',
    actions: {
      metrics: { tool: 'get_metrics', gloss: 'request rate, latency percentiles and error rate' },
      errors: { tool: 'get_errors', gloss: 'recent 5xx errors grouped by endpoint' },
      usage: { tool: 'get_usage', gloss: 'plan usage against its limits' },
      incidents: { tool: 'get_pending_incidents', gloss: 'what was detected, fixed or queued while nobody was watching' },
      request_logs: { tool: 'list_request_logs', gloss: 'each request the runtime API served: method, path, status, latency, time' },
      set_alert: { tool: 'set_alert', gloss: 'an alert on error rate, p95 latency, request rate or integration failures' },
    },
  },
  {
    name: 'autonomy',
    title: 'Autonomy',
    summary:
      'The self-healing loop. Approving what it queued is for a human on the Autonomy page; an agent can ' +
      'read it and set how much the loop may apply on its own.',
    actions: {
      status: { tool: 'get_autonomy_status', gloss: 'mode, recent repairs and what is waiting' },
      findings: { tool: 'list_findings', gloss: 'open health findings with evidence' },
      maintenance: { tool: 'get_maintenance_ladder', gloss: 'the schema-maintenance ladder and its consent state' },
      set_level: { tool: 'set_autonomy_level', gloss: 'OFF, CONSERVATIVE, BALANCED or AGGRESSIVE' },
    },
  },
  {
    name: 'webhooks',
    title: 'Webhooks',
    summary:
      'Endpoints that receive signed POSTs when rows change or an end user signs up (the Webhooks page), and ' +
      'table triggers whose action calls a URL. Endpoint deliveries carry X-Webhook-Signature: ' +
      'sha256=<HMAC-SHA256 of the raw body>; a secret is returned once, in data.secret.',
    openWorld: true,
    actions: {
      list: { tool: 'list_webhooks', gloss: 'every endpoint with its event, URL, on/off state and capture health' },
      create: { tool: 'create_webhook', gloss: 'an endpoint for row.inserted, row.updated, row.deleted or auth.user.created' },
      update: { tool: 'update_webhook', gloss: 'change the URL or event of an endpoint, or switch it on or off' },
      delete: { tool: 'delete_webhook', gloss: 'remove an endpoint and its delivery history' },
      test: { tool: 'test_webhook', gloss: 'send one real signed test delivery now and see what the receiver answered' },
      logs: { tool: 'list_webhook_logs', gloss: 'the deliveries of one endpoint, with status, HTTP code, error and payload' },
      replay: { tool: 'replay_webhook_log', gloss: 'send a FAILED or DEAD_LETTER delivery again' },
      rotate_secret: { tool: 'rotate_webhook_endpoint_secret', gloss: 'a new signing secret for an endpoint' },
      triggers: { tool: 'list_triggers', gloss: 'the table triggers, including those whose action calls a URL' },
      trigger_deliveries: { tool: 'list_webhook_deliveries', gloss: 'recent trigger deliveries, filterable by SUCCESS, FAILED or DEAD' },
      replay_trigger_delivery: { tool: 'replay_webhook_delivery', gloss: 'send a DEAD trigger delivery again' },
      rotate_trigger_secret: { tool: 'rotate_webhook_secret', gloss: 'a new signing secret for a trigger' },
    },
  },
  {
    name: 'deploy',
    title: 'Deploy',
    summary: 'Publishing and rolling back. Both change what production serves, so both wait for a human.',
    actions: {
      status: { tool: 'get_deploy_status', gloss: 'the live version, when it shipped and its state' },
      history: { tool: 'list_deploy_versions', gloss: 'every published version, which one is serving, and which can be rolled back to' },
      readiness: { tool: 'get_readiness', gloss: 'the 0-100 readiness score with blockers; fixes nothing unless autoFix is true', readGloss: 'the 0-100 readiness score with its blockers' },
      deploy: { tool: 'trigger_deploy', gloss: 'publish the current backend' },
      rollback: { tool: 'rollback_deploy', gloss: 'return to an earlier version' },
    },
  },
  {
    name: 'connect',
    title: 'Connect',
    summary:
      'Keys, secrets and connections for the apps and tools that use this backend. To rotate a key without ' +
      'downtime: create_api_key, move the app to the new key, then revoke_api_key the old one.',
    // No rotate_api_key: the executor puts the new secret in its summary, and an
    // approved exact call stores that summary where check_approval and the
    // approvals list serve it. Create-then-revoke rotates with nothing stored.
    actions: {
      whoami: { tool: 'get_connection_identity', gloss: 'the project this connection is bound to, and the key or OAuth connection calling' },
      create_api_key: { tool: 'create_api_key', gloss: 'a scoped key for an app, optionally bound to a preview branch' },
      list_api_keys: { tool: 'list_api_keys', gloss: 'every key with its scope and last use' },
      set_key_permissions: { tool: 'set_key_permissions', gloss: 'change what a key may do' },
      revoke_api_key: { tool: 'revoke_api_key', gloss: 'disable a key (apps using it stop working)' },
      set_env: { tool: 'set_env_var', gloss: 'an encrypted variable functions read as ctx.env.KEY' },
      list_env: { tool: 'list_env_vars', gloss: 'variable names with 4-character previews' },
      delete_env: { tool: 'delete_env_var', gloss: 'remove a variable' },
      database_credentials: { tool: 'get_database_credentials', gloss: 'a Postgres connection string (read-write only after a human arms it)' },
      connect_frontend: { tool: 'connect_frontend', gloss: 'allow a frontend origin (CORS)' },
      disconnect_frontend: { tool: 'disconnect_frontend', gloss: 'remove a frontend origin' },
      list_apps: { tool: 'list_connected_apps', gloss: 'the frontends connected to this backend' },
    },
  },
]

const BY_NAME = new Map(DOMAIN_TOOLS.map((d) => [d.name, d]))

export function isDomainTool(name: string): boolean {
  return BY_NAME.has(name)
}

export function getDomainTool(name: string): DomainTool | undefined {
  return BY_NAME.get(name)
}

/**
 * Whether an action must wait for a human. Derived from the two authorities
 * that already decide it elsewhere, never from a list kept here: the brain's
 * destructive set, and the executor's own risk rating. The executor rates
 * DISCONNECT_FRONTEND high while the brain does not list it as destructive, so
 * consulting only one of them would let a high-risk action run unreviewed.
 */
export function needsApproval(target: string): boolean {
  if (isDestructiveTool(target)) return true
  const build = TOOL_TO_ACTION[target]
  if (!build) return false
  return riskLevelForExecutorAction(build({}).action) === 'high'
}

/**
 * A domain as a read-only key sees it: only the actions whose target is a read,
 * or null when there are none.
 *
 * A read-only key used to see no domain tools at all, because each carries at
 * least one write, so an operator on one lost the per-section door even though
 * every read action behind it was allowed. The view keeps the door and narrows
 * it: the action enum, the description and the argument schema are built from
 * the read actions alone, so a write action is never shown. The route enforces
 * the same line by judging each call's target (app/api/mcp/tool/route.ts).
 */
export function readOnlyView(domain: DomainTool): DomainTool | null {
  const reads = Object.entries(domain.actions)
    .filter(([, a]) => READ_ONLY_TOOLS.has(a.tool as any))
    .map(([name, a]) => [name, { tool: a.tool, gloss: a.readGloss ?? a.gloss }] as const)
  if (reads.length === 0) return null
  return {
    name: domain.name,
    title: domain.title,
    summary:
      `${domain.title}, as a read-only key sees it: every action here reads and changes nothing. ` +
      'Changing anything needs a read-write key, which only a human can issue.',
    actions: Object.fromEntries(reads),
    openWorld: false,
  }
}

/** Arguments that ask a read to write, never offered to a read-only key. */
const WRITE_ONLY_ARGS = new Set(['autoFix'])

export type DomainResolution =
  | { kind: 'ok'; domain: DomainTool; action: string; target: string; approval: boolean }
  | { kind: 'unknown_action'; domain: DomainTool; action: string; supported: string[] }

export function resolveDomainAction(toolName: string, action: unknown): DomainResolution | null {
  const domain = BY_NAME.get(toolName)
  if (!domain) return null
  const key = typeof action === 'string' ? action.trim().toLowerCase() : ''
  const hit = domain.actions[key]
  if (!hit) return { kind: 'unknown_action', domain, action: key, supported: Object.keys(domain.actions) }
  return { kind: 'ok', domain, action: key, target: hit.tool, approval: needsApproval(hit.tool) }
}

type JsonSchema = Record<string, any>

function brainParams(tool: string): { properties: Record<string, JsonSchema>; required: string[] } {
  const def = BRAIN_TOOLS.find((t) => t.function?.name === tool)?.function as any
  return { properties: def?.parameters?.properties ?? {}, required: def?.parameters?.required ?? [] }
}

/**
 * The advertised schema for a domain tool: `action` plus the union of the
 * arguments its actions take, generated from the brain tools' own definitions
 * so the two can never disagree. A property several actions share keeps one
 * description and lists which actions use it.
 */
export function domainInputSchema(domain: DomainTool, opts?: { readOnly?: boolean }): {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
  additionalProperties: false
} {
  const properties: Record<string, JsonSchema> = {}
  const usedBy: Record<string, string[]> = {}

  for (const [action, { tool }] of Object.entries(domain.actions)) {
    for (const [prop, schema] of Object.entries(brainParams(tool).properties)) {
      if (prop === 'action') continue
      if (opts?.readOnly && WRITE_ONLY_ARGS.has(prop)) continue
      if (!properties[prop]) {
        properties[prop] = { ...schema }
        usedBy[prop] = [action]
        continue
      }
      usedBy[prop].push(action)
      const existing = properties[prop]
      if (existing.type !== schema.type) delete existing.type
      if (existing.enum || schema.enum) {
        existing.enum = [...new Set([...(existing.enum ?? []), ...(schema.enum ?? [])])]
      }
    }
  }

  for (const [prop, schema] of Object.entries(properties)) {
    const base = typeof schema.description === 'string' ? schema.description.replace(/\s*$/, '') : ''
    const who = `For: ${usedBy[prop].join(', ')}.`
    schema.description = base ? `${base}${/[.!?]$/.test(base) ? '' : '.'} ${who}` : who
  }

  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: Object.keys(domain.actions),
        description: 'What to do. The tool description lists each action and the arguments it needs.',
      },
      ...properties,
    },
    required: ['action'],
    additionalProperties: false,
  }
}

/** The advertised description: the summary, then one line per action. */
export function domainDescription(domain: DomainTool): string {
  const lines = Object.entries(domain.actions).map(([action, { tool, gloss }]) => {
    const needs = brainParams(tool).required
    const args = needs.length ? ` (needs ${needs.join(', ')})` : ''
    const gate = needsApproval(tool) ? ' [waits for human approval; poll check_approval]' : ''
    return `• ${action}: ${gloss}${args}${gate}`
  })
  return `${domain.summary}\nActions:\n${lines.join('\n')}`
}
