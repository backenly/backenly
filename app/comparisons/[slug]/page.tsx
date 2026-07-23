import { Metadata } from 'next'
import { safeJsonLd } from "@/lib/security/safe-jsonld"
import { notFound } from 'next/navigation'
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
  FaqList,
  CtaSection,
  ChipRow,
  ChipLink,
} from '@/components/site/kit'

const APP_URL = 'https://backenly.com'

type ComparisonRow = { aspect: string; competitor: string; backenly: string }

type ComparisonData = {
  slug: string
  competitor: string
  metaTitle: string
  metaDescription: string
  headline: string
  intro: string
  summary: string
  table: ComparisonRow[]
  /** In-depth analysis sections rendered after the table. */
  deepDive: { heading: string; body: string }[]
  backenlySuitsWho: string
  competitorSuitsWho: string
  faq: { q: string; a: string }[]
}

const COMPARISONS: Record<string, ComparisonData> = {
  'backenly-vs-supabase': {
    slug: 'backenly-vs-supabase',
    competitor: 'Supabase',
    metaTitle: 'Backenly vs. Supabase — Autonomous Backend vs. Open-Source BaaS',
    metaDescription:
      'Backenly vs. Supabase: same PostgreSQL, same PostgREST query grammar. The difference is who designs the schema, writes the policies, and operates it after launch.',
    headline: 'Backenly vs. Supabase',
    intro:
      'Supabase is an excellent open-source Backend-as-a-Service platform built on PostgreSQL. It provides a database, auto-generated APIs, authentication, and storage. Developers who are comfortable with SQL and want maximum control over their schema love it.',
    summary:
      "Backenly and Supabase run the same query engine: PostgreSQL served through PostgREST. The filters, ordering, pagination, and embedded resources are the same grammar, so a developer fluent in Supabase is fluent in Backenly on day one — and Backenly adds a stable typed REST contract alongside it. The difference is not the API, it is who does the work around it. On Supabase you design the schema, write the migrations, author the RLS policies, and own monitoring and recovery. On Backenly you describe the backend and it plans and applies those changes through a governed action system with dry-run, audit, and rollback, then keeps watching the running system and repairs what drifts. Supabase is better if you want to own that work directly. Backenly is better if you want the same Postgres API without owning it. Both are open source and self-hostable.",
    table: [
      { aspect: 'Database', competitor: 'PostgreSQL — you design the schema in SQL', backenly: 'PostgreSQL — the schema is planned from your description, then applied as governed steps' },
      { aspect: 'Query API', competitor: 'PostgREST — filters, ordering, embedded resources', backenly: 'The same PostgREST grammar, unchanged — plus a stable typed REST contract alongside it' },
      { aspect: 'Reading your data', competitor: 'Standard SQL and the PostgREST grammar', backenly: 'Identical — standard SQL reads, same grammar, same embedded resources' },
      { aspect: 'Changing structure', competitor: 'You write and run the migration', backenly: 'Typed actions with dry-run, audit, and rollback — no accidental DROP' },
      { aspect: 'Authentication', competitor: 'Manual configuration — choose providers, set up flows', backenly: 'Built-in, configured automatically per project' },
      { aspect: 'Setup time', competitor: 'Hours to days — schema design, auth setup, storage config', backenly: 'Minutes — describe, review the plan, apply' },
      { aspect: 'Technical knowledge required', competitor: 'SQL, PostgreSQL, basic backend understanding', backenly: 'The same Postgres fluency pays off — but the schema, policy, and migration work is done for you' },
      { aspect: 'Row-level security', competitor: 'You write and test policies in SQL', backenly: 'Generated from plain-English rules, then behaviorally verified' },
      { aspect: 'Who operates it after launch', competitor: 'You — monitoring, incident response, and schema upkeep are yours', backenly: 'The platform — anomaly detection, safe fixes, approval queue for risky changes' },
      { aspect: 'Destructive change protection', competitor: 'None by default — a DROP TABLE runs if you run it', backenly: 'Blocked pending approval, with live row counts and restore points' },
      { aspect: 'Open-source', competitor: 'Yes — self-hostable', backenly: 'Yes — Apache-2.0, self-hostable, including the autonomy engine' },
      { aspect: 'Pricing', competitor: 'Free tier + paid plans starting at $25/month', backenly: 'Free forever plan + Pro at $25/month — same price, plus the autonomous operating layer' },
    ],
    deepDive: [
      {
        heading: 'The real difference is who does the assembly — and the upkeep',
        body: "Supabase's parts are genuinely excellent, and this comparison assumes you know that. But a backend is not a pile of parts. Between 'I have a Supabase project' and 'my product has a working backend' sits the assembly: designing a normalized schema, writing row-level security policies that actually block what they should, configuring auth flows, wiring storage rules, and setting up something to tell you when production degrades. For an experienced backend developer that is a satisfying week. For everyone else it is the place projects stall — or worse, ship with an RLS policy that silently leaks rows between users. Backenly's position is that the assembly and the upkeep are the product: you describe the rules in plain English, the platform builds them, and then it proves the isolation works by signing in as a second test user and showing you the evidence.",
      },
      {
        heading: 'What happens on week six, not day one',
        body: "Day-one comparisons flatter every tool. The divergence shows up when your tables have live data. On Supabase, a schema change is a migration you write and test, an incident is a page you respond to, and a mistaken DROP is recoverable only if you configured backups and know how to restore them. On Backenly, schema changes are planned against the live backend and applied as governed steps; destructive requests stop at an approval card showing exactly how many live rows are affected; every change gets a restore point; and a monitoring loop watches real traffic on a fixed cadence, fixing what is safe to fix and queueing what is not. Neither model is universally right: full manual control is a feature for professional operators, and an operating layer is a feature for everyone who doesn't want that job.",
      },
      {
        heading: 'Migration and coexistence',
        body: "This is not a one-way door. Backenly's output is standard PostgreSQL and REST — the same primitives a Supabase developer already knows — so a developer joining later finds familiar ground, not a proprietary runtime. Moving an existing Supabase project means exporting your data and describing your schema to Backenly (the team helps with complex migrations). And a common middle path exists: teams keep a hand-built system where they need full control and put new products on Backenly, where speed and hands-off operations matter more.",
      },
    ],
    backenlySuitsWho: 'Developers shipping with AI coding agents, founders running products with real users, and startup teams who want the backend operated for them — keeping the Postgres API they already know, without owning the migration, policy, and recovery work behind it.',
    competitorSuitsWho: 'Developers who want direct SQL-level control and are comfortable designing schemas and configuring backends manually.',
    faq: [
      { q: 'Does Backenly use the same database as Supabase?', a: 'Yes — PostgreSQL, served through PostgREST, the same engine Supabase runs. The query grammar is identical: ?price=gte.100, ?or=(a.eq.1,b.eq.2), ?order=created_at.desc, and embedded resources like ?select=*,author(*). What differs is that structural changes go through governed, reversible actions instead of hand-written migrations, and a monitoring loop operates the backend after launch.' },
      { q: 'Can I migrate from Supabase to Backenly?', a: 'Because both run PostgreSQL and PostgREST, your queries and client code carry over largely unchanged — the filter grammar and embedded resources are the same. Migration is a pg_dump of your data plus describing your schema to Backenly, and your row-level security model maps onto Postgres grants and RLS the same way. The Backenly team can assist with complex migrations.' },
      { q: 'Is Backenly cheaper than Supabase?', a: "Both Pro plans cost $25/month. The difference is what the $25 buys: Supabase Pro raises capacity; Backenly Pro raises capacity and includes the autonomous self-healing loop (every minute, company-funded — it never draws from your AI credits). Backenly's free plan is permanent and includes 1 project." },
    ],
  },
  'backenly-vs-firebase': {
    slug: 'backenly-vs-firebase',
    competitor: 'Firebase',
    metaTitle: 'Backenly vs. Firebase — Autonomous Backend vs. Google NoSQL BaaS',
    metaDescription:
      'Backenly vs. Firebase: Backenly uses PostgreSQL with AI-generated relational schemas and REST APIs. Firebase uses a NoSQL document model with manual data structure design. Compare both for your use case.',
    headline: 'Backenly vs. Firebase',
    intro:
      "Firebase is Google's Backend-as-a-Service platform, offering a NoSQL Realtime Database and Firestore, along with authentication, hosting, and serverless functions. It is widely used for mobile apps and apps that need simple realtime data.",
    summary:
      "Backenly and Firebase address different backend needs. Firebase uses a document-based NoSQL model — flexible for simple data but limiting for complex relational queries. Backenly uses PostgreSQL — the industry-standard relational database — which handles structured, relational data better and supports complex queries naturally. Backenly also generates the entire backend automatically from a plain English description, while Firebase requires you to design your data structure, write security rules, and configure each service manually. For apps with complex relational data or teams without backend expertise, Backenly is typically a better fit.",
    table: [
      { aspect: 'Database model', competitor: 'NoSQL document (Firestore / Realtime DB)', backenly: 'Relational (PostgreSQL)' },
      { aspect: 'Query capability', competitor: 'Limited — no joins, complex queries require denormalization', backenly: 'Full relational queries via REST API' },
      { aspect: 'API style', competitor: 'SDK-first, Firebase-specific client libraries', backenly: 'Standard REST API + JavaScript SDK' },
      { aspect: 'Setup required', competitor: 'Manual — design data structure, write security rules', backenly: 'None — AI generates from plain English description' },
      { aspect: 'Authentication', competitor: 'Manual configuration — many providers available', backenly: 'Built-in JWT auth, configured automatically' },
      { aspect: 'Vendor lock-in', competitor: 'High — Firebase SDK, Google proprietary formats', backenly: 'Very low — open source (Apache-2.0), self-hostable, standard REST + PostgreSQL' },
      { aspect: 'Backend monitoring', competitor: 'Manual — Firebase Console + Google Cloud monitoring', backenly: 'Built-in continuous monitoring with safe auto-fixes' },
      { aspect: 'Who operates it after launch', competitor: 'You — rules, indexes, and cost tuning are your job', backenly: 'The platform — anomaly detection, approval queue, restore points' },
      { aspect: 'Pricing model', competitor: 'Usage-based — costs grow with reads/writes at scale', backenly: 'Flat monthly plans — predictable costs' },
    ],
    deepDive: [
      {
        heading: 'The data-model decision you are actually making',
        body: "Choosing Firebase is choosing NoSQL documents, and that choice compounds. Document stores are wonderful while your data is simple and brutal once it is relational: no joins means denormalizing — copying data into multiple documents and keeping the copies in sync yourself. The classic Firestore trap is discovering in month four that your marketplace needs a query ('orders by users who follow this seller') the data model cannot express without restructuring collections and backfilling. PostgreSQL — what Backenly generates — expresses that query naturally, because relations are the model. If your product has users who own things that reference other things (most products), you have relational data, whichever database you put it in.",
      },
      {
        heading: 'Security rules vs. verified policies',
        body: "Firebase access control lives in its security-rules language — powerful, but hand-written, and wrong rules fail silently by allowing reads they shouldn't. Google's own docs urge you to write tests for your rules; almost nobody does. Backenly generates row-level security in PostgreSQL from your plain-English rules and then behaviorally verifies them after every build: it signs in as a second test user over live HTTP and shows you the zero-rows evidence. The difference is not which system can be made secure — both can — it is which system checks.",
      },
      {
        heading: 'Cost predictability at scale',
        body: "Firebase bills per operation, and the bill is a function of how well you modeled your data — a chatty listener or an unindexed query pattern turns directly into money. Teams routinely discover this in their first month of real traffic. Backenly's plans are flat (free to validate, $25/month Pro, Enterprise above), with quotas you can see. Neither model is dishonest, but they fail differently: usage pricing surprises you with a bill; flat pricing surprises you with a quota. For a small team, the quota is the survivable surprise.",
      },
    ],
    backenlySuitsWho: 'Apps with structured, relational data — e-commerce, SaaS, user-generated content platforms — and teams without dedicated backend engineering expertise.',
    competitorSuitsWho: 'Mobile-first apps with simple data requirements, teams already in the Google ecosystem, and apps that need Firebase-specific features like push notifications or Firebase ML.',
    faq: [
      { q: 'Is Firebase a good alternative to Backenly?', a: 'Firebase and Backenly serve different use cases. Firebase is better for simple, document-based data with mobile SDK integration. Backenly is better for structured relational data and teams who want AI-generated backend infrastructure.' },
      { q: 'Does Backenly support realtime like Firebase?', a: 'Yes. Backenly includes realtime subscriptions via Server-Sent Events. You can subscribe to database changes and receive updates in real time — similar to Firebase Realtime Database, but built on PostgreSQL.' },
      { q: 'Is Backenly more expensive than Firebase?', a: "Both have permanent free tiers. The difference is the pricing model: Firebase bills per operation, so costs grow with reads and writes and depend heavily on how your data is modeled. Backenly uses flat monthly plans ($0 Free / $25 Pro, Enterprise above) with visible quotas — more predictable for a small team budgeting ahead." },
    ],
  },
  'backenly-vs-no-code-builders': {
    slug: 'backenly-vs-no-code-builders',
    competitor: 'No-Code Builders',
    metaTitle: 'Backenly vs. No-Code App Builders — AI Backend vs. Bubble, Webflow, and Others',
    metaDescription:
      'Backenly vs. no-code builders like Bubble and Webflow: Backenly is backend-only and gives you a real database + REST API. No-code builders bundle frontend and backend, limiting your frontend choices.',
    headline: 'Backenly vs. No-Code App Builders',
    intro:
      "No-code app builders like Bubble, Webflow, Adalo, and FlutterFlow let you build applications visually without writing code. They bundle the frontend and backend in a single tool, which makes simple apps fast to build. The limitation appears when you need more control over your data, a custom frontend, or integration with external services.",
    summary:
      "Backenly and no-code builders address the same pain point — building apps without backend engineering — but in fundamentally different ways. No-code builders replace your entire stack (frontend + backend) with their visual editor. Backenly is backend-only — you get a real PostgreSQL database, REST APIs, and authentication that you can connect to any frontend. This means Backenly works with React, Vue, Next.js, mobile apps (React Native, Flutter), or any other frontend stack. No-code builders lock you into their frontend environment, which limits what you can build and makes it harder to switch later.",
    table: [
      { aspect: 'Frontend choice', competitor: 'Locked to the no-code builder\'s frontend environment', backenly: 'Any frontend — React, Vue, mobile, or plain HTML' },
      { aspect: 'Database', competitor: 'Proprietary internal database, limited SQL access', backenly: 'Standard PostgreSQL — industry-standard' },
      { aspect: 'API access', competitor: 'Limited or none — data accessed via the builder\'s internal system', backenly: 'Full REST API — accessible from any client' },
      { aspect: 'Scalability', competitor: 'Often limited — performance degrades at scale', backenly: 'Production PostgreSQL, designed for real scale' },
      { aspect: 'Customization', competitor: 'Limited to what the visual editor supports', backenly: 'Custom triggers, functions, and security policies' },
      { aspect: 'Data portability', competitor: 'Difficult — data is locked in proprietary formats', backenly: 'Standard PostgreSQL — data is always portable' },
      { aspect: 'Developer handoff', competitor: 'Difficult — the codebase is the visual editor', backenly: 'Clean — hand off the REST API to any developer' },
      { aspect: 'Who operates it after launch', competitor: 'The platform hosts it; performance and logic debugging is on you', backenly: 'The platform — monitoring, safe fixes, approvals, restore points' },
      { aspect: 'Pricing', competitor: 'Varies — often higher at scale', backenly: 'Free forever + Pro at $25/month' },
    ],
    deepDive: [
      {
        heading: 'Bundling is the feature — and the ceiling',
        body: "No-code builders win the first week because everything is in one place: design a screen, bind it to data, ship. Backenly deliberately does not compete with that integration — it is backend-only. What you get in exchange is a real boundary: your frontend is yours (React, Vue, a Lovable or Bolt project, a mobile app), your data is standard PostgreSQL, and your API is plain REST. Boundaries feel like extra work on day one and become the most valuable property you own the first time you need a custom interface the visual editor can't express, a mobile app sharing the web app's data, or a developer to take over — three ordinary events that are ceilings in a bundled platform and non-events with a standard backend.",
      },
      {
        heading: 'The exit problem, stated honestly',
        body: "Ask any agency what happens when a successful Bubble app needs to scale or customize past the platform: the answer is a rebuild, at the moment the product can least afford one — traction has arrived and the foundation has to be replaced under it. This is not Bubble being bad; it is the structural cost of proprietary data and logic formats. A backend that is PostgreSQL and REST from day one has no equivalent cliff: the same API that served your no-code frontend serves whatever replaces it. If you take one heuristic from this page: choose tools by their exit paths, not their onboarding.",
      },
      {
        heading: 'Using both together',
        body: "The practical pattern in 2026 is not either/or. Visual builders — including the AI generation of them — are the best frontend tools non-developers have ever had. Because Backenly is a standard REST API with a hosted, typed SDK, anything that writes frontend code can build against it: drop the SDK snippet in and the app is wired to your real tables, auth, and storage instead of a backend the tool provisioned and forgot. You keep the visual builder's speed on screens; the data layer lives somewhere built to run and guard it — with verified access policies, approval-gated destructive changes, and continuous monitoring underneath.",
      },
    ],
    backenlySuitsWho: 'Builders who want a real database and REST API without backend engineering work, but still want full control over their frontend stack and data.',
    competitorSuitsWho: 'Non-technical builders who want to build simple apps quickly and are comfortable with the no-code platform\'s frontend environment and limitations.',
    faq: [
      { q: 'Can I use Backenly with Webflow or Framer?', a: 'Yes. Backenly provides a standard REST API that can be called from any frontend, including Webflow CMS interactions via custom JavaScript or Framer components.' },
      { q: 'Is Backenly a no-code tool?', a: "Backenly is often described as a no-code backend because you don't write backend code. But unlike traditional no-code builders, Backenly gives you a real database and REST API — not a proprietary visual environment. You still use your preferred frontend tools." },
      { q: 'What is the difference between Backenly and Bubble?', a: "Bubble is a full-stack no-code builder — you build both frontend and backend visually. Backenly is backend-only — you get a real PostgreSQL database, REST APIs, and auth. Backenly works with any frontend; Bubble locks you into its visual editor." },
    ],
  },
  'backenly-vs-traditional-backend-development': {
    slug: 'backenly-vs-traditional-backend-development',
    competitor: 'Traditional Backend Development',
    metaTitle: 'Backenly vs. Traditional Backend Development — AI-Generated vs. Hand-Written',
    metaDescription:
      'Backenly vs. traditional backend development: Backenly generates a complete backend in minutes. Traditional development takes weeks of engineering work. See the trade-offs for your team.',
    headline: 'Backenly vs. Traditional Backend Development',
    intro:
      'Traditional backend development means writing your backend by hand — designing a database schema, writing migration files, building REST or GraphQL API endpoints, implementing authentication, configuring storage, setting up CI/CD, and managing deployments. This approach gives maximum flexibility and control, but requires significant engineering expertise and time.',
    summary:
      "The core trade-off between Backenly and traditional backend development is speed vs. control. Traditional backend development gives you complete control over every architectural decision — database design, API structure, auth implementation, deployment strategy. Backenly generates a production-ready backend automatically from a plain English description, making decisions on your behalf based on best practices. For most product teams, especially early-stage startups and solo builders, the speed advantage of Backenly outweighs the control trade-off. For large engineering teams with complex, unique requirements, traditional development may still be the right choice.",
    table: [
      { aspect: 'Time to first working backend', competitor: 'Days to weeks — schema design, API dev, auth, deployment', backenly: 'Minutes — describe, review the plan, apply' },
      { aspect: 'Technical expertise required', competitor: 'Senior backend engineer — SQL, APIs, auth, DevOps', backenly: 'None — plain English description sufficient' },
      { aspect: 'Control over architecture', competitor: 'Complete — every decision is yours', backenly: 'High, with AI-set best-practice defaults' },
      { aspect: 'Maintenance overhead', competitor: 'High — schema migrations, dependency updates, monitoring', backenly: 'Low — the platform monitors, repairs safely, and asks before anything risky' },
      { aspect: 'Cost', competitor: '$5k–$30k+ up front, plus ongoing engineering time', backenly: 'Free to start, Pro at a flat $25/month' },
      { aspect: 'Iteration speed', competitor: 'Slow — schema changes require migration files and testing', backenly: 'Fast — describe the change, AI applies it' },
      { aspect: 'Portability', competitor: 'Complete — your code, your infrastructure', backenly: 'Complete — open source (Apache-2.0), self-hostable, standard PostgreSQL + REST' },
      { aspect: 'Customization ceiling', competitor: 'Unlimited — you can build anything', backenly: 'High — but bounded by what Backenly supports' },
    ],
    deepDive: [
      {
        heading: 'The honest math',
        body: "A competent freelance backend engineer runs $60–150+/hour depending on market. A minimal production backend — schema, APIs, auth, storage, deployment, basic monitoring — is realistically two to six weeks of work: $5,000–$30,000 before your first user, and that buys version one, not the ongoing changes. The counter-argument is real too: that money buys exactly the architecture you specify, owned outright. The question is timing. Spending five figures on infrastructure before validating a product is the most expensive way to discover the product needed to change. Most teams are better served validating on generated infrastructure and hiring when they know what they're building — at which point the engineer inherits standard PostgreSQL and REST, not a mystery.",
      },
      {
        heading: 'What hand-building buys that a platform cannot',
        body: "Full honesty requires this section. Hand-built backends have no capability ceiling: exotic data models, microsecond latency budgets, unusual protocols — all possible when you write every line, and a platform optimizes for the common shape instead. (Owning the infrastructure is no longer the dividing line — Backenly is open source and self-hostable — so the real boundary is the feature surface, not the hosting.) Backenly covers the standard product shape deeply (relational data, auth, permissions, files, realtime, event triggers, scheduled and serverless functions, integrations) and that covers most software products — but 'most' is not 'all'. If your backend is your product — you are building a database, a trading engine, a telecom system — hire engineers. If your backend serves your product, the calculus flips.",
      },
      {
        heading: 'The operating cost nobody budgets',
        body: "The invisible line item in traditional development is what happens after shipping: schema migrations against live data, dependency updates, monitoring setup, incident response, and the bus factor of the one person who understands the deployment. This is a permanent tax paid in your team's attention. On Backenly the operating layer is the platform: real-traffic monitoring on a fixed cadence, anomalies detected and safe fixes applied automatically (at the autonomy level you choose), destructive changes stopped for approval with live row counts, restore points on every change, and a written receipt for every autonomous action. A hired engineer can do all of this too — it is simply the part of the job that most often doesn't get done.",
      },
    ],
    backenlySuitsWho: 'Startups, solo builders, and product teams who need to ship quickly and do not want to spend weeks on backend engineering before validating their product.',
    competitorSuitsWho: 'Large engineering teams building highly complex or unique systems where the customization ceiling of a managed platform would be a constraint.',
    faq: [
      { q: 'Can I use Backenly for a production app?', a: 'Yes. Backenly is designed for production applications. The generated backend uses PostgreSQL, proper authentication, row-level security, and production-grade infrastructure. Many teams run production workloads on Backenly.' },
      { q: 'What if I need custom business logic?', a: 'Backenly supports custom event triggers (run on insert, update, delete, or webhook) and serverless AI functions. These allow you to add custom business logic without leaving the platform.' },
      { q: 'Can I hire a developer to extend my Backenly backend?', a: 'Yes. Backenly generates standard REST APIs and PostgreSQL — any backend developer can understand and extend your backend via the Backenly dashboard or the AI interface.' },
    ],
  },
}

