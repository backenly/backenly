/**
 * Comparison data — the single source of truth for /comparisons.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The four comparison pages used to be object literals inside the route file,
 * and the sitemap kept its own hand-written copy of the same four slugs. Two
 * lists of the same thing with nothing tying them together is how a page goes
 * live and stays out of the sitemap, or stays in the sitemap after it is gone.
 * `scripts/verify-content-integrity.ts` now checks them against each other, and
 * that check is only possible because the data lives here.
 *
 * WHAT A COMPARISON HAS TO CARRY
 * ------------------------------
 * Two fields are load-bearing and are enforced structurally rather than left to
 * review: `competitorStrengths` and `chooseCompetitorWhen`. A comparison page
 * that cannot say why a reader should pick the other product is an
 * advertisement wearing a table, and the build fails rather than shipping one.
 *
 * `facts` is the other honesty mechanism. Every statement about a competitor
 * that could be checked against their documentation carries the URL it came
 * from and the date it was read. Competitor pricing and capabilities move; a
 * claim with no date attached is a claim nobody can ever audit. The gate warns
 * when an entry gets stale rather than failing the build, because a stale fact
 * is a review task and a broken build is an outage.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * It is not a template that makes every page read the same. `architecture`,
 * `operating`, `agents` and `migration` are per-page and optional on purpose:
 * the agent-safety comparison is the heart of the Supabase page and would be
 * filler on the no-code one. Sections that would be padding are simply absent.
 *
 * Backenly claims here stay inside the audited boundary. In particular: the
 * autonomous repair band is narrow and enumerable, snapshots cover the
 * schema-touching repair classes rather than every change, and rollback is
 * plan-gated. None of those may be widened in copy.
 */

/**
 * A statement about a competitor that can be checked against a primary source.
 *
 * Official documentation, official pricing, or the official repository. Not
 * comparison blogs, not recollection.
 */
export type ExternalFact = {
  claim: string
  /** Official competitor URL the claim was read from. */
  source: string
  /** ISO date the source was last read. */
  verifiedOn: string
}

/**
 * One row of a capability table.
 *
 * The fourth column is the reason these tables are worth having. A row that
 * reduces to a tick against a cross tells a reader nothing and flatters
 * whoever wrote it; `practical` forces the row to say what the difference
 * actually costs or buys, including when the answer is "nothing".
 */
export type ComparisonRow = {
  aspect: string
  competitor: string
  backenly: string
  practical: string
}

export type ComparisonData = {
  slug: string
  /** Display name of the thing being compared against. */
  competitor: string
  /** Short category label for the index card. */
  category: string
  metaTitle: string
  metaDescription: string
  /** Card copy on the index. Never restated on /alternatives. */
  positioning: string
  headline: string
  intro: string
  summary: string
  /** How the two are shaped differently. Prose, because the answer is prose. */
  architecture: { heading: string; body: string }[]
  table: ComparisonRow[]
  /** Enforced: at least two, and they have to be real. */
  competitorStrengths: { title: string; body: string }[]
  backenlyStrengths: { title: string; body: string }[]
  /** Present only where the operating model is the actual difference. */
  operating?: { heading: string; body: string }
  /** Present only where agent access is a real point of divergence. */
  agents?: { heading: string; body: string }
  migration?: {
    heading: string
    body: string
    /** What the reader still owns. Never softened. */
    limits: string[]
    link?: { href: string; label: string }
  }
  chooseBackenlyWhen: string[]
  /** Enforced: at least one. */
  chooseCompetitorWhen: string[]
  faq: { q: string; a: string }[]
  facts: ExternalFact[]
}

