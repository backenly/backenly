/**
 * Every MCP acceptance case, and the evidence that decides it.
 *
 * Most cases are proved by tests CI already runs (tests/unit on the static job,
 * the database-backed suites on the integration job, the stdio package's own
 * tests on the mcp-server job); the evidence names them by file and test name,
 * and scripts/mcp-acceptance/matrix.ts reads the results those jobs wrote. What
 * only the final AWS staging image can show is DEFERRED, with the exact command
 * the release session runs. Nothing here is a PASS by being listed.
 */

import type { AcceptanceCase, Deferral, Evidence } from './evaluate'

const esc = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const unit = (file: string, ...tests: string[]): Evidence => ({ kind: 'jest', suite: 'unit', file: `tests/unit/${file}`, tests: tests.map(esc) })
const db = (file: string, ...tests: string[]): Evidence => ({ kind: 'jest', suite: 'integration', file, tests: tests.map(esc) })
const golden = (...tests: string[]) => db('tests/integration/mcp-golden-workflows.spec.ts', ...tests)
const gap = (...tests: string[]) => db('tests/integration/mcp-acceptance-cases.spec.ts', ...tests)
const ops = (...tests: string[]) => db('tests/integration/mcp-domain-operations.spec.ts', ...tests)
const migration = (...tests: string[]) => db('tests/integration/apply-migration-existing-table.spec.ts', ...tests)
const pkg = (what: string): Evidence => ({ kind: 'job', job: 'mcp-server', what })
const skip = (reason: string): Evidence => ({ kind: 'skip', reason })

/** The live harness on the final staging image; see the deferral records below. */
const HARNESS = 'npx tsx scripts/mcp-harness/run.ts --endpoint "$BACKENLY_API_URL" --key "$BACKENLY_MCP_KEY" --strict --json acceptance-live.json'
const HARNESS_ENV = ['BACKENLY_API_URL', 'BACKENLY_MCP_KEY']
const THROWAWAY = 'A dedicated throwaway project on final staging, and a read-write MCP key for it (never a project with real data).'
/** The CLI takes its endpoint from BACKENLY_API_URL; it has no --endpoint flag. */
const CLI_READY = 'BACKENLY_API_URL exported (the CLI reads it), and the CLI linked: npx -y @backenly/cli@0.2.0 link --project "$BACKENLY_PROJECT_ID" --key "$BACKENLY_MCP_KEY".'
const HARNESS_CLEANUP = 'The harness prints DROP TABLE SQL for its hx_<run>_* tables; functions it deploys are named hx-<run>-*; delete the throwaway project when done.'
const live = (harness: string[], expected: string, why: string): Evidence => ({
  kind: 'deferred',
  deferral: { command: HARNESS, env: HARNESS_ENV, preconditions: THROWAWAY, expected, cleanup: HARNESS_CLEANUP, why, harness },
})
const staging = (d: Omit<Deferral, 'harness'>): Evidence => ({ kind: 'deferred', deferral: d })

const connect = (provider: string, envVar: string, extra = ''): Evidence => staging({
  command:
    `npx -y @backenly/cli@0.2.0 link --project "$BACKENLY_PROJECT_ID" --key "$BACKENLY_MCP_KEY" && ` +
    `npx -y @backenly/cli@0.2.0 call integrations action=connect integrationId=${provider} apiKey="$${envVar}"${extra} && ` +
    `npx -y @backenly/cli@0.2.0 call integrations action=verify integrationId=${provider}`,
  env: ['BACKENLY_API_URL', 'BACKENLY_PROJECT_ID', 'BACKENLY_MCP_KEY', envVar],
  preconditions: `${THROWAWAY} A ${provider} TEST-mode key in ${envVar}.`,
  expected: provider === 'posthog'
    ? 'connect answers ok with the key stored as unverifiable (PostHog project keys cannot be checked by an API call); verify says there is nothing it can check.'
    : `connect answers ok with the key verified by ${provider}; verify answers ok and records it; a deliberately wrong key is refused, not stored.`,
  cleanup: `npx -y @backenly/cli@0.2.0 call integrations action=disconnect integrationId=${provider}, which parks for approval; approve it on the Autonomy page, or delete the throwaway project.`,
  why: `Needs a real ${provider} test key and outbound network from the deployed runtime; CI holds neither.`,
})

