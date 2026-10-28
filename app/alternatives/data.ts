/**
 * Alternatives: evaluation content, deliberately not a second comparison page.
 *
 * WHY THIS IS SEPARATE FROM app/comparisons/data.ts
 * -------------------------------------------------
 * /alternatives used to be a lower-fidelity copy of /comparisons: the same four
 * competitors, the same capability claims, and three of its four entries on
 * stale copy. The split is by reader, not by topic. Someone on /comparisons has
 * a shortlist and wants to know how two products differ. Someone here is
 * earlier: they are deciding whether to move at all, and the useful thing is a
 * way to decide, plus an honest account of when the answer is "stay".
 *
 * So this file holds criteria, limits, and switching costs. It holds no
 * per-competitor capability rows and no competitor positioning lines. The
 * content-integrity gate enforces that: if a string here also contains a
 * comparison summary, intro or positioning line, the build fails.
 *
 * WHAT THE PAGE SHOWS (2026-10-15, founders: "no jargon, no lots of text")
 * ------------------------------------------------------------------------
 * The six questions with Backenly's answer to each, where Backenly does not
 * fit (`NOT_FOR`, `DO_NOT_SWITCH`), what switching costs, and a short FAQ.
 * Every entry is a title and one or two plain sentences. `REASONS_TEAMS_LOOK`
 * is no longer shown; it stays because the content gate reads it.
 *
 * `NOT_FOR` and `DO_NOT_SWITCH` are the fields that make this page worth
 * reading. They are sourced from limits that are checkable in this repository,
 * and they are not to be softened into advantages.
 */

export type Criterion = {
  /** The question a reader should actually ask. */
  question: string
  /** Why it matters, in a sentence or two. */
  why: string
  /** Where Backenly lands, stated without decoration. */
  backenly: string
}

export type SwitchingCost = {
  item: string
  detail: string
  /** The one part of a move that is cheap. Shown with a check instead of a dash. */
  cheap?: boolean
}

/**
 * Reasons teams start looking. True of the situation rather than flattering
 * to us: two of these are not problems Backenly solves. Not rendered.
 */
export const REASONS_TEAMS_LOOK: { title: string; body: string }[] = [
  {
    title: 'The data model stopped fitting',
    body: 'A query the product now needs cannot be written without restructuring the data. It is the most expensive reason to move.',
  },
  {
    title: 'Nobody wants to own the upkeep',
    body: 'The platform works, but migrations, policy reviews and incident response keep slipping because nobody has time.',
  },
  {
    title: 'The bill became unpredictable',
    body: 'Metered pricing followed a chatty access pattern. The fix is often a data-model change rather than a new platform.',
  },
  {
    title: 'An agent writes most of the code',
    body: 'That asks new questions of a backend: what the agent can read, what it can change, and what happens on a bad turn.',
  },
  {
    title: 'Nobody checked the exit path',
    body: 'Find out what leaving your current platform involves first. If it is a database dump, you may not need to move.',
  },
]

/**
 * The questions that decide this, in the order they tend to matter.
 * Phrased as questions to ask any platform, including this one.
 */
export const CRITERIA: Criterion[] = [
  {
    question: 'Does the data model fit how your data relates?',
    why: "It is the hardest choice to undo. Documents suit simple, self-contained records. Once records reference each other, keeping copies in sync becomes your code's job.",
    backenly: 'PostgreSQL, with joins, foreign keys, constraints and transactions, served over PostgREST and a typed REST API.',
  },
  {
    question: 'Who makes a schema change, and what if it is wrong?',
    why: 'Every platform can change a schema. What differs is who writes the change, what reviews it, whether it is recorded, and whether a drop can happen by accident.',
    backenly: 'Every change is one entry in History, and any of them can be restored alone or with everything after it. Destructive ones wait for a person, with the target named.',
  },
  {
    question: 'Who looks after the backend after launch?',
    why: 'Most platforms give you metrics, logs and alerts, and you respond. That works when an experienced engineer has time. On a small team, most weeks nobody does.',
    backenly: 'Self-healing checks the backend on a schedule and fixes a short list of safe problems. Anything touching auth, or anything destructive, waits for a person. The rest is reported.',
  },
  {
    question: 'What can a coding agent do to your backend?',
    why: 'If an agent writes your code, its access is a security boundary. Check whether destructive actions are reachable, whether a key can be limited, and whether the platform enforces the limit or leaves it to your settings.',
    backenly: 'Twenty-three advertised MCP tools. Destructive requests become an approval for a person, and a read-only key blocks every write, including the natural-language tool.',
  },
  {
    question: 'What does leaving look like?',
    why: 'Check before you arrive: whether the data exports in a standard format, whether the access rules carry over, and whether the source is available.',
    backenly: 'Plain PostgreSQL, so pg_dump. The platform is Apache-2.0 and self-hostable, self-healing included, and the client packages are MIT.',
  },
  {
    question: 'How does the bill behave?',
    why: 'Metered plans can surprise you with a bill. Flat plans can surprise you with a quota. Choose the surprise your team can absorb.',
    backenly: 'Flat monthly plans with visible quotas: a permanent free plan with one project, Pro at $25 a month, and a sales-led Enterprise plan. Self-healing is not metered on any plan.',
  },
]

