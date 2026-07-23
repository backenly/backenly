import { Metadata } from 'next'
import { safeJsonLd } from '@/lib/security/safe-jsonld'
import {
  Terminal,
  KeyRound,
  ShieldCheck,
  Bot,
  Sparkles,
  Database,
  Search,
  Plug,
  type LucideIcon,
} from 'lucide-react'
import { SiteShell } from '@/components/site/SiteShell'
import {
  Breadcrumb,
  InlineArrow,
  PageHero,
  PrimaryButton,
  SecondaryButton,
  Section,
  SectionHeading,
  Lead,
  Card,
  IconTile,
  Tag,
  FaqList,
  CtaSection,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'
import { CodeBlock } from '@/components/site/CodeBlock'

const APP_URL = 'https://backenly.com'

/**
 * The single agent-setup page.
 *
 * /mcp used to be a second, longer page covering the same ground, and the two
 * drifted: /mcp advertised "60+ tools across four tiers" months after the
 * catalog was cut to an 18-tool allowlist, and this page told readers to set
 * `BACKENLY_MCP_KEY` — a name only the CI harness uses; the package reads
 * `BACKENLY_API_KEY`. One page, checked against lib/mcp/catalog.ts and
 * packages/mcp-server/src/config.ts, is the fix. /mcp now 301s here
 * (next.config.js).
 */
export const metadata: Metadata = {
  title: 'Quickstart — Connect Claude Code, Cursor & Codex to a real backend | Backenly',
  description:
    'Connect Backenly to Claude Code, Cursor, Codex, or Cline over MCP in one command, describe your backend in plain English, and query it with the PostgREST grammar you already know.',
  keywords: [
    'Backenly quickstart',
    'Backenly MCP',
    'MCP server',
    'Model Context Protocol backend',
    'Claude Code backend',
    'Cursor MCP backend',
    'connect AI agent to backend',
    'agent-native backend',
    'PostgREST quickstart',
  ],
  openGraph: {
    title: 'Backenly Quickstart — give your coding agent a real backend',
    description:
      'One command connects Claude Code, Cursor, Codex, or Cline to a live Backenly backend. Describe what you need; query it over standard PostgREST.',
    url: `${APP_URL}/quickstart`,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Backenly Quickstart — give your coding agent a real backend',
    description:
      'Connect Claude Code, Cursor, Codex & Cline to a live Backenly backend over MCP. One command.',
  },
  alternates: { canonical: `${APP_URL}/quickstart` },
}

/* ── Code samples ───────────────────────────────────────────────────────── */

const INSTALL = `# Claude Code
claude mcp add backenly -- npx -y @backenly/mcp-server \\
  --project <projectId> --key mcp_live_...

# Codex
codex mcp add backenly -- npx -y @backenly/mcp-server \\
  --project <projectId> --key mcp_live_...`

const MCP_CONFIG = `{
  "mcpServers": {
    "backenly": {
      "command": "npx",
      "args": [
        "-y", "@backenly/mcp-server",
        "--project", "<projectId>",
        "--key", "mcp_live_..."
      ]
    }
  }
}`

const INIT = `npx @backenly/mcp-server init

# Verifies the key, then writes ~/.backenly/mcp.json (mode 0600).
# Host config then needs no key at all:
#   "args": ["-y", "@backenly/mcp-server"]
# BACKENLY_API_KEY in an env block works too.`

const DESCRIBE = `A job board. Employers post listings with a title,
description, salary range and location. Applicants apply to a
listing with a CV and a cover note. Applicants may only read
and edit their own applications; employers see applications
to their own listings only.`

const MIGRATION = `-- apply_migration: ordinary PostgreSQL DDL
CREATE TABLE listings (
  title       text NOT NULL,
  salary_max  integer,
  employer_id uuid REFERENCES users(id)
);
CREATE INDEX ON listings (employer_id);`

const READ_SQL = `-- run_query: standard SQL, read-only
SELECT l.title, count(a.id) AS applications
FROM listings l
LEFT JOIN applications a ON a.listing_id = l.id
GROUP BY l.title
ORDER BY applications DESC
LIMIT 10;`

const QUERY = `# The typed contract
curl "$URL/api/v1/$PROJECT_ID/db/listings?limit=20&sort=-created_at" \\
  -H "x-api-key: $ANON_KEY"

# Or the PostgREST grammar, passed through untouched
curl "$URL/api/v2/$PROJECT_ID/listings?salary_max=gte.90000&order=created_at.desc" \\
  -H "apikey: $ANON_KEY"

# Embedded resources — listing + its employer in one round trip
curl "$URL/api/v2/$PROJECT_ID/listings?select=*,employer(*)" \\
  -H "apikey: $ANON_KEY"`

const AGENT_INSTRUCTIONS = `# Connecting to Backenly (instructions for the coding agent)

Backenly is the backend. To create or change backend resources
(tables, REST APIs, auth, storage, realtime, triggers, functions,
cron jobs), use the Backenly MCP server — do NOT write your own
server, migrations, or connection code.

1. Ask the user to open backenly.com -> their project -> Connect ->
   Agents, and generate an MCP key (starts with "mcp_live_").
2. Install, then restart the host:

   claude mcp add backenly -- npx -y @backenly/mcp-server \\
     --project <projectId> --key <the mcp_live_ key>

3. Call read_backend_state first on any non-trivial task. It is the
   single read-state door; pass \`section\` to drill in.
4. To build: prefer backend_chat with a plain-English request. For
   schema you can express as DDL, apply_migration takes ordinary
   PostgreSQL and translates it into governed actions.
5. To read data: run_query takes standard read-only SQL (joins,
   GROUP BY, CTEs, EXPLAIN). To write rows: db_insert / db_update /
   db_delete.
6. Destructive operations (drop table/column, delete bucket) are
   never executed from MCP. backend_chat returns an approval id;
   a human approves it in the dashboard Review Queue and you poll
   check_approval until it is executed or rejected.
7. Unsure about a capability? Call fetch_docs instead of guessing.`

/* ── Content ────────────────────────────────────────────────────────────── */

type Snippet = { label: string; language: string; code: string }

const STEPS: { n: string; title: string; body: string; code?: Snippet; extra?: Snippet }[] = [
  {
    n: '01',
    title: 'Generate a scoped key',
    body: 'Open your project on backenly.com → Connect → Agents → Generate key. You get an mcp_live_ key that is scoped to MCP routes and revocable from the same page. It is never your account credential, and an SDK key cannot be replayed in its place.',
  },
  {
    n: '02',
    title: 'Point your agent at it',
    body: 'One command for Claude Code and Codex. Cursor, Cline, and Claude Desktop take the same server block in their MCP config. Restart the host afterwards.',
    code: { label: 'terminal', language: 'bash', code: INSTALL },
    extra: { label: 'mcp.json — Cursor · Cline · Claude Desktop', language: 'json', code: MCP_CONFIG },
  },
  {
    n: '03',
    title: 'Describe the backend',
    body: 'Say what the product does, including who is allowed to see what. Backenly derives the tables, foreign keys, indexes, REST surface and row-level security from it, shows you the plan, and applies it as governed steps once you confirm.',
    code: { label: 'to your agent, in plain English', language: 'text', code: DESCRIBE },
  },
  {
    n: '04',
    title: 'Query it',
    body: 'Every table is served by PostgREST reading the PostgreSQL catalog, so a table created a second ago is queryable immediately. There is no registry to sync and nothing to deploy first.',
    code: { label: 'terminal', language: 'bash', code: QUERY },
  },
]

const HOSTS: { name: string; how: string }[] = [
  { name: 'Claude Code', how: 'claude mcp add backenly -- …' },
  { name: 'Codex', how: 'codex mcp add backenly -- …' },
  { name: 'Cursor', how: '.cursor/mcp.json' },
  { name: 'Cline (VS Code)', how: 'cline_mcp_settings.json' },
  { name: 'Claude Desktop', how: 'claude_desktop_config.json' },
]

/**
 * Mirrors the MCP_SURFACE allowlist in lib/mcp/catalog.ts. If a tool is added
 * or removed there, it changes here — this table is the public face of that
 * file and a drift between them is exactly what retired the old /mcp page.
 */
const TOOL_DOORS: { icon: LucideIcon; tier: string; title: string; body: string; tools: string[] }[] = [
  {
    icon: Sparkles,
    tier: 'describe',
    title: 'Say what you want',
    body: 'The fall-through for anything not covered by a specific tool. Your request goes to Backenly’s brain, which plans the steps, executes them, and returns a summary. Your agent never has to learn a vocabulary.',
    tools: ['backend_chat'],
  },
  {
    icon: Search,
    tier: 'read',
    title: 'One read door, not twenty-six',
    body: 'Everything that answers “what is currently true?” is one tool with a section argument — tables, APIs, RLS, metrics, errors, deploys, usage, autonomy. Picking a string beats picking between 26 similarly-named tools.',
    tools: ['read_backend_state', 'run_query', 'fetch_docs', 'check_approval'],
  },
  {
    icon: Database,
    tier: 'write',
    title: 'Structure in DDL, rows in verbs',
    body: 'apply_migration accepts ordinary PostgreSQL DDL and translates each statement into a governed action — planned, verified, reversible, all-or-nothing. It is not raw SQL execution; anything it cannot govern is refused with the tool to use instead.',
    tools: ['apply_migration', 'db_insert', 'db_update', 'db_delete'],
  },
  {
    icon: Plug,
    tier: 'capabilities',
    title: 'Things SQL cannot express',
    body: 'Auth, buckets, generated APIs, functions, realtime, keys and environment variables — plus direct Postgres credentials and reconciliation for schema you changed outside Backenly.',
    tools: [
      'enable_auth',
      'create_bucket',
      'generate_api',
      'generate_function',
      'enable_realtime',
      'create_api_key',
      'set_env_var',
      'get_database_credentials',
      'adopt_external_schema',
    ],
  },
]

const SECURITY = [
  {
    icon: KeyRound,
    title: 'Scope-gated keys',
    body: 'MCP keys (mcp_live_…) only work on MCP routes. A leaked SDK key cannot be replayed to reach them, and any key dies instantly from Connect → Agents.',
  },
  {
    icon: ShieldCheck,
    title: 'Destructive work stops at a human',
    body: 'drop_table, truncate_table and delete_bucket are not in the catalog. Ask for one and it parks in your Review Queue with an approval id — the agent polls check_approval, it never self-approves.',
  },
  {
    icon: Database,
    title: 'Reads run as a read-only role',
    body: 'run_query executes as a SELECT-only Postgres role scoped to your project, so isolation is a database grant rather than a SQL parser that has to be right every time. Secret-bearing columns come back redacted.',
  },
  {
    icon: Terminal,
    title: 'Every change leaves a receipt',
    body: 'Each mutation writes an audit-log entry on your project timeline, with a restore point. Per-key rate limits and plan quotas apply on every call.',
  },
]

const FAQ = [
  {
    q: 'What is MCP and why do I need it?',
    a: 'The Model Context Protocol is an open standard that lets AI coding agents call external tools. Connecting Backenly over MCP gives your agent — Claude Code, Cursor, Codex, Cline — governed access to a real backend it can read and change, instead of you pasting API docs into a chat. It reads your live schema and drives tables, APIs, auth, storage and functions through changes it cannot break, with a receipt in your project history for every one.',
  },
  {
    q: 'Why so few tools? Other MCP servers expose dozens.',
    a: 'Backenly advertised 71 and it made the agent worse. Tool-selection accuracy degrades with catalog size, and models misfire hardest between tools with similar names — we shipped query, db_query and run_query at once, three doors to two behaviours. The catalog is now an allowlist admitted on one rule: is there exactly one tool that answers a given request? Everything else is reached through backend_chat or stays dispatchable for older clients. Capability is unchanged; the number of decisions the model has to get right dropped by a factor of four.',
  },
  {
    q: 'Do I need to know SQL?',
    a: 'Not to build — you describe the backend and Backenly plans and applies the schema, policies and indexes. But knowing SQL is an asset, not a workaround: reads are standard SQL through run_query and the full PostgREST grammar, schema changes can be written as plain DDL through apply_migration, and you can connect any Postgres client with a read-only or read-write connection string.',
  },
  {
    q: 'I already know Supabase. What is different here?',
    a: 'The query layer is the same — PostgreSQL served through PostgREST, same filters, same ordering, same embedded resources. What differs is who does the work around it: structural changes go through typed actions with dry-run, audit and rollback rather than migrations you write, and a monitoring loop watches the running backend and repairs drift on its own.',
  },
  {
    q: 'Is there a dashboard, or is it agent-only?',
    a: 'There is a full dashboard for inspecting tables, policies, logs, storage and deployments, plus an Assistant (⌘J) that answers questions about your project. Building happens through your coding agent over MCP — Backenly deliberately does not ship a competing in-app builder chat.',
  },
  {
    q: 'What does it cost?',
    a: 'The MCP server is free to install from npm. When your agent drives the backend through direct tool calls, that is never metered as AI — your agent supplies the intelligence and you pay your own model provider, while Backenly meters only infrastructure against your plan. The exception is backend_chat, which runs Backenly’s own brain.',
  },
  {
    q: 'The agent says my key has the wrong scope.',
    a: 'You pasted your SDK/anon key. Generate a dedicated MCP key (it starts with mcp_live_) from your project’s Connect → Agents page and use that instead.',
  },
  {
    q: 'Can I get my data out?',
    a: 'Yes — direct PostgreSQL connection strings and full pg_dump exports are one command away, and the whole platform is open source under Apache-2.0 if you would rather run it yourself. Structure is governed; nothing is locked in.',
  },
]

const howToSchema = {
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name: 'Connect your coding agent to a Backenly backend over MCP',
  description:
    'Connect Backenly to Claude Code, Cursor, Codex, or Cline over MCP, describe a backend in plain English, and query it over PostgREST.',
  step: STEPS.map((s, i) => ({
    '@type': 'HowToStep',
    position: i + 1,
    name: s.title,
    text: s.body,
  })),
}

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
}

