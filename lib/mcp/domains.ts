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
 *
 * Two texts per action, for two readers. `gloss` is the docs' line: the action
 * tables in public/docs/agents are generated from it (lib/mcp/agent-docs-render.ts).
 * `brief` is what tools/list says, which every session pays for before the
 * user types anything (production QA 2026-11-09, report 99): only what the
 * action's name and required arguments do not already say, and the tool's
 * description names the docs topic that has the rest.
 */

import { BRAIN_TOOLS, READ_ONLY_TOOLS, TOOL_TO_ACTION, isDestructiveTool } from '@/lib/ai/brain/tools'
import { riskLevelForExecutorAction } from '@/lib/operational-memory/ledger'
import { connectableProviderIds } from '@/lib/services/ai-functions/integration-registry'
import { AGENT_DOC_TOPICS, docsPointer } from '@/lib/mcp/agent-docs'

export interface DomainAction {
  /** The brain tool that performs this action. */
  tool: string
  /** The docs' line for this action (the generated action tables). */
  gloss: string
  /** What tools/list says after the action's name and required arguments, when they do not say enough. */
  brief?: string
  /** The brief a read-only key sees instead, when `brief` mentions changing something. */
  readBrief?: string
}

export interface DomainTool {
  name: string
  title: string
  /** What tools/list says the section is. The action list is appended from `actions`. */
  summary: string
  actions: Record<string, DomainAction>
  /** Some action reaches an outside provider (MCP openWorldHint). */
  openWorld?: boolean
  /**
   * What tools/list says about an argument, in place of its brain tool's
   * description, which the brain's own model reads. '' leaves only the actions
   * that take it.
   */
  argText?: Record<string, string>
}

