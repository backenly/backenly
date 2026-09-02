/**
 * Alternatives — evaluation content, deliberately not a second comparison page.
 *
 * WHY THIS IS SEPARATE FROM app/comparisons/data.ts
 * -------------------------------------------------
 * /alternatives used to be a lower-fidelity copy of /comparisons: the same four
 * competitors, the same capability claims, the same "works well for" pairs, and
 * an eyebrow that literally said "Comparisons". Three of its four entries were
 * still carrying pre-rewrite copy, so the page was both duplicative and the
 * stale half of the duplicate.
 *
 * The split is by reader, not by topic. Someone on /comparisons has a shortlist
 * and wants to know how two specific products differ. Someone here is earlier:
 * they are deciding whether to move at all, and the useful thing is a way to
 * think about the decision, plus an honest account of when the answer is "stay
 * where you are".
 *
 * So this file holds criteria, limits, and switching costs. It holds no
 * per-competitor capability rows and no competitor positioning lines. The
 * content-integrity gate enforces that: if a string here also appears as a
 * comparison summary or positioning line, the build fails, because that is
 * exactly how the duplication grew back last time.
 *
 * `notFor` and `doNotSwitch` are the fields that make this page worth reading.
 * They are sourced from limits that are checkable in this repository, and they
 * are not to be softened into advantages.
 */

export type Criterion = {
  /** The question a reader should actually ask. */
  question: string
  /** Why this one matters more than it looks. */
  why: string
  /** Where Backenly lands, stated without decoration. */
  backenly: string
}

export type SwitchingCost = {
  item: string
  detail: string
}

/**
 * Reasons teams start looking. Written to be true of the situation rather than
 * flattering to us — two of these are not problems Backenly solves.
 */
export const REASONS_TEAMS_LOOK: { title: string; body: string }[] = [
  {
    title: 'The data model stopped fitting',
    body: 'Usually this arrives as a query the product now needs and the database cannot express without restructuring. It is the most expensive reason to move and the one that gives the least warning, because nothing is broken until the requirement appears.',
  },
  {
    title: 'Nobody wants to own the operational half',
    body: 'The platform works; the schema migrations, policy reviews, and incident response around it are the part that keeps slipping. This is less a complaint about the tool than about who has time, and it is the reason most likely to lead somewhere useful.',
  },
  {
    title: 'The bill became unpredictable',
    body: 'Metered pricing tracks usage faithfully, which is a virtue until a chatty access pattern turns into a number nobody forecast. Note that the fix is often a data-modelling change rather than a new platform.',
  },
  {
    title: 'An agent is now writing most of the code',
    body: 'A workflow built around a coding agent asks different questions of a backend: what the agent can read, what it can change, and what happens on a bad turn. A platform chosen before that shift was not chosen against those criteria.',
  },
  {
    title: 'The exit path was never checked',
    body: 'Sometimes the trigger is simply realising nobody knows what leaving would involve. That is worth resolving on your current platform first: if the answer is a database dump, you may not need to move at all.',
  },
]

/**
 * The criteria that actually decide this, in the order they tend to bind.
 *
 * Deliberately phrased as questions to ask any platform, including this one.
 */
export const CRITERIA: Criterion[] = [
  {
    question: 'What is the data model, and does it match how your entities relate?',
    why: 'This is the decision that is hardest to reverse. A document store is excellent for simple, self-contained records and demanding once records reference each other, because the work of keeping denormalised copies consistent moves into your application code. A relational database makes those relationships the model. Changing your mind later means remodelling data that now has users attached to it.',
    backenly: 'PostgreSQL. Relational, with joins, foreign keys, constraints, and transactions, served over both a PostgREST grammar and a typed REST surface.',
  },
  {
    question: 'Who authors and applies a schema change, and what happens if one is wrong?',
    why: 'Every platform can change a schema. The differences are who writes the change, whether anything reviews it, whether there is a record afterwards, and whether a destructive operation can happen by accident. On most platforms this is a migration you write and run, with your pull request as the review. That is a good workflow when someone is reviewing.',
    backenly: 'Changes go through one audited path. Schema-touching work takes a restore point before it runs, and destructive operations stop for human approval with the target named. You direct the change; the platform records and gates it.',
  },
  {
    question: 'What operates the backend after launch, on a week when nobody has time?',
    why: 'Most platforms report: metrics, logs, alerts, and your response. That is the normal and reasonable shape, and an experienced operator with good dashboards will beat any automation. The question is what happens in the weeks when there is no experienced operator with time, which for small teams is most weeks.',
    backenly: 'A loop reconciles the backend against declared invariants on a schedule. A narrow set of additive repairs is applied automatically, anything touching authentication or anything destructive waits for a person, and the rest is reported with its evidence.',
  },
  {
    question: 'What can a coding agent do to your backend, and what happens on a bad turn?',
    why: 'If an agent is writing your code, its access to the backend is a real security boundary rather than a convenience feature. The useful questions are whether destructive operations are reachable at all, whether a key can be scoped down, and whether the constraint is something you configure or something the surface enforces.',
    backenly: 'Twenty advertised MCP tools with destructive operations filtered out of the surface entirely, so they cannot be selected. Those requests become an approval queued for a person. Keys can be minted read-only, which withholds every write door including the natural-language one.',
  },
  {
    question: 'What does leaving look like, concretely?',
    why: 'Worth answering before you arrive rather than when you want to go. The specific things to check are whether the data comes out in a standard format, whether the access rules are portable or have to be rewritten, and whether the source is available if the managed service ever stops suiting you.',
    backenly: 'Ordinary PostgreSQL, so pg_dump. The platform is Apache-2.0 and self-hostable including the autonomy engine, and the client packages are MIT.',
  },
  {
    question: 'What shape is the bill, and how does it fail?',
    why: 'Metered pricing and flat pricing are both honest and they surprise you differently: metered billing surprises you with an invoice, and a flat plan surprises you with a quota. Neither is a trick. Match the failure mode to which surprise your team can absorb.',
    backenly: 'Flat monthly plans with visible quotas. A permanent free plan with one project, a $25 Pro plan, and a sales-led Enterprise tier. Capacity separates the plans; the repair loop is not metered on any of them.',
  },
]

