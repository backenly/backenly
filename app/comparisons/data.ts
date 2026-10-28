/**
 * Comparison data: the single source of truth for /comparisons.
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
 * WHAT A PAGE SHOWS (2026-10-15, founders: "no jargon, no lots of text")
 * ----------------------------------------------------------------------
 * The hero line (`intro`), three short points (`architecture`), the table and
 * its sources, "Which one to pick" (`summary` and the two `choose...When`
 * lists), moving across (`migration`, where there is one) and a short FAQ.
 * Every string is short and plain on purpose. The long reasoning that used to
 * sit between those blocks is gone; the table carries the detail.
 *
 * WHAT A COMPARISON HAS TO CARRY
 * ------------------------------
 * `competitorStrengths` and `chooseCompetitorWhen` are enforced by the gate and
 * by tests/unit/comparisons-content.spec.ts. A comparison page that cannot say
 * why a reader should pick the other product is an advertisement wearing a
 * table. The page shows the "choose when" lists; the strengths stay here as the
 * record of why, because the gate and the test check them.
 *
 * `facts` is the other honesty mechanism. Every statement about a competitor
 * that could be checked against their documentation carries the URL it came
 * from and the date it was read. Competitor pricing and capabilities move; a
 * claim with no date attached is a claim nobody can ever audit. The gate warns
 * when an entry gets stale rather than failing the build.
 *
 * Backenly claims here stay inside the audited boundary. In particular: the
 * automatic repairs are a short, fixed list, and a restore reaches back only as
 * far as the plan keeps restore points (7 days on Free).
 * Since #545 every change is one entry in History and can be restored, alone
 * or back to a point, but data the app wrote is never rewound and a credential
 * never comes back (docs/CHANGE_RECOVERY.md). None of those may be widened in
 * copy.
 *
 * Two phrases are tied to code by the unit test and must stay: the advertised
 * MCP tool count ("twenty-three advertised", lib/mcp/catalog.ts) and the
 * branch cap ("up to five active", lib/branches/engine.ts).
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
 * whoever wrote it; `practical` says what the difference actually costs or
 * buys, including when the answer is "nothing".
 */
export type ComparisonRow = {
  aspect: string
  competitor: string
  backenly: string
  practical: string
}