export const DOMAIN_TOOLS: DomainTool[] = [
  {
    name: 'auth',
    title: 'End-user auth',
    summary: 'Sign-up and sign-in for the END-USERS of the app being built, not Backenly accounts.',
    actions: {
      enable: { tool: 'enable_auth', gloss: 'turn on email + password sign-up with JWT sessions', brief: 'email + password sign-up' },
      add_oauth_provider: { tool: 'add_oauth_provider', gloss: 'Google, GitHub, Discord or Facebook sign-in, with the provider\'s clientId and clientSecret' },
      remove_oauth_provider: { tool: 'disable_oauth_provider', gloss: 'turn a sign-in provider off' },
      list_users: { tool: 'list_end_users', gloss: 'the end-users who have signed up' },
      reset_password: { tool: 'reset_end_user_password', gloss: 'send a password reset to one user (userId or email)', brief: 'userId or email' },
      block_user: { tool: 'block_end_user', gloss: 'stop one user from signing in' },
      unblock_user: { tool: 'unblock_end_user', gloss: 'let a blocked user sign in again' },
      enable_teams: { tool: 'enable_teams', gloss: 'organizations with members and roles' },
      email_settings: { tool: 'get_auth_email_settings', gloss: 'how verification and password-reset emails are sent, whether the last test worked, the templates, and the sign-in email policy' },
      set_email_policy: { tool: 'set_auth_email_policy', gloss: 'the app name and URL auth emails link to, whether sign-in requires a verified email (needs a working sender first), and whether magic links are on' },
      set_smtp: { tool: 'set_auth_smtp', gloss: 'the SMTP server auth emails are sent through (the password is stored encrypted and never returned)' },
      test_smtp: { tool: 'test_auth_smtp', gloss: 'send one real test email and record whether it arrived at the server' },
      remove_smtp: { tool: 'remove_auth_smtp', gloss: 'remove the SMTP settings' },
      set_email_template: { tool: 'set_auth_email_template', gloss: 'the app\'s own verification, password_reset or magic_link email; must include {{ctaUrl}}', brief: 'bodyHtml must include {{ctaUrl}}' },
      reset_email_template: { tool: 'reset_auth_email_template', gloss: 'go back to the default for one of them' },
    },
    argText: {
      provider: 'The sign-in provider.', kind: 'Which email.',
      clientId: '', clientSecret: '', requireEmailVerification: '', magicLinksEnabled: '',
      host: '', port: '', password: '', fromName: '', enabled: '', to: '',
      appName: '', appUrl: 'Where reset links land.', fromAddress: 'A verified sender.',
    },
  },
  {
    name: 'storage',
    title: 'File storage',
    summary: 'Buckets and files. Uploads go from the app (SDK or REST), not through this tool.',
    actions: {
      create_bucket: { tool: 'create_bucket', gloss: 'a new bucket, private unless isPublic', brief: 'private unless isPublic' },
      set_public: { tool: 'set_bucket_public', gloss: 'make a bucket public or private (shorthand for the public_read / private policies)' },
      set_policy: { tool: 'set_bucket_policy', gloss: 'set the enforced access policy: public_read, cdn_cacheable, private or owner_only' },
      list_buckets: { tool: 'list_buckets', gloss: 'every bucket with its visibility' },
      list_files: { tool: 'list_files', gloss: 'the files in one bucket' },
      signed_url: { tool: 'generate_signed_url', gloss: 'a time-limited download link for one file' },
      delete_file: { tool: 'delete_file', gloss: 'remove one file' },
      delete_bucket: { tool: 'delete_bucket', gloss: 'remove a bucket and everything in it', brief: 'and everything in it' },
    },
    argText: { bucketName: 'The bucket.', path: 'The file\'s path in the bucket.' },
  },
  {
    name: 'functions',
    title: 'Functions',
    summary:
      'Server-side functions and schedules. create and schedule have Backenly\'s model write the code from your spec ' +
      '(draws AI credits); deploy_code stores code you wrote, exactly as written.',
    actions: {
      create: { tool: 'generate_function', gloss: 'a function from a plain-English spec, fired by sign-up, a table event, HTTP or manually' },
      deploy_code: { tool: 'deploy_function_code', gloss: 'your own source: a route module for trigger http, a ctx sandbox body for every other trigger; replaces the code of a function with the same name', brief: 'replaces a function with the same name' },
      list: { tool: 'list_ai_functions', gloss: 'every function with its trigger and on/off state' },
      get: { tool: 'get_ai_function', gloss: 'one function in full: its code, trigger, endpoint, state and last error' },
      invoke: { tool: 'invoke_ai_function', gloss: 'run it once now and get its answer, return value and log lines; a failure is reported, never auto-repaired' },
      logs: { tool: 'list_ai_function_logs', gloss: 'recent runs from every trigger, with errors and ctx.log lines' },
      set_active: { tool: 'toggle_ai_function', gloss: 'turn a function on or off' },
      delete: { tool: 'delete_ai_function', gloss: 'remove a function' },
      schedule: { tool: 'create_cron_job', gloss: 'a job on a schedule ("every 15 minutes" or 5-field cron), its code written from your description by Backenly\'s model' },
      list_schedules: { tool: 'list_cron_jobs', gloss: 'every scheduled job' },
      delete_schedule: { tool: 'delete_cron_job', gloss: 'remove a scheduled job' },
    },
    argText: {
      name: 'The function\'s name.',
      description: 'What it does, and the tables and integrations it uses.',
      trigger: 'What fires it.', functionId: '', event: '',
      table: 'The table, for a row trigger.',
      method: 'http only. Default POST.',
      code: 'A route module for trigger "http", a sandbox body for any other.',
      columns: 'on_update: run only when one of these changes.',
      schedule: '"every 15 minutes" or 5-field cron.',
    },
  },
  {
    name: 'realtime',
    title: 'Realtime',
    summary: 'Live insert, update and delete events for a table, streamed to the app over SSE.',
    actions: {
      enable: { tool: 'enable_realtime', gloss: 'stream inserts, updates and deletes for one table' },
      status: { tool: 'get_realtime_status', gloss: 'which tables stream changes' },
      disable: { tool: 'disable_realtime', gloss: 'stop streaming a table (live subscribers disconnect)', brief: 'live subscribers disconnect' },
    },
  },
  {
    name: 'integrations',
    title: 'Integrations',
    summary:
      // The registry's list, the same one the Integrations page offers.
      `Provider keys for functions, used as ctx.integrations.<id>: ${connectableProviderIds()}. A person can paste ` +
      'a key on the Integrations page instead, keeping it out of this conversation.',
    openWorld: true,
    actions: {
      list: { tool: 'list_integration_keys', gloss: 'connected providers, masked keys and verification state' },
      capabilities: { tool: 'list_integration_capabilities', gloss: 'the exact ctx.integrations methods each provider gives a function, and for Stripe its receiver URL and signing-secret state', brief: 'the methods each provider gives' },
      verify: { tool: 'verify_integration_key', gloss: 'ask the provider again whether the stored key works' },
      connect: { tool: 'store_integration_key', gloss: 'store a provider key (Stripe also takes webhookSecret, OneSignal also takes appId, Resend/SendGrid also takes fromEmail) and wire the first functions, which Backenly\'s model writes', brief: 'also wires the first functions, written by Backenly\'s model' },
      disconnect: { tool: 'remove_integration_key', gloss: 'remove a provider key' },
      send_push: { tool: 'send_push', gloss: 'a push notification through the connected OneSignal app', brief: 'through OneSignal' },
    },
    argText: {
      integrationId: '', apiKey: '', label: '',
      webhookSecret: 'Stripe: the whsec_… secret; events are rejected until it is stored.',
      appId: 'OneSignal: the App ID.',
      fromEmail: 'Resend or SendGrid: a verified sender.',
    },
  },
  {
    name: 'monitoring',
    title: 'Monitoring',
    summary: 'How the running backend is behaving.',
    // No set_alert: it stored an alert under project.activeIntegrations that
    // nothing ever evaluates, so an agent was told an alert was set that could
    // never fire (and the call failed besides: its `type` never reached the
    // executor, which reads `metric`). It comes back with an evaluator.
    actions: {
      metrics: { tool: 'get_metrics', gloss: 'request rate, latency percentiles and error rate' },
      errors: { tool: 'get_errors', gloss: 'recent 5xx errors grouped by endpoint', brief: 'recent 5xx by endpoint' },
      usage: { tool: 'get_usage', gloss: 'plan usage against its limits' },
      incidents: { tool: 'get_pending_incidents', gloss: 'what was detected, fixed or queued while nobody was watching' },
      request_logs: { tool: 'list_request_logs', gloss: 'each request the runtime API served: method, path, status, latency, time' },
    },
    argText: { windowMinutes: '', minStatus: '', pathPrefix: '', branchId: 'A preview branch id.' },
  },
  {
    name: 'autonomy',
    title: 'Autonomy',
    summary: 'The self-healing loop. Only a person approves what it queued, on the Autonomy page.',
    actions: {
      status: { tool: 'get_autonomy_status', gloss: 'mode, recent repairs and what is waiting' },
      findings: { tool: 'list_findings', gloss: 'open health findings with evidence' },
      maintenance: { tool: 'get_maintenance_ladder', gloss: 'the schema-maintenance ladder and its consent state' },
      evolution: { tool: 'get_evolution_proposals', gloss: 'architecture changes, what waits for approval, recommendations; detail: true for evidence and exact plans', brief: 'architecture changes' },
      set_level: { tool: 'set_autonomy_level', gloss: 'OFF, CONSERVATIVE, BALANCED or AGGRESSIVE', brief: 'how much it may apply on its own' },
    },
    argText: { detail: 'Evidence and exact plans.' },
  },
  {
    name: 'webhooks',
    title: 'Webhooks',
    summary:
      'Endpoints that get a signed POST when rows change or an end-user signs up, and table triggers that call a ' +
      'URL. A signing secret is returned once, in data.secret: keep it.',
    openWorld: true,
    actions: {
      list: { tool: 'list_webhooks', gloss: 'every endpoint with its event, URL, on/off state and capture health' },
      create: { tool: 'create_webhook', gloss: 'an endpoint for row.inserted, row.updated, row.deleted or auth.user.created; tables limits a row event to some tables' },
      update: { tool: 'update_webhook', gloss: 'change the URL, event or tables of an endpoint, or switch it on or off' },
      delete: { tool: 'delete_webhook', gloss: 'remove an endpoint and its delivery history' },
      test: { tool: 'test_webhook', gloss: 'send one real signed test delivery now and see what the receiver answered' },
      logs: { tool: 'list_webhook_logs', gloss: 'the deliveries of one endpoint, with status, HTTP code, error and payload' },
      replay: { tool: 'replay_webhook_log', gloss: 'send a FAILED or DEAD_LETTER delivery again', brief: 'a FAILED or DEAD_LETTER delivery' },
      rotate_secret: { tool: 'rotate_webhook_endpoint_secret', gloss: 'a new signing secret for an endpoint' },
      triggers: { tool: 'list_triggers', gloss: 'the table triggers, including those whose action calls a URL', brief: 'table triggers' },
      trigger_deliveries: { tool: 'list_webhook_deliveries', gloss: 'recent trigger deliveries, filterable by SUCCESS, FAILED or DEAD' },
      replay_trigger_delivery: { tool: 'replay_webhook_delivery', gloss: 'send a DEAD trigger delivery again', brief: 'a DEAD one' },
      rotate_trigger_secret: { tool: 'rotate_webhook_secret', gloss: 'a new signing secret for a trigger' },
    },
    argText: {
      eventType: '', targetUrl: '', active: '', status: '', triggerName: '', triggerId: '',
      webhookId: 'From list.',
      tables: 'Row events only. Omit: every table.',
      deliveryId: 'From logs.',
      id: 'From trigger_deliveries.',
    },
  },
  {
    name: 'deploy',
    title: 'Deploy',
    summary: 'Publishing, the change history, and restoring the state before a change.',
    actions: {
      status: { tool: 'get_deploy_status', gloss: 'the live version, when it shipped and its state' },
      history: { tool: 'list_deploy_versions', gloss: 'every published version and which one is serving' },
      readiness: { tool: 'get_readiness', gloss: 'the 0-100 readiness score with blockers; fixes nothing unless autoFix is true', brief: 'fixes nothing unless autoFix', readBrief: '' },
      deploy: { tool: 'trigger_deploy', gloss: 'publish the current backend' },
      rollback: { tool: 'rollback_deploy', gloss: 'ask to restore the backend to a published version (version or deploymentId); a person approves Backenly\'s list of the changes it would undo, and approving undoes them, newest first', brief: 'to a published version (version or deploymentId)' },
      changes: { tool: 'list_schema_changes', gloss: 'every schema change to production, newest first: its changeId, who made it, what it did, whether it was verified, and whether the state before it can be restored', brief: 'schema changes, with their changeId' },
      revert_change: { tool: 'revert_schema_change', gloss: 'ask to restore the state before one change (changeId); a person approves it, and data written since is never dropped silently' },
    },
    argText: { autoFix: 'Apply the safe fixes. Default false.', version: '', deploymentId: '', limit: '', changeId: 'From changes.' },
  },
  {
    name: 'connect',
    title: 'Connect',
    summary:
      'Keys, env variables and frontend origins for the apps that use this backend. An app uses a key from ' +
      'create_api_key, never your MCP key.',
    // No rotate_api_key: the executor puts the new secret in its summary, and an
    // approved exact call stores that summary where check_approval and the
    // approvals list serve it. Create-then-revoke rotates with nothing stored.
    actions: {
      whoami: { tool: 'get_connection_identity', gloss: 'the project this connection is bound to, and the key or OAuth connection calling' },
      create_api_key: { tool: 'create_api_key', gloss: 'the key an app uses: publishable and safe in a browser (a person creates a server\'s service-role key in Settings); optionally bound to a preview branch', brief: 'publishable, safe in a browser' },
      list_api_keys: { tool: 'list_api_keys', gloss: 'every key with its scope and last use' },
      set_key_permissions: { tool: 'set_key_permissions', gloss: 'change what a key may do' },
      revoke_api_key: { tool: 'revoke_api_key', gloss: 'disable a key (apps using it stop working)', brief: 'apps using it stop working' },
      set_env: { tool: 'set_env_var', gloss: 'an encrypted variable functions read as ctx.env.KEY', brief: 'functions read it as ctx.env.KEY' },
      list_env: { tool: 'list_env_vars', gloss: 'variable names with 4-character previews' },
      delete_env: { tool: 'delete_env_var', gloss: 'remove a variable' },
      database_credentials: { tool: 'get_database_credentials', gloss: 'a Postgres connection string (read-write only after a human arms it)', brief: 'read-write only after a person arms it' },
      connect_frontend: { tool: 'connect_frontend', gloss: 'allow a frontend origin (CORS); binds at once, and once a deployed (non-localhost) origin is connected, connected origins become the project\'s CORS allowlist', brief: 'allow its origin (CORS); once a non-localhost one is connected, only connected origins are allowed' },
      disconnect_frontend: { tool: 'disconnect_frontend', gloss: 'remove a frontend origin' },
      list_apps: { tool: 'list_connected_apps', gloss: 'the frontends connected to this backend' },
    },
    argText: {
      description: 'A label.',
      permissions: 'Default ["read","write"].',
      expiresInDays: 'Omit: never expires.',
      serviceRole: 'true is refused (SERVICE_KEY_REQUIRES_HUMAN): a person creates those in Settings.',
      branchId: 'Bind the key to a preview branch.',
      keyId: 'From list_api_keys.',
      key: 'UPPER_SNAKE_CASE.',
      value: '', mode: 'Default READ_ONLY.',
      url: 'The frontend\'s URL.',
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
 * needsApproval for one call, asked by both doors (the MCP tool route and the
 * brain's gate). Deleting a function nothing calls, one switched off or not
 * run in 7 days, runs at once: History keeps its code, and restoring the
 * change brings it back (lib/services/ai-functions/delete-rule.ts). Every
 * other call answers as needsApproval does.
 */
export async function approvalNeededFor(target: string, args: Record<string, unknown>, projectId: string): Promise<boolean> {
  if (!needsApproval(target)) return false
  if (target === 'delete_ai_function') {
    const { deleteWaitsForPerson } = await import('@/lib/services/ai-functions/delete-rule')
    return deleteWaitsForPerson(projectId, args)
  }
  return true
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
    .map(([name, a]) => [name, { tool: a.tool, gloss: a.gloss, brief: a.readBrief ?? a.brief }] as const)
  if (reads.length === 0) return null
  return {
    name: domain.name,
    title: domain.title,
    summary:
      `${domain.title}, read-only: every action here only reads. A change needs a read-write key, which only a ` +
      'person can issue.',
    actions: Object.fromEntries(reads),
    openWorld: false,
    argText: domain.argText,
  }
}

/** Arguments that ask a read to write, never offered to a read-only key. */
const WRITE_ONLY_ARGS = new Set(['autoFix'])

/**
 * Arguments only the brain's own model uses. `force` answers a confirmation
 * prompt in backend_chat; the typed door binds without one, so offering it
 * there only cost every session its description.
 */
const BRAIN_ONLY_ARGS = new Set(['force'])

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
 * Tools whose executor requires ONE OF several arguments. Their brain schema
 * declares `required: []` (JSON Schema here cannot express the alternative),
 * which rendered as "Needs: nothing" — and the executor then refused the
 * call. The docs and descriptions print this declared alternative instead.
 */
const REQUIRED_ALTERNATIVES: Record<string, string> = {
  rotate_webhook_secret: 'triggerName or triggerId',
  block_end_user: 'userId or email',
  unblock_end_user: 'userId or email',
}

/** Whether `prop` is one of the arguments an action's line says it requires. */
function requiredInLine(tool: string, prop: string): boolean {
  return actionRequires(tool).some((r) => r.split(' or ').includes(prop))
}

/** The arguments an action's target tool requires, as its description lists them. */
export function actionRequires(tool: string): string[] {
  const alternative = REQUIRED_ALTERNATIVES[tool]
  if (alternative) return [alternative]
  return brainParams(tool).required.filter((p) => p !== 'action')
}

/**
 * The advertised schema for a domain tool: `action` plus the union of the
 * arguments its actions take, generated from the brain tools' own definitions
 * so the two can never disagree. A property several actions share keeps one
 * description and lists which actions use it. Its text is the domain's
 * `argText` where it has one, else the brain tool's.
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
      if (BRAIN_ONLY_ARGS.has(prop)) continue
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

  // "For:" names the actions that take an argument without requiring it: the
  // ones that require it say so on their line of the description. An argument
  // with no text of its own still names every action that takes it.
  for (const [prop, schema] of Object.entries(properties)) {
    const own = domain.argText?.[prop]
    const text = (own ?? (typeof schema.description === 'string' ? schema.description : '')).replace(/\s*$/, '')
    const base = text && !/[.!?]$/.test(text) ? `${text}.` : text
    const optionalFor = usedBy[prop].filter((a) => !requiredInLine(domain.actions[a].tool, prop))
    const forList = optionalFor.length ? optionalFor : base ? [] : usedBy[prop]
    schema.description = [base, forList.length ? `For: ${forList.join(', ')}.` : ''].filter(Boolean).join(' ')
  }

  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: Object.keys(domain.actions),
        description: 'The action.',
      },
      ...properties,
    },
    required: ['action'],
    additionalProperties: false,
  }
}

/** How an action that waits for a person is marked in a description. */
export const APPROVAL_MARK = '[waits for approval]'

/** The docs topic a domain tool's description sends the agent to. */
export function domainDocsTopic(name: string): string {
  const topic = AGENT_DOC_TOPICS.find((t) => t.domain === name)
  if (!topic) throw new Error(`Section tool ${name} has no docs topic in lib/mcp/agent-docs.ts`)
  return topic.id
}

/**
 * The advertised description: the summary and its docs topic, then a line for
 * each action that requires arguments, has a brief or waits for a person.
 * Every action is in the `action` enum; one with none of these has nothing to
 * add to it.
 */
export function domainDescription(domain: DomainTool): string {
  let withArgs = false
  const lines = Object.entries(domain.actions).flatMap(([action, { tool, brief }]) => {
    const needs = actionRequires(tool)
    const gated = needsApproval(tool)
    if (!needs.length && !brief && !gated) return []
    if (needs.length) withArgs = true
    const args = needs.length ? ` (${needs.join(', ')})` : ''
    return [`- ${action}${args}${brief ? `: ${brief}` : ''}${gated ? ` ${APPROVAL_MARK}` : ''}`]
  })
  const head = `${domain.summary} ${docsPointer(domainDocsTopic(domain.name))}`
  if (!lines.length) return head
  return `${head}\n${withArgs ? 'Required arguments in parentheses:\n' : ''}${lines.join('\n')}`
}