export default function QuickstartPage() {
  return (
    <SiteShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(howToSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(faqSchema) }}
      />

      <main className="relative z-20">
        <Breadcrumb items={[{ label: 'Home', href: '/' }, { label: 'Quickstart' }]} />

        <PageHero
          align="center"
          eyebrow="Quickstart · MCP"
          icon={
            <IconTile size={56}>
              <Terminal size={26} className="text-violet-300" strokeWidth={1.75} />
            </IconTile>
          }
          title="A working backend in four steps"
          subtitle="Connect your coding agent, describe what your product does, and query the result with an API you already know. No schema design session, no migration files, no deploy step before the first request works."
          actions={
            <>
              <PrimaryButton href="/auth/signup">
                Get your MCP key
                <InlineArrow />
              </PrimaryButton>
              <SecondaryButton
                href="https://www.npmjs.com/package/@backenly/mcp-server"
                external
              >
                View on npm
              </SecondaryButton>
            </>
          }
          proof={[
            { label: 'Works with', value: 'Claude Code · Cursor · Codex · Cline' },
            { label: 'Setup', value: 'One command' },
            { label: 'Tool surface', value: '18 tools, one door per job' },
          ]}
        />

        <Section aria-label="Steps" width="default" className="!pt-12">
          <div className="flex flex-col gap-10">
            {STEPS.map((step) => (
              <div key={step.n} className="grid gap-5 lg:grid-cols-[auto_1fr] lg:gap-8">
                <div className="font-mono text-sm text-violet-300/70 lg:pt-1">{step.n}</div>
                <div>
                  <h3 className="mb-2 text-lg font-medium text-zinc-100">{step.title}</h3>
                  <p className="mb-4 text-sm leading-relaxed text-zinc-400">{step.body}</p>
                  {step.code && (
                    <CodeBlock
                      label={step.code.label}
                      language={step.code.language}
                      code={step.code.code}
                    />
                  )}
                  {step.extra && (
                    <div className="mt-3">
                      <CodeBlock
                        label={step.extra.label}
                        language={step.extra.language}
                        code={step.extra.code}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section aria-label="Supported hosts" width="default">
          <SectionHeading className="mb-3">Every MCP host, same block</SectionHeading>
          <Lead className="mb-8">
            The protocol is identical everywhere — only where you put the server block
            changes. Any MCP-compatible host works, including ones not listed here.
          </Lead>
          <div className="overflow-hidden rounded-lg border border-white/10">
            {HOSTS.map((host, i) => (
              <div
                key={host.name}
                className={`flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${
                  i !== 0 ? 'border-t border-white/[0.06]' : ''
                }`}
              >
                <span className="text-sm font-medium text-white">{host.name}</span>
                <code className="font-mono text-xs text-zinc-400">{host.how}</code>
              </div>
            ))}
          </div>
          <p className="mb-4 mt-8 text-sm leading-relaxed text-zinc-400">
            Prefer to keep the key out of your host config — or out of a repo you commit?
            Run the installer once and the key lives in a user-only file instead.
          </p>
          <CodeBlock label="terminal" language="bash" code={INIT} />
        </Section>

        <Section aria-label="What you get" width="default">
          <SectionHeading className="mb-3">What exists after step three</SectionHeading>
          <Lead className="mb-8">
            Not a scaffold you finish by hand — a running backend with the parts that
            usually take a week.
          </Lead>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ['A normalised PostgreSQL schema', 'Tables, foreign keys, indexes and check constraints, in a schema isolated to your project.'],
              ['A REST API on every table', 'Served by PostgREST from the catalog — plus a stable typed contract at /api/v1.'],
              ['Row-level security that was tested', 'Policies derived from the rules in your description, then verified by signing in as a second user and proving they see nothing of the first.'],
              ['End-user auth', 'Email + password, magic links, OAuth, JWT access and refresh tokens, scoped to your project.'],
              ['Realtime, storage and functions', 'Change subscriptions, presence, file buckets and serverless handlers, all on the same auth model.'],
              ['A loop that keeps it running', 'Monitors the live backend and repairs drift, missing indexes and RLS gaps on its own — anything risky waits for you.'],
            ].map(([title, body]) => (
              <Card key={title} className="!p-5">
                <h4 className="mb-1.5 text-sm font-medium text-zinc-100">{title}</h4>
                <p className="text-sm leading-relaxed text-zinc-400">{body}</p>
              </Card>
            ))}
          </div>
        </Section>

        <Section aria-label="Tool surface" width="wide">
          <SectionHeading className="mb-3">Eighteen tools, not sixty</SectionHeading>
          <Lead className="mb-8">
            The catalog is an allowlist, admitted on one rule: is there exactly one tool
            here that answers a given request? Competing doors were removed, not because
            they were useless, but because every extra tool costs the model accuracy on
            every call. Anything niche is reached through{' '}
            <span className="text-zinc-200">backend_chat</span>.
          </Lead>
          <div className="grid gap-6 sm:grid-cols-2">
            {TOOL_DOORS.map((group) => {
              const Icon = group.icon
              return (
                <Card key={group.tier} className="flex flex-col">
                  <div className="flex items-center gap-3">
                    <IconTile size={44}>
                      <Icon size={20} className="text-violet-300" strokeWidth={1.75} />
                    </IconTile>
                    <Tag>{group.tier}</Tag>
                  </div>
                  <h3 className="mt-4 text-base font-medium text-white">{group.title}</h3>
                  <p className="mt-2 flex-1 text-sm leading-relaxed text-zinc-400">
                    {group.body}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {group.tools.map((t) => (
                      <span
                        key={t}
                        className="rounded-md border border-white/10 bg-black/40 px-2 py-1 font-mono text-xs text-zinc-400"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </Card>
              )
            })}
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                Schema, as DDL you already write
              </p>
              <CodeBlock label="apply_migration" language="sql" code={MIGRATION} />
            </div>
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                Reads, as SQL you already write
              </p>
              <CodeBlock label="run_query" language="sql" code={READ_SQL} />
            </div>
          </div>
          <p className="mt-6 text-sm leading-relaxed text-zinc-400">
            Both are the grammar the model already knows, and neither is raw SQL against
            your database. Every DDL statement is translated into a governed action, so it
            stays planned, verified and reversible; every read runs as a SELECT-only role
            scoped to your project, so the tenant boundary is a Postgres grant rather than
            a parser that has to be right every time.
          </p>
        </Section>

        <Section aria-label="Security" width="default">
          <SectionHeading className="mb-3">Built to be handed to an agent</SectionHeading>
          <Lead className="mb-8">
            The agent operates; it does not get the keys to the building.
          </Lead>
          <div className="grid gap-5 sm:grid-cols-2">
            {SECURITY.map((item) => {
              const Icon = item.icon
              return (
                <Card key={item.title} className="!p-5">
                  <IconTile size={40}>
                    <Icon size={18} className="text-violet-300" strokeWidth={1.75} />
                  </IconTile>
                  <h3 className="mt-4 text-base font-medium text-white">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400">{item.body}</p>
                </Card>
              )
            })}
          </div>
        </Section>

        <Section aria-label="For AI agents" width="default">
          <div className="mb-6 flex items-center gap-3">
            <IconTile size={44}>
              <Bot size={20} className="text-violet-300" strokeWidth={1.75} />
            </IconTile>
            <SectionHeading className="!text-2xl md:!text-3xl">For AI agents</SectionHeading>
          </div>
          <Lead className="mb-6">
            If you are an AI coding agent reading this page, copy the block below into your
            working context. It tells you exactly how to connect and which door to use.
          </Lead>
          <CodeBlock label="agent-instructions.md" language="markdown" code={AGENT_INSTRUCTIONS} />
        </Section>

        <Section aria-label="FAQ" width="default">
          <SectionHeading className="mb-8">Frequently asked</SectionHeading>
          <FaqList items={FAQ} />
        </Section>

        <ChipRow label="Read next">
          <ChipLink href="/comparisons/backenly-vs-supabase">vs. Supabase</ChipLink>
          <ChipLink href="/features">Features</ChipLink>
          <ChipLink href="/use-cases">Use cases</ChipLink>
          <ChipLink href="/pricing">Pricing</ChipLink>
          <ChipLink href="/resources">Resources</ChipLink>
        </ChipRow>

        <CtaSection
          title="Point your agent at a real backend"
          body="Free forever plan, one live project, no card required."
        >
          <PrimaryButton href="/auth/signup">
            Get your MCP key
            <InlineArrow />
          </PrimaryButton>
          <SecondaryButton href="/pricing">See pricing</SecondaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