export const ACCEPTANCE_CASES: AcceptanceCase[] = [
  // ── Protocol ───────────────────────────────────────────────────────────────
  { id: 'PROTO-CURRENT', area: 'Protocol', title: '2026-07-28 (current) negotiated and served', evidence: unit('mcp-remote-protocol.spec.ts', 'remote endpoint, modern era negotiates the revision of its era') },
  { id: 'PROTO-OLDER', area: 'Protocol', title: 'older revisions still answered', evidence: unit('mcp-remote-protocol.spec.ts', 'answers a 2024-11-05 initialize in that revision', 'answers a 2025-03-26 initialize in that revision', 'answers a 2025-06-18 initialize in that revision', 'remote endpoint, legacy era negotiates the revision of its era') },
  { id: 'PROTO-INITIALIZE', area: 'Protocol', title: 'initialize, and an unknown revision answered with a known one', evidence: unit('mcp-remote-protocol.spec.ts', 'answers a 2025-11-25 initialize in that revision', 'answers a revision it does not know with one it does') },
  { id: 'PROTO-DISCOVERY', area: 'Protocol', title: 'discovery and list without a prior initialize', evidence: unit('mcp-remote-protocol.spec.ts', 'serves tools/list statelessly, without a prior initialize') },
  { id: 'PROTO-TOOLS-LIST', area: 'Protocol', title: 'tools/list: the full catalog with titles and annotations', evidence: unit('mcp-remote-protocol.spec.ts', 'lists the full catalog, with titles and annotations, to a read-write key') },
  { id: 'PROTO-TOOLS-CALL', area: 'Protocol', title: 'tools/call returns the handler body', evidence: unit('mcp-remote-protocol.spec.ts', 'returns a successful call as the handler body, as text and as structuredContent', 'routes backend_chat to the brain and keeps its approval object, adding nothing') },
  { id: 'PROTO-RESOURCES', area: 'Protocol', title: 'resources: list, read, unknown refused', evidence: unit('mcp-remote-protocol.spec.ts', 'lists its resources and reads one through its read-only tool', 'refuses an unknown resource as invalid params, naming the uri') },
  { id: 'PROTO-STRUCTURED', area: 'Protocol', title: 'structured results for success and refusal', evidence: unit('mcp-remote-protocol.spec.ts', 'returns a refusal with its code, hint and what already landed') },
  { id: 'PROTO-INVALID', area: 'Protocol', title: 'invalid requests: parse error, method not found, GET', evidence: unit('mcp-remote-protocol.spec.ts', 'refuses a body that is not JSON-RPC with a parse error', 'answers a method it does not serve with method-not-found', 'answers GET with 405: there is no server-initiated stream') },
  { id: 'PROTO-AUTH-FAILURE', area: 'Protocol', title: 'auth failures: 401 with WWW-Authenticate, expired token refreshed', evidence: unit('mcp-remote-protocol.spec.ts', 'answers a missing credential with 401 and WWW-Authenticate, in both eras', 'answers an expired token with a challenge, and the client refreshes and retries') },
  { id: 'PROTO-CATALOG-RECOVERY', area: 'Protocol', title: 'catalog recovery and list_changed (stdio package)', evidence: pkg('the built stdio package recovers its catalog and sends list_changed, in both eras') },
  { id: 'PROTO-STAGING', area: 'Protocol', title: 'both eras over the deployed ALB and TLS', evidence: staging({
    command:
      'curl -sS "$BACKENLY_API_URL/api/mcp" -H "x-api-key: $BACKENLY_MCP_KEY" -H "content-type: application/json" -H "accept: application/json, text/event-stream" ' +
      '-d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gate","version":"0"}}}\' ; ' +
      'curl -sS "$BACKENLY_API_URL/api/mcp" -H "x-api-key: $BACKENLY_MCP_KEY" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -H "mcp-protocol-version: 2026-07-28" ' +
      '-d \'{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\' ; ' +
      'curl -sS -o /dev/null -w "%{http_code}\\n" "$BACKENLY_API_URL/api/mcp" -H "content-type: application/json" -d \'{"jsonrpc":"2.0","id":3,"method":"tools/list"}\'',
    env: ['BACKENLY_API_URL', 'BACKENLY_MCP_KEY'],
    preconditions: 'The final staging web image is serving /api/mcp.',
    expected: 'initialize answers protocolVersion 2025-06-18 with serverInfo; the 2026-07-28 tools/list answers 23 tools; the unauthenticated call answers 401.',
    cleanup: 'None: reads only.',
    why: 'Proves the protocol through the real load balancer, TLS and container, which the in-process tests cannot.',
  }) },

  // ── Transports ─────────────────────────────────────────────────────────────
  { id: 'TRANSPORT-STDIO', area: 'Transports', title: 'the built stdio package serves the same surface as remote', evidence: unit('mcp-transport-parity.spec.ts', 'legacy era read-write key serves the same instructions, capabilities, tools and resources', 'modern era read-write key serves the same instructions, capabilities, tools and resources') },
  { id: 'TRANSPORT-STDIO-PACKAGE', area: 'Transports', title: 'the stdio package under the official client, raw JSON-RPC included', evidence: pkg('stdio-protocol.test.mjs: both eras, older revisions, malformed lines, a key rejected at boot') },
  { id: 'TRANSPORT-REMOTE', area: 'Transports', title: 'remote Streamable HTTP in both eras', evidence: unit('mcp-remote-protocol.spec.ts', 'remote endpoint, legacy era returns a successful call', 'remote endpoint, modern era returns a successful call') },
  { id: 'TRANSPORT-PARITY', area: 'Transports', title: 'identical answers call for call', evidence: unit('mcp-transport-parity.spec.ts', 'identically') },
  { id: 'TRANSPORT-STDIO-STAGING', area: 'Transports', title: 'the published @backenly/mcp-server@0.4.0 against final staging', evidence: staging({
    command: 'npx -y @modelcontextprotocol/inspector --cli npx -y @backenly/mcp-server@0.4.0 --project "$BACKENLY_PROJECT_ID" --key "$BACKENLY_MCP_KEY" --endpoint "$BACKENLY_API_URL" --method tools/list',
    env: ['BACKENLY_API_URL', 'BACKENLY_PROJECT_ID', 'BACKENLY_MCP_KEY'],
    preconditions: '@backenly/mcp-server@0.4.0 published (only after the final staging web is live), and a clean npm cache.',
    expected: 'tools/list answers the same 23 tools the remote endpoint does; a tools/call of read_backend_state answers ok.',
    cleanup: 'None: reads only.',
    why: 'The 0.4.0 package routes db_* through /api/mcp/tool, whose validation exists only on an image containing #130; it must not be published before that image is live.',
  }) },

  // ── Key types ──────────────────────────────────────────────────────────────
  { id: 'KEY-READ-WRITE', area: 'Keys', title: 'a read-write key is served the full surface', evidence: unit('mcp-transport-parity.spec.ts', 'read-write key answers tools/call read_backend_state {} identically') },
  { id: 'KEY-READ-ONLY', area: 'Keys', title: 'a read-only key sees and runs only reads', evidence: unit('mcp-read-only-keys.spec.ts', 'withholds every write door, including the natural-language one') },
  { id: 'KEY-READ-ONLY-ROUTE', area: 'Keys', title: 'a read-only key is refused every write, before it runs', evidence: unit('mcp-domain-tools.spec.ts', 'refuses a read-only key every write action of every domain, and dispatches nothing', 'never parks a request from a read-only key either') },
  { id: 'KEY-INVALID', area: 'Keys', title: 'a missing or invalid credential is refused', evidence: unit('mcp-remote-protocol.spec.ts', 'refuses a client with no credential, with the challenge that starts OAuth') },
  { id: 'KEY-REVOKED', area: 'Keys', title: 'a revoked key is refused after the approved revoke', evidence: gap('APPROVAL-EXACT-REPLAY and KEY-REVOKED') },
  { id: 'KEY-OAUTH-REVOKED', area: 'Keys', title: 'revoking an OAuth connection kills its tokens', evidence: db('tests/integration/mcp-oauth-flow.spec.ts', 'kills outstanding access tokens when the connection is revoked') },

  // ── Database ───────────────────────────────────────────────────────────────
  { id: 'DB-INSPECT', area: 'Database', title: 'get_table_schema shows FKs and CHECK values', evidence: golden('builds its accounts schema with a foreign key, a CHECK, a default and an index') },
  { id: 'DB-MIGRATION', area: 'Database', title: 'a multi-statement migration: tables, FK, CHECK, default, index', evidence: golden('builds its accounts schema with a foreign key, a CHECK, a default and an index') },
  { id: 'DB-TABLE-CHECKS', area: 'Database', title: 'CREATE of an existing table and ALTER of a missing one refused', evidence: migration('refuses CREATE TABLE for a table that exists', 'refuses ALTER TABLE on a table that does not exist', 'lets a migration alter a table it creates earlier') },
  { id: 'DB-ADD-COLUMN', area: 'Database', title: 'ADD COLUMN applies NOT NULL, DEFAULT and UNIQUE as declared', evidence: migration('ADD COLUMN applies what it declares') },
  { id: 'DB-QUERY', area: 'Database', title: 'run_query with a join and GROUP BY', evidence: golden('reads them back with a join') },
  { id: 'DB-WRITE', area: 'Database', title: 'db_insert and db_update', evidence: golden('writes rows, refuses a table-wide update and a CHECK violation') },
  { id: 'DB-DELETE', area: 'Database', title: 'db_delete by filter', evidence: gap('DB-DELETE') },
  { id: 'DB-TYPES', area: 'Database', title: 'generate_types from the live catalog', evidence: golden('generates types for the tables it built') },
  { id: 'DB-VALIDATION', area: 'Database', title: 'row-tool arguments validated the same on every surface', evidence: unit('mcp-db-tool-requests.spec.ts', 'refuse the same calls with the same answer', 'through both MCP transports') },
  { id: 'DB-EMPTY-FILTER', area: 'Database', title: 'a table-wide update or delete is refused', evidence: golden('refuses a table-wide update') },
  { id: 'DB-RUNTIME-STAGING', area: 'Database', title: 'the runtime /db plane (PostgREST) serves the contract', evidence: live(['CONTRACT-4-runtime-api'], 'CONTRACT-4-runtime-api passes.', 'The /db data plane is PostgREST behind the runtime; CI has no PostgREST.') },

  // ── Auth ───────────────────────────────────────────────────────────────────
  { id: 'AUTH-ENABLE', area: 'Auth', title: 'enable auth and teams', evidence: golden('turns on end-user auth and teams') },
  { id: 'AUTH-STATE', area: 'Auth', title: 'auth email state, for a read-only key too', evidence: ops('shows the sender and the three templates, for a read-only key too') },
  { id: 'AUTH-ADMIN', area: 'Auth', title: 'list users; blocking a user waits for a human', evidence: gap('AUTH-ADMIN') },
  { id: 'AUTH-SETTINGS', area: 'Auth', title: 'templates and SMTP, secrets never returned', evidence: ops('saves a template and puts the default back', 'stores the password and never returns it', 'refuses a template without the link it exists to deliver') },
  { id: 'AUTH-PROVIDER', area: 'Auth', title: 'an OAuth provider configured with real credentials', evidence: staging({
    command: 'npx -y @backenly/cli@0.2.0 call auth action=add_oauth_provider provider=github clientId="$GITHUB_OAUTH_CLIENT_ID" clientSecret="$GITHUB_OAUTH_CLIENT_SECRET" && npx -y @backenly/cli@0.2.0 call read_backend_state section=users',
    env: ['BACKENLY_API_URL', 'BACKENLY_PROJECT_ID', 'BACKENLY_MCP_KEY', 'GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET'],
    preconditions: `${THROWAWAY} ${CLI_READY} A GitHub OAuth app whose callback is the staging project's /auth/github callback.`,
    expected: 'add_oauth_provider answers ok and the secret is never echoed; GET /api/v1/{projectId}/auth/github redirects to github.com with the client id.',
    cleanup: 'npx -y @backenly/cli@0.2.0 call auth action=remove_oauth_provider provider=github (parks for approval), or delete the throwaway project.',
    why: 'Needs a real OAuth app and the deployed callback URL.',
  }) },

  // ── RLS ────────────────────────────────────────────────────────────────────
  { id: 'RLS-CUSTOM', area: 'RLS', title: 'set_rls installs exact predicates', evidence: golden('locks account members to themselves with exact RLS') },
  { id: 'RLS-ALLOW', area: 'RLS', title: 'an end-user reads their own row', evidence: gap('RLS-ALLOW') },
  { id: 'RLS-DENY', area: 'RLS', title: 'another end-user and an anonymous caller are denied', evidence: gap('RLS-DENY') },
  { id: 'RLS-READ-ONLY', area: 'RLS', title: 'a read-only key cannot change a policy', evidence: gap('RLS-READ-ONLY') },

  // ── Storage ────────────────────────────────────────────────────────────────
  { id: 'STORAGE-CREATE-LIST', area: 'Storage', title: 'create a private bucket and list it', evidence: golden('creates a private bucket for attachments') },
  { id: 'STORAGE-CLEANUP', area: 'Storage', title: 'deleting a bucket waits for a human, and a rejection deletes nothing', evidence: gap('APPROVAL-REJECT') },
  { id: 'STORAGE-SIGNED-URL', area: 'Storage', title: 'a signed URL for an uploaded file downloads it', evidence: staging({
    command:
      'curl -sS -X POST "$BACKENLY_API_URL/api/v1/$BACKENLY_PROJECT_ID/storage/upload" -H "x-api-key: $BACKENLY_RUNTIME_KEY" -F bucket=gate -F path=gate/README.md -F file=@README.md && ' +
      'npx -y @backenly/cli@0.2.0 call storage action=signed_url bucketName=gate path=gate/README.md',
    env: ['BACKENLY_API_URL', 'BACKENLY_PROJECT_ID', 'BACKENLY_MCP_KEY', 'BACKENLY_RUNTIME_KEY'],
    preconditions: `${THROWAWAY} ${CLI_READY} A private bucket named gate (storage action=create_bucket bucketName=gate) and a runtime key.`,
    expected: 'signed_url answers a URL; fetching it returns the file with HTTP 200; fetching the object without the signature does not.',
    cleanup: 'storage action=delete_bucket bucketName=gate parks for approval; approve it, or delete the throwaway project.',
    why: 'Cloud storage is native S3 through the task role; only the deployed image has it.',
  }) },

  // ── Functions ──────────────────────────────────────────────────────────────
  { id: 'FN-INSPECT', area: 'Functions', title: 'get a function in full, for a read-only key too', evidence: ops('reads one in full by name, for a read-only key too') },
  { id: 'FN-DEPLOY-CODE', area: 'Functions', title: 'deploy agent-written code exactly as written, both contracts', evidence: ops('deploys an http route module exactly as written', 'deploys a sandbox body that reads this project') },
  { id: 'FN-DEPLOY-REFUSED', area: 'Functions', title: 'code that cannot run, keys in code, and read-only keys refused', evidence: unit('function-deploy-code.spec.ts', 'refused before anything is stored', 'the sandbox worker answers for sandbox bodies') },
  { id: 'FN-INVOKE', area: 'Functions', title: 'invoke returns the answer, return value and log lines', evidence: ops('runs one and returns its answer, return value and log lines') },
  { id: 'FN-LOGS-SUCCESS', area: 'Functions', title: 'a successful run is in the logs', evidence: ops('deploys an http route module exactly as written, runs it, and records the run') },
  { id: 'FN-LOGS-FAILURE', area: 'Functions', title: 'a failed run is in the logs with its error and log lines', evidence: ops('records a failing run with its error and log lines') },
  { id: 'FN-ISOLATION', area: 'Functions', title: 'function SQL reaches its own tables and none of the platform\'s', evidence: ops('reaches this project', 'cannot reach another project') },
  { id: 'FN-ENV-ISOLATION', area: 'Functions', title: 'process.env carries no platform secret', evidence: unit('function-deploy-code.spec.ts', 'holds the project\'s own values and none of the platform\'s') },
  { id: 'FN-STAGING', area: 'Functions', title: 'deploy_code isolation on RDS with function-roles.sql installed', evidence: live(['STAGING-deploy-code-isolation'], 'STAGING-deploy-code-isolation passes: the probe function is refused public.users with permission denied.', 'The project function role is created by scripts/sql/function-roles.sql on RDS; only the final staging database has it installed.') },

  // ── Realtime ───────────────────────────────────────────────────────────────
  { id: 'RT-ENABLE', area: 'Realtime', title: 'enable a table and see it streaming', evidence: golden('streams the messages table, and says so') },
  { id: 'RT-DISABLE-GOVERNED', area: 'Realtime', title: 'disabling waits for a human', evidence: golden('asks a human before it stops streaming a table') },
  { id: 'RT-DELIVERY', area: 'Realtime', title: 'an insert arrives as an SSE event', evidence: staging({
    command:
      'T=$(curl -sS -X POST "$BACKENLY_API_URL/api/v1/$BACKENLY_PROJECT_ID/realtime/ticket" -H "x-api-key: $BACKENLY_RUNTIME_KEY" | jq -r .ticket) && ' +
      '(curl -sN "$BACKENLY_API_URL/api/v1/$BACKENLY_PROJECT_ID/realtime/subscribe?table=messages&ticket=$T" -H "accept: text/event-stream" --max-time 20 > sse.log &) && sleep 3 && ' +
      'npx -y @backenly/cli@0.2.0 call db_insert table=messages \'row={"room":"gate","body":"hello","author_id":"00000000-0000-4000-8000-000000000001"}\' && sleep 5 && grep \'"type":"insert"\' sse.log',
    env: ['BACKENLY_API_URL', 'BACKENLY_PROJECT_ID', 'BACKENLY_MCP_KEY', 'BACKENLY_RUNTIME_KEY'],
    preconditions: `${THROWAWAY} ${CLI_READY} A messages table with realtime enabled (the golden chat workflow's steps), and a runtime key.`,
    expected: 'sse.log contains a connected event and then an insert event for the row.',
    cleanup: 'None beyond the throwaway project.',
    why: 'Delivery runs through the runtime container\'s LISTEN hub and the ALB; CI runs neither.',
  }) },

  // ── Integrations ───────────────────────────────────────────────────────────
  { id: 'INT-CAPABILITIES', area: 'Integrations', title: 'the exact methods a function can call, never a key', evidence: ops('names the exact methods a function can call, and never a key') },
  { id: 'INT-VALIDATION', area: 'Integrations', title: 'unknown providers refused; verify is a write', evidence: ops('answers for one provider, and refuses one that does not exist', 'does not let a read-only key re-check') },
  { id: 'INT-VERIFY-HONEST', area: 'Integrations', title: 'verify records the honest answer, and says when nothing is stored', evidence: ops('re-asks about a stored key and records the honest answer', 'says there is nothing to verify when no key is stored') },
  { id: 'INT-STRIPE', area: 'Integrations', title: 'Stripe: connect and verify a test key, signing secret stored', evidence: connect('stripe', 'STRIPE_TEST_SECRET_KEY', ' webhookSecret="$STRIPE_TEST_WEBHOOK_SECRET"') },
  { id: 'INT-RESEND', area: 'Integrations', title: 'Resend: connect and verify', evidence: connect('resend', 'RESEND_TEST_API_KEY') },
  { id: 'INT-OPENAI', area: 'Integrations', title: 'OpenAI: connect and verify', evidence: connect('openai', 'OPENAI_TEST_API_KEY') },
  { id: 'INT-ANTHROPIC', area: 'Integrations', title: 'Anthropic: connect and verify', evidence: connect('anthropic', 'ANTHROPIC_TEST_API_KEY') },
  { id: 'INT-POSTHOG', area: 'Integrations', title: 'PostHog: connect, stored as unverifiable', evidence: connect('posthog', 'POSTHOG_TEST_PROJECT_KEY') },

  // ── Webhooks ───────────────────────────────────────────────────────────────
  { id: 'WH-CREATE', area: 'Webhooks', title: 'create: the secret once, in data only', evidence: ops('creates one, returning the secret once in data and never in the summary', 'refuses a destination the egress guard blocks') },
  { id: 'WH-INSPECT', area: 'Webhooks', title: 'list and delivery logs, secret withheld', evidence: ops('lists it for a read-only key too, without the secret', 'shows the deliveries, newest first') },
  { id: 'WH-DELIVERY', area: 'Webhooks', title: 'a real signed test delivery, and a refused one recorded as FAILED', evidence: ops('sends a real test delivery the receiver can verify with the secret', 'reports a receiver that refuses as a failed delivery') },
  { id: 'WH-REPLAY', area: 'Webhooks', title: 'replay a failed delivery; never a delivered one or a disabled endpoint', evidence: ops('sends a failed delivery again as a new attempt', 'refuses to send a delivered event twice', 'refuses to replay to a disabled endpoint') },
  { id: 'WH-DELETE-GOVERNED', area: 'Webhooks', title: 'delete parks for a human and runs exactly that call once approved', evidence: ops('parks a delete for a human, deletes nothing, and runs exactly that call once approved') },

  // ── Monitoring ─────────────────────────────────────────────────────────────
  { id: 'MON-METRICS', area: 'Monitoring', title: 'metrics and request logs answer for the project', evidence: golden('reads its monitoring: request logs and metrics answer for this project') },
  { id: 'MON-REQUEST-LOGS', area: 'Monitoring', title: 'request logs: the project\'s runtime traffic only, filterable', evidence: ops('returns only the project runtime traffic, never the platform routes', 'narrows to failures') },
  { id: 'MON-FUNCTION-LOGS', area: 'Monitoring', title: 'function runs, failures with their error', evidence: ops('shows the runs, failures with their error') },
  { id: 'MON-USAGE', area: 'Monitoring', title: 'usage and incidents', evidence: gap('MON-USAGE') },
  { id: 'MON-ALERT-NOT-OFFERED', area: 'Monitoring', title: 'no alert action is offered while nothing evaluates alerts', evidence: gap('MON-ALERT-NOT-OFFERED') },
  { id: 'MON-ALERTS', area: 'Monitoring', title: 'alert operations', evidence: skip('No alert evaluator exists: set_alert stored alerts nothing read, so it was removed from the MCP surface (#135). Comes back with an evaluator.') },

  // ── Autonomy ───────────────────────────────────────────────────────────────
  { id: 'AUTO-STATUS-LEVEL', area: 'Autonomy', title: 'status, findings, and a level a read-only key cannot set', evidence: gap('AUTONOMY-STATUS-LEVEL') },
  { id: 'AUTO-APPROVAL', area: 'Autonomy', title: 'destructive and high-risk actions park for a human', evidence: unit('mcp-domain-tools.spec.ts', 'sends every destructive target to approval', 'sends every target the executor rates high risk to approval', 'parks a high-risk action the brain does not call destructive') },

  // ── Branches ───────────────────────────────────────────────────────────────
  { id: 'BRANCH-LIFECYCLE', area: 'Branches', title: 'create, diff, merge, and discard through approval', evidence: staging({
    command:
      'npx -y @backenly/cli@0.2.0 call branch action=create name=gate && npx -y @backenly/cli@0.2.0 call branch action=list && ' +
      'npx -y @backenly/cli@0.2.0 call branch action=diff branchId=<id from list> && npx -y @backenly/cli@0.2.0 call branch action=merge branchId=<id>',
    env: ['BACKENLY_API_URL', 'BACKENLY_PROJECT_ID', 'BACKENLY_MCP_KEY'],
    preconditions: `${THROWAWAY} ${CLI_READY} The Cloud edition (branches are Backenly Cloud).`,
    expected: 'create answers a branch that starts empty; diff lists what differs; merge applies it; a key bound to the merged branch is then refused with BRANCH_INACTIVE.',
    cleanup: 'backend_chat "discard branch gate" parks for approval; approve it, or delete the throwaway project.',
    why: 'Branch provisioning is part of the Cloud composition; the public CI builds the unset edition.',
  }) },

  // ── Deploy ─────────────────────────────────────────────────────────────────
  { id: 'DEPLOY-READINESS', area: 'Deploy', title: 'readiness is a read, even when asked to fix', evidence: unit('mcp-readiness-is-a-read.spec.ts', 'fixes nothing when read through read_backend_state', 'fixes nothing from a read-only key, even when asked to') },
  { id: 'DEPLOY-READINESS-DB', area: 'Deploy', title: 'readiness changes nothing in the database', evidence: golden('reads readiness without changing anything, even from a read-only key') },
  { id: 'DEPLOY-REQUEST', area: 'Deploy', title: 'a deploy waits for a human, and a read-only key cannot ask', evidence: golden('asks a human before it deploys, and the read-only key cannot even ask') },
  { id: 'DEPLOY-STATUS-HISTORY', area: 'Deploy', title: 'status and history', evidence: ops('says plainly that nothing is published yet', 'lists published versions newest first') },
  { id: 'DEPLOY-ROLLBACK-EXACT', area: 'Deploy', title: 'a rollback parks with exactly the arguments sent', evidence: gap('DEPLOY-ROLLBACK-EXACT') },
  { id: 'DEPLOY-STAGING', area: 'Deploy', title: 'an approved deploy and rollback on the deployed pipeline', evidence: staging({
    command: 'npx -y @backenly/cli@0.2.0 call deploy action=deploy ; npx -y @backenly/cli@0.2.0 call check_approval id=<approval id>',
    env: ['BACKENLY_API_URL', 'BACKENLY_PROJECT_ID', 'BACKENLY_MCP_KEY'],
    preconditions: `${THROWAWAY} ${CLI_READY} A human who can approve on the project's Autonomy page.`,
    expected: 'deploy parks with an approval id; after approval check_approval reports executed and deploy action=history lists the version; a rollback approval returns to the earlier version.',
    cleanup: 'None beyond the throwaway project.',
    why: 'Publishing runs the real deployment pipeline, which exists only on the deployed stack.',
  }) },

  // ── Connect ────────────────────────────────────────────────────────────────
  { id: 'CONNECT-WHOAMI', area: 'Connect', title: 'whoami names the bound project and the calling key', evidence: ops('names the bound project and the calling key, from the database', 'reports a read-only key as read-only') },
  { id: 'CONNECT-STATE', area: 'Connect', title: 'keys listed without their secrets', evidence: gap('CONNECT-STATE') },
  { id: 'CONNECT-DISCONNECT', area: 'Connect', title: 'disconnecting a frontend waits for a human', evidence: gap('CONNECT-DISCONNECT-GOVERNED') },

  // ── Approvals ──────────────────────────────────────────────────────────────
  { id: 'APPR-EXACT-STORED', area: 'Approvals', title: 'the exact call is stored', evidence: unit('mcp-domain-tools.spec.ts', 'parks a destructive action with the exact call and runs nothing') },
  { id: 'APPR-EXACT-REPLAY', area: 'Approvals', title: 'the approved call runs verbatim', evidence: gap('APPROVAL-EXACT-REPLAY and KEY-REVOKED') },
  { id: 'APPR-REJECT', area: 'Approvals', title: 'a rejection runs nothing', evidence: gap('APPROVAL-REJECT') },
  { id: 'APPR-FAILED', area: 'Approvals', title: 'a failed execution is reported as failed', evidence: unit('mcp-domain-tools.spec.ts', 'reports a failed call as failed', 'does not call it executed when the executor only asked for another confirmation') },
  { id: 'APPR-TIMEOUT', area: 'Approvals', title: 'an expired request reports expired and can no longer be approved', evidence: gap('APPROVAL-TIMEOUT') },
  { id: 'APPR-OVERRUN', area: 'Approvals', title: 'a thrown or overrunning approved call is failed, not hung', evidence: unit('mcp-domain-tools.spec.ts', 'reports a thrown or overrunning call as failed rather than hanging') },
  { id: 'APPR-NO-LLM', area: 'Approvals', title: 'no model re-reads the approved call', evidence: unit('mcp-domain-tools.spec.ts', 'runs the exact call with destructive confirmation') },

  // ── Failure recovery ───────────────────────────────────────────────────────
  { id: 'FAIL-PARTIAL', area: 'Failure recovery', title: 'a migration that stops part-way says what applied and what remains', evidence: gap('FAIL-PARTIAL') },
  { id: 'FAIL-MISSING-TABLE', area: 'Failure recovery', title: 'a statement on a missing table is refused before anything runs', evidence: gap('FAIL-MISSING-TABLE') },
  { id: 'FAIL-NETWORK', area: 'Failure recovery', title: 'a paused project is answered once and not retried; an ordinary 503 is retried', evidence: unit('project-pause-surfaces.spec.ts', 'answers once, with the code and where to resume', 'still retries an ordinary 503') },
  { id: 'FAIL-MALFORMED', area: 'Failure recovery', title: 'malformed arguments refused with the arguments that exist', evidence: unit('mcp-db-tool-requests.spec.ts', 'UNKNOWN_PARAMS', 'UNSUPPORTED_PARAMS') },
  { id: 'FAIL-PROVIDER', area: 'Failure recovery', title: 'a provider that refuses is recorded as a failure, never a green tick', evidence: ops('refuses SMTP settings that cannot authenticate', 'reports a test send that fails, and records the failure instead of a green tick') },
  { id: 'FAIL-CONSTRAINT', area: 'Failure recovery', title: 'a CHECK violation is refused', evidence: golden('refuses a table-wide update and a CHECK violation') },
  { id: 'FAIL-REVOKED-KEY', area: 'Failure recovery', title: 'a revoked key fails closed', evidence: gap('APPROVAL-EXACT-REPLAY and KEY-REVOKED') },
  { id: 'FAIL-CATALOG-BOOTSTRAP', area: 'Failure recovery', title: 'the stdio package recovers when the catalog fetch fails', evidence: pkg('catalog-recovery.test.mjs: a degraded catalog is served, then replaced and announced with list_changed') },

  // ── Golden workflows ───────────────────────────────────────────────────────
  { id: 'GOLDEN-SAAS-1', area: 'Golden workflows', title: 'SaaS backend, run 1', evidence: golden('golden workflow: a SaaS backend (run 1)') },
  { id: 'GOLDEN-SAAS-2', area: 'Golden workflows', title: 'SaaS backend, run 2', evidence: golden('golden workflow: a SaaS backend (run 2)') },
  { id: 'GOLDEN-CHAT-1', area: 'Golden workflows', title: 'Realtime chat backend, run 1', evidence: golden('golden workflow: a realtime chat backend (run 1)') },
  { id: 'GOLDEN-CHAT-2', area: 'Golden workflows', title: 'Realtime chat backend, run 2', evidence: golden('golden workflow: a realtime chat backend (run 2)') },
  { id: 'GOLDEN-STAGING', area: 'Golden workflows', title: 'the live harness golden workflow and guards on final staging', evidence: live(['GOLDEN-expense-tracker', 'CONTRACT-1-named-tools-exist', 'CONTRACT-3-mutation-guardrails', 'CONTRACT-5-destructive-refused', 'CONTRACT-6-ship-tools', 'STAGING-migration-table-checks'], 'Every listed harness case passes; the run exits 0.', 'Runs the same guards against the deployed stack, including PostgREST and the runtime container.') },

  // ── Docs ───────────────────────────────────────────────────────────────────
  { id: 'DOCS-CONFORMANCE', area: 'Docs', title: 'every claim in the agent docs held to the code', evidence: unit('agent-docs-conformance.spec.ts', 'the generated tables are what the code says', 'every call the docs show is one that exists', 'what the docs say functions can call', 'what the docs say about access', 'what the docs no longer carry') },
  { id: 'DOCS-FETCH', area: 'Docs', title: 'fetch_docs serves each topic as its own file', evidence: unit('agent-docs-conformance.spec.ts', 'fetch_docs serves the topic asked for') },
  { id: 'DOCS-STAGING', area: 'Docs', title: 'the deployed image serves the index and topics', evidence: live(['STAGING-docs-topics'], 'STAGING-docs-topics passes.', 'Proves public/docs/agents reached the standalone image.') },
]