const LIST: ComparisonData[] = [
  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'backenly-vs-supabase',
    competitor: 'Supabase',
    category: 'Open-source Postgres platform',
    metaTitle: 'Backenly vs. Supabase — the same Postgres, a different operating model',
    metaDescription:
      'Both serve PostgreSQL through PostgREST, so the query grammar is the same. The difference is who authors schema changes and policies, and who operates the backend after launch.',
    positioning:
      'Same database, same query grammar. The difference is who owns schema change, policy authorship, and recovery.',
    headline: 'Backenly vs. Supabase',
    intro:
      'Supabase is an open-source platform built on PostgreSQL, with auto-generated APIs, authentication, storage, and Edge Functions. It is a good product with a large ecosystem, and this page assumes you already know that.',
    summary:
      'These two run the same query engine. Both serve your tables through PostgREST on PostgreSQL, so filters, ordering, embedded resources, and exact counts use the same grammar, and a developer fluent in one is fluent in the other. The difference is not the API, it is the workflow around it. On Supabase you design the schema, write the migrations, author the row-level security policies, and own monitoring and recovery. On Backenly those structural changes go through one audited path with a change record and a restore point for schema-touching work, and a loop keeps checking a set of declared invariants after you stop looking. Neither model is universally correct. Owning the work directly is a feature if your team wants that job, and an operating layer is a feature if it does not.',
    architecture: [
      {
        heading: 'The same query engine, reached the same way',
        body: "Backenly's data plane is PostgREST, which is what Supabase serves its tables through. Filters, ordering, embedded resources in one round trip, upsert with a conflict target, exact counts over Content-Range: the same grammar on both sides, because it is the same software. Backenly publishes it at /api/v2/{projectId}/{table}, and ships a compatibility entry point in its SDK that emits PostgREST directly rather than translating into a narrower dialect. The practical consequence is that most of what you know transfers, and so does most of your client code.",
      },
      {
        heading: 'Where the products diverge: who applies the change',
        body: 'On Supabase a schema change is a migration you write, test, and run. That is a well-understood workflow with decades of tooling behind it, and it puts every decision in your hands. On Backenly a schema change is a typed action applied through a single kernel: planned against the live backend, recorded, and for schema-touching work snapshotted before it runs. Destructive operations do not execute on request. They stop at an approval naming the target, with the affected row count where it can be read cheaply. This is the trade the comparison turns on. You give up writing the migration; you get a path where a mistaken drop is a card rather than an incident.',
      },
      {
        heading: 'And who is watching afterwards',
        body: 'Supabase gives you logs, metrics, and a dashboard, and you decide what to do with them. Backenly declares a set of invariants about a backend — every table holding user data is protected by row-level security, no policy is silently a no-op, relationship columns have foreign keys and indexes, the REST plane is actually answering — and reconciles the live system against them on a schedule. Most findings are reported. A narrow, enumerable class is repaired automatically. Anything touching authentication, external credentials, or anything destructive requires a person, at every autonomy setting including the most permissive.',
      },
    ],
    table: [
      {
        aspect: 'Database',
        competitor: 'PostgreSQL',
        backenly: 'PostgreSQL',
        practical: 'No difference. Both are ordinary Postgres, and pg_dump moves data in either direction.',
      },
      {
        aspect: 'Query API',
        competitor: 'PostgREST',
        backenly: 'PostgREST, plus a typed REST surface alongside it',
        practical: 'The same grammar, so query code and mental models carry across without a rewrite.',
      },
      {
        aspect: 'Schema change',
        competitor: 'Migrations you author and run',
        backenly: 'Typed actions through one audited kernel, with a restore point on schema-touching work',
        practical: 'Direct control versus a reviewable path. Supabase gives you every decision; Backenly gives you a record and an undo.',
      },
      {
        aspect: 'Destructive operations',
        competitor: 'Run when you run them',
        backenly: 'Held for approval, with the target and its row count where cheaply readable',
        practical: 'A guardrail, not a capability difference. Both can drop a table; only one makes you confirm it twice.',
      },
      {
        aspect: 'Row-level security',
        competitor: 'You author policies; the docs require a pgTAP suite to know they work',
        backenly: 'Policy SQL installed verbatim and read back from pg_policies; invariants inspect known failure modes',
        practical: 'Neither removes your responsibility for the rule itself. Backenly checks a narrow set of ways a policy can be wrong.',
      },
      {
        aspect: 'After launch',
        competitor: 'Logs, metrics, and your own response',
        backenly: 'A reconciliation loop with a narrow automatic repair band and an approval queue',
        practical: 'The platform repairs only what it can repair safely. Everything else it reports, like any monitor.',
      },
      {
        aspect: 'Preview environments',
        competitor: 'Branching, wired into GitHub pull requests',
        backenly: 'Branch-scoped data environments, up to five active, selected by the API key',
        practical: "Supabase's is integrated with your git workflow. Backenly's covers the data and REST surfaces; auth, functions, and storage still resolve to main.",
      },
      {
        aspect: 'Agent access',
        competitor: 'Official MCP server with a broader tool surface, read-only mode, and project scoping',
        backenly: 'Twenty advertised tools; destructive operations are absent from the surface and route to approval',
        practical: 'Different safety models rather than different reach. See the agent section below.',
      },
      {
        aspect: 'Serverless functions',
        competitor: 'Edge Functions',
        backenly: 'Event, HTTP, and scheduled functions',
        practical: "Supabase's is a general-purpose edge runtime. Backenly's are shaped around database events.",
      },
      {
        aspect: 'Licence',
        competitor: 'Apache-2.0, self-hostable',
        backenly: 'Apache-2.0, self-hostable',
        practical: 'The same answer. Neither locks the door on the way out.',
      },
      {
        aspect: 'Billing shape',
        competitor: 'Pro starts at $25/month with metered dimensions above the included limits',
        backenly: 'Pro is a flat $25/month',
        practical: 'A difference in shape rather than headline price. Metered billing tracks what you use; a flat plan is easier to forecast and gives you a quota instead.',
      },
    ],
    competitorStrengths: [
      {
        title: 'A larger established ecosystem and community',
        body: 'Supabase has been generally available for years and Backenly has not. That difference shows up in the things an ecosystem produces: answered questions, third-party integrations, tutorials, and engineers who already know the platform. For many teams this alone decides it, and it is a rational reason.',
      },
      {
        title: 'Branching that plugs into your git workflow',
        body: 'Supabase branches are driven from GitHub, with a deployment workflow that runs on pushes and preview branches tied to pull requests. Backenly has branch-scoped data environments but nothing wired into pull requests. If preview-per-PR is central to how your team ships, Supabase does it and Backenly does not.',
      },
      {
        title: 'A general-purpose edge function runtime',
        body: "Edge Functions run arbitrary server-side code at the edge. Backenly's functions are shaped around database events, HTTP endpoints, and schedules, which covers a lot of application logic and is not the same thing as an open runtime.",
      },
      {
        title: 'A broader agent tool surface',
        body: "Supabase's official MCP server advertises more tools than Backenly's twenty, across more product areas including account management and Edge Functions. If you want the widest agent reach, theirs is wider.",
      },
      {
        title: 'A defined tier above Pro',
        body: 'Supabase publishes a Team plan above Pro. Backenly goes from a $25 Pro plan straight to a sales-led Enterprise conversation, which is a worse fit for a mid-size team that wants to self-serve.',
      },
    ],
    backenlyStrengths: [
      {
        title: 'One audited path for structural change',
        body: 'Every schema mutation goes through the same kernel, whether it came from the dashboard, an agent, or the repair loop. That is what makes a change history, a restore point, and an approval gate possible at all, rather than three features bolted onto three code paths.',
      },
      {
        title: 'Policy SQL is installed as written, and read back',
        body: 'Backenly has a typed door for row-level security that takes your predicate verbatim, installs exactly the commands you named, and re-reads pg_policies before reporting success. It exists because the alternative — describing a policy to a language model — was observed dropping conjuncts and quietly narrowing predicates.',
      },
      {
        title: 'Something keeps checking after you stop',
        body: 'The invariant set includes failures that are invisible from a dashboard: a policy technically enabled but evaluating to USING (true), a policy that denies everyone including the owner, and a policy written against session variables the data plane never sets, which matches nothing and returns 200 with an empty array.',
      },
      {
        title: 'The agent surface cannot execute a drop',
        body: 'Destructive tools are filtered out of the advertised MCP surface rather than present and discouraged. A request to drop a table becomes an approval id and a card for a person.',
      },
    ],
    operating: {
      heading: 'What the operating layer actually does, stated narrowly',
      body: 'Backenly reconciles a live backend against a set of declared invariants and sorts each finding into one of three outcomes. Applied automatically: a narrow, enumerable band that is additive or restorative — create a missing index, vacuum a bloated table, reindex a bloated index, install a row-security policy where ownership is derivable from the schema, restore a missing REST surface, register a schema that was never exposed, adopt schema changes made over a direct connection, restart a data plane that is already down. Held for a person: anything touching authentication, external credentials, or anything destructive or irreversible, at every autonomy level including the most permissive. Reported only: everything with no safe repair, which is most of the catalogue, including behavioural regressions where the cause is not in the measurement. Schema-touching repairs take a restore point before they run and re-probe afterwards, and the result records whether the gap was confirmed closed or merely attempted. If the backend is already mid-incident, automatic changes are frozen for that cycle, because mutating a failing system is how automation makes an outage worse.',
    },
    agents: {
      heading: 'Two different answers to the same agent question',
      body: "Both products ship an official MCP server, and Supabase's advertises more tools than Backenly's. Tool count is not the interesting difference. Supabase's approach is configuration: the server offers a read-only mode and project scoping, and their documentation recommends pointing it at a development project rather than production. That is sound advice and the controls are real, but they are controls you have to apply. Backenly's approach is structural: destructive operations are filtered out of the advertised surface entirely, so a model cannot select one, and a request to drop a table returns an approval id parked in a queue for a person. A key can additionally be minted read-only, which withholds every write door including the natural-language one, since a chat tool that can create a table is not read-only in any useful sense. The honest summary is that Supabase gives you a wider surface plus the settings to constrain it, and Backenly gives you a narrower one you do not have to remember to constrain.",
    },
    migration: {
      heading: 'Moving an existing project',
      body: 'Backenly publishes a compatibility entry point in its SDK that emits PostgREST directly, so a supabase-js frontend keeps its query grammar: filters, embedded resources, upsert with a conflict target, exact counts, and the { data, error } convention that never throws. Data moves with pg_dump, in either direction, because both sides are ordinary PostgreSQL. That is the whole of what is provided, and it is a client-compatibility bridge rather than a migration product.',
      limits: [
        'There is no migration service. Nothing here is done for you, on any plan.',
        'rpc() is not supported. Backenly exposes no SQL-function surface, so stored-procedure call sites need re-homing as event, HTTP, or scheduled functions.',
        'Policies are re-authored, not translated. Your row-level security model does not convert automatically.',
        "Auth and storage are Backenly's own implementations. Common calls map across; anything provider-specific needs checking.",
        'Moving the data and running the cutover remain your work.',
      ],
      link: { href: '/use-cases/migrate-from-supabase', label: 'The compatibility layer in detail' },
    },
    chooseBackenlyWhen: [
      'Nobody on the team wants to own migrations, policy review, and incident response, and you would rather that work were done by a system that keeps a change record.',
      'A coding agent is doing much of your building, and you want a surface where a bad turn structurally cannot drop a table.',
      'Predictable billing matters more to you than paying only for what you use.',
      'You want the Postgres API you already know without owning the operational work behind it.',
    ],
    chooseCompetitorWhen: [
      'Your team is comfortable owning schema design, migrations, and RLS review, and treats that control as a feature rather than a chore.',
      'Preview environments per pull request are central to how you ship.',
      'You need a general-purpose edge runtime rather than event-shaped functions.',
      'Ecosystem size, hiring pool, and the volume of existing answers are decisive. They are legitimate reasons, and Supabase wins on all three.',
      'You want a self-serve tier between a small paid plan and an enterprise contract.',
    ],
    faq: [
      {
        q: 'Do Backenly and Supabase really use the same query grammar?',
        a: 'Both serve tables through PostgREST on PostgreSQL, so filters, ordering, embedded resources, upsert with a conflict target, and exact counts behave the same way. Backenly exposes it at /api/v2/{projectId}/{table} and ships a compatibility entry point that emits PostgREST rather than translating it. The common path carries over; rpc() does not, because Backenly exposes no SQL-function surface.',
      },
      {
        q: 'Is Backenly cheaper than Supabase?',
        a: 'Not necessarily, and the comparison is a shape rather than a number. Both Pro plans start at the same advertised price. Supabase Pro adds metered dimensions above its included limits, so the bill tracks usage. Backenly Pro is flat, so the bill is predictable and you meet a quota instead of a line item. Which works out cheaper depends entirely on your usage.',
      },
      {
        q: 'Does Backenly make row-level security correct automatically?',
        a: 'No. It can install a policy you specify, exactly as written, and read it back to confirm what landed. It can generate one where row ownership is derivable from the schema, and where it is not, it refuses and asks you for the rule rather than guessing, because a wrong policy turns a data leak into an outage. Separately, a set of invariants inspects known ways a policy fails silently. The rule itself is still yours on both platforms.',
      },
      {
        q: 'Is Supabase open source? Is Backenly?',
        a: 'Both. The main Supabase repository is Apache-2.0 and self-hostable, and Backenly is Apache-2.0 and self-hostable including its autonomy engine, with the client packages under MIT. On licensing and exit path there is no meaningful difference to argue about.',
      },
    ],
    facts: [
      {
        claim:
          'Supabase plans: Free from $0/month, Pro from $25/month, Team from $599/month, Enterprise custom. Pro includes metered dimensions above plan limits, with spend caps on by default.',
        source: 'https://supabase.com/pricing',
        verifiedOn: '2026-09-02',
      },
      {
        claim:
          "Supabase ships an official MCP server with a broader tool surface than Backenly's twenty, supporting a read-only mode and project scoping. Its documentation recommends using it with a development project rather than production.",
        source: 'https://supabase.com/docs/guides/getting-started/mcp',
        verifiedOn: '2026-09-02',
      },
      {
        claim:
          'Supabase documents branching driven from GitHub, with preview branches tied to pull requests and a deployment workflow that runs on commits pushed to a git branch. New branches start without data from the main project.',
        source: 'https://supabase.com/docs/guides/deployment/branching',
        verifiedOn: '2026-09-02',
      },
      {
        claim:
          'Supabase documents that RLS is not enabled by default on new tables, and its guide requires a pgTAP test suite, stating that until the suite passes you do not know whether the policies do what you intended.',
        source: 'https://supabase.com/docs/guides/database/postgres/row-level-security',
        verifiedOn: '2026-09-02',
      },
      {
        claim: 'The main supabase/supabase repository is licensed Apache-2.0, and self-hosting is offered.',
        source: 'https://github.com/supabase/supabase',
        verifiedOn: '2026-09-02',
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'backenly-vs-firebase',
    competitor: 'Firebase',
    category: 'Google mobile and app platform',
    metaTitle: 'Backenly vs. Firebase — document store and mobile SDKs vs. relational Postgres',
    metaDescription:
      'Firebase is a document database with a mature mobile client ecosystem. Backenly is relational PostgreSQL with a governed change path. The data model is the decision that compounds.',
    positioning:
      'A document store with a mature mobile SDK ecosystem, against relational Postgres with an operating layer. The data model is the decision that compounds.',
    headline: 'Backenly vs. Firebase',
    intro:
      "Firebase is Google's app development platform: Firestore and the Realtime Database, authentication, hosting, Cloud Functions, and a mature first-party mobile SDK ecosystem. It is particularly strong for mobile-first products.",
    summary:
      'The real choice here is the data model, and it is the one decision that gets more expensive to revisit than any other. Firestore stores documents, which is flexible while your data is simple and becomes work once it is relational, because the native query API has no cross-collection joins and the documented pattern is to denormalise and keep the copies in sync yourself. Backenly is PostgreSQL, where relations are the model and a query across three tables is ordinary. Around that, the two products differ in what they do after launch: Firebase and Google Cloud give you a strong observability stack that tells you what is happening, and Backenly adds a repair loop that acts on a narrow class of findings and queues the rest for a person. If your product is mobile-first with simple data, Firebase is very hard to beat. If your data has relationships, start relational.',
    architecture: [
      {
        heading: 'Documents versus relations, and why it compounds',
        body: "Choosing Firestore is choosing a document model, and that choice propagates through everything you build on it. Document stores are excellent while access patterns are simple and become demanding when they are not: without cross-collection joins in the native query API, the documented approach is denormalisation, which means copying data into several documents and owning the consistency of those copies in application code. The failure mode is not that something breaks; it is that in month four a query the product now needs cannot be expressed without restructuring collections and backfilling. PostgreSQL expresses that query directly, because relations are the model rather than something layered on top. If your product has users who own things that reference other things, you have relational data whichever database you keep it in.",
      },
      {
        heading: 'Two honest ways to be surprised by a bill',
        body: 'Firestore is billed per operation, with a free daily allowance and metered usage above it, so the bill is a function of how your data is modelled and how chatty your listeners are. That is a fair model and it scales down to nothing for small projects. Backenly bills a flat monthly plan with visible quotas. Neither is dishonest and they fail differently: usage pricing surprises you with a bill, and a flat plan surprises you with a quota. For a small team, the quota is usually the more survivable surprise, and for a large one with efficient access patterns the metered model can easily be cheaper.',
      },
      {
        heading: 'What each platform does when something is wrong',
        body: 'Firebase and Google Cloud provide a mature observability stack: metrics, logging, error reporting, and alerting that will tell you a rule is rejecting traffic or a query is slow. It reports, and you act. Backenly reports too, and additionally acts on a narrow set of findings where the repair is additive and reversible — a missing index, a bloated table, a REST surface that stopped being served. Everything else, including anything touching authentication or anything destructive, is queued for a person. The difference is not that one platform watches and the other does not. It is that one of them will also apply a small, enumerable set of fixes without being asked.',
      },
    ],
    table: [
      {
        aspect: 'Data model',
        competitor: 'Document collections (Firestore, Realtime Database)',
        backenly: 'Relational PostgreSQL',
        practical: 'The decision that is hardest to reverse later. Pick it against your access patterns, not your first screen.',
      },
      {
        aspect: 'Cross-entity queries',
        competitor: 'No joins in the native query API; denormalisation is the documented pattern. Firestore Enterprise edition documents pipeline operations that join with subqueries',
        backenly: 'Ordinary SQL joins, and embedded resources over REST in one round trip',
        practical: 'On Firestore a relational query is a data-modelling exercise. On Postgres it is a query.',
      },
      {
        aspect: 'Mobile clients',
        competitor: 'Mature first-party SDKs for Android and Apple platforms, with offline persistence on by default',
        backenly: 'A JavaScript SDK and a standard REST API',
        practical: "Firebase is clearly stronger here. If you are building a native mobile app, this row may outweigh the rest of the table.",
      },
      {
        aspect: 'Offline behaviour',
        competitor: 'Local persistence and offline reads and writes, enabled by default on Android and Apple platforms',
        backenly: 'No offline persistence layer; the client talks to the API',
        practical: 'For an app expected to work on a train, Firebase solves a problem Backenly does not attempt.',
      },
      {
        aspect: 'Access control',
        competitor: 'Security Rules, a dedicated rules language with its own testing tooling',
        backenly: 'PostgreSQL grants and row-level security, with policy SQL installed verbatim and read back',
        practical: 'Both are capable and both can be got wrong. The difference is the language you express the rule in and where it is enforced.',
      },
      {
        aspect: 'Realtime',
        competitor: 'Realtime Database and Firestore listeners, a core strength',
        backenly: 'Change events over Server-Sent Events, built on Postgres LISTEN/NOTIFY',
        practical: 'Both deliver live updates. Firebase pairs its listeners with documented offline persistence; Backenly has no offline layer.',
      },
      {
        aspect: 'Observability and repair',
        competitor: 'Firebase console plus Google Cloud monitoring, logging, and alerting',
        backenly: 'The same reporting posture, plus a narrow set of repairs applied automatically and the rest queued for approval',
        practical: 'Not monitoring versus no monitoring. Reporting versus reporting plus a small, bounded set of automatic fixes.',
      },
      {
        aspect: 'Adjacent tooling',
        competitor: 'Crashlytics, Analytics, App Distribution, Remote Config, Cloud Messaging',
        backenly: 'None of these',
        practical: 'Firebase is a product suite. Backenly is a backend. If you want the suite, that is a real advantage.',
      },
      {
        aspect: 'Portability',
        competitor: 'Firestore export tooling; the data model is proprietary',
        backenly: 'Ordinary PostgreSQL and pg_dump; Apache-2.0 and self-hostable',
        practical: 'Leaving Postgres is a dump and a restore. Leaving a document model usually means remodelling the data.',
      },
      {
        aspect: 'Billing shape',
        competitor: 'Free Spark tier, then pay-as-you-go on Blaze, billed per operation',
        backenly: 'Flat monthly plans with visible quotas',
        practical: 'Metered cost tracks usage and can be cheaper or much more expensive. A flat plan trades that for predictability.',
      },
    ],
    competitorStrengths: [
      {
        title: 'A mature mobile SDK ecosystem with strong offline support',
        body: 'First-party Android and Apple SDKs, with offline persistence enabled by default on both, documented by Firebase itself. If you are shipping a native mobile app, this is a genuine advantage and Backenly does not compete with it.',
      },
      {
        title: 'Offline-first behaviour that actually works',
        body: 'Firestore caches locally and serves reads and writes while the device is offline, syncing when it reconnects. Building that on top of a REST API is a project in its own right.',
      },
      {
        title: 'A product suite, not just a backend',
        body: 'Crashlytics, Analytics, Cloud Messaging, Remote Config, and App Distribution sit alongside the database. If you want those integrated rather than assembled, Firebase gives you a coherent set on day one.',
      },
      {
        title: 'Google Cloud underneath',
        body: 'Scale, regional coverage, IAM, and an observability stack that a small team could not build. If your organisation is already on Google Cloud, the integration and the procurement path are both easier.',
      },
      {
        title: 'A free tier that scales down to genuinely nothing',
        body: 'The Spark plan needs no payment method, and Blaze keeps the free allowances. For a prototype with light traffic, the bill can stay at zero for a long time.',
      },
    ],
    backenlyStrengths: [
      {
        title: 'Relational data expressed as relational data',
        body: 'Joins, foreign keys, constraints, and transactions are the model rather than something you emulate. For products whose entities reference each other, this removes an entire class of consistency code from the application.',
      },
      {
        title: 'Authorisation enforced in the database',
        body: 'Access control is PostgreSQL grants and row-level security, applied where the data lives rather than in a separate rules layer, and the policy SQL is read back from the catalogue after it is installed.',
      },
      {
        title: 'Invariants that catch silent policy failures',
        body: 'A policy that is enabled but evaluates to USING (true), or one written against a session variable the data plane never sets, produces a healthy-looking 200 with no rows. These are the failures a dashboard cannot show you, and they have dedicated checks.',
      },
      {
        title: 'An exit that is a database dump',
        body: 'Standard PostgreSQL and REST, Apache-2.0 licensed and self-hostable. Moving off is a dump and a restore rather than a remodelling exercise.',
      },
    ],
    operating: {
      heading: 'Reporting, and the narrow band beyond it',
      body: 'Both platforms will tell you something is wrong. Firebase and Google Cloud do it with metrics, logs, error reporting, and alerts, and the response is yours. Backenly reports the same way and additionally repairs a small, enumerable set of findings without being asked: a missing index on a relationship column, a table carrying more dead rows than live ones, an index that is mostly empty space, a REST surface that stopped being served, a row-security policy where row ownership is derivable from the schema. Schema-touching repairs take a restore point first and re-probe afterwards. Anything touching authentication, external credentials, or anything destructive or irreversible always waits for a person, and cannot be made automatic by choosing a more permissive setting. Most of the catalogue is reported rather than repaired, which is the honest shape of the feature.',
    },
    migration: {
      heading: 'Moving from Firestore',
      body: 'There is no automated path, and it would be misleading to imply one. Moving from a document store to a relational schema means deciding what your entities and relationships actually are, which is design work that only your team can do. What Backenly provides on the other side is ordinary PostgreSQL and a REST API, so the destination is a standard one and the second migration, if you ever need it, is a pg_dump.',
      limits: [
        'No import tool and no migration service exists, on any plan.',
        'Remodelling documents into tables is design work you own.',
        'Security Rules do not translate into row-level security. The rules are re-authored.',
        'Backenly has no offline persistence layer, so an offline-first client needs rethinking.',
        'Firebase-specific services such as Crashlytics, Analytics, and Cloud Messaging have no Backenly equivalent and would stay where they are or be replaced.',
      ],
    },
    chooseBackenlyWhen: [
      'Your entities reference each other and you want joins, foreign keys, and transactions rather than denormalised copies.',
      'You want authorisation enforced by the database rather than in a separate rules language.',
      'Predictable monthly cost matters more than paying per operation.',
      'You want the option to take the whole thing elsewhere as an ordinary Postgres dump.',
    ],
    chooseCompetitorWhen: [
      'You are building a native mobile app and want first-party SDKs with offline persistence that already works.',
      'Your app must function offline and sync later. Firebase solves this; Backenly does not attempt it.',
      'You want Crashlytics, Analytics, Cloud Messaging, and Remote Config integrated rather than assembled.',
      'Your data is genuinely document-shaped, with few relationships and simple access patterns.',
      'Your organisation is already on Google Cloud and the integration and procurement path matter.',
    ],
    faq: [
      {
        q: 'Can Firestore really not do joins?',
        a: "Firestore's native query API has no cross-collection joins, and the documented pattern for relational access is to denormalise. Firestore's Enterprise edition documents pipeline operations that perform joins using subqueries, so the flat statement that Firestore cannot join is out of date. The practical point stands for the standard query API: relational access is a data-modelling exercise there and a query in Postgres.",
      },
      {
        q: 'Does Backenly do realtime like Firebase?',
        a: 'Backenly delivers database change events over Server-Sent Events, built on PostgreSQL LISTEN/NOTIFY through a shared listener hub. You can subscribe to changes and receive updates live. It does not replicate offline persistence or the local cache, which is a substantial part of what makes Firebase realtime feel the way it does on mobile.',
      },
      {
        q: 'Is Firebase less secure than Backenly?',
        a: 'No. Security Rules are a capable access-control system with their own testing tooling, and a correctly written rule set is secure. The difference is where the rule is enforced and what language it is written in: Firebase evaluates rules at its API layer, Backenly enforces grants and row-level security inside PostgreSQL. Both can be got wrong by the person writing them.',
      },
      {
        q: 'Which one is cheaper?',
        a: 'It depends on your traffic and your data model, and any answer that does not say so is guessing. Firestore bills per operation with a free daily allowance, so a low-traffic app can cost nothing and a chatty one can cost a lot. Backenly charges a flat monthly plan, so the cost is fixed and you meet a quota instead.',
      },
    ],
    facts: [
      {
        claim:
          'Firebase offers a no-cost Spark plan requiring no payment method and a pay-as-you-go Blaze plan that retains the Spark free allowances. Firestore is billed per operation, with free daily allowances for reads, writes, and deletes.',
        source: 'https://firebase.google.com/pricing',
        verifiedOn: '2026-09-02',
      },
      {
        claim:
          'Cloud Firestore documents no cross-collection joins in its native query API. Enterprise edition documents pipeline operations that perform joins with subqueries.',
        source: 'https://firebase.google.com/docs/firestore/query-data/queries',
        verifiedOn: '2026-09-02',
      },
      {
        claim:
          'Cloud Firestore offline persistence is supported on Android, Apple platforms, and web, and is enabled by default on Android and Apple platforms. On web it is off by default and must be enabled explicitly.',
        source: 'https://firebase.google.com/docs/firestore/manage-data/enable-offline',
        verifiedOn: '2026-09-02',
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'backenly-vs-no-code-builders',
    competitor: 'No-Code App Builders',
    category: 'Integrated visual builders',
    metaTitle: 'Backenly vs. no-code app builders — integrated builder or standalone backend',
    metaDescription:
      'Visual app builders integrate the frontend and the backend in one system. Backenly is backend-only: standard PostgreSQL and a REST API that any frontend can use. The difference is where the boundary sits.',
    positioning:
      'An integrated builder gives you one system with everything in it. Backenly is the data layer on its own, behind a standard API. The difference is where the boundary sits.',
    headline: 'Backenly vs. no-code app builders',
    intro:
      'Visual app builders let you assemble an application without writing code, with the interface, the logic, and the data living in one integrated environment. That integration is the product, and for a lot of applications it is exactly the right shape.',
    summary:
      'This is a comparison about architecture rather than capability, and the two are not really competing for the same job. An integrated builder gives you the interface and the data in one place, which is why a simple application comes together quickly in it. Backenly is deliberately only the back half: a PostgreSQL database and a REST API with authentication, storage, and realtime, and no opinion at all about your frontend. That means it does not replace a visual builder and cannot be judged on how fast it puts a screen on the internet. What it offers instead is a boundary — the data is standard Postgres, the interface is a standard API — and boundaries are worth little on day one and quite a lot the first time you need something the integrated environment does not express. The most useful framing is not either-or: many teams keep the visual builder for the interface and put the data layer somewhere it can be queried, secured, and taken with them.',
    architecture: [
      {
        heading: 'Integration is the feature, and it is also the ceiling',
        body: 'An integrated builder wins the first week precisely because everything is in one place: design a screen, bind it to data, publish. There is no API to design, no client to wire up, no second system to reason about. That is a real advantage and Backenly does not try to compete with it, because Backenly is backend-only and has no screen to give you. The trade is that the integrated environment defines what is expressible. When a requirement falls outside it — an interface the editor does not support, a second client such as a mobile app sharing the same data, a developer joining to extend what exists — you are working against the grain of the tool rather than with it. Neither shape is better. They are different bets about where you expect the surprises to come from.',
      },
      {
        heading: 'What a standalone data layer actually buys',
        body: 'Backenly gives you a PostgreSQL database and a REST API, and that is close to the whole pitch. The database is ordinary Postgres, so it can be queried with SQL, connected to with any Postgres client, dumped with pg_dump, and understood by anyone you hire. The API is ordinary REST with authentication and row-level security enforced in the database. Because it is a standard interface, anything that can make an HTTP request can build against it: a React app, a mobile client, a server-side job, or a frontend produced by a visual or AI-assisted builder. The value is not that this is faster than an integrated tool. It is that the data layer is independent of whatever is drawing the screens, so replacing the frontend does not mean replacing the backend.',
      },
      {
        heading: 'Using both, which is what people actually do',
        body: 'The framing where you must choose one is mostly a marketing artefact. Visual builders and AI-assisted frontend tools put interface building within reach of people who do not write code, and pointing one of them at a real backend is a well-supported pattern rather than a workaround. Because Backenly is a standard REST API with a typed SDK, a builder that can call an HTTP endpoint or import a package can work against real tables, real authentication, and real file storage instead of whatever store the builder provisioned. You keep the speed of the visual tool where it helps, on the screens, and the data lives somewhere designed to query, secure, and back it.',
      },
    ],
    table: [
      {
        aspect: 'Scope',
        competitor: 'Interface, logic, and data in one integrated system',
        backenly: 'Backend only: database, API, authentication, storage, realtime',
        practical: 'Not substitutes. A builder replaces your whole stack; Backenly replaces the back half of it.',
      },
      {
        aspect: 'Time to a working screen',
        competitor: 'Fast. Designing and binding data happen in the same place',
        backenly: 'Backenly does not produce a screen. You bring or build the frontend',
        practical: 'For getting something in front of a person this week, an integrated builder is the shorter path.',
      },
      {
        aspect: 'Frontend choice',
        competitor: "The builder's own environment",
        backenly: 'Any client that can make an HTTP request',
        practical: 'Matters when you need a second client, such as a mobile app on the same data, or a custom interface.',
      },
      {
        aspect: 'Database access',
        competitor: 'Varies by product; typically through the builder',
        backenly: 'Standard PostgreSQL, reachable by SQL and by any Postgres client',
        practical: 'Determines whether reporting, analytics, and ad-hoc queries are an ordinary task or a support question.',
      },
      {
        aspect: 'API surface',
        competitor: 'Varies by product',
        backenly: 'A documented REST API with a typed SDK',
        practical: 'A standard interface is what lets an unrelated tool, script, or hire build against your data unaided.',
      },
      {
        aspect: 'Authorisation',
        competitor: "Configured in the builder's own permissions model",
        backenly: 'PostgreSQL grants and row-level security, enforced in the database',
        practical: 'Enforcement in the database applies to every client equally, including ones you add later.',
      },
      {
        aspect: 'Developer handoff',
        competitor: 'A developer works inside the builder',
        backenly: 'A developer gets Postgres and REST, which they already know',
        practical: 'Relevant the day you hire, or hand the project to someone else.',
      },
      {
        aspect: 'Exit path',
        competitor: 'Varies by product; check the export story before you commit',
        backenly: 'pg_dump, plus Apache-2.0 source you can self-host',
        practical: 'Worth checking early on any platform. It is cheap to verify at the start and expensive to discover later.',
      },
    ],
    competitorStrengths: [
      {
        title: 'One system instead of two',
        body: 'Interface, logic, and data in a single place, with no API contract to design and no integration to maintain. For a straightforward application this removes most of the work, and it removes it at the stage where teams have the least capacity.',
      },
      {
        title: 'Genuinely fast for building a working application',
        body: 'Going from an idea to something a person can use is measured in hours in a good visual builder. Backenly cannot make that claim, because it gives you no interface at all.',
      },
      {
        title: 'Accessible to people who do not write code',
        body: 'An integrated builder is usable by someone who has never used a terminal. Backenly assumes you have a frontend and someone or something to build it, whether that is a developer or a coding agent.',
      },
      {
        title: 'Hosting and delivery included',
        body: 'The application is deployed and served by the same platform that builds it. With Backenly the backend is hosted, and where the frontend lives is still your decision.',
      },
    ],
    backenlyStrengths: [
      {
        title: 'The data layer is independent of the interface',
        body: 'Replacing or adding a frontend does not touch the backend. The same API serves a web app, a mobile client, and a background job without any of them knowing about the others.',
      },
      {
        title: 'Ordinary PostgreSQL',
        body: 'Queryable with SQL, connectable with any Postgres client, understood by anyone you hire, and portable with pg_dump. There is nothing proprietary to learn or to escape.',
      },
      {
        title: 'Authorisation in the database',
        body: 'Row-level security applies to every path into the data, so a client added later is subject to the same rules rather than needing them re-implemented.',
      },
      {
        title: 'It composes with the tools you are already using',
        body: 'Because the interface is a standard REST API with a typed SDK, a visual or AI-assisted frontend tool can build against real tables instead of a store it provisioned itself.',
      },
    ],
    chooseBackenlyWhen: [
      'You want the data layer to outlive whatever is currently drawing your screens.',
      'You need more than one client on the same data, such as a web app and a mobile app.',
      'You want SQL access, standard REST, and the ability to hand the backend to a developer without a tour.',
      'You are building the frontend with a coding agent or an AI-assisted tool and want it wired to a real backend.',
    ],
    chooseCompetitorWhen: [
      'You want an application, not a backend, and you want it working this week.',
      'Nobody on the project writes code and there is no agent or developer to build the interface.',
      'The application is well within what the builder expresses, and adding a second system would be pure overhead.',
      'Having the interface, the logic, the data, and the hosting in one place is worth more to you than a portable data layer.',
    ],
    faq: [
      {
        q: 'Is Backenly a no-code tool?',
        a: 'Not in the usual sense. You do not write backend code, but you do not get a visual application builder either. What you get is a real database and a real API, which still needs a frontend built by someone, whether that is you, a developer, or a coding agent.',
      },
      {
        q: 'Can I use Backenly with a visual builder or an AI frontend tool?',
        a: 'Yes, and it is a sensible pattern. Backenly exposes a standard REST API with a typed SDK, so any tool that can make an HTTP request or import a package can build against your real tables, authentication, and storage.',
      },
      {
        q: 'Why would I add a second system instead of using one?',
        a: 'Often you should not. If the application fits comfortably inside an integrated builder, one system is simpler and you should use it. The case for separating them is specific: you need a second client on the same data, you want SQL access, you expect to change the frontend, or you want the data layer to be portable. If none of those apply, the boundary is overhead.',
      },
    ],
    facts: [],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'backenly-vs-traditional-backend-development',
    competitor: 'Traditional Backend Development',
    category: 'Custom-built backends',
    metaTitle: 'Backenly vs. building your own backend — where a platform helps and where it stops',
    metaDescription:
      'A hand-built backend has no capability ceiling and costs engineering time to build and operate. Backenly covers a common shape and provides an operating layer. It does not remove engineering judgement.',
    positioning:
      'A hand-built backend has no capability ceiling. Backenly covers a common shape and operates it. The question is which constraint binds first for you.',
    headline: 'Backenly vs. building your own backend',
    intro:
      'Building a backend by hand means designing the schema, writing migrations, building endpoints, implementing authentication, configuring storage, setting up deployment, and operating all of it afterwards. It is well-understood work with mature tooling, and it produces exactly the system you specify.',
    summary:
      'The trade is capability ceiling against time and operational load, and it is worth stating plainly in both directions. A hand-built backend can do anything, because you write every line: unusual data models, specific latency budgets, protocols nothing else speaks. A platform optimises for a common shape and is bounded by what it supports. Backenly covers that common shape — relational data, authentication, permissions, files, realtime, event and scheduled functions — and adds an operating layer that watches declared invariants and repairs a narrow class of problems. What it does not do is remove engineering. You still decide what the data model should be, whether a proposed schema is right, what your access rules are, and what your product does. It removes a set of repetitive operational tasks, not judgement.',
    architecture: [
      {
        heading: 'What a platform is actually replacing',
        body: 'It is not the thinking. The parts of backend work that a platform can take on are the ones that are the same across most products: creating tables and keeping their migrations coherent, serving CRUD over an API, wiring session handling and token verification, enforcing per-row access, providing file storage with signed access, publishing change events, and running code on a schedule or an event. That list is genuinely repetitive, and reimplementing it per project is how a lot of engineering time gets spent. What remains is the part that is specific to your product: what the entities are, how they relate, what the rules are, what should happen when something changes. Backenly does not do that part, and any framing where it does is wrong.',
      },
      {
        heading: 'The ceiling is real, and it is the strongest argument for building',
        body: 'A hand-built backend has no capability limit, and that is not a small thing. If your backend is your product — you are building a database, an exchange, a protocol implementation, something with an unusual consistency model or a hard latency budget — a platform will be in your way, and the right answer is to hire engineers and write it. Ownership of the infrastructure is not the dividing line here, because Backenly is Apache-2.0 and self-hostable, so you can run it yourself and read all of it. The dividing line is the feature surface: what Backenly supports is a common shape covering a large fraction of software products, and a large fraction is not all of them.',
      },
      {
        heading: 'The part that is easy to leave out of the estimate',
        body: 'Building version one is the visible cost. The recurring one is what comes after: schema changes against data that now has users in it, dependency updates, monitoring that has to be set up before it can be useful, incident response, and the concentration of knowledge in whoever configured the deployment. This work is real regardless of who does it, and it is usually the part that gets deferred rather than the part that gets skipped. Backenly moves a portion of it into the platform: reconciliation against declared invariants on a schedule, a narrow set of repairs applied automatically, a restore point taken before schema-touching repairs, approval required for anything touching authentication or anything destructive, and a record of every autonomous action. A good engineer does all of this too. The difference is that the platform does it on a schedule whether or not anyone has time this week.',
      },
    ],
    table: [
      {
        aspect: 'Capability ceiling',
        competitor: 'None. If you can write it, you can have it',
        backenly: 'Bounded by what the platform supports',
        practical: 'The single most important row. If your requirements sit outside the common shape, build.',
      },
      {
        aspect: 'Time to a working backend',
        competitor: 'Design, build, test, deploy',
        backenly: 'Describe it, review the plan, apply',
        practical: 'A platform is faster to first working state. That advantage shrinks as requirements get more unusual.',
      },
      {
        aspect: 'Expertise required',
        competitor: 'Backend engineering: SQL, API design, auth, operations',
        backenly: 'Less of the implementation, none of the judgement',
        practical: 'You still decide the data model and the access rules. Backenly does not make those decisions correct.',
      },
      {
        aspect: 'Architectural control',
        competitor: 'Complete. Every decision is yours',
        backenly: 'You direct it; the platform applies defaults where you do not',
        practical: 'Control is a feature when you have an opinion, and overhead when you do not.',
      },
      {
        aspect: 'Schema change',
        competitor: 'Migrations you write, review, and run',
        backenly: 'Typed actions through one audited path, with a restore point on schema-touching work',
        practical: 'Both work. One puts the review in your pull request, the other in the platform.',
      },
      {
        aspect: 'Operating after launch',
        competitor: 'Your monitoring, your alerts, your on-call',
        backenly: 'Invariant reconciliation, a narrow automatic repair band, approvals for the rest',
        practical: 'A platform will not replace an experienced operator. It will keep checking on a week when nobody has time.',
      },
      {
        aspect: 'Portability',
        competitor: 'Complete. Your code, your infrastructure',
        backenly: 'Standard PostgreSQL and REST, Apache-2.0, self-hostable',
        practical: 'Not a meaningful difference. Neither route locks you in.',
      },
      {
        aspect: 'Cost shape',
        competitor: 'Engineering time, up front and ongoing',
        backenly: 'A subscription, plus your time directing it',
        practical: 'Which is cheaper depends on your team and your requirements, and it is not a number anyone can give you generically.',
      },
    ],
    competitorStrengths: [
      {
        title: 'There is no capability ceiling',
        body: 'This is the strongest argument for building and it is not close. Unusual data models, specific performance characteristics, protocols outside the mainstream, custom consistency requirements: all available when you write the code, and all potentially blocked by a platform that optimised for the common case.',
      },
      {
        title: 'Every architectural decision is yours',
        body: 'Where a platform applies a sensible default, a hand-built system applies your choice. When you have a considered opinion about how something should work, that is worth a great deal.',
      },
      {
        title: 'No platform to be constrained by, or to depend on',
        body: 'Your dependencies are the ones you chose. There is no feature surface to check against your requirements and no upstream roadmap to wait on.',
      },
      {
        title: 'It is the right answer when the backend is the product',
        body: 'If what you are selling is the backend itself, its behaviour is your differentiator and it should not be generated. Hire engineers.',
      },
    ],
    backenlyStrengths: [
      {
        title: 'The repetitive layer is already built',
        body: 'Tables, CRUD over an API, authentication, per-row access, file storage, change events, and scheduled work are the same in most products. Having them present and coherent from the start is time not spent on the parts that are identical everywhere.',
      },
      {
        title: 'Structural change goes through one recorded path',
        body: 'One kernel applies every schema mutation, so the change history, the restore point on schema-touching work, and the approval gate for destructive operations all exist by construction rather than by discipline.',
      },
      {
        title: 'Operational checks that run whether or not anyone is free',
        body: 'Reconciliation against declared invariants happens on a schedule. It catches a specific set of problems — unindexed relationship columns, tables carrying more dead rows than live ones, policies that silently match nothing, a REST surface that stopped answering — and reports or repairs them within a bounded set of safe actions.',
      },
      {
        title: 'A destination an engineer already understands',
        body: 'When you do hire, they inherit PostgreSQL and REST rather than a proprietary runtime. The handover is a schema and an API, not a tour.',
      },
    ],
    operating: {
      heading: 'What the operating layer covers, and what stays yours',
      body: 'The platform reconciles the live backend against declared invariants on a schedule and sorts each finding. A narrow, enumerable band is applied automatically because the action is additive or restorative: creating a missing index, vacuuming a bloated table, reindexing one that is mostly empty space, restoring a REST surface that stopped being served, installing a row-security policy where ownership is derivable from the schema. Schema-touching repairs take a restore point before they run and re-probe afterwards to record whether the gap actually closed. Anything touching authentication, external credentials, or anything destructive or irreversible requires a person at every autonomy level, and selecting the most permissive setting does not change that. Everything else is reported with its evidence and left to you. What stays yours is the larger part: whether the data model is right, what the access rules should be, what the product does, and every judgement call about all three.',
    },
    chooseBackenlyWhen: [
      'Your backend serves your product rather than being the product.',
      'The shape you need is relational data, authentication, permissions, files, realtime, and scheduled or event-driven work.',
      'You would rather spend your engineering time on what makes the product different.',
      'You want the operational checks to run on a schedule rather than when someone remembers.',
    ],
    chooseCompetitorWhen: [
      'Your backend is your product, or its behaviour is your differentiator.',
      'You have requirements a platform will not cover: unusual data models, hard latency budgets, uncommon protocols, custom consistency semantics.',
      'You already have backend engineers who would rather own the system directly, and that ownership is a genuine advantage.',
      'You have specific architectural opinions and want every decision made deliberately rather than defaulted.',
      'Regulatory, contractual, or organisational constraints require a particular implementation you control end to end.',
    ],
    faq: [
      {
        q: 'Does Backenly mean I never have to think about the backend?',
        a: 'No, and that would be a bad thing to claim. It builds and operates a common backend shape, and it applies a narrow set of repairs automatically. You still decide what the data model is, whether a proposed schema is right for your product, what your access rules should be, and what happens when something is wrong that the platform can only report. It removes repetitive implementation and operational work, not engineering judgement.',
      },
      {
        q: 'Can I hire a developer to extend a Backenly backend?',
        a: 'Yes, and they inherit something standard: PostgreSQL and a REST API. They can connect with an ordinary Postgres client, read the schema, and work from the dashboard, the API, or SQL directly. There is no proprietary runtime to learn first.',
      },
      {
        q: 'What if I need custom logic the platform does not cover?',
        a: 'Backenly supports functions that run on database events, on an HTTP request, or on a schedule, which covers a lot of application logic. Beyond that there is a real boundary, and the honest answer is that if your requirements sit outside what the platform supports, a hand-built backend is the better choice. That is what the capability-ceiling row in the table is about.',
      },
      {
        q: 'Is it cheaper than hiring an engineer?',
        a: 'That depends on your requirements, your team, and what you would be asking the engineer to do, and generic figures would be invented. What can be said precisely is the shape: a platform is a subscription plus your time directing it, and building is engineering time up front and ongoing.',
      },
    ],
    facts: [],
  },
]

export const COMPARISON_LIST: readonly ComparisonData[] = LIST

export const COMPARISONS: Record<string, ComparisonData> = Object.fromEntries(
  LIST.map((c) => [c.slug, c]),
)

/** Canonical slug list. The sitemap derives from this — never hand-maintained. */
export const COMPARISON_SLUGS: readonly string[] = LIST.map((c) => c.slug)