export type ComparisonData = {
  slug: string
  /** Display name of the thing being compared against: the crumb, the table column, the index card. */
  competitor: string
  /** The same name mid-sentence ("Choose no-code app builders when"), where it is not a proper noun. */
  nameInSentence?: string
  /** Short category label for the index card. */
  category: string
  metaTitle: string
  metaDescription: string
  /** Index card line. Never restated on /alternatives. */
  positioning: string
  headline: string
  /** The hero line: the difference in one or two short sentences. */
  intro: string
  /** The verdict, one or two sentences, under "Which one to pick". */
  summary: string
  /** Three short points shown first: a heading and one sentence each. */
  architecture: { heading: string; body: string }[]
  table: ComparisonRow[]
  /** Enforced: at least two, and they have to be real. */
  competitorStrengths: { title: string; body: string }[]
  backenlyStrengths: { title: string; body: string }[]
  migration?: {
    heading: string
    body: string
    /** What moves across unchanged, shown as chips. */
    carries?: string[]
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
    metaTitle: 'Backenly vs Supabase: same Postgres, different workflow',
    metaDescription:
      'Same Postgres and query API. Supabase leaves migrations, restores and fixes to you. Backenly checks each change, can undo a single one and fixes safe problems.',
    positioning:
      'The same Postgres and query API. The difference is who handles schema changes, access rules and upkeep.',
    headline: 'Backenly vs. Supabase',
    intro:
      'Both run PostgreSQL behind the same query API. The difference is how changes are made, and who looks after the backend after launch.',
    summary:
      'Neither suits every team. If yours wants to own migrations, access rules and upkeep, Supabase gives it that control. If it does not, Backenly takes on part of that work.',
    architecture: [
      {
        heading: 'Same query API',
        body: 'Both serve your tables through PostgREST on PostgreSQL. Queries are written the same way, so most client code carries over.',
      },
      {
        heading: 'How changes are made',
        body: 'On Supabase you write and run migrations. On Backenly each change is recorded, and destructive ones wait for a person to approve.',
      },
      {
        heading: 'After launch',
        body: 'Supabase gives you logs and metrics to act on. Backenly also fixes a short list of safe problems itself and reports the rest.',
      },
    ],
    table: [
      {
        aspect: 'Database',
        competitor: 'PostgreSQL',
        backenly: 'PostgreSQL',
        practical: 'No difference. pg_dump moves data in either direction.',
      },
      {
        aspect: 'Query API',
        competitor: 'PostgREST',
        backenly: 'PostgREST, plus a typed REST API',
        practical: 'The same syntax, so query code carries over without a rewrite.',
      },
      {
        aspect: 'Schema changes',
        competitor: 'Migrations you write and run',
        backenly: 'Every change recorded in one History, restorable on its own or back to a point',
        practical: 'Supabase leaves every decision to you. Backenly keeps a record and a way back.',
      },
      {
        aspect: 'Destructive changes',
        competitor: 'Run when you run them',
        backenly: 'Wait for approval, showing the target and, where available, how many rows it holds',
        practical: 'Both can drop a table. Only Backenly asks a person first.',
      },
      {
        aspect: 'Undoing a bad change',
        competitor: 'Restore a daily backup, or a point in time with the PITR add-on; the project is offline while it restores',
        backenly: 'Restore that one change from History, checked first; anything that would touch later data waits for you',
        practical: 'A backup takes the whole project back. Backenly undoes one change and leaves the rest as it is.',
      },
      {
        aspect: 'Row-level security',
        competitor: 'You write the policies; its guide calls for a pgTAP test suite',
        backenly: 'Your policy SQL is installed as written and read back; known mistakes are checked',
        practical: 'The rule is still yours on both. Backenly checks a few ways a policy can be wrong.',
      },
      {
        aspect: 'After launch',
        competitor: 'Advisors flag security and performance issues; you run the fix',
        backenly: 'Self-healing fixes a short list of safe problems; risky ones wait for a person',
        practical: 'Both find problems. Backenly applies a short list of safe fixes itself and reports the rest.',
      },
      {
        aspect: 'Preview environments',
        competitor: 'Branches tied to GitHub pull requests',
        backenly: 'Data branches, up to five active, picked by API key',
        practical: "Supabase's branches fit your git workflow. Backenly's cover data and the REST API; auth, functions and storage stay on main.",
      },
      {
        aspect: 'Agent access',
        competitor: 'Official MCP server with a read-only mode and project scoping',
        backenly: 'Twenty-three advertised tools; destructive actions wait for a person',
        practical: 'Supabase reaches more product areas and gives you settings to limit it. Backenly limits destructive actions for you.',
      },
      {
        aspect: 'Functions',
        competitor: 'Edge Functions',
        backenly: 'Functions on database events, HTTP calls or a schedule',
        practical: "Supabase's run any server code at the edge. Backenly's are built around database events.",
      },
      {
        aspect: 'License',
        competitor: 'Apache-2.0, self-hostable',
        backenly: 'Apache-2.0, self-hostable',
        practical: 'The same on both. Neither locks you in.',
      },
      {
        aspect: 'Pricing',
        competitor: 'Pro from $25 a month, with metered usage above the included limits',
        backenly: 'Pro is $25 a month; quotas are hard caps unless you set a spend limit',
        practical: 'The same starting price. Backenly bills nothing past $25 unless you set a limit, and never more than it.',
      },
    ],
    competitorStrengths: [
      {
        title: 'A larger ecosystem',
        body: 'Supabase has been generally available for years. That shows in answered questions, integrations, tutorials and engineers who already know it.',
      },
      {
        title: 'Branching tied to pull requests',
        body: 'Supabase branches are driven from GitHub, with preview branches for pull requests. Backenly has data branches but nothing wired into pull requests.',
      },
      {
        title: 'A general-purpose edge runtime',
        body: 'Edge Functions run any server-side code at the edge. Backenly functions are built around database events, HTTP calls and schedules.',
      },
      {
        title: 'More agent tools',
        body: "Supabase's official MCP server covers more product areas than Backenly's, including account management and Edge Functions.",
      },
      {
        title: 'A plan between Pro and Enterprise',
        body: 'Supabase publishes a Team plan above Pro. Backenly goes from Pro straight to a sales-led Enterprise conversation.',
      },
    ],
    backenlyStrengths: [
      {
        title: 'One recorded path for every change',
        body: 'Changes from the dashboard, an agent or self-healing, to the schema, auth, storage, functions or keys, all take the same path into one History, which is what makes restores and approvals possible.',
      },
      {
        title: 'Policies installed as written',
        body: 'Backenly installs your row-level security SQL exactly as written and reads it back from the database before it reports success.',
      },
      {
        title: 'Checks that keep running',
        body: 'Backenly checks for policy mistakes a dashboard cannot show, such as a policy that allows every row, one that blocks even the owner, or one that matches nothing.',
      },
      {
        title: 'An agent cannot drop a table',
        body: "An agent's request to drop a table becomes an approval for a person instead of running.",
      },
    ],
    migration: {
      heading: 'Moving from Supabase',
      body: "Backenly's SDK has a Supabase-compatible entry point, so most supabase-js query code works unchanged. Data moves with pg_dump, since both sides are plain PostgreSQL.",
      carries: ['Filters and ordering', 'Related rows in one request', 'Upsert', 'Exact counts', '{ data, error } results'],
      limits: [
        'There is no migration service. Nothing here is done for you, on any plan.',
        'rpc() is not supported. Stored-procedure calls move into event, HTTP or scheduled functions.',
        'Row-level security policies are rewritten, not converted.',
        "Auth and storage are Backenly's own. Common calls work; check anything Supabase-specific.",
        'Moving the data and running the cutover are your work.',
      ],
    },
    chooseBackenlyWhen: [
      'Nobody on the team wants to own migrations, access rules and incident response.',
      'A coding agent does much of the building, and you want it unable to drop a table on its own.',
      'Predictable billing matters more than paying only for what you use.',
      'You want the Postgres API you know without running the backend yourself.',
    ],
    chooseCompetitorWhen: [
      'Your team wants to own schema design, migrations and access rules.',
      'A preview environment per pull request is central to how you ship.',
      'You need a general-purpose edge runtime.',
      'A large ecosystem and hiring pool matter most. Supabase is ahead on both.',
      'You want a self-serve plan between Pro and Enterprise.',
    ],
    faq: [
      {
        q: 'Do Backenly and Supabase use the same query syntax?',
        a: 'For the common path, yes. Both serve tables through PostgREST, so filters, ordering, related rows, upserts and exact counts work the same way. rpc() does not carry over, because Backenly has no SQL-function endpoint.',
      },
      {
        q: 'Is Backenly cheaper than Supabase?',
        a: 'It depends on your usage. Both Pro plans start at $25 a month. Supabase meters usage above its included limits. Backenly bills nothing past $25 unless you set a spend limit, so by default you reach a quota instead of a larger bill.',
      },
      {
        q: 'Does Backenly get row-level security right for me?',
        a: 'No. It installs a policy exactly as you write it and reads it back to confirm. It can write one when the schema shows who owns each row, and asks you when it does not. It also checks for a few common ways a policy fails. The rule itself is yours on both platforms.',
      },
      {
        q: 'Are both open source?',
        a: "Yes. Supabase's main repository and Backenly are both Apache-2.0 and self-hostable, and self-hosted Backenly includes self-healing. Backenly's client packages are MIT.",
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
          "Supabase ships an official MCP server with a read-only mode and project scoping. Its documentation recommends using it with a development project rather than production.",
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
      {
        claim:
          'Supabase backs up Pro, Team and Enterprise projects daily. Point-in-Time Recovery is an add-on on those plans, and the project is inaccessible while a restore runs.',
        source: 'https://supabase.com/docs/guides/platform/backups',
        verifiedOn: '2026-10-24',
      },
      {
        claim:
          "Supabase's Security and Performance Advisors flag health, security and performance issues. The documented fixes are SQL or settings changes the user runs.",
        source: 'https://supabase.com/docs/guides/database/database-advisors',
        verifiedOn: '2026-10-24',
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'backenly-vs-firebase',
    competitor: 'Firebase',
    category: 'Google mobile and app platform',
    metaTitle: 'Backenly vs Firebase: Postgres or a document database',
    metaDescription:
      'Firebase: documents and mature mobile SDKs. Backenly: relational Postgres that checks each schema change and repairs itself. The data model decides most of it.',
    positioning: 'Documents and strong mobile SDKs, or relational Postgres. The data model decides most of it.',
    headline: 'Backenly vs. Firebase',
    intro:
      'Firebase is a document database with strong mobile SDKs. Backenly is relational PostgreSQL. The data model is the choice that is hardest to undo.',
    summary:
      'For a mobile-first app with simple data, Firebase is the stronger choice. If your data has relationships, start relational.',
    architecture: [
      {
        heading: 'Documents or tables',
        body: "Firestore's standard queries have no joins, so related data is copied between documents and kept in sync by your code. In Postgres, a join is an ordinary query.",
      },
      {
        heading: 'How you pay',
        body: 'Firestore bills per operation, so cost follows usage. Backenly is a flat monthly plan, so you reach a quota instead of a bigger bill.',
      },
      {
        heading: 'When something breaks',
        body: 'Both report problems. Backenly also fixes a short list of safe ones itself, such as a missing index, and reports the rest to you.',
      },
    ],
    table: [
      {
        aspect: 'Data model',
        competitor: 'Documents in collections (Firestore, Realtime Database)',
        backenly: 'Relational PostgreSQL',
        practical: 'The hardest choice to undo. Pick it for how your data relates, not for your first screen.',
      },
      {
        aspect: 'Related data',
        competitor: 'No joins in the standard query API, so data is copied between documents. Enterprise edition documents pipeline joins',
        backenly: 'SQL joins, and related rows over REST in one request',
        practical: 'On Firestore, a related query is a modeling job. On Postgres, it is a query.',
      },
      {
        aspect: 'Mobile apps',
        competitor: 'Mature Android and Apple SDKs, with offline support on by default',
        backenly: 'A JavaScript SDK and a standard REST API',
        practical: 'Firebase is clearly stronger. For a native mobile app, this row may decide it.',
      },
      {
        aspect: 'Offline',
        competitor: 'Offline reads and writes, on by default on Android and Apple platforms',
        backenly: 'No offline layer; the app talks to the API',
        practical: 'For an app that must work without a connection, Firebase solves a problem Backenly does not.',
      },
      {
        aspect: 'Access control',
        competitor: 'Security Rules, a rules language with its own test tools',
        backenly: 'PostgreSQL grants and row-level security; policies are read back after install',
        practical: 'Both work, and both can be written wrong. They differ in the rule language and where it runs.',
      },
      {
        aspect: 'Realtime',
        competitor: 'Realtime Database and Firestore listeners, a core strength',
        backenly: 'Database changes, sent live over server-sent events',
        practical: 'Both send live updates. Only Firebase pairs them with offline support.',
      },
      {
        aspect: 'Undoing a bad change',
        competitor: 'Point-in-time recovery keeps 7 days: read past versions and write them back, or clone the database',
        backenly: 'Restore that one change from History, checked first; anything that would touch later data waits for you',
        practical: 'Firestore recovers documents. Backenly undoes one schema change and never drops later data without asking.',
      },
      {
        aspect: 'Monitoring and fixes',
        competitor: 'Firebase console plus Google Cloud monitoring, logs and alerts',
        backenly: 'Reports problems too, and fixes a short list of safe ones itself; the rest wait for approval',
        practical: 'The difference is a small set of fixes Backenly applies on its own.',
      },
      {
        aspect: 'Other products',
        competitor: 'Crashlytics, Analytics, App Distribution, Remote Config, Cloud Messaging',
        backenly: 'None of these',
        practical: 'Firebase is a product suite and Backenly is a backend. If you want the suite, Firebase wins here.',
      },
      {
        aspect: 'Leaving',
        competitor: "Export tools; the data model is Firebase's own",
        backenly: 'Plain PostgreSQL and pg_dump; Apache-2.0 and self-hostable',
        practical: 'Leaving Postgres is a dump and restore. Leaving a document store usually means remodeling the data.',
      },
      {
        aspect: 'Pricing',
        competitor: 'Free Spark plan, then pay-as-you-go Blaze, billed per operation',
        backenly: 'Flat monthly plans with visible quotas',
        practical: 'Per-operation pricing can be far cheaper or far more expensive. A flat plan is predictable.',
      },
    ],
    competitorStrengths: [
      {
        title: 'Mature mobile SDKs',
        body: 'First-party Android and Apple SDKs with offline support on by default. For a native mobile app, Backenly does not compete with this.',
      },
      {
        title: 'Offline support that works',
        body: 'Firestore caches data on the device and keeps working offline, syncing when it reconnects. Building that on a REST API is a project of its own.',
      },
      {
        title: 'A product suite',
        body: 'Crashlytics, Analytics, Cloud Messaging, Remote Config and App Distribution sit next to the database, ready on day one.',
      },
      {
        title: 'Google Cloud underneath',
        body: 'Scale, regions, IAM and monitoring a small team could not build, and an easier path for a company already on Google Cloud.',
      },
      {
        title: 'A free tier that costs nothing',
        body: 'The Spark plan needs no payment method, and Blaze keeps the free allowances, so a light prototype can stay free for a long time.',
      },
    ],
    backenlyStrengths: [
      {
        title: 'Relational data as tables',
        body: 'Joins, foreign keys, constraints and transactions are built in, which removes a whole class of sync code from your app.',
      },
      {
        title: 'Access rules in the database',
        body: 'Access control is PostgreSQL grants and row-level security, applied where the data lives, and policies are read back after they are installed.',
      },
      {
        title: 'Checks for silent policy mistakes',
        body: 'A policy that allows every row, or one that matches nothing, looks healthy from outside. Backenly checks for both.',
      },
      {
        title: 'Leaving is a database dump',
        body: 'Standard PostgreSQL and REST, Apache-2.0 and self-hostable. Moving off is a dump and a restore, not a remodeling project.',
      },
    ],
    migration: {
      heading: 'Moving from Firestore',
      body: 'There is no automatic path. Turning documents into tables is design work only your team can do. The destination is plain PostgreSQL, so any later move is a pg_dump.',
      limits: [
        'There is no import tool or migration service, on any plan.',
        'Remodeling documents into tables is design work you own.',
        'Security Rules do not convert to row-level security. They are rewritten.',
        'Backenly has no offline layer, so an offline-first app needs rethinking.',
        'Crashlytics, Analytics and Cloud Messaging have no Backenly equivalent. Keep them or replace them.',
      ],
    },
    chooseBackenlyWhen: [
      'Your data has relationships, and you want joins, foreign keys and transactions.',
      'You want access rules enforced by the database, not a separate rules language.',
      'A predictable monthly cost matters more than paying per operation.',
      'You want to be able to leave with a standard Postgres dump.',
    ],
    chooseCompetitorWhen: [
      'You are building a native mobile app and want first-party SDKs with offline support.',
      'Your app must work offline and sync later. Backenly does not do this.',
      'You want Crashlytics, Analytics, Cloud Messaging and Remote Config in one place.',
      'Your data is document-shaped, with few relationships.',
      'Your company already runs on Google Cloud.',
    ],
    faq: [
      {
        q: 'Can Firestore really not do joins?',
        a: 'Not in its standard query API, where copying data between documents is the documented pattern. The Enterprise edition documents joins through pipeline operations. On Postgres, a join is an ordinary query.',
      },
      {
        q: 'Does Backenly do realtime like Firebase?',
        a: 'It sends database changes live over server-sent events, built on PostgreSQL LISTEN/NOTIFY. It has no offline cache, which is a large part of how Firebase realtime feels on mobile.',
      },
      {
        q: 'Is Firebase less secure than Backenly?',
        a: 'No. Security Rules are capable, and a correct rule set is secure. Firebase checks rules at its API layer; Backenly enforces grants and row-level security inside PostgreSQL. Either can be written wrong.',
      },
      {
        q: 'Which one is cheaper?',
        a: 'It depends on your traffic and data model. Firestore bills per operation with a free daily allowance, so a quiet app can cost nothing and a busy one a lot. Backenly is a flat monthly plan, so the cost is fixed and you reach a quota instead.',
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
      {
        claim:
          'Firestore point-in-time recovery keeps 7 days. Recovery is a read of documents at a past timestamp written back to the live database, or a clone or export of the database at that timestamp.',
        source: 'https://firebase.google.com/docs/firestore/pitr',
        verifiedOn: '2026-10-24',
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'backenly-vs-insforge',
    competitor: 'InsForge',
    category: 'Open-source agent backend',
    metaTitle: 'Backenly vs InsForge: two backends for coding agents',
    metaDescription:
      'Both are open-source Postgres backends for coding agents. InsForge has more products; Backenly checks each change, holds destructive ones and can undo any one.',
    positioning: 'Both are open-source backends built for coding agents. They differ in what happens when the agent gets a change wrong.',
    headline: 'Backenly vs. InsForge',
    intro:
      'Both give a coding agent a Postgres backend over MCP and a CLI. The difference is what happens when the agent gets a change wrong, and who fixes problems after it leaves.',
    summary:
      'If you want the most products under one agent interface, InsForge has more of them. If you want each change checked, destructive calls held for a person and any one change undoable, that is what Backenly is built around.',
    architecture: [
      {
        heading: 'Same starting point',
        body: 'Both run PostgreSQL with every table served as a REST API, plus auth, storage, realtime and functions, all reached by the agent over MCP.',
      },
      {
        heading: 'When a change is wrong',
        body: 'InsForge restores a backup, which replaces the database and loses data written since. Backenly restores that one change from History and keeps what the app wrote.',
      },
      {
        heading: 'After the agent leaves',
        body: "InsForge's advisor writes a fix for the agent to apply. Backenly applies a short list of safe fixes itself and holds the rest for you.",
      },
    ],
    table: [
      {
        aspect: 'Database',
        competitor: 'PostgreSQL; every table becomes a typed REST and SDK surface',
        backenly: 'PostgreSQL; every table is a REST API over PostgREST',
        practical: 'No real difference in the data layer.',
      },
      {
        aspect: 'Agent access',
        competitor: 'MCP server and CLI; write and admin actions need the admin API key',
        backenly: 'Twenty-three advertised tools; destructive actions wait for a person',
        practical: 'Both connect the same agents. Only Backenly parks a destructive call until a person approves it.',
      },
      {
        aspect: 'Raw SQL',
        competitor: 'run-raw-sql in strict mode with the admin key; system tables and auth.users blocked',
        backenly: 'Read-only SQL as a SELECT-only role; writes go through typed, checked actions',
        practical: 'InsForge lets the agent write any SQL with the admin key. Backenly lets it read any SQL and write only through checked actions.',
      },
      {
        aspect: 'Schema changes',
        competitor: 'Forward-only SQL migrations the CLI applies in a transaction',
        backenly: 'Each change checkpointed, applied and verified by Backenly, then recorded in History',
        practical: "On InsForge a migration that runs is done. On Backenly a change is done when Backenly's own checks pass.",
      },
      {
        aspect: 'Undoing a bad change',
        competitor: 'Restore a backup: it replaces the database, takes the project offline and loses data created since',
        backenly: 'Restore that one change from History, checked first; anything that would touch later data waits for you',
        practical: 'A backup restore is all or nothing. Backenly undoes one change and leaves the rest as it is.',
      },
      {
        aspect: 'Preview environments',
        competitor: 'Branches copy the whole backend: Postgres, auth, storage and functions; two per project',
        backenly: 'Data branches, up to five active, picked by API key',
        practical: "InsForge branches more of the backend. Backenly's cover data and the REST API; auth, functions and storage stay on main.",
      },
      {
        aspect: 'After launch',
        competitor: 'An advisor writes a remediation for each issue; the agent applies it',
        backenly: 'Checks every minute and applies a short list of safe fixes itself; risky ones wait for a person',
        practical: "InsForge's fixes need an agent session. Backenly's safe fixes do not.",
      },
      {
        aspect: 'Other products',
        competitor: 'Sites, a model gateway, analytics and payments',
        backenly: 'None of these; provider integrations for Stripe, Resend, OpenAI, Anthropic and PostHog',
        practical: 'InsForge covers more of the stack. Backenly is the backend only.',
      },
      {
        aspect: 'License',
        competitor: 'Apache-2.0, self-hostable with Docker Compose',
        backenly: 'Apache-2.0, self-hostable',
        practical: 'The same on both. Neither locks you in.',
      },
      {
        aspect: 'Pricing',
        competitor: 'Free with a 500 MB database; Pro $25 a month, with metered usage above it',
        backenly: 'Pro is $25 a month; quotas are hard caps unless you set a spend limit',
        practical: 'The same starting price. Backenly bills nothing past $25 unless you set a limit.',
      },
    ],
    competitorStrengths: [
      {
        title: 'More products in one place',
        body: 'InsForge ships sites, a model gateway, analytics and payments behind the same MCP server and SDK. Backenly is the backend only.',
      },
      {
        title: 'Branches of the whole backend',
        body: 'An InsForge branch copies Postgres, auth, storage and functions and merges back with a three-way diff. Backenly branches cover data and the REST API.',
      },
      {
        title: 'Settings as a config file',
        body: 'InsForge keeps auth, SMTP, storage and deployment settings in an insforge.toml that the agent plans and applies, so they can be reviewed in a pull request.',
      },
      {
        title: 'A larger community',
        body: "InsForge's repository has about 13,000 stars, and its site offers templates, so there are more worked examples to start from.",
      },
    ],
    backenlyStrengths: [
      {
        title: 'Destructive calls wait for a person',
        body: 'apply_migration refuses DROP, and dropping a table, deleting files or revoking a key is parked until a person approves that exact call.',
      },
      {
        title: 'Undo one change',
        body: 'Every change is one entry in History. Restore it alone or everything back to a point, without rewinding what the app wrote.',
      },
      {
        title: 'Checked by the platform',
        body: 'Backenly verifies each schema change against the live database: every reported step happened and row-level security was not weakened.',
      },
      {
        title: 'Fixes without an agent',
        body: 'Checks run every minute on every plan, and a short list of safe fixes is applied without waiting for an agent session.',
      },
    ],
    chooseBackenlyWhen: [
      'Your agent works on a production backend and you want destructive calls held for you.',
      'You want to undo one bad change without restoring a backup.',
      'Nobody will start an agent session every time an advisor finds something.',
    ],
    chooseCompetitorWhen: [
      'You want hosting, a model gateway or payments in the same platform as the backend.',
      'You want branches that copy auth, storage and functions as well as data.',
      'You want backend settings in a config file that is reviewed in pull requests.',
    ],
    faq: [
      {
        q: 'Are both open source?',
        a: "Yes. Both platforms are Apache-2.0 and can be self-hosted. Backenly's SDK, CLI and MCP server are MIT.",
      },
      {
        q: 'Do both work with Claude Code and Cursor?',
        a: 'Yes. Both have an MCP server and a CLI, and both document setup for Claude Code, Cursor and other clients.',
      },
      {
        q: 'What happens if my agent drops a table?',
        a: "On InsForge, raw SQL runs with the admin key, and the documented way back is a backup restore, which replaces the whole database. On Backenly, apply_migration refuses DROP, a drop requested through backend_chat waits for a person, and the dropped table's data is kept in the change's vault.",
      },
      {
        q: 'Which is cheaper?',
        a: "Both start at $0 and both Pro plans are $25 a month. InsForge meters usage above the plan; Backenly's quotas are hard caps unless you set a spend limit.",
      },
    ],
    facts: [
      {
        claim:
          'The InsForge MCP server exposes get-table-schema, run-raw-sql and bulk-upsert for the database, plus delete-bucket and delete-function among others. Write and admin actions require the admin API key; raw SQL runs in strict mode with system tables and auth.users blocked.',
        source: 'https://docs.insforge.dev/mcp-setup',
        verifiedOn: '2026-10-24',
      },
      {
        claim:
          'InsForge migrations are timestamped SQL files applied forward-only by the CLI, each inside a transaction, recorded only on success.',
        source: 'https://docs.insforge.dev/core-concepts/database/migrations',
        verifiedOn: '2026-10-24',
      },
      {
        claim:
          'Restoring an InsForge backup replaces the current database: the project goes offline during the restore, data created after the backup is lost, and the restore cannot be undone. Backups cover the database only.',
        source: 'https://docs.insforge.dev/core-concepts/database/backups',
        verifiedOn: '2026-10-24',
      },
      {
        claim:
          'An InsForge branch is a child project with its own Postgres, auth config, storage and edge functions, merged with a three-way diff or reset. Two active branches per parent project.',
        source: 'https://docs.insforge.dev/agent-native/branching',
        verifiedOn: '2026-10-24',
      },
      {
        claim:
          "InsForge's advisor scans for security, performance and health issues and writes a remediation for each; the agent fetches the findings and applies the fix itself.",
        source: 'https://docs.insforge.dev/agent-native/diagnostics',
        verifiedOn: '2026-10-24',
      },
      {
        claim:
          'InsForge ships ten products, including Postgres, auth, storage, realtime, edge functions, sites, a model gateway, analytics and payments, behind one MCP server and SDK.',
        source: 'https://docs.insforge.dev/products',
        verifiedOn: '2026-10-24',
      },
      {
        claim: 'InsForge manages auth, SMTP, storage and deployment settings from an insforge.toml with the CLI’s plan, apply and export workflow.',
        source: 'https://docs.insforge.dev/agent-native/config-as-code',
        verifiedOn: '2026-10-24',
      },
      {
        claim: 'The InsForge/InsForge repository is licensed Apache-2.0, with about 13,000 stars; self-hosting with Docker Compose is documented.',
        source: 'https://github.com/InsForge/InsForge',
        verifiedOn: '2026-10-24',
      },
      {
        claim:
          'InsForge Free is $0 with a 500 MB database and 50,000 monthly active users; free projects pause after a week of inactivity. Pro is $25 a month ($20 billed yearly), with usage above the plan billed per unit.',
        source: 'https://insforge.dev/pricing',
        verifiedOn: '2026-10-24',
      },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'backenly-vs-no-code-builders',
    competitor: 'No-code app builders',
    nameInSentence: 'no-code app builders',
    category: 'Integrated visual builders',
    metaTitle: 'Backenly vs no-code app builders: a standalone backend',
    metaDescription:
      'Visual app builders keep the frontend and the backend in one system. Backenly is backend only: standard PostgreSQL and a REST API that any frontend can use.',
    positioning: 'One tool for screens and data, or a separate backend that any frontend can use.',
    headline: 'Backenly vs. no-code app builders',
    intro:
      'A visual builder keeps the screens and the data in one tool. Backenly is only the backend, so any frontend can use it.',
    summary:
      'Often it is not either-or. Many teams keep a builder for the screens and put the data in a backend they can query and take with them.',
    architecture: [
      {
        heading: 'One tool or two',
        body: 'A builder is quick because screens and data live in one tool. You can only build what that tool supports.',
      },
      {
        heading: 'A standard backend',
        body: 'Backenly is PostgreSQL and a REST API, so any frontend can use it and most developers already know it.',
      },
      {
        heading: 'Or use both',
        body: 'A builder that can call a REST API can use Backenly for real tables, sign-in and file storage instead of its own store.',
      },
    ],
    table: [
      {
        aspect: 'Scope',
        competitor: 'Screens, logic and data in one tool',
        backenly: 'Backend only: database, API, auth, storage, realtime',
        practical: 'Not substitutes. A builder replaces your whole stack; Backenly replaces the back half.',
      },
      {
        aspect: 'First working screen',
        competitor: 'Fast. Design and data live in the same place',
        backenly: 'Not provided. You bring or build the frontend',
        practical: 'To put something in front of users this week, a builder is quicker.',
      },
      {
        aspect: 'Frontend',
        competitor: "The builder's own editor",
        backenly: 'Any app that can make an HTTP request',
        practical: 'Matters when you need a second app, such as mobile, on the same data.',
      },
      {
        aspect: 'Database access',
        competitor: 'Depends on the product; usually through the builder',
        backenly: 'Standard PostgreSQL, open to SQL and any Postgres client',
        practical: 'Decides whether reports and one-off queries are easy or a support ticket.',
      },
      {
        aspect: 'API',
        competitor: 'Depends on the product',
        backenly: 'A documented REST API and a typed SDK',
        practical: 'Lets any tool, script or new hire work with your data unaided.',
      },
      {
        aspect: 'Access rules',
        competitor: "Set in the builder's own permissions",
        backenly: 'PostgreSQL grants and row-level security, in the database',
        practical: 'The rules sit in the database, so an app you add later does not need them rebuilt.',
      },
      {
        aspect: 'Handing to a developer',
        competitor: 'They work inside the builder',
        backenly: 'They get Postgres and REST, which they already know',
        practical: 'Matters the day you hire, or hand the project to someone else.',
      },
      {
        aspect: 'Leaving',
        competitor: 'Depends on the product; check its export before you commit',
        backenly: 'pg_dump, plus Apache-2.0 source you can self-host',
        practical: 'Worth checking on any platform before you build on it.',
      },
    ],
    competitorStrengths: [
      {
        title: 'One system instead of two',
        body: 'Screens, logic and data in one place, with no API to design and nothing to integrate. For a simple app that removes most of the work.',
      },
      {
        title: 'Fast to a working app',
        body: 'A good visual builder gets from idea to something people can use in hours. Backenly gives you no interface at all.',
      },
      {
        title: 'Usable without code',
        body: 'Someone who has never opened a terminal can use a builder. Backenly assumes a developer or a coding agent builds the frontend.',
      },
      {
        title: 'Hosting included',
        body: 'The builder hosts and serves the app it builds. With Backenly the backend is hosted, and where the frontend lives is up to you.',
      },
    ],
    backenlyStrengths: [
      {
        title: 'Data separate from the screens',
        body: 'Replacing or adding a frontend does not touch the backend. One API serves a web app, a mobile app and background jobs.',
      },
      {
        title: 'Standard PostgreSQL',
        body: 'Query it with SQL, connect any Postgres client, hire people who already know it, and export it with pg_dump.',
      },
      {
        title: 'Access rules in the database',
        body: 'Row-level security lives in the database, so an app you add later does not need the rules written again.',
      },
      {
        title: 'Works with the tools you use',
        body: 'A standard REST API and typed SDK let a visual or AI frontend tool work with real tables instead of a store of its own.',
      },
    ],
    chooseBackenlyWhen: [
      'You want your data to outlast whatever draws the screens today.',
      'You need more than one app on the same data, such as web and mobile.',
      'You want SQL access, a standard REST API, and a backend a developer can pick up without a tour.',
      'A coding agent or AI tool is building your frontend and needs a real backend.',
    ],
    chooseCompetitorWhen: [
      'You want a working app, not a backend, and you want it this week.',
      'Nobody on the project writes code, and no agent or developer will build the screens.',
      'The app fits easily inside what the builder supports.',
      'Having screens, data and hosting in one place matters more than a portable backend.',
    ],
    faq: [
      {
        q: 'Is Backenly a no-code tool?',
        a: 'Not in the usual sense. You do not write backend code, but there is no visual app builder. You get a real database and API, and someone still builds the frontend: you, a developer or a coding agent.',
      },
      {
        q: 'Can I use Backenly with a visual builder or an AI frontend tool?',
        a: 'Yes. Backenly has a standard REST API and a typed SDK, so any tool that can make an HTTP request or import a package can use your tables, sign-in and file storage.',
      },
      {
        q: 'Why add a second system instead of using one?',
        a: 'Often you should not. If the app fits inside a builder, one system is simpler. Separate them when you need a second app on the same data, SQL access, a frontend you may replace, or a backend you can take with you.',
      },
    ],
    facts: [],
  },

  // ───────────────────────────────────────────────────────────────────────────
  {
    slug: 'backenly-vs-traditional-backend-development',
    competitor: 'Your own backend',
    nameInSentence: 'your own backend',
    category: 'Custom-built backends',
    metaTitle: 'Backenly vs building your own backend: what it covers',
    metaDescription:
      'A hand-built backend has no limits but costs engineering time to build and run. Backenly covers the common parts and checks them; design decisions stay yours.',
    positioning: 'Build every part yourself, or start from a platform that covers the common parts.',
    headline: 'Backenly vs. building your own backend',
    intro:
      'A hand-built backend has no limits, but you build and run all of it. Backenly covers the common parts. The design decisions stay yours.',
    summary:
      'Build it yourself when the backend is the product or needs something unusual. Otherwise a platform saves the repeated work, and the judgment stays with you.',
    architecture: [
      {
        heading: 'What a platform covers',
        body: 'The parts most products share: tables, an API, sign-in, access rules, files, change events and scheduled jobs.',
      },
      {
        heading: 'Where building wins',
        body: 'A hand-built backend can do anything. If the backend is your product, build it with your own engineers.',
      },
      {
        heading: 'The work after launch',
        body: 'Schema changes, monitoring and incidents continue after version one. Backenly checks the backend on a schedule and fixes a short list of safe problems.',
      },
    ],
    table: [
      {
        aspect: 'What it can do',
        competitor: 'Anything you can write',
        backenly: 'What the platform supports',
        practical: 'The most important row. If your needs fall outside the common shape, build.',
      },
      {
        aspect: 'Time to a working backend',
        competitor: 'Design, build, test, deploy',
        backenly: 'Describe it, review the plan, apply',
        practical: 'A platform is faster to start. The gap shrinks as your needs get unusual.',
      },
      {
        aspect: 'Expertise needed',
        competitor: 'Backend engineering: SQL, API design, auth and running it in production',
        backenly: 'Less implementation work; the judgment is still yours',
        practical: 'You still choose the data model and access rules. Backenly does not make those choices right.',
      },
      {
        aspect: 'Control',
        competitor: 'Complete. Every decision is yours',
        backenly: 'You direct it; defaults fill the gaps',
        practical: 'Full control pays off when you have firm views on the design.',
      },
      {
        aspect: 'Schema changes',
        competitor: 'Migrations you write, review and run',
        backenly: 'Every change recorded in one History, restorable on its own or back to a point',
        practical: 'Both work. One puts the review in your pull request, the other in the platform.',
      },
      {
        aspect: 'After launch',
        competitor: 'Your monitoring, alerts and on-call',
        backenly: 'Scheduled checks, a short list of safe fixes, approval for the rest',
        practical: 'It will not replace an experienced engineer. It keeps checking in weeks when nobody has time.',
      },
      {
        aspect: 'Portability',
        competitor: 'Complete. Your code, your servers',
        backenly: 'Standard PostgreSQL and REST, Apache-2.0, self-hostable',
        practical: 'No real difference. Neither route locks you in.',
      },
      {
        aspect: 'Cost',
        competitor: 'Engineering time, up front and ongoing',
        backenly: 'A subscription, plus your time directing it',
        practical: 'Which is cheaper depends on your team and needs. There is no general answer.',
      },
    ],
    competitorStrengths: [
      {
        title: 'No limit on what it can do',
        body: 'Unusual data models, specific performance needs, uncommon protocols and custom consistency rules are all possible when you write the code.',
      },
      {
        title: 'Every decision is yours',
        body: 'Where a platform applies a default, a hand-built system applies your choice. That is worth a lot when you have a firm view.',
      },
      {
        title: 'No platform to depend on',
        body: 'Your dependencies are the ones you chose, with no feature list to check and no roadmap to wait for.',
      },
      {
        title: 'Right when the backend is the product',
        body: 'If the backend itself is what you sell, its behavior is your edge, and your own engineers should build it.',
      },
    ],
    backenlyStrengths: [
      {
        title: 'The common parts are built',
        body: 'Tables, an API, sign-in, row access, file storage, change events and scheduled jobs are ready from the start.',
      },
      {
        title: 'One recorded path for changes',
        body: 'Every schema change takes one path, so the history, the restore point and the approval for destructive changes exist without relying on discipline.',
      },
      {
        title: 'Checks that run without you',
        body: 'Scheduled checks catch problems such as unindexed relation columns, bloated tables, policies that match nothing and an API that stopped answering.',
      },
      {
        title: 'A handover engineers understand',
        body: 'A new hire inherits PostgreSQL and REST, not a proprietary runtime. The handover is a schema and an API.',
      },
    ],
    chooseBackenlyWhen: [
      'Your backend supports your product rather than being it.',
      'You need relational data, sign-in, permissions, files, realtime and scheduled or event-driven work.',
      'You would rather spend engineering time on what makes your product different.',
      'You want routine checks to run on a schedule, not when someone remembers.',
    ],
    chooseCompetitorWhen: [
      'Your backend is your product, or how it behaves is what sets you apart.',
      'You need what a platform will not cover: unusual data models, tight latency budgets, uncommon protocols or custom consistency rules.',
      'You have backend engineers who want to own the system, and that ownership is an advantage.',
      'You want every architecture decision made on purpose, not by default.',
      'Regulatory, contract or company rules require an implementation you control end to end.',
    ],
    faq: [
      {
        q: 'Does Backenly mean I never think about the backend?',
        a: 'No. It builds and runs a common backend shape and fixes a short list of problems itself. You still decide the data model, whether a schema fits your product, and what the access rules are.',
      },
      {
        q: 'Can I hire a developer to extend a Backenly backend?',
        a: 'Yes. They get standard PostgreSQL and a REST API, and can work from the dashboard, the API or SQL directly. There is no proprietary runtime to learn first.',
      },
      {
        q: 'What if I need custom logic the platform does not cover?',
        a: 'Functions run on database events, HTTP requests or a schedule, which covers a lot of app logic. Past that there is a real limit, and a hand-built backend is the better choice.',
      },
      {
        q: 'Is it cheaper than hiring an engineer?',
        a: 'That depends on what you need and who is on your team, and a general figure would be made up. A platform is a subscription plus your time directing it. Building is engineering time, up front and ongoing.',
      },
    ],
    facts: [],
  },
]

export const COMPARISON_LIST: readonly ComparisonData[] = LIST

export const COMPARISONS: Record<string, ComparisonData> = Object.fromEntries(
  LIST.map((c) => [c.slug, c]),
)

/** Canonical slug list. The sitemap derives from this, never hand-maintained. */
export const COMPARISON_SLUGS: readonly string[] = LIST.map((c) => c.slug)
