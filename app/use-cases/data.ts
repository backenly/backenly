/**
 * Use cases — workflows, not audience segments.
 *
 * A page here has to survive one test: does it describe a real problem and a
 * real sequence of things the platform does about it? "For startups" and "for
 * side projects" are not use cases, they are demographics, and the pages that
 * were shaped that way could only be filled with adjectives.
 *
 * Every entry therefore carries the shape below, and the two fields that keep
 * it honest are `responsibility.you` and `limitations`. A use case that cannot
 * name what stays the developer's problem, or where the platform stops, is a
 * brochure and should not ship.
 *
 * Claims here must be checkable in this repository. `capabilities` names the
 * actual tools, routes, and modules involved so a reader can go and look.
 */

export type UseCaseData = {
  slug: string
  /** Short label for cards, chips, and breadcrumbs. */
  label: string
  metaTitle: string
  metaDescription: string
  headline: string
  subheadline: string
  /** One line each — rendered in the hero's proof row. */
  who: string
  alreadyHave: string
  need: string
  /** The situation. */
  problem: string
  normallyBuild: string
  /** The mechanism, as an ordered sequence. */
  workflow: { label: string; title: string; body: string }[]
  code?: { language: string; label: string; code: string }
  result: string
  responsibility: { platform: string[]; you: string[] }
  capabilities: { name: string; detail: string }[]
  limitations: string[]
  faq: { q: string; a: string }[]
}