export function generateStaticParams() {
  return Object.keys(COMPARISONS).map((slug) => ({ slug }))
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const c = COMPARISONS[params.slug]
  if (!c) return { title: 'Not Found' }
  return {
    title: c.metaTitle,
    description: c.metaDescription,
    openGraph: { title: c.metaTitle, description: c.metaDescription, url: `${APP_URL}/comparisons/${c.slug}`, type: 'website' },
    twitter: { card: 'summary_large_image', title: c.metaTitle, description: c.metaDescription },
    alternates: { canonical: `${APP_URL}/comparisons/${c.slug}` },
  }
}

export default function ComparisonSlugPage({ params }: { params: { slug: string } }) {
  const c = COMPARISONS[params.slug]
  if (!c) notFound()

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: c.faq.map((item) => ({
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
      { '@type': 'ListItem', position: 2, name: 'Comparisons', item: `${APP_URL}/comparisons` },
      { '@type': 'ListItem', position: 3, name: c.headline, item: `${APP_URL}/comparisons/${c.slug}` },
    ],
  }

  const otherComparisons = Object.values(COMPARISONS).filter((x) => x.slug !== c.slug)

  return (
    <SiteShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(faqSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbSchema) }} />
      <main className="relative z-20">
        <Breadcrumb
          width="wide"
          items={[
            { label: 'Home', href: '/' },
            { label: 'Comparisons', href: '/comparisons' },
            { label: c.competitor },
          ]}
        />

        <PageHero
          width="wide"
          title={c.headline}
          subtitle={c.intro}
          actions={
            <>
              <PrimaryButton href="/auth/signup">
                Try Backenly free
                <InlineArrow />
              </PrimaryButton>
              <SecondaryButton href="/pricing">See pricing</SecondaryButton>
            </>
          }
          proof={[
            { label: c.competitor, value: 'Manual setup' },
            { label: 'Backenly', value: 'AI-generated setup' },
            { label: 'Database', value: 'PostgreSQL runtime' },
          ]}
        />

        {/* Summary */}
        <Section width="prose" className="!pt-0">
          <SectionHeading className="!text-xl mb-4">The key difference</SectionHeading>
          <Lead>{c.summary}</Lead>
        </Section>

        {/* Comparison table */}
        <Section aria-label="Feature comparison table" width="wide">
          <SectionHeading className="mb-8">Side-by-side comparison</SectionHeading>
          <div className="overflow-x-auto rounded-lg border border-white/10 bg-white/[0.025]">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-white/[0.035]">
                <tr className="border-b border-white/10">
                  <th className="text-left font-normal text-neutral-400 px-4 py-3 w-[28%]">Aspect</th>
                  <th className="text-left font-normal text-neutral-400 px-4 py-3">{c.competitor}</th>
                  <th className="text-left font-normal text-violet-300 px-4 py-3">Backenly</th>
                </tr>
              </thead>
              <tbody>
                {c.table.map((row, i) => (
                  <tr key={row.aspect} className={i % 2 === 0 ? '' : 'bg-white/[0.015]'}>
                    <td className="align-top px-4 py-3.5 text-white font-normal border-b border-white/[0.05]">
                      {row.aspect}
                    </td>
                    <td className="align-top px-4 py-3.5 text-neutral-400 font-extralight leading-relaxed border-b border-white/[0.05]">
                      {row.competitor}
                    </td>
                    <td className="align-top px-4 py-3.5 text-neutral-400 font-extralight leading-relaxed border-b border-white/[0.05]">
                      {row.backenly}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* In-depth analysis */}
        <Section width="prose" aria-label="In-depth analysis">
          <div className="flex flex-col gap-10">
            {c.deepDive.map((section) => (
              <div key={section.heading}>
                <h2 className="text-xl font-light tracking-tight text-white mb-3">
                  {section.heading}
                </h2>
                <Lead>{section.body}</Lead>
              </div>
            ))}
          </div>
        </Section>

        {/* Who each suits */}
        <Section width="wide">
          <div className="grid gap-5 sm:grid-cols-2">
            <Card>
              <p className="text-[11px] font-mono uppercase tracking-[0.15em] text-neutral-500 mb-3">
                {c.competitor} works best for:
              </p>
              <p className="text-sm text-neutral-400 font-extralight leading-relaxed">
                {c.competitorSuitsWho}
              </p>
            </Card>
            <Card className="!border-violet-400/20">
              <p className="text-[11px] font-mono uppercase tracking-[0.15em] text-violet-300 mb-3">
                Backenly works best for:
              </p>
              <p className="text-sm text-neutral-400 font-extralight leading-relaxed">
                {c.backenlySuitsWho}
              </p>
            </Card>
          </div>
        </Section>

        {/* FAQ */}
        <Section aria-label="Frequently asked questions" width="prose">
          <SectionHeading className="mb-8">Common questions</SectionHeading>
          <FaqList items={c.faq} />
        </Section>

        {/* Other comparisons */}
        <Section width="prose" className="!py-12">
          <ChipRow label="Other comparisons:">
            {otherComparisons.map((x) => (
              <ChipLink key={x.slug} href={`/comparisons/${x.slug}`}>
                {x.headline}
              </ChipLink>
            ))}
          </ChipRow>
        </Section>

        <CtaSection
          title="Try Backenly free"
          body="One free project. No credit card. No infrastructure to configure."
        >
          <PrimaryButton href="/auth/signup">Get started free</PrimaryButton>
          <SecondaryButton href="/pricing">See pricing</SecondaryButton>
        </CtaSection>
      </main>
    </SiteShell>
  )
}