/**
 * Where Backenly stops. Sourced from limits that are checkable in this
 * repository, and stated without a recovery clause.
 */
export const NOT_FOR: { title: string; body: string }[] = [
  {
    title: 'A backend that is the product',
    body: 'If its behavior is what you sell, such as a database or an exchange, write it yourself.',
  },
  {
    title: 'Offline-first mobile apps',
    body: 'There is no offline storage or sync. Firebase is built for that.',
  },
  {
    title: 'Stored procedures over the API',
    body: 'There is no SQL-function endpoint, so rpc() calls move into functions.',
  },
  {
    title: 'A preview environment per pull request',
    body: 'Branches cover data and the REST API but are not wired into git. Auth, functions and storage stay on main.',
  },
  {
    title: 'A frontend',
    body: 'Backenly is backend only. You bring the frontend, whether you, a visual builder or a coding agent builds it.',
  },
  {
    title: 'A general-purpose server',
    body: 'Functions run on events, HTTP calls and schedules. A workload that needs a general compute platform should use one.',
  },
]

export const DO_NOT_SWITCH: { title: string; body: string }[] = [
  {
    title: 'Your platform works and someone enjoys running it',
    body: "Backenly's main offer is taking that work off your hands. If someone on your team wants the job, you would give up control for little gain.",
  },
  {
    title: 'You are mid-launch',
    body: 'Do not move a backend while you need the product stable. Revisit once things are calm.',
  },
  {
    title: 'The real problem is the data model',
    body: 'Moving a poorly modeled schema moves the problem with it. Fix the model first; you may no longer want to move.',
  },
  {
    title: 'Ecosystem size matters most',
    body: 'If you rely on existing answers, integrations and engineers who know your platform, a smaller one is a real cost.',
  },
]

export const SWITCHING_COSTS: SwitchingCost[] = [
  {
    item: 'Moving the data',
    detail: 'Yours to do: pg_dump between Postgres platforms, or remodeling from a document store. There is no import tool or migration service.',
  },
  {
    item: 'Rewriting access rules',
    detail: 'Policies are not converted. Row-level security is rewritten for Backenly, and Firebase Security Rules do not convert to it at all.',
  },
  {
    item: 'Moving SQL functions',
    detail: 'rpc() calls become event, HTTP or scheduled functions. That is code to write, not a setting.',
  },
  {
    item: 'Checking auth and storage calls',
    detail: 'Backenly has its own auth and storage. Common calls work through the compatibility layer; check anything provider-specific.',
  },
  {
    item: 'The cutover',
    detail: 'Planning it, running it and being ready to go back are yours, on every plan.',
  },
  {
    item: 'The cheap part',
    detail: 'From another PostgREST-based Postgres platform, queries are written the same way, so most client query code moves unchanged.',
    cheap: true,
  },
]

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'How do I know whether moving is worth it?',
    a: 'Pick the question above that matters most to you, then check whether Backenly is better on it. If that is ecosystem size, offline support or a general server runtime, it is not. If nobody wants to own migrations, access rules and incidents, that is what Backenly is built for.',
  },
  {
    q: 'Is there a migration service?',
    a: 'No. A compatibility layer keeps most supabase-js query code working, and pg_dump moves the data, since both sides are PostgreSQL. Moving the data, rewriting policies and the cutover are yours on every plan.',
  },
  {
    q: 'Can I try it without committing?',
    a: 'Yes. The free plan is permanent and includes one project, with the same self-healing as the paid plans. Rebuild one non-critical part of your schema on it and see whether the workflow suits you.',
  },
]