const LIST: UseCaseData[] = [
  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'ai-assisted-developers',
    label: 'Agent-driven development',
    metaTitle: 'Drive a real backend from Claude Code or Cursor — Backenly',
    metaDescription:
      'Give your coding agent a live schema to read and a governed surface to write through: 20 MCP tools, destructive operations blocked at the key scope and routed to human approval, and a change ledger that outlives the session.',
    headline: 'Give your agent a backend it cannot guess at',
    subheadline:
      'Your agent writes the frontend against real tables, applies schema changes through a governed kernel, and structurally cannot drop a table on a bad turn.',
    who: 'Developers using Claude Code, Cursor, or Codex',
    alreadyHave: 'A frontend and an agent in the editor',
    need: 'A live schema and safe writes',
    problem:
      'Ask an agent for a full-stack feature without giving it a backend and it invents one. It writes fetch calls to endpoints that do not exist, defines response types nothing returns, and mocks the data so the UI renders. The frontend works the way a film set works. Then the session ends, and everything the agent knew about the schema ends with it — the next session re-derives it, slightly differently.',
    normallyBuild:
      'A schema and its migrations, REST or GraphQL handlers, auth middleware and session handling, row-level authorization on every query path, a deploy pipeline, and enough monitoring to know when one of them breaks. Then you own all of it, including the parts the agent wrote and will not remember writing.',
    workflow: [
      {
        label: 'Connect',
        title: 'One command, one scoped key, one restart',
        body: 'Local over stdio or remote over Streamable-HTTP. The key is scoped to a single project and revocable, and can be minted read-only, which withholds every write door including backend_chat.',
      },
      {
        label: 'Read',
        title: 'Your agent grounds itself in the real schema',
        body: 'read_backend_state for the project, get_table_schema for one table — which returns column types, foreign keys with their ON DELETE behaviour, indexes, and CHECK constraints with their permitted values. An agent that has not read those writes an insert that looks correct and fails on a constraint it had no way to see.',
      },
      {
        label: 'Write',
        title: 'Schema changes as ordinary DDL',
        body: 'apply_migration takes CREATE TABLE, ALTER TABLE, and CREATE INDEX, applies them as written, and translates them into governed typed actions. Anything it cannot map is refused with the route forward rather than silently dropped. Row changes go through db_insert, db_update, and db_delete.',
      },
      {
        label: 'Refuse',
        title: 'Destructive operations never execute over MCP',
        body: 'They are absent from the advertised surface. A request to drop a table parks in the Review Queue with an approval id; the dashboard card shows the target and the live row count. Your agent polls check_approval, whose terminal statuses distinguish failed — nothing applied, safe to retry — from partial.',
      },
      {
        label: 'Type',
        title: 'Generated types instead of hand-written ones',
        body: 'generate_types reads the live catalog and carries a schema hash, so you can tell whether a regeneration actually changed anything. The CLI\'s diff command exits non-zero when committed types drift from the schema, which makes it a CI gate.',
      },
    ],
    code: {
      language: 'text',
      label: 'What agent-to-backend looks like',
      code: `You:   What tables does this project have?
Agent: (read_backend_state) users, recipes, follows, favorites —
       with columns, types, and relations from the live schema.

You:   Add a saved_searches table with user_id and query.
Agent: (apply_migration) Applied. The table is served at
       /db/saved_searches immediately — no generation step.

You:   Drop the users table.
Agent: Not available over MCP. Sent to the Review Queue as
       approval a1f3… — 1,284 live rows. Approve in the dashboard.`,
    },
    result:
      'A backend that outlives the session and a record of how it got there. The agent reads real field names, so its integration code compiles against something that exists; the change ledger explains what happened last Tuesday and why, whether you or the agent did it.',
    responsibility: {
      platform: [
        'Serves the tool manifest and enforces key scope on every call.',
        'Applies every structural change through one audited kernel.',
        'Refuses destructive operations over MCP and routes them to human approval.',
        'Keeps the schema, the change history, and the verification evidence after the session ends.',
      ],
      you: [
        'Restart the MCP host after installing — the tools do not exist until it reconnects.',
        'Approve or reject anything that reaches the Review Queue.',
        'Own the frontend, the product decisions, and whether a proposed schema is the right one.',
        'Keep the scoped key out of the repository.',
      ],
    },
    capabilities: [
      { name: 'MCP server', detail: '20 advertised tools over stdio or Streamable-HTTP; the dispatcher stays wider so pinned clients keep working.' },
      { name: 'get_table_schema', detail: 'Columns, foreign keys with ON DELETE, indexes, CHECK constraints with permitted values, and live RLS policies with their roles.' },
      { name: 'apply_migration', detail: 'Ordinary PostgreSQL DDL, applied as written and translated into governed actions. All-or-nothing.' },
      { name: 'check_approval', detail: 'Polls an escalated operation: pending, executed, partial, failed, rejected, expired.' },
      { name: 'generate_types', detail: 'TypeScript declarations or a typed client from the live catalog, with a schema hash.' },
      { name: 'Read-only keys', detail: 'A reduced manifest; a write call is refused with READ_ONLY_KEY before anything runs.' },
    ],
    limitations: [
      'MCP hosts read their manifest at process start. Tools are absent from the session that installed them until the host restarts — this is the single most common "it did not work" report, and it is not a bug.',
      'The advertised surface is capped at 20 tools on purpose. Capabilities beyond it — preview-branch discard, vector search, schema adoption — are reached by describing them to backend_chat rather than by a named tool.',
      'There is no raw-SQL path for mutating structure. Operations the migration parser cannot map are refused rather than passed through.',
      'Backenly exposes no SQL functions, so there is no rpc() surface. Custom logic runs as an event, cron, or HTTP function.',
    ],
    faq: [
      {
        q: 'Which agents work with this?',
        a: 'Anything that speaks MCP. Claude Code, Cursor, Codex, Cline, and Claude Desktop are the ones with tested setup paths, and the Connect tab renders the exact config for each. Two transports are available: the npm package over stdio, or a remote Streamable-HTTP endpoint with nothing to install.',
      },
      {
        q: 'Can my agent break production?',
        a: 'It cannot execute a destructive operation. Those tools are not on the MCP surface, so a request to drop or truncate returns an approval id instead of a result and waits for a human in the dashboard. Non-destructive changes it can make are applied through the governed kernel and recorded, and schema changes capture a snapshot before they run.',
      },
      {
        q: 'What happens to my types when the schema changes?',
        a: 'Regenerate them with generate_types or the CLI. If you commit generated types, wire `backenly diff` into CI — it exits non-zero when the committed types no longer match the live schema, which turns silent drift into a failed build.',
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'founders',
    label: 'Adopting an existing backend',
    metaTitle: 'Put governance under a backend your AI tools already built — Backenly',
    metaDescription:
      'Bring an existing PostgreSQL backend under governance without rebuilding it: direct connection strings, drift adoption that registers tables without executing DDL, verified isolation, and a monitoring loop.',
    headline: 'Your prototype has users. Nobody is operating it.',
    subheadline:
      'Bring an existing schema under governance — REST, policies, monitoring, and an audit trail — without a rewrite and without giving up direct database access.',
    who: 'Teams whose AI-built product now has real users',
    alreadyHave: 'A working product and live data',
    need: 'An operator, not a rebuild',
    problem:
      'The tools that got you here optimised for generating, not operating. A builder provisioned a database, an agent wrote the schema in bulk, and it worked. Now there are real users, real rows, and real consequences, and nobody owns the migration that breaks, the policy that leaks, or the error spike at 2 a.m. The thing that made you fast quietly made you on-call.',
    normallyBuild:
      'Either you hire the operator, or you rebuild on something governed and pay for the migration in downtime and lost data fidelity. Both are expensive at exactly the moment the product starts working.',
    workflow: [
      {
        label: 'Connect',
        title: 'Take a direct connection string',
        body: 'get_database_credentials returns a real PostgreSQL connection string for the project schema. Read-only is SELECT-only and provisions on request with no human in the loop. Read-write is returned only after the project owner arms it in the dashboard, and every response reports whether write access exists so an agent can check without requesting it.',
      },
      {
        label: 'Migrate',
        title: 'Run your own migrations if you want to',
        body: 'psql, an ORM, your existing migration tool. DDL you run over the read-write connection is observed by the drift watch rather than fought.',
      },
      {
        label: 'Adopt',
        title: 'Reconcile the schema into the governed contract',
        body: 'adopt_external_schema registers new tables with their REST surface, RLS, and realtime, refreshes altered ones, prunes dropped ones, re-baselines the schema snapshot, and re-syncs grants. It is bookkeeping only and never executes DDL.',
      },
      {
        label: 'Verify',
        title: 'Prove the access rules actually hold',
        body: 'The isolation check creates a second end-user, signs in, and asserts they receive zero of the first user\'s rows. On an inherited backend this is usually the first time anyone has tested that behaviourally rather than reading the policy text.',
      },
      {
        label: 'Operate',
        title: 'The loop takes the night shift',
        body: 'One-minute cadence on every plan. It applies the reversible safe band and queues auth, credential, and destructive changes for you, with a receipt and an undo where the engine can honour one.',
      },
    ],
    result:
      'The same PostgreSQL, now with a REST surface derived from the catalog, policies you can read, verified isolation, monitoring on real traffic, and a change ledger. When an engineer joins, they inherit standard Postgres and REST with a history — not a mystery. `pg_dump` still works, in both directions.',
    responsibility: {
      platform: [
        'Provisions scoped Postgres roles through SECURITY DEFINER functions, read-write only after a human arms it.',
        'Reconciles out-of-band DDL into the governed contract without executing DDL itself.',
        'Verifies cross-user isolation behaviourally and shows the evidence.',
        'Monitors real traffic and repairs the reversible safe band, with everything else queued.',
      ],
      you: [
        'The data migration itself, and choosing when to cut over.',
        'Re-authoring access rules that were previously enforced in application code.',
        'Approving anything the loop queues rather than letting it sit.',
        'Product decisions — the loop fixes operational problems, not product ones.',
      ],
    },
    capabilities: [
      { name: 'get_database_credentials', detail: 'Read-only on demand; read-write only after the owner arms it in the dashboard. Carries readWriteArmed and an arming URL.' },
      { name: 'adopt_external_schema', detail: 'Registers, refreshes, and prunes to match reality. Never emits DDL. Dispatchable but not advertised — ask for it by name.' },
      { name: 'Drift watch', detail: 'Observes schema changes made outside the governed path so they can be reconciled rather than silently diverging.' },
      { name: 'Behavioural verification', detail: 'CRUD lifecycle, auth flow, two-user RLS isolation, and live HTTP checks, each returned with its evidence.' },
      { name: 'Autonomy loop', detail: 'One-minute cadence on every plan, uncapped, applying only reversible snapshotted changes on its own.' },
      { name: 'pg_dump export', detail: 'Full export of your workspace schema at any time, so adoption is reversible.' },
    ],
    limitations: [
      'Adoption is reconciliation, not a migration tool. Moving the data is your job; Backenly makes the resulting schema governed.',
      'adopt_external_schema is not on the advertised 20-tool surface. Reach it through backend_chat by name.',
      'Structure mutates only through governed actions afterwards. If your workflow depends on arbitrary DDL from application code, that path is closed by design.',
      'Deployment rollback and full deployment history are plan-gated and not available on Free. Check the pricing page before relying on them.',
      'The autonomy loop sweeps a project that shows a sign of life within 30 days — traffic, a governed change, or a conversation. A completely dormant project is not being checked.',
    ],
    faq: [
      {
        q: 'Do I have to rewrite my frontend?',
        a: 'No. Your tables are served over REST from the catalog, and if the frontend was written against supabase-js there is a compatibility entry point that emits PostgREST directly. What usually does change is authorization: rules previously enforced in application code become row-level security policies in the database.',
      },
      {
        q: 'Can I still use psql and my own migration tool?',
        a: 'Yes. Take a read-write connection string once the owner arms it, run your migrations, then reconcile with adopt_external_schema so the platform and your schema agree. If you only need to inspect or export, a read-only string is provisioned on request without any arming step.',
      },
      {
        q: 'What if I want to leave?',
        a: 'Take a full pg_dump of your workspace schema whenever you want. The platform is also open source under Apache-2.0, so self-hosting the same codebase is an option rather than a negotiation.',
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'migrate-from-supabase',
    label: 'Moving from Supabase',
    metaTitle: 'Point a supabase-js frontend at Backenly',
    metaDescription:
      'A supabase-js frontend keeps working: the compatibility entry point emits PostgREST directly, so filters, embeds, upsert onConflict, exact counts, and postgres_changes all behave. What differs, and what is refused.',
    headline: 'Keep the client. Change what operates it.',
    subheadline:
      'Backenly\'s data plane is PostgREST, so a supabase-js frontend keeps its query grammar. What you gain is the governed change path and the autonomy loop.',
    who: 'Teams on Supabase who want the operator, not a new client',
    alreadyHave: 'A supabase-js frontend and a Postgres schema',
    need: 'Governance without a frontend rewrite',
    problem:
      'Supabase is good infrastructure, which is exactly the issue when nobody on the team wants to own schema design, migrations, and RLS review. The assembly and the upkeep are yours. Switching platforms normally means rewriting every call site, which is why teams stay past the point where it is working for them.',
    normallyBuild:
      'A rewrite of every data call, a new auth integration, a re-derivation of every security policy in a different dialect, and a migration window long enough to do all three.',
    workflow: [
      {
        label: 'Swap',
        title: 'Change the import and the client construction',
        body: 'The compatibility entry point is built on the v2 surface, which passes PostgREST\'s grammar through untouched. It emits PostgREST rather than translating into a narrower dialect, which is why it is complete rather than approximate.',
      },
      {
        label: 'Keep',
        title: 'Filters, embeds, upsert, and counts behave',
        body: 'or(), select(\'*, author(*)\') embeds, overlaps(), upsert with onConflict, and count: \'exact\' via Content-Range. Every operation resolves { data, error } and never throws, which is the convention the frontend is written against.',
      },
      {
        label: 'Move',
        title: 'Bring the data and re-author the policies',
        body: 'pg_dump in, then take a connection string and run your migrations, then reconcile with adopt_external_schema. Policies are re-authored in Backenly\'s claim form, where set_rls installs your predicate verbatim and reads pg_policies back before reporting success.',
      },
      {
        label: 'Gain',
        title: 'The part that was not on offer before',
        body: 'A governed mutation kernel, behavioural verification after changes, and a loop that monitors and repairs without being asked.',
      },
    ],
    code: {
      language: 'js',
      label: 'The client swap',
      code: `// before
import { createClient } from '@supabase/supabase-js'
const supabase = createClient('https://xyz.supabase.co', SUPABASE_ANON_KEY)

// after
import { createClient } from '@backenly/sdk/supabase'
const supabase = createClient(
  'https://backenly.com/api/v1/<PROJECT_ID>',
  BACKENLY_ANON_KEY,
)

// unchanged — this is PostgREST on both sides
const { data, error } = await supabase
  .from('posts')
  .select('*, author(*)')
  .or('published.eq.true,pinned.eq.true')
  .order('createdAt', { ascending: false })`,
    },
    result:
      'The same query grammar, the same { data, error } contract, and the same realtime subscription shape — over a backend where structural change is governed, verified, and reversible, and where a loop is watching between your deploys.',
    responsibility: {
      platform: [
        'Serves PostgREST\'s grammar verbatim on the v2 surface, embeds included.',
        'Maps auth and postgres_changes subscriptions onto Backenly equivalents.',
        'Installs your RLS predicates verbatim and reads them back before reporting success.',
        'Refuses what it cannot honour rather than approximating it.',
      ],
      you: [
        'The data migration and the cutover window.',
        'Re-authoring policies into the claim form, and testing them.',
        'Replacing any rpc() call sites — there is no SQL-function surface.',
        'Deciding whether the governance trade is worth it for your team.',
      ],
    },
    capabilities: [
      { name: '@backenly/sdk/supabase', detail: 'Compatibility entry point emitting PostgREST directly, with { data, error } semantics and no throws.' },
      { name: '/api/v2/{projectId}/{table}', detail: 'PostgREST grammar passed through untouched — filters, ordering, embeds, Prefer headers, Content-Range counts.' },
      { name: 'set_rls', detail: 'Policies as exact SQL, installed verbatim, read back from pg_policies. No model in the path.' },
      { name: 'pg_dump', detail: 'Full schema export in either direction, so the move is reversible.' },
      { name: 'Autonomy loop', detail: 'Continuous monitoring and repair of the reversible safe band — the capability that has no Supabase equivalent.' },
    ],
    limitations: [
      'rpc() is refused. Backenly exposes no SQL functions by design, so any stored-procedure call sites need re-homing as event, cron, or HTTP functions.',
      'Policies must be re-authored. They are not translated automatically from Supabase\'s dialect.',
      'Storage and auth are Backenly\'s implementations, not Supabase\'s. The compat layer maps the common auth calls; anything provider-specific needs checking.',
      'This is a client-compatibility bridge, not a one-click migration. Moving data and cutting over remain manual work.',
    ],
    faq: [
      {
        q: 'Does my existing query code really work unchanged?',
        a: 'The common path does, because both sides are PostgREST clients and the mapping is largely the identity function. Filters, column projection, embedded resources, upsert with onConflict, and exact counts pass through. Test rpc() call sites and anything provider-specific before cutting over.',
      },
      {
        q: 'What about realtime subscriptions?',
        a: 'channel().on(\'postgres_changes\', …) maps onto Backenly realtime, which is PostgreSQL LISTEN/NOTIFY over Server-Sent Events through a shared listener hub. No WebSocket server and no Redis on this side.',
      },
      {
        q: 'Why would I move at all?',
        a: 'Only one reason is worth the work: you want the operating layer. Supabase hands you excellent primitives and you own the assembly and upkeep. Backenly governs every structural change, verifies it behaviourally, and runs a repair loop between your deploys. If your team enjoys owning that, Supabase is a good product and you should stay on it.',
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'ai-product-backends',
    label: 'AI product backends',
    metaTitle: 'Backend infrastructure for AI products — Backenly',
    metaDescription:
      'Conversation storage under verified isolation, pgvector retrieval inside the same policies, event and cron functions instead of a queue, job status as a row you subscribe to, and per-key rate limits.',
    headline: 'Prompts are private data. Store them like it.',
    subheadline:
      'Conversation history, retrieval, async pipelines, and live job status — as backend features under one access model rather than four systems you operate.',
    who: 'Teams shipping products with an inference layer',
    alreadyHave: 'Model access and a product idea',
    need: 'Storage, retrieval, pipelines, and cost control',
    problem:
      'An AI product has backend requirements a CRUD tutorial never covers, and each one is a separate infrastructure project by default: a queue for asynchronous inference, a vector store for retrieval, a socket layer so users are not staring at a frozen spinner, and rate limiting so one enthusiastic user does not spend your monthly inference budget in an afternoon. Meanwhile the most sensitive table in the product is the one holding every prompt your users have ever written.',
    normallyBuild:
      'A queue and workers, a standalone vector database with its own copy of sensitive data and its own sync bugs, a WebSocket server, a rate limiter, and the glue between them — before shipping the model behaviour that actually differentiates you.',
    workflow: [
      {
        label: 'Model',
        title: 'Conversations and runs, with isolation proven',
        body: 'Describe the shape — documents, runs, a status, an owner — and the isolation rule. The post-build check signs in as a second user and asserts they receive zero rows of the first user\'s data. On a table holding prompts, that is the check you most want to exist and least want to write.',
      },
      {
        label: 'Retrieve',
        title: 'Vectors beside the rows they describe',
        body: 'pgvector columns live in the same schema, and similarity queries run under the same user context as any other read. A retrieval that ignores row-level security is a breach with extra steps — user A\'s question surfacing user B\'s documents as context. Keeping vectors in the policy-enforced database is the structural fix.',
      },
      {
        label: 'Process',
        title: 'Database events are the queue',
        body: 'Functions attach to on_db_insert, on_db_update, on_db_delete, on_signup, a cron schedule, or an HTTP endpoint. "When a document is added, summarise it and write the summary back" is a function on an event, not a worker fleet.',
      },
      {
        label: 'Stream',
        title: 'Job status is a row',
        body: 'Make status a column and subscribe to changes on it over Server-Sent Events. Every writer — your inference layer, a trigger function, the dashboard — feeds the same stream, and there is no socket server to run.',
      },
      {
        label: 'Bound',
        title: 'Per-key rate limits and real request metrics',
        body: 'Rate limits on the runtime API, and latency percentiles and error rates computed from one request-log source of truth, so "which endpoint went hot" is a glance rather than a log dive.',
      },
    ],
    code: {
      language: 'js',
      label: 'Live job status without a socket server',
      code: `const unsub = backend.realtime.subscribe('ai_runs', (event) => {
  if (event.type !== 'update') return
  showStatus(event.data.status)        // queued → running → done
  if (event.data.status === 'done') {
    renderOutput(event.data.output)
    unsub()
  }
})`,
    },
    result:
      'One system, one access model, one bill: PostgreSQL with pgvector, REST with verified isolation, event and cron functions with metered invocations, and SSE for live status. Your differentiation stays in the model layer, which is the only part nobody else can do for you.',
    responsibility: {
      platform: [
        'Enforces per-user isolation in the database, including on similarity queries.',
        'Runs event, cron, and HTTP functions with metered invocations.',
        'Streams row changes over SSE through a shared listener hub.',
        'Applies per-key rate limits and records request-level metrics.',
      ],
      you: [
        'Model choice, prompts, evaluation, and inference cost.',
        'Chunking and embedding strategy — the platform stores and queries vectors, it does not design your retrieval.',
        'Deciding what the pipeline should actually do at each step.',
        'Handling provider failures and retries inside your function logic.',
      ],
    },
    capabilities: [
      { name: 'pgvector', detail: 'Embedding columns in your workspace schema; similarity queries run under the same user context as any other read.' },
      { name: 'Functions', detail: 'on_signup, on_db_insert / on_db_update / on_db_delete, cron, http, and manual triggers.' },
      { name: 'Invocation quota', detail: 'Metered per plan and enforced at execution — 10,000 function runs a month on Free, 2 million on Pro.' },
      { name: 'Realtime SSE', detail: 'PostgreSQL LISTEN/NOTIFY through a shared listener hub, with auto-reconnect. Row change events.' },
      { name: 'Rate limits', detail: 'Per-key limits on the runtime API, with the ceiling set by plan.' },
      { name: 'Behavioural verification', detail: 'Two-user isolation asserted against the live runtime after a build.' },
    ],
    limitations: [
      'Realtime carries row change events, not token streams. Stream tokens from your own inference endpoint; use SSE for status transitions.',
      'Vector search is not on the advertised 20-tool surface. Ask for it through backend_chat rather than a named tool.',
      'Event triggers are a paid capability — the Free plan seeds zero triggers per project. Check the pricing page before designing a pipeline around them.',
      'Function invocations are metered and enforced. A hot pipeline hits the plan quota and is refused rather than silently billed.',
      'The platform does not manage your inference spend. Rate limits bound request volume; they do not know what a request costs you.',
    ],
    faq: [
      {
        q: 'Can I use my own model provider?',
        a: 'Yes. Backenly stores and serves data over REST, so your inference layer reads and writes like any other client. Functions can also call providers directly through a registry surface, with the credential verified against the provider at connect time rather than merely stored.',
      },
      {
        q: 'Do I need a separate vector database?',
        a: 'Not for product-stage retrieval. pgvector keeps embeddings next to the rows they describe, so similarity search composes with your existing filters and with row-level security. A standalone vector store is a second system to operate, a second copy of sensitive data to secure, and a class of sync bug you do not need yet.',
      },
      {
        q: 'How do I show progress on a slow generation?',
        a: 'Make the job a row with a status column, update it as the work advances, and subscribe to changes on that row over SSE. Because the events come from the database, any writer feeds the same stream.',
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'multi-tenant-saas',
    label: 'Multi-tenant SaaS',
    metaTitle: 'Organizations, members, and tenant isolation — Backenly',
    metaDescription:
      'Provision the organization data model in your app, scope every row by membership with the org_members policy, and have the isolation proven behaviourally instead of assumed from policy text.',
    headline: 'Tenant isolation you can demonstrate',
    subheadline:
      'Organizations, members, and invitations as real tables, with row access scoped by membership in the database and the boundary tested by signing in as someone else.',
    who: 'Teams building B2B software with shared workspaces',
    alreadyHave: 'A product where customers have teammates',
    need: 'Per-tenant data isolation that holds',
    problem:
      'Multi-tenancy is where authorization bugs become incidents. The rule is simple to state — a member sees their organization\'s rows and nothing else — and easy to get subtly wrong: an endpoint that forgets the tenant filter, a policy that grants one side of a join, a query written before the rule existed. Nothing fails loudly. One customer sees another customer\'s data, and you find out from them.',
    normallyBuild:
      'An organizations and members model, an invitation flow with expiring tokens, a role system, and a tenant filter applied at every single query site — plus the discipline to never miss one, forever, across everyone who joins the team.',
    workflow: [
      {
        label: 'Provision',
        title: 'The organization model as real tables',
        body: 'enable_teams ensures end-user auth is on, then creates organizations (name, unique slug, owner), organization_members (organization, user, role defaulting to member, joined_at), and organization_invitations (email, role, unique token, inviter, expiry, accepted_at) — with CRUD endpoints and the lookup indexes membership checks need. It is idempotent, so re-running it is safe.',
      },
      {
        label: 'Scope',
        title: 'Membership decides row access, in the database',
        body: 'The org_members policy grants access to rows whose organization_id matches an organization the calling user belongs to. It requires the table to have an organization_id column and teams to be enabled — a precondition it checks rather than assumes.',
      },
      {
        label: 'Refine',
        title: 'Exact SQL where a template is not enough',
        body: 'set_rls takes your predicate verbatim, one rule per command, and reads pg_policies back before reporting success. Naming only update and delete leaves the select and insert rules byte-identical, so a scoped edit stays scoped.',
      },
      {
        label: 'Prove',
        title: 'Sign in as the other tenant',
        body: 'The isolation check creates a second end-user and asserts they receive zero rows. This is the difference between a policy that reads correctly and a boundary that holds — and it is the evidence to show a customer who asks how you separate their data.',
      },
    ],
    result:
      'Tenant separation enforced by PostgreSQL rather than by remembering a WHERE clause, a membership model with the indexes it needs, and a behavioural check you can point at when someone asks how isolation works.',
    responsibility: {
      platform: [
        'Provisions the organization, member, and invitation tables with their endpoints and indexes.',
        'Scopes rows by membership through a policy enforced in the database.',
        'Installs custom predicates verbatim and verifies them against pg_policies.',
        'Asserts cross-user isolation behaviourally and returns the evidence.',
      ],
      you: [
        'The invitation UX — sending the email, and the accept screen.',
        'What each role is allowed to do in your product; the schema seeds owner, admin, and member as values, not as behaviour.',
        'Billing and seat logic.',
        'Adding organization_id to the tables that should be tenant-scoped.',
      ],
    },
    capabilities: [
      { name: 'enable_teams', detail: 'Creates organizations, organization_members, and organization_invitations with CRUD APIs and membership indexes. Idempotent. Dispatchable but not advertised — reach it through backend_chat.' },
      { name: 'org_members policy', detail: 'Row access where organization_id matches an org the caller belongs to. Requires the column and enabled teams.' },
      { name: 'set_rls', detail: 'Exact SQL per command, installed verbatim, read back from pg_policies. Scoped edits leave other commands untouched.' },
      { name: 'Behavioural verification', detail: 'A second end-user is created and signed in; the check passes only on zero rows.' },
      { name: 'Schema isolation', detail: 'Each project has its own PostgreSQL schema; cross-project isolation is a grant, not a filter.' },
    ],
    limitations: [
      'This is your application\'s team model. It is unrelated to Backenly account seats, which are how many people can log into your Backenly dashboard — a separate, plan-limited thing.',
      'enable_teams provisions the data model and endpoints. Sending invitation emails and building the accept flow are yours.',
      'Roles are seeded as values (owner, admin, member). What each one may do is your policy work, expressed with set_rls.',
      'The org_members template requires an organization_id column on each scoped table and teams already enabled. It refuses rather than guessing.',
      'Cross-organization reporting needs deliberate design — the policies that make isolation hold also make aggregate queries across tenants intentionally hard.',
    ],
    faq: [
      {
        q: 'Is this the same as inviting teammates to Backenly?',
        a: 'No, and the distinction matters. Backenly account seats control who can open your dashboard and are limited by plan. This use case is about organizations inside the product you are building — your customers\' teams, living in your project\'s own schema, with their own users and policies.',
      },
      {
        q: 'How do I prove tenant isolation to a customer?',
        a: 'Point at the isolation check. It creates a second end-user, signs in, and asserts zero rows are returned — a behavioural result rather than a claim about policy text. Combined with per-project schema isolation enforced by Postgres grants, that is a concrete answer to a question most teams answer with an architecture diagram.',
      },
      {
        q: 'Can a tenant have nested teams or custom roles?',
        a: 'The provisioned model is organizations, members with a role string, and invitations. Anything beyond that — nested groups, per-resource permissions — is schema you add and policies you write with set_rls, which takes arbitrary predicates including EXISTS lookups against a parent row.',
      },
    ],
  },
]

export const USE_CASE_LIST: UseCaseData[] = LIST

export const USE_CASES: Record<string, UseCaseData> = Object.fromEntries(
  LIST.map((uc) => [uc.slug, uc]),
)

/** Card data for the index page. */
export const useCaseCards = LIST.map((uc) => ({
  slug: uc.slug,
  label: uc.label,
  headline: uc.headline,
  summary: uc.subheadline,
  who: uc.who,
  /** Surfaced on the card so the trade-off is visible before the click. */
  firstLimitation: uc.limitations[0],
}))
