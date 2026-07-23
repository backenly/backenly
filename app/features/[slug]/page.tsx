import { Metadata } from 'next'
import { safeJsonLd } from "@/lib/security/safe-jsonld"
import { notFound } from 'next/navigation'
import { Sparkles, Database, Lock, Zap, Rocket, type LucideIcon } from 'lucide-react'
import { SiteShell } from '@/components/site/SiteShell'
import {
  Breadcrumb,
  InlineArrow,
  PageHero,
  PrimaryButton,
  Section,
  SectionHeading,
  Lead,
  Card,
  IconTile,
  FaqList,
  CtaSection,
  ChipRow,
  ChipLink,
  MutedChipLink,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

type FeatureData = {
  slug: string
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

const FEATURES: Record<string, FeatureData> = {
  'ai-backend-generation': {
    slug: 'ai-backend-generation',
    name: 'AI Backend Generation',
    icon: Sparkles,
    metaTitle: 'AI Backend Generation — Build a Complete Backend from Plain English',
    metaDescription:
      'Backenly generates a production-ready backend automatically from a plain English description. Database schema, REST APIs, authentication, and storage — all created by AI in minutes.',
    headline: 'Your entire backend, generated from a description',
    subheadline: 'Tell Backenly what you need. The AI builds it — schema, APIs, auth, storage — instantly.',
    what: "AI backend generation is the core of Backenly. Instead of manually designing a database schema, writing API endpoints, configuring authentication, and setting up storage, you describe what you need in plain English. Backenly's two-brain AI system understands your intent and generates a complete, production-ready backend automatically.",
    how: "You write a description like \"I need a database for an e-commerce app with products, orders, and customers. Each order should belong to a customer and contain multiple products.\" Backenly parses this description, extracts the data model, infers relationships, generates a normalized PostgreSQL schema, creates REST API endpoints for every table, applies row-level security, wires up authentication, and deploys everything — all in one step.",
    why: "Building a backend manually requires weeks of engineering work: designing schemas, writing migrations, building API routes, implementing auth, configuring storage, and managing deployments. AI backend generation eliminates every step. You go from idea to working backend in minutes, not weeks.",
    inPractice: "Take the description \"users can post recipes with photos, follow each other, and save favorites — users only edit their own recipes.\" Backenly shows you the full plan first: four tables (users, recipes, follows, favorites), the foreign keys between them, the API endpoints, and the access policies derived from that last clause. You confirm with one click, the platform applies the plan as governed steps, and then — the part that separates this from a code generator — it verifies the result behaviorally: a real test signup over live HTTP, real CRUD calls against the generated endpoints, and a second test user who is proven to receive zero rows of the first user's private data. Every check comes back with expandable evidence — in your coding agent's response and in the project History. If one fails, you see the failure, not a green checkmark.",
    details: [
      {
        title: 'Intent understanding',
        body: "Backenly's first AI brain extracts an intent graph from your description — entities, relationships, access rules, and actions — without writing a single line of SQL.",
      },
      {
        title: 'Automated schema generation',
        body: 'The AI generates a properly normalized PostgreSQL schema with the correct column types, constraints, indexes, and foreign key relationships based on your description.',
      },
      {
        title: 'API generation included',
        body: 'Every table gets a complete REST API automatically — list, create, get, update, delete, filter, and sort endpoints, all properly authenticated.',
      },
      {
        title: 'Iterative generation',
        body: 'Change your mind? Describe the change to Backenly. The AI updates the schema and APIs incrementally — no manual migrations or refactoring required.',
      },
    ],
    faq: [
      {
        q: 'What languages or frameworks does Backenly support?',
        a: 'Backenly generates a standard REST API accessible from any language or framework — JavaScript, Python, Swift, Kotlin, or anything else that can make HTTP requests. A JavaScript SDK is also included.',
      },
      {
        q: 'Can I change my backend after it is generated?',
        a: "Yes. You can describe changes to Backenly at any time — add a new table, rename a column, add a relationship — and the AI will update your backend incrementally. Backenly maintains a full change history with rollback support.",
      },
      {
        q: 'How complex can my backend description be?',
        a: 'Backenly handles complex multi-entity schemas with relationships, business rules, and role-based access control. It is designed for real production applications, not simple demos.',
      },
    ],
    relatedFeatures: ['database-setup', 'api-generation', 'authentication', 'deployment-ready-backends'],
  },
  'database-setup': {
    slug: 'database-setup',
    name: 'Database Setup',
    icon: Database,
    metaTitle: 'Automatic Database Setup — PostgreSQL Schema Generated from Plain English',
    metaDescription:
      'Backenly automatically generates a production-ready PostgreSQL database schema from a plain English description. Tables, columns, relationships, indexes, and row-level security — zero configuration.',
    headline: 'A production PostgreSQL database, generated automatically',
    subheadline: 'Describe your data model in plain English. Backenly creates the schema, tables, relationships, and security policies automatically.',
    what: "Backenly's database setup feature automatically generates a complete PostgreSQL database schema from your natural language description. You describe what data your application needs and how it is related — Backenly generates the tables, columns, data types, foreign key relationships, indexes, and row-level security policies. No schema design sessions, no hand-written migration files. What you get is ordinary PostgreSQL: query it with standard SQL, or through the same PostgREST grammar Supabase serves, with embedded resources and the full filter vocabulary. The generation replaces the design work, not the API you already know.",
    how: "When you describe your backend, Backenly's AI identifies the entities in your description and the relationships between them. It selects appropriate PostgreSQL data types for each field, creates proper foreign key constraints to maintain referential integrity, adds indexes for common query patterns, and applies row-level security policies to protect your data at the database level.",
    why: "Database design is time-consuming and error-prone. Getting the schema right requires experience — understanding normalization, choosing the right data types, designing for query performance, and implementing security correctly. Backenly handles all of this automatically, giving you a production-grade schema without the weeks of work.",
    inPractice: "The test of a schema tool is not creating tables — it is changing them once they hold live data. Ask Backenly to \"add a comments table, each task can have multiple comments\" and it plans the change against your live backend: the new table, the foreign keys, the APIs, and policies consistent with your existing rules, applied as governed steps and verified afterward. Ask it to \"drop the projects table\" and it refuses to run silently: an approval card shows exactly how many live rows are affected and whether the data is recoverable, and nothing happens until you explicitly confirm. Every change — additive or destructive — gets a restore point, so the schema can be rolled back to any saved version. Each project's schema is also physically isolated in its own PostgreSQL namespace, so no bug or query can ever cross between projects.",
    details: [
      {
        title: 'Normalized schema design',
        body: 'Backenly generates properly normalized tables — eliminating data duplication and ensuring referential integrity through correct use of foreign keys and join tables.',
      },
      {
        title: 'Appropriate data types',
        body: 'The AI selects correct PostgreSQL data types for each field — UUIDs for IDs, timestamps with timezone for dates, JSONB for flexible data, text vs. varchar as appropriate.',
      },
      {
        title: 'Row-level security',
        body: "Backenly automatically generates PostgreSQL row-level security policies so each user only sees their own data. You don't need to implement access control in your API code.",
      },
      {
        title: 'Schema evolution',
        body: "Need to add a column or a new table? Describe the change and Backenly updates the schema safely — with migration tracking and the ability to roll back.",
      },
    ],
    faq: [
      {
        q: 'Does Backenly use PostgreSQL?',
        a: 'Yes. Backenly uses PostgreSQL — the industry-standard open-source relational database. Your data is stored in a properly isolated PostgreSQL schema per project.',
      },
      {
        q: 'Can I access the database directly?',
        a: 'Yes. You can provision a read-only PostgreSQL connection string on demand, and arm a read-write one explicitly from the dashboard — both scoped to your project’s schema. Full pg_dump exports are available any time, and read-only SQL (joins, aggregates, window functions, CTEs, EXPLAIN) runs from the CLI and over MCP. What Backenly governs is structural change: schema mutations go through planned, verified, reversible actions rather than ad-hoc DDL — so your data is portable, while your schema stays accountable.',
      },
      {
        q: 'What happens to my data if I upgrade or downgrade my plan?',
        a: 'Your data is preserved across plan changes. Upgrading gives you more storage and capacity; downgrading retains your data within the limits of the new plan.',
      },
    ],
    relatedFeatures: ['ai-backend-generation', 'api-generation', 'authentication', 'deployment-ready-backends'],
  },
  'authentication': {
    slug: 'authentication',
    name: 'Authentication',
    icon: Lock,
    metaTitle: 'Built-in Authentication — User Auth for Your Backend, Instantly',
    metaDescription:
      'Backenly includes complete user authentication out of the box — sign-up, sign-in, JWT tokens, session management, and access control. No auth library to configure or maintain.',
    headline: 'Complete user authentication, built in',
    subheadline: 'Sign-up, sign-in, JWT sessions, and access control — all included. No auth library to configure.',
    what: "Backenly includes a complete user authentication system for every project. End-users of your application can register, sign in, and authenticate API requests using JWT tokens. The authentication system is isolated per project — each project has its own user database and JWT secret, completely separate from all other projects.",
    how: "When your project is created, Backenly automatically provisions a users table in your project's workspace, sets up sign-up and sign-in API endpoints, configures JWT token generation and validation, and applies row-level security so each user can only access their own data. Your frontend can call the auth endpoints directly or use the Backenly SDK to handle authentication flows.",
    why: "Authentication is one of the most complex and security-critical parts of any backend. Getting it wrong can expose user data or allow unauthorized access. Backenly implements authentication correctly by default — using industry-standard JWT tokens, bcrypt password hashing, and proper session management — so you never have to worry about auth security.",
    inPractice: "From your frontend, auth is two SDK calls: backend.auth.signUp({ email, password }) creates a real row in your project's users table, and backend.auth.signIn(...) starts a session the SDK carries on every request automatically. Beyond email/password, projects can enable Google sign-in, email verification, and magic links — with hosted pages and branded emails handled by the platform. The part you never see is the part that matters most: because sessions integrate with row-level security in PostgreSQL, a signed-in user's queries are already scoped to their own data. After every build, Backenly proves this by signing in as a second test user and confirming they receive zero rows of another user's private data — with the evidence shown, not asserted.",
    details: [
      {
        title: 'Sign-up and sign-in endpoints',
        body: 'Backenly generates /auth/signup and /auth/signin endpoints for your project automatically. Users can register with email and password and receive JWT tokens for subsequent authenticated requests.',
      },
      {
        title: 'JWT-based sessions',
        body: 'Authentication uses short-lived JWT access tokens and longer-lived refresh tokens. Tokens are signed with a project-specific secret, completely isolated from other projects.',
      },
      {
        title: 'Row-level security integration',
        body: 'Authentication integrates with database row-level security — authenticated users can only read and write their own data, enforced at the database level, not just the API layer.',
      },
      {
        title: 'User management via SDK',
        body: 'The Backenly JavaScript SDK includes auth helpers for sign-up, sign-in, sign-out, and token refresh — so your frontend can handle authentication with a few lines of code.',
      },
    ],
    faq: [
      {
        q: 'Is authentication included on the free plan?',
        a: 'Yes. Authentication is included on all plans, including the free plan. There are no auth-specific limits or additional charges.',
      },
      {
        q: 'Can I customize the authentication flow?',
        a: "You can configure auth settings at the project level. Custom roles, permission policies, and access control rules can be set through the Backenly dashboard or AI commands.",
      },
      {
        q: 'Does Backenly support OAuth or social login?',
        a: 'Yes. Projects can enable Google sign-in for their end users, alongside email/password. Email verification and magic-link sign-in are also supported, with hosted pages and branded emails handled by the platform.',
      },
    ],
    relatedFeatures: ['ai-backend-generation', 'database-setup', 'api-generation'],
  },
  'api-generation': {
    slug: 'api-generation',
    name: 'API Generation',
    icon: Zap,
    metaTitle: 'Instant REST API on PostgREST — The API Is Your Schema',
    metaDescription:
      'Every table in Backenly is served by PostgREST — the same engine Supabase runs — reading straight from the PostgreSQL catalog. Filters, ordering, pagination, and embedded resources, with authorization enforced by Postgres grants and RLS.',
    headline: 'The API is your schema',
    subheadline: 'Every table is served by PostgREST, reading directly from the PostgreSQL catalog. No registry to keep in sync — a table created a second ago is queryable now.',
    what: "Every table in your project is served by PostgREST — the same engine Supabase runs — reading directly from the PostgreSQL catalog. There is no separate API registry to generate, deploy, or keep in sync: the API *is* the schema, so a table created a second ago is queryable immediately, and a column renamed a second ago is reflected without a rebuild. You get filtering, ordering, pagination, full-text search, and embedded resources across two surfaces that share one engine and one authorization path.",
    how: "Backenly exposes two surfaces over the same engine. `/api/v1/{projectId}/db/{table}` is Backenly's stable REST contract — list, create, get, update, delete with typed responses. `/api/v2/{projectId}/{table}` passes PostgREST's native grammar through untouched: `?price=gte.100`, `?or=(a.eq.1,b.eq.2)`, `?order=created_at.desc`, and embedded resources — `?select=*,author(*)` returns a post and its author in one round trip. If you already know Supabase or PostgREST, you know this API.",
    why: "Generated API layers drift. The moment the code that serves your data is separate from the schema that defines it, the two can disagree — and that gap is where stale endpoints, forgotten authorization checks, and 'the table exists but the API doesn't' bugs live. Reading from the catalog removes the gap by construction. Authorization is enforced by PostgreSQL grants and row-level security rather than by application code, so a request for another tenant's rows fails on a missing database privilege instead of on a check somebody remembered to write.",
    inPractice: "Every endpoint is testable from the dashboard the moment it exists: the APIs view lists each route per table, and an inline tester sends real requests against your live backend — type a JSON body into POST /auth/signup, send it, and watch the actual HTTP response, then open the users table and see the row it created. From code, the SDK mirrors the API one-to-one: backend.tasks.list({ where: { status: 'todo' }, orderBy: 'due_date', limit: 25 }) for filtered queries, backend.projects.list({ include: ['tasks'] }) to resolve relations server-side in one request, and backend.tasks.count(...) when you need numbers without rows. Because row-level security lives in the database, all of these return only what the calling user is allowed to see — there is no way to forget an authorization check in your client code.",
    details: [
      {
        title: 'Two surfaces, one engine',
        body: '/api/v1 is Backenly’s stable REST contract — list, create, get, update, delete with typed responses. /api/v2 is PostgREST’s native grammar, passed through untouched. Both read the same catalog and share one authorization path.',
      },
      {
        title: 'Embedded resources in one round trip',
        body: '?select=*,author(*) returns a post and its author together — the relationship is resolved from the foreign key in the catalog, so there is nothing to configure and no N+1 to hand-optimize.',
      },
      {
        title: 'Authorization in the database, not the app',
        body: 'Grants and row-level security decide what a request can reach. A read for another tenant’s rows — or for the auth table, or through an embedded resource — is refused by Postgres itself, not by a check in application code that someone has to remember to write.',
      },
      {
        title: 'Typed clients and a drift gate',
        body: 'Generate an OpenAPI spec and a typed client from the CLI. `backenly diff` exits non-zero when your committed types drift from the live schema, so contract drift fails CI instead of production.',
      },
    ],
    faq: [
      {
        q: 'Is this a custom API layer or a real standard?',
        a: 'It is PostgREST — the same open-source engine Supabase runs — reading directly from your PostgreSQL catalog. On query capability Backenly is at parity with Supabase: same engine, same grammar, embedded resources included. If you already know one, you know the other.',
      },
      {
        q: 'Do I have to regenerate the API when my schema changes?',
        a: 'No. The API is the schema. PostgREST reads the catalog, so a table or column created a second ago is queryable immediately — there is no registry to regenerate, redeploy, or keep in sync.',
      },
      {
        q: 'Can I add custom API logic or custom endpoints?',
        a: 'Yes — serverless TypeScript functions and event triggers add custom business logic that runs on API events, on a schedule, or at a public HTTPS endpoint.',
      },
      {
        q: 'Is there API documentation?',
        a: 'Every project’s live endpoints are browsable in the dashboard with an inline request tester, and the CLI exports an OpenAPI spec plus a typed client for your codebase.',
      },
    ],
    relatedFeatures: ['ai-backend-generation', 'database-setup', 'authentication', 'deployment-ready-backends'],
  },
  'deployment-ready-backends': {
    slug: 'deployment-ready-backends',
    name: 'Deployment-Ready Backends',
    icon: Rocket,
    metaTitle: 'Deployment-Ready Backends — Live in Minutes, No DevOps Required',
    metaDescription:
      'Backenly deploys your backend automatically. No Docker, no Kubernetes, no cloud consoles. Your backend goes live at a public URL in minutes — with monitoring, rollback snapshots, and continuous health management built in.',
    headline: 'Your backend is live before you finish your coffee',
    subheadline: 'No Docker, no Kubernetes, no cloud console. Backenly deploys and manages your backend automatically.',
    what: "Backenly deploys your backend automatically as part of the generation process. When you describe your backend and Backenly generates the schema and APIs, the entire backend is deployed and live at a public URL — without any deployment steps on your part. No Docker containers to build, no cloud infrastructure to provision, no Kubernetes manifests to write.",
    how: "Backenly runs your backend on managed infrastructure. When a new project is created or an update is applied, Backenly handles the deployment pipeline — provisioning the database, deploying the API server, configuring the network, and making the endpoints publicly accessible. The backend runs continuously and Backenly monitors it for health issues, applying automatic fixes when safe to do so.",
    why: "Deployment and DevOps is a full-time job. Managing cloud infrastructure, container orchestration, database provisioning, and monitoring requires specialized expertise and significant ongoing effort. Backenly handles all of this automatically, so you and your team can focus entirely on building your product.",
    inPractice: "Going live is a sentence — \"put it live\" — and before every deploy the platform captures a rollback snapshot, so shipping is never a one-way door. After launch, the autonomy loop takes over: it watches your real request traffic (requests, latency, error rates) on a cadence set by your plan — every 30 minutes on Free, every minute on Pro — detects anomalies, and reacts at the autonomy level you choose. In review-only mode, every proposed fix waits for your approval in a queue; in safe-fixes mode, low-risk repairs are applied automatically and written up afterward with what was detected, what changed, and how the fix was verified. The result is a backend with an operator on duty from day one — one that never sleeps and documents everything it touches.",
    details: [
      {
        title: 'Deployed in minutes',
        body: 'Your backend goes live at a public URL minutes after creation. No build step, no CI/CD pipeline to configure, no cloud console to navigate.',
      },
      {
        title: 'Deployment history and rollback',
        body: 'Every change to your backend creates a deployment record, and a rollback snapshot is saved before every deploy. If a change causes problems, roll back to any previous version from the dashboard.',
      },
      {
        title: 'Continuous health monitoring',
        body: 'Backenly monitors your backend continuously — real request metrics, schema integrity, auth configuration, and security policies — detecting issues and fixing the ones that are safe to fix.',
      },
      {
        title: 'Minimal maintenance overhead',
        body: 'You never patch servers, manage capacity, or babysit the database. Infrastructure upkeep is the platform\'s job; anything requiring a risky change is queued for your approval rather than done behind your back.',
      },
    ],
    faq: [
      {
        q: 'Where is my backend hosted?',
        a: "On Backenly Cloud, we host your backend on managed infrastructure — each project's data lives in a fully isolated PostgreSQL schema, with no data leakage between projects. Backenly is also open source (Apache-2.0), so you can self-host the whole platform on your own infrastructure instead.",
      },
      {
        q: 'Can I use a custom domain?',
        a: 'Custom domains are available on the Pro plan ($25/month) and above.',
      },
      {
        q: 'What is the uptime guarantee?',
        a: "Backenly is designed for production use. Specific SLA terms are available on the Enterprise plan. The Free and Pro plans receive the same infrastructure reliability — there is no degraded tier.",
      },
    ],
    relatedFeatures: ['ai-backend-generation', 'database-setup', 'api-generation'],
  },
}

export function generateStaticParams() {
  return Object.keys(FEATURES).map((slug) => ({ slug }))
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const f = FEATURES[params.slug]
  if (!f) return { title: 'Not Found' }
  return {
    title: f.metaTitle,
    description: f.metaDescription,
    openGraph: { title: f.metaTitle, description: f.metaDescription, url: `${APP_URL}/features/${f.slug}`, type: 'website' },
    twitter: { card: 'summary_large_image', title: f.metaTitle, description: f.metaDescription },
    alternates: { canonical: `${APP_URL}/features/${f.slug}` },
  }
}

export default function FeatureSlugPage({ params }: { params: { slug: string } }) {
  const f = FEATURES[params.slug]
  if (!f) notFound()

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: f.faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: APP_URL },
      { '@type': 'ListItem', position: 2, name: 'Features', item: `${APP_URL}/features` },
      { '@type': 'ListItem', position: 3, name: f.name, item: `${APP_URL}/features/${f.slug}` },
    ],
  }

  const relatedList = f.relatedFeatures
    .map((slug) => FEATURES[slug])
    .filter(Boolean)

  const HeroIcon = f.icon

  return (
    <SiteShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbSchema) }} />
      <main className="relative z-20">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Features', href: '/features' },
            { label: f.name },
          ]}
        />

        <PageHero
          eyebrow="Feature"
          icon={
            <IconTile>
              <HeroIcon size={26} className="text-violet-300" strokeWidth={1.75} />
            </IconTile>
          }
          title={f.headline}
          subtitle={f.subheadline}
          actions={
            <PrimaryButton href="/auth/signup">
              Try it free
              <InlineArrow />
            </PrimaryButton>
          }
          proof={[
            { label: 'Generated', value: f.name },
            { label: 'Works with', value: 'Any frontend' },
            { label: 'Plan', value: 'Free to start' },
          ]}
        />

        {/* What / How / Why */}
        <Section className="!pt-0">
          <div className="flex flex-col gap-8">
            {[
              { label: `What is ${f.name}?`, body: f.what },
              { label: 'How it works', body: f.how },
              { label: 'Why it matters', body: f.why },
              { label: 'In practice', body: f.inPractice },
            ].map((block) => (
              <div key={block.label}>
                <SectionHeading className="!text-xl mb-3">{block.label}</SectionHeading>
                <Lead>{block.body}</Lead>
              </div>
            ))}
          </div>
        </Section>

        {/* Detail cards */}
        <Section aria-label="Feature details">
          <SectionHeading className="mb-8">What you get</SectionHeading>
          <div className="grid gap-5 sm:grid-cols-2">
            {f.details.map((d) => (
              <Card key={d.title}>
                <h3 className="text-base font-normal text-white mb-2">{d.title}</h3>
                <p className="text-sm text-neutral-400 font-extralight leading-relaxed">{d.body}</p>
              </Card>
            ))}
          </div>
        </Section>

        {/* FAQ */}
        <Section aria-label="Frequently asked questions" width="prose">
          <SectionHeading className="mb-8">Common questions</SectionHeading>
          <FaqList items={f.faq} />
        </Section>

        {/* Related features */}
        {relatedList.length > 0 && (
          <Section aria-label="Related features" className="!py-12">
            <ChipRow label="Related features:">
              {relatedList.map((r) => {
                const RelIcon = r.icon
                return (
                  <ChipLink key={r.slug} href={`/features/${r.slug}`}>
                    <RelIcon size={14} strokeWidth={1.75} aria-hidden="true" />
                    {r.name}
                  </ChipLink>
                )
              })}
              <MutedChipLink href="/features">
                All features
                <InlineArrow />
              </MutedChipLink>
            </ChipRow>
          </Section>
        )}

        <CtaSection
          title={`Try ${f.name} free`}
          body="One free project. No credit card. No infrastructure setup."
        >
          <PrimaryButton href="/auth/signup">Get started free</PrimaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