/**
 * Where Backenly stops. Sourced from limits that are checkable in this
 * repository, and stated without a recovery clause.
 */
export const NOT_FOR: { title: string; body: string }[] = [
  {
    title: 'A backend that is itself the product',
    body: 'If you are building a database, an exchange, a protocol implementation, or anything whose backend behaviour is the differentiator, a platform optimised for a common shape will be in the way. Write it yourself.',
  },
  {
    title: 'Offline-first mobile applications',
    body: 'There is no local persistence or offline sync layer. An application expected to work without a connection and reconcile later needs something built for that, and Firebase is the obvious example.',
  },
  {
    title: 'Stored procedures and SQL-function surfaces',
    body: 'Backenly exposes no SQL-function endpoint. Logic lives in functions triggered by database events, HTTP requests, or a schedule, so a codebase leaning on rpc()-style calls needs those call sites re-homed.',
  },
  {
    title: 'Preview environments per pull request',
    body: 'Branches exist and are scoped by API key, but nothing is wired into git. There is no preview-per-PR workflow, and auth, functions, and storage still resolve to main, so a branch is a data environment rather than a full copy of the system.',
  },
  {
    title: 'A frontend',
    body: 'Backenly is backend-only. It produces no interface, and it is not a substitute for an application builder. You bring the frontend, whether that is a framework, a visual builder, or a coding agent.',
  },
  {
    title: 'An arbitrary server-side runtime',
    body: 'Functions are shaped around events, HTTP, and schedules. This is not a general-purpose compute platform, and workloads that need one should use one.',
  },
]

export const DO_NOT_SWITCH: { title: string; body: string }[] = [
  {
    title: 'Your current platform is working and someone enjoys operating it',
    body: 'The main thing Backenly offers is that the operational work is done for you. If a member of your team wants that job and is good at it, you would be trading away control for a benefit you do not need.',
  },
  {
    title: 'You are mid-launch',
    body: 'A backend migration during a period when you need the product stable is a bad trade at almost any level of benefit. If the current system holds, let it hold, and revisit when nothing is on fire.',
  },
  {
    title: 'The real problem is the data model',
    body: 'Moving a poorly modelled schema to a new platform relocates the problem. If the pain is queries the model cannot express, fix the model. You may find you no longer want to move.',
  },
  {
    title: 'Ecosystem size is your binding constraint',
    body: 'If you depend on a large body of existing answers, third-party integrations, and engineers who already know the platform, a smaller one is a real cost. That is a rational reason to stay and it does not need justifying further.',
  },
  {
    title: 'You need something on the "not for" list above',
    body: 'Offline sync, stored procedures, preview-per-PR, or a general-purpose runtime. If one of those is load-bearing for you, this is settled and no amount of other advantages changes it.',
  },
]

export const SWITCHING_COSTS: SwitchingCost[] = [
  {
    item: 'Moving the data',
    detail: 'Yours to do. pg_dump and restore between Postgres platforms; a remodelling exercise from a document store. There is no import tool and no migration service on any plan.',
  },
  {
    item: 'Re-authoring access rules',
    detail: 'Policies are not translated. Row-level security is re-authored against Backenly\'s claim form, and Firebase Security Rules do not convert into RLS at all.',
  },
  {
    item: 'Re-homing anything that was a SQL function',
    detail: 'rpc()-style call sites become event, HTTP, or scheduled functions. This is code, not configuration.',
  },
  {
    item: 'Checking auth and storage call sites',
    detail: 'These are Backenly\'s own implementations. Common calls map across through the compatibility layer; anything provider-specific needs verifying.',
  },
  {
    item: 'The cutover itself',
    detail: 'Planning the window, running it, and being ready to go back. Yours to own, on every plan.',
  },
  {
    item: 'What you do not pay',
    detail: 'If you are coming from another PostgREST-backed Postgres platform, the query grammar is the same and the compatibility entry point means most client query code moves unchanged. That is the one part of this list that is genuinely cheap.',
  },
]

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'How do I know whether moving is worth it at all?',
    a: 'Work out which of the criteria above is actually binding for you, then check whether Backenly is better on that specific one. If the binding constraint is ecosystem size, offline support, or a general-purpose runtime, the answer is no and you can stop there. If it is that nobody wants to own migrations, policy review, and incident response, that is the thing Backenly is built around.',
  },
  {
    q: 'Is there a migration service?',
    a: 'No. There is a client-compatibility layer that lets a supabase-js frontend keep its query grammar, and pg_dump for the data, because both sides are ordinary PostgreSQL. Moving the data, re-authoring the policies, and running the cutover are yours on every plan, and nobody does them for you.',
  },
  {
    q: 'Can I try it without committing?',
    a: 'The free plan is permanent and includes one project, with the same repair loop and the same autonomy settings as the paid plans. The realistic test is to rebuild one non-critical part of your schema on it and see whether the workflow suits you before you consider anything larger.',
  },
  {
    q: 'What happens to my data if I want to leave?',
    a: 'It is PostgreSQL, so pg_dump gives you everything in a standard format that any Postgres will restore. The platform is Apache-2.0 and self-hostable if you would rather run it yourself. This is worth verifying on any platform you are evaluating, including this one, before you depend on it.',
  },
]
