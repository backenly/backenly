import {
  Activity,
  BadgeCheck,
  BookOpen,
  Boxes,
  Building2,
  CalendarClock,
  Camera,
  Code2,
  Cpu,
  Database,
  DatabaseBackup,
  Download,
  FileJson,
  FileText,
  Filter,
  Fingerprint,
  FolderOpen,
  GitBranch,
  GitCompare,
  Github,
  Globe,
  Hand,
  HardDrive,
  KeyRound,
  Layers,
  Link2,
  ListChecks,
  LockKeyhole,
  LogIn,
  Mail,
  Megaphone,
  Network,
  Package,
  Plug,
  Radio,
  Receipt,
  RefreshCw,
  Rocket,
  ScrollText,
  SearchCode,
  Server,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Terminal,
  Timer,
  Upload,
  Users,
  Wand2,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react'

/**
 * Features: the product catalog (/features) and its five deep-dive pages.
 *
 * Kept out of the route files because a Next.js page module may only export
 * its component, metadata and route config, and the index needs the deep-dive
 * names and slugs too.
 *
 * Every line here must be true of the product today. Plan-gated capabilities
 * say which plan they need, in the line itself, so nobody reads a Pro feature
 * as a Free one. Numbers that can move (quotas, prices) live on /pricing and are
 * not restated here beyond what the pricing table itself states.
 *
 * Slugs are permanent: the sitemap and a redirect in next.config.js point at
 * them, and search engines have indexed them.
 */

/* ── The deep-dive pages ─────────────────────────────────────────────────── */

export type FeatureData = {
  slug: string
  /** Short display name, used in the trail, cards and related links. */
  name: string
  icon: LucideIcon
  metaTitle: string
  metaDescription: string
  headline: string
  subheadline: string
  what: string
  how: string
  why: string
  /** A concrete, verifiable walkthrough of the feature doing its job. */
  inPractice: string
  details: { title: string; body: string }[]
  faq: { q: string; a: string }[]
  relatedFeatures: string[]
}

const FEATURE_LIST: FeatureData[] = [
  {
    slug: 'ai-backend-generation',
    name: 'Agent-built backends',
    icon: Sparkles,
    metaTitle: 'AI Backend Generation: A Real Backend, Built by Your Coding Agent',
    metaDescription:
      'Backenly turns a description into a running backend: PostgreSQL schema, REST APIs, authentication and storage, planned as typed actions, applied with approvals and restore points, and verified against the live runtime.',
    headline: 'Your agent asks. Backenly builds it right.',
    subheadline:
      'Tables, relations, APIs, auth and access rules, planned as typed actions, applied as one governed change and verified against the running backend.',
    what: 'Backenly turns a description of what your product needs into a running backend. Your coding agent reaches it over MCP, either through typed tools that compile straight to SQL, or by describing the change in natural language and letting Backenly plan it. Either way the result is the same kind of object: ordinary PostgreSQL tables with real relations, served as REST, protected by row-level security, with auth and storage wired in.',
    how: 'Take a description like "an e-commerce app with products, orders and customers, where each order belongs to a customer and holds several products." Backenly extracts the entities and how they relate, chooses column types, adds foreign keys and indexes, and derives access policies from any rules you stated. All of it becomes a plan of typed actions that says what each step touches. Additive work applies as one atomic change behind a restore point; anything destructive waits for a person. Every new table is served as an API the moment it exists.',
    why: 'An agent can write backend code well. What it cannot do is remember the schema after the session ends, notice that a policy is wrong, or stop itself from dropping a table on a bad turn. Building inside a governed platform keeps what an agent is good at and removes what it is not: the schema persists, every change is checked against the running backend, and nothing destructive happens without you.',
    inPractice:
      'Take the description "users can post recipes with photos, follow each other, and save favorites; users only edit their own recipes." Backenly shows the full plan first: four tables (users, recipes, follows, favorites), the foreign keys between them, the API endpoints, and the access policies derived from that last clause. You confirm, the platform applies the plan as governed steps, and then comes the part that separates this from a code generator. It verifies the result behaviourally: a real test signup over live HTTP, real CRUD calls against the new endpoints, and a second test user who is proven to receive zero rows of the first user\'s private data. Every check comes back with expandable evidence, in your agent\'s response and in the project history. If one fails, you see the failure, not a green checkmark.',
    details: [
      {
        title: 'Intent before SQL',
        body: 'Backenly extracts the entities, relationships, access rules and actions from the description before a single statement is written, so the plan can be read and questioned first.',
      },
      {
        title: 'A normalized schema',
        body: 'Correct PostgreSQL column types, constraints, indexes and foreign keys, chosen from the description rather than defaulted.',
      },
      {
        title: 'APIs from the first table',
        body: 'Every table is served as REST the moment it exists: list, create, read, update, delete, filtering and ordering, behind the same authorization as the database.',
      },
      {
        title: 'Changes after the first build',
        body: 'Describe the next change and Backenly plans it against the live schema, incrementally, with no hand-written migration. Every change is recorded with its actor and its diff.',
      },
    ],
    faq: [
      {
        q: 'What languages or frameworks does Backenly support?',
        a: 'Backenly serves a standard REST API, so anything that can make an HTTP request can use it: JavaScript, Python, Swift, Kotlin or anything else. A JavaScript SDK is included, and the CLI generates a typed client from the live schema.',
      },
      {
        q: 'Can I change my backend after it is generated?',
        a: 'Yes. Describe the change at any time, whether a new table, a renamed column or a new relationship, and Backenly plans it against the live backend and applies it incrementally. Every change is recorded, and on Pro and above any recorded change can be rolled back.',
      },
      {
        q: 'How complex can a backend be?',
        a: 'Backenly handles multi-entity schemas with relationships, business rules and role-based access control. It is built for real production applications, and the verification checks run against the live backend whatever its size.',
      },
    ],
    relatedFeatures: ['database-setup', 'api-generation', 'authentication', 'deployment-ready-backends'],
  },
  {
    slug: 'database-setup',
    name: 'Postgres database',
    icon: Database,
    metaTitle: 'Automatic Database Setup: A PostgreSQL Schema Designed for You',
    metaDescription:
      'Backenly designs and applies a production PostgreSQL schema from a description: tables, relations, indexes and row-level security, in a schema isolated to your project, with direct connection strings and pg_dump exports.',
    headline: 'Real PostgreSQL, designed for you',
    subheadline:
      'Describe the data model. Backenly creates the tables, relations, indexes and row-level security, in a schema that belongs to your project alone.',
    what: 'Backenly designs and applies a complete PostgreSQL schema from a description of your data: the tables, columns and types, the foreign keys between them, the indexes and the row-level security policies. No schema design sessions and no hand-written migration files. What you get is ordinary PostgreSQL. Query it with standard SQL, or through the same PostgREST grammar Supabase serves, with embedded resources and the full filter vocabulary. The generation replaces the design work, not the API you already know.',
    how: 'Backenly identifies the entities in your description and the relationships between them. It selects a PostgreSQL type for each field, creates foreign key constraints to keep references intact, adds indexes for the queries the model implies, and applies row-level security so the data is protected in the database itself rather than in application code.',
    why: 'Getting a schema right takes experience: normalization, the right types, indexes for the real query patterns, and security that holds on every path. Getting a change to a live schema right takes more. Backenly does both as governed work, so a production-grade schema does not depend on having a database specialist on the team.',
    inPractice:
      'The test of a schema tool is not creating tables, it is changing them once they hold live data. Ask Backenly to "add a comments table, each task can have multiple comments" and it plans the change against the live backend: the new table, the foreign keys, the APIs, and policies consistent with your existing rules, applied as governed steps and verified afterwards. Ask it to "drop the projects table" and it will not run silently. An approval card shows exactly how many live rows are affected and whether the data is recoverable, and nothing happens until a person confirms. Every change, additive or destructive, gets a restore point. Each project\'s schema is also isolated in its own PostgreSQL namespace, so no query can cross between projects.',
    details: [
      {
        title: 'Normalized by default',
        body: 'Tables without duplicated data, with referential integrity held by foreign keys and join tables rather than by convention.',
      },
      {
        title: 'The right types',
        body: 'UUIDs for identifiers, timestamps with time zone for dates, JSONB where the data is genuinely flexible, and text where it is not.',
      },
      {
        title: 'Row-level security',
        body: 'Policies in PostgreSQL decide what each user can read and write, so access control does not have to be remembered on every API path.',
      },
      {
        title: 'Safe schema evolution',
        body: 'Describe a change and Backenly applies it behind a restore point, records it, and routes anything destructive to a person first.',
      },
    ],
    faq: [
      {
        q: 'Does Backenly use PostgreSQL?',
        a: 'Yes. Every project is standard PostgreSQL, in its own isolated schema, with pgvector available for embeddings.',
      },
      {
        q: 'Can I access the database directly?',
        a: 'Yes. Provision a read-only connection string on demand, and arm a read-write one explicitly from the dashboard, both scoped to your project\'s schema. Full pg_dump exports are available at any time, and read-only SQL (joins, aggregates, window functions, CTEs, EXPLAIN) runs from the CLI and over MCP. What Backenly governs is structural change: schema mutations go through planned, verified, reversible actions rather than ad-hoc DDL. Your data stays portable and your schema stays accountable.',
      },
      {
        q: 'What happens to my data if I change plans?',
        a: 'Your data is preserved across plan changes. Upgrading adds capacity; downgrading keeps your data within the limits of the new plan.',
      },
    ],
    relatedFeatures: ['ai-backend-generation', 'api-generation', 'authentication', 'deployment-ready-backends'],
  },
  {
    slug: 'authentication',
    name: 'Authentication',
    icon: KeyRound,
    metaTitle: 'Built-in Authentication: User Auth for Your Backend, Isolated per Project',
    metaDescription:
      'Backenly includes complete end-user authentication on every plan: email and password, Google sign-in, magic links, email verification and JWT sessions, signed with a per-project secret and enforced by row-level security.',
    headline: 'Auth for your users, built in',
    subheadline:
      'Sign-up, sign-in, sessions and access control on every plan, signed with a secret that belongs to your project alone.',
    what: 'Every Backenly project includes a complete authentication system for the people who use your product. They register, sign in, and authenticate API requests with JWTs. It is isolated per project: each project has its own users table and its own signing secret, completely separate from every other project on the platform.',
    how: 'When a project is created, Backenly provisions a users table in the project\'s own schema, the sign-up and sign-in endpoints, token issuing and validation, and row-level security that scopes each user to their own data. Your frontend calls the endpoints directly or lets the SDK run the flows.',
    why: 'Authentication is one of the most security-critical parts of a backend, and one of the easiest to get subtly wrong. Backenly implements it correctly by default, with industry-standard JWTs, bcrypt password hashing and proper session handling, and then proves the isolation holds after every build.',
    inPractice:
      'From your frontend, auth is two SDK calls. backend.auth.signUp({ email, password }) creates a real row in your project\'s users table, and backend.auth.signIn(...) starts a session the SDK carries on every request. Beyond email and password, projects can enable Google sign-in, email verification and magic links, with hosted pages and branded emails handled by the platform. The part you never see matters most: because sessions integrate with row-level security in PostgreSQL, a signed-in user\'s queries are already scoped to their own data. After every build Backenly proves it by signing in as a second test user and confirming they receive zero rows of another user\'s private data, with the evidence shown rather than asserted.',
    details: [
      {
        title: 'Sign-up and sign-in endpoints',
        body: 'Every project gets its own sign-up and sign-in endpoints. Users register with email and password and receive tokens for their authenticated requests.',
      },
      {
        title: 'JWT sessions',
        body: 'Short-lived access tokens and longer-lived refresh tokens, signed with a project-specific secret that no other project shares.',
      },
      {
        title: 'Enforced by the database',
        body: 'Sessions integrate with row-level security, so a signed-in user reads and writes only their own rows, enforced in PostgreSQL rather than in API code.',
      },
      {
        title: 'SDK helpers',
        body: 'Sign-up, sign-in, sign-out and token refresh in the JavaScript SDK, so a frontend needs a few lines rather than an auth library.',
      },
    ],
    faq: [
      {
        q: 'Is authentication included on the Free plan?',
        a: 'Yes. Authentication is included on every plan, Free included, with no auth-specific charges.',
      },
      {
        q: 'Can I customize the authentication flow?',
        a: 'Auth settings are configured per project. Roles, permission policies and access rules can be set from the dashboard or by your agent.',
      },
      {
        q: 'Does Backenly support OAuth or social login?',
        a: 'Yes. Projects can enable Google sign-in for their users alongside email and password. Email verification and magic-link sign-in are also supported, with hosted pages and branded emails handled by the platform.',
      },
    ],
    relatedFeatures: ['ai-backend-generation', 'database-setup', 'api-generation'],
  },
  {
    slug: 'api-generation',
    name: 'REST API',
    icon: Zap,
    metaTitle: 'Instant REST API on PostgREST: The API Is Your Schema',
    metaDescription:
      'Every table in Backenly is served by PostgREST, the same engine Supabase runs, reading straight from the PostgreSQL catalog. Filters, ordering, pagination and embedded resources, with authorization enforced by Postgres grants and RLS.',
    headline: 'The API is your schema',
    subheadline:
      'Every table is served by PostgREST, straight from the PostgreSQL catalog. Nothing to regenerate: a table created a second ago is queryable now.',
    what: 'Every table in your project is served by PostgREST, the same engine Supabase runs, reading directly from the PostgreSQL catalog. There is no separate API registry to generate, deploy or keep in sync. The API is the schema, so a table created a second ago is queryable immediately, and a column renamed a second ago is reflected without a rebuild. You get filtering, ordering, pagination, full-text search and embedded resources, across two surfaces that share one engine and one authorization path.',
    how: 'Backenly exposes two surfaces over the same engine. `/api/v1/{projectId}/db/{table}` is Backenly\'s stable REST contract: list, create, get, update and delete with typed responses. `/api/v2/{projectId}/{table}` passes PostgREST\'s native grammar through untouched: `?price=gte.100`, `?or=(a.eq.1,b.eq.2)`, `?order=created_at.desc`, and embedded resources, where `?select=*,author(*)` returns a post and its author in one round trip. If you already know Supabase or PostgREST, you know this API.',
    why: 'Generated API layers drift. Once the code that serves your data is separate from the schema that defines it, the two can disagree, and that gap is where stale endpoints, forgotten authorization checks and "the table exists but the API does not" bugs live. Reading from the catalog removes the gap by construction. Authorization is enforced by PostgreSQL grants and row-level security rather than by application code, so a request for another tenant\'s rows fails on a missing database privilege instead of on a check somebody had to remember to write.',
    inPractice:
      'Every endpoint is testable from the dashboard the moment it exists. The APIs view lists each route per table, and an inline tester sends real requests to your live backend: type a JSON body into POST /auth/signup, send it, read the actual HTTP response, then open the users table and see the row it created. From code, the SDK mirrors the API: backend.tasks.list({ where: { status: \'todo\' }, orderBy: \'due_date\', limit: 25 }) for filtered queries, backend.projects.list({ include: [\'tasks\'] }) to resolve relations server-side in one request, and backend.tasks.count(...) when you need numbers without rows. Because row-level security lives in the database, all of these return only what the calling user may see. There is no authorization check to forget in client code.',
    details: [
      {
        title: 'Two surfaces, one engine',
        body: '/api/v1 is Backenly\'s stable REST contract, with typed responses. /api/v2 is PostgREST\'s native grammar, passed through untouched. Both read the same catalog and share one authorization path.',
      },
      {
        title: 'Embedded resources in one round trip',
        body: '`?select=*,author(*)` returns a post and its author together. The relationship is resolved from the foreign key in the catalog, so there is nothing to configure and no N+1 to hand-optimize.',
      },
      {
        title: 'Authorization in the database',
        body: 'Grants and row-level security decide what a request can reach. A read for another tenant\'s rows, for the auth table, or through an embedded resource is refused by Postgres itself.',
      },
      {
        title: 'Typed clients and a drift gate',
        body: 'Generate an OpenAPI spec and a typed client from the CLI. `backenly diff` exits non-zero when committed types drift from the live schema, so contract drift fails CI instead of production.',
      },
    ],
    faq: [
      {
        q: 'Is this a custom API layer or a real standard?',
        a: 'It is PostgREST, the same open-source engine Supabase runs, reading directly from your PostgreSQL catalog. On query capability Backenly is at parity with Supabase: same engine, same grammar, embedded resources included. If you know one, you know the other.',
      },
      {
        q: 'Do I have to regenerate the API when my schema changes?',
        a: 'No. The API is the schema. PostgREST reads the catalog, so a table or column created a second ago is queryable immediately, with no registry to regenerate, redeploy or keep in sync.',
      },
      {
        q: 'Can I add custom API logic or custom endpoints?',
        a: 'Yes. Serverless TypeScript functions and event triggers add business logic that runs on data events, on a schedule, or at a public HTTPS endpoint.',
      },
      {
        q: 'Is there API documentation?',
        a: 'Every project\'s live endpoints are browsable in the dashboard with an inline request tester, and the CLI exports an OpenAPI spec and a typed client for your codebase.',
      },
    ],
    relatedFeatures: ['ai-backend-generation', 'database-setup', 'authentication', 'deployment-ready-backends'],
  },
  {
    slug: 'deployment-ready-backends',
    name: 'Operations and autonomy',
    icon: Rocket,
    metaTitle: 'Deployment-Ready Backends: Live Immediately, Operated Every Minute',
    metaDescription:
      'Backenly runs your backend on managed infrastructure. No Docker, no Kubernetes, no cloud console: a rollback snapshot before every deploy, and a self-healing loop that watches the live backend every minute on every plan.',
    headline: 'Live at once, operated every minute',
    subheadline:
      'No Docker, no Kubernetes, no cloud console. Backenly runs the backend, snapshots before every deploy, and watches it every minute once it is live.',
    what: 'Backenly deploys your backend as part of building it. When the schema and APIs exist, the backend is live at a public URL, with no deployment step on your part: no containers to build, no infrastructure to provision, no manifests to write. And it does not stop at deploy. A resident loop keeps operating the backend afterwards.',
    how: 'Backenly runs your backend on managed infrastructure. When a project is created or a change is applied, the platform provisions the database, serves the API, and keeps the endpoints reachable. Once live, the autonomy loop checks every project every minute, applies the fixes that are safe and reversible, verifies them, and turns anything riskier into a proposal for you.',
    why: 'Running a backend is a job of its own: infrastructure, database upkeep, monitoring, and someone awake when an error rate moves at 3am. Backenly takes that job, and does it the way you would want an operator to: with a snapshot before every change and a written account of everything it touched.',
    inPractice:
      'Going live is one sentence, "put it live", and before every deploy the platform captures a rollback snapshot, so shipping is never a one-way door. After launch the autonomy loop takes over. It watches real request traffic (requests, latency, error rates) every minute on every plan, detects anomalies, and reacts at the autonomy level you choose. In review-only mode every proposed fix waits in a queue for your approval; in safe-fixes mode low-risk repairs apply automatically and are written up afterwards with what was detected, what changed, and how the fix was verified. The result is a backend with an operator on duty from day one, one that never sleeps and documents everything it touches.',
    details: [
      {
        title: 'Live without a pipeline',
        body: 'The backend is reachable at a public URL as soon as it is built. No build step, no CI/CD pipeline to configure, no cloud console.',
      },
      {
        title: 'History and rollback',
        body: 'Every change creates a record, and a rollback snapshot is saved before every deploy. On Pro and above, roll back to an earlier version from the dashboard.',
      },
      {
        title: 'Watched every minute',
        body: 'Request metrics, schema integrity, auth configuration and security policies, checked continuously, with the safe fixes applied and the rest reported.',
      },
      {
        title: 'Nothing behind your back',
        body: 'You never patch servers or babysit the database, and anything that needs a risky change is queued for your approval rather than done quietly.',
      },
    ],
    faq: [
      {
        q: 'Where is my backend hosted?',
        a: 'On Backenly Cloud, we run it on managed infrastructure, with each project\'s data in its own isolated PostgreSQL schema. Backenly is also open source under Apache-2.0, so you can self-host the whole platform on your own infrastructure instead.',
      },
      {
        q: 'Can I use a custom domain?',
        a: 'Custom domains are available on Pro ($25 a month) and Enterprise.',
      },
      {
        q: 'What is the uptime guarantee?',
        a: 'Backenly is built for production use. SLA terms are available on Enterprise. Free and Pro run on the same infrastructure; there is no degraded tier.',
      },
    ],
    relatedFeatures: ['ai-backend-generation', 'database-setup', 'api-generation'],
  },
]

export const FEATURES: Record<string, FeatureData> = Object.fromEntries(FEATURE_LIST.map((f) => [f.slug, f]))
export const FEATURE_SLUGS = FEATURE_LIST.map((f) => f.slug)

/* ── The catalog on /features ────────────────────────────────────────────── */

export type Capability = { icon: LucideIcon; name: string; body: string }

/** Which drawing a group carries. Resolved to a component in the page. */
export type AtlasVisual =
  | 'connect'
  | 'database'
  | 'rest'
  | 'auth'
  | 'storage'
  | 'realtime'
  | 'functions'

export type AtlasGroup = {
  id: string
  title: string
  lede: string
  items: Capability[]
  visual?: AtlasVisual
  deepDive?: { slug: string; label: string }
}

export const ATLAS: AtlasGroup[] = [
  {
    id: 'agents',
    title: 'Build with your agent',
    lede: 'Your coding agent is the builder. It reaches the backend over MCP, with a key scoped to one project.',
    visual: 'connect',
    deepDive: { slug: 'ai-backend-generation', label: 'How agent-built backends work' },
    items: [
      { icon: Plug, name: 'MCP server', body: 'Typed tools for schema, data, auth, storage and functions, local over stdio or remote over HTTP.' },
      { icon: KeyRound, name: 'Scoped, revocable keys', body: 'One key per project, revocable from the dashboard, and mintable as read-only.' },
      { icon: Hand, name: 'Requests, never approvals', body: 'An agent key can ask for a destructive change. Only a person can approve one.' },
      { icon: Terminal, name: 'CLI', body: 'Schema, generated types, CI drift checks, logs and read-only SQL, with zero dependencies.' },
      { icon: BookOpen, name: 'Agent skill', body: 'A canonical skill at backenly.com/skill.md, so an agent learns the platform first.' },
      { icon: FileText, name: 'llms.txt and fetch_docs', body: 'The complete reference in one file, also fetchable by an agent at run time.' },
    ],
  },
  {
    id: 'database',
    title: 'Database',
    lede: 'Standard PostgreSQL in a schema of your own. Isolation is a Postgres grant, not a WHERE clause.',
    visual: 'database',
    deepDive: { slug: 'database-setup', label: 'The database in depth' },
    items: [
      { icon: Table2, name: 'Tables and relations', body: 'Columns, foreign keys with their delete behaviour, indexes and CHECK constraints.' },
      { icon: Boxes, name: 'pgvector', body: 'Store embeddings beside the rows they describe, and query both in SQL.' },
      { icon: Link2, name: 'Direct connections', body: 'Read-only on demand, read-write when you arm it. psql, ORMs, any BI tool.' },
      { icon: SearchCode, name: 'Read-only SQL', body: 'Joins, aggregates, CTEs and EXPLAIN, run as a SELECT-only role from the CLI or MCP.' },
      { icon: DatabaseBackup, name: 'Daily backups', body: 'Taken every day and kept for seven days, on every plan.' },
      { icon: Download, name: 'pg_dump exports', body: 'A full export that restores on any Postgres, Free plan included.' },
    ],
  },
  {
    id: 'apis',
    title: 'REST APIs',
    lede: 'PostgREST serves every table from the catalog. A table created a second ago is queryable now.',
    visual: 'rest',
    deepDive: { slug: 'api-generation', label: 'The REST API in depth' },
    items: [
      { icon: Filter, name: 'Filters and pagination', body: 'The full PostgREST grammar: operators, or-groups, ordering, ranges and full-text search.' },
      { icon: Network, name: 'Embedded resources', body: '`?select=*,author(*)` returns a row and its relations in one round trip.' },
      { icon: Layers, name: 'Two surfaces, one engine', body: '/api/v1 is the stable contract; /api/v2 passes PostgREST through untouched.' },
      { icon: FileJson, name: 'OpenAPI and typed clients', body: 'Generated from the live schema by the CLI, never written by hand.' },
      { icon: GitCompare, name: 'A drift gate for CI', body: '`backenly diff` fails the build when committed types drift from the schema.' },
      { icon: Package, name: 'JavaScript SDK', body: 'CRUD, auth, storage and realtime from one typed client.' },
    ],
  },
  {
    id: 'auth',
    title: 'Auth',
    lede: 'Sign-up and sign-in for your users, isolated per project and signed with the project\'s own secret.',
    visual: 'auth',
    deepDive: { slug: 'authentication', label: 'Authentication in depth' },
    items: [
      { icon: Mail, name: 'Email and password', body: 'Sign-up, sign-in, sessions and refresh, from two SDK calls.' },
      { icon: LogIn, name: 'Google sign-in', body: 'OAuth for your users, alongside email and password.' },
      { icon: Wand2, name: 'Magic links and verification', body: 'Passwordless sign-in and verified emails, with hosted pages and branded mail.' },
      { icon: Fingerprint, name: 'A secret per project', body: 'Tokens from one project are never accepted by another.' },
      { icon: Shield, name: 'Row-level security by description', body: 'Say who can read and write what. Backenly writes and enforces the policies.' },
      { icon: Building2, name: 'Teams for your product', body: 'Organizations, members and invitations for your own customers, scoped by policy.' },
    ],
  },
  {
    id: 'storage',
    title: 'Storage',
    lede: 'Buckets and files with their metadata, served publicly or through URLs that expire.',
    visual: 'storage',
    items: [
      { icon: FolderOpen, name: 'Public and private buckets', body: 'Public files load anywhere; private ones need a session or a signed URL.' },
      { icon: Upload, name: 'Uploads and metadata', body: 'Upload from the SDK, and every file keeps its metadata beside it.' },
      { icon: Timer, name: 'Expiring signed URLs', body: 'Share a private file for a limited time, then never again.' },
      { icon: HardDrive, name: 'Local disk or S3', body: 'Self-hosted installs choose local storage or any S3-compatible provider.' },
    ],
  },
  {
    id: 'realtime',
    title: 'Realtime',
    lede: 'Inserts, updates and deletes as they land, over server-sent events. No socket server to run.',
    visual: 'realtime',
    items: [
      { icon: Radio, name: 'Database changes', body: 'Subscribe to a table and receive every committed change as it lands.' },
      { icon: Users, name: 'Presence', body: 'Who is online right now, with a sixty-second activity window.' },
      { icon: Megaphone, name: 'Broadcast', body: 'Ephemeral messages between clients, up to 6 KB each.' },
      { icon: RefreshCw, name: 'Automatic reconnect', body: 'The SDK reconnects by itself after a dropped connection.' },
    ],
  },
  {
    id: 'functions',
    title: 'Functions and events',
    lede: 'Run TypeScript when rows change, when a user signs up, on a schedule, or at a public HTTPS endpoint.',
    visual: 'functions',
    items: [
      { icon: Code2, name: 'Serverless TypeScript', body: 'Your code, run by the platform, with no server to deploy.' },
      { icon: Zap, name: 'Event triggers', body: 'Insert, update, delete and signup events call your function. Pro and Enterprise.' },
      { icon: CalendarClock, name: 'Cron schedules', body: 'Run a function on a schedule you write as a cron expression.' },
      { icon: Webhook, name: 'Outbound webhooks', body: 'Tell other systems when your data changes. Pro and Enterprise.' },
      { icon: Activity, name: 'Rate limits', body: 'Built in, so one noisy caller cannot exhaust the rest.' },
      { icon: Globe, name: 'Public endpoints', body: 'Expose a function at an HTTPS endpoint of its own.' },
    ],
  },
  {
    id: 'governance',
    title: 'Governed change',
    lede: 'Every change, from you, your agent or the autonomy loop, goes through one path that plans it, gates it, applies it, verifies it and records it.',
    items: [
      { icon: ListChecks, name: 'Typed actions', body: 'Ordinary SQL becomes named actions that say exactly what each one touches.' },
      { icon: Hand, name: 'Review Queue', body: 'Destructive work waits for a person, with the live row count beside it.' },
      { icon: Camera, name: 'Restore points', body: 'Captured before the first write, then the plan commits atomically.' },
      { icon: BadgeCheck, name: 'Behavioural verification', body: 'Real requests as a stranger and as a signed-in user, with the evidence kept.' },
      { icon: ScrollText, name: 'Change ledger', body: 'Every change with its actor, its diff and a way back.' },
      { icon: GitBranch, name: 'Branches', body: 'Clone the backend, let your agent experiment, review the diff, merge what works.' },
    ],
  },
  {
    id: 'autonomy',
    title: 'Autonomy and operations',
    lede: 'A resident loop checks every project every minute, fixes what is safe to fix, verifies the fix, and leaves you a receipt.',
    deepDive: { slug: 'deployment-ready-backends', label: 'Operations and autonomy in depth' },
    items: [
      { icon: Timer, name: 'Every minute, every plan', body: 'The same loop on Free as on Enterprise, never metered.' },
      { icon: Cpu, name: 'No model calls', body: 'Repairs are deterministic, so healing never spends AI credits.' },
      { icon: Camera, name: 'Snapshot first', body: 'Only reversible fixes apply on their own. The rest become proposals.' },
      { icon: SlidersHorizontal, name: 'Your autonomy level', body: 'Review-only, or apply safe fixes and read about them afterwards.' },
      { icon: Activity, name: 'Traffic watched', body: 'Requests, latency and error rates, checked for anomalies.' },
      { icon: Receipt, name: 'Receipts', body: 'What was detected, what changed, and how the fix was verified.' },
    ],
  },
  {
    id: 'platform',
    title: 'Teams, security and hosting',
    lede: 'The questions a company asks before it trusts a backend with production.',
    items: [
      { icon: Users, name: 'Organizations and roles', body: 'Invite teammates with roles. Pro includes five seats.' },
      { icon: Globe, name: 'Custom domains', body: 'Serve your backend from your own domain on Pro and Enterprise.' },
      { icon: ScrollText, name: 'Logs', body: 'Kept for 7 days on Free, 30 on Pro and 90 on Enterprise.' },
      { icon: LockKeyhole, name: 'Single sign-on', body: 'OIDC sign-on for your team, on Enterprise.' },
      { icon: Github, name: 'Open source', body: 'The platform is Apache-2.0; the SDK, CLI, MCP server and skill are MIT.' },
      { icon: Server, name: 'Self-host or Cloud', body: 'One codebase either way, with pg_dump to move between them.' },
    ],
  },
]
