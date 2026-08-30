import type { ArticleData } from './types'

export const article: ArticleData = {
  slug: 'after-you-launch',
  title: 'After you launch',
  metaDescription:
    'What the autonomy loop does once a backend is live: the four dial settings, the safe band it will act on alone, the review queue for everything else, how undo works, the activity gate, and what monitoring actually measures.',
  lane: 'mechanism',
  category: 'Operations',
  answers: 'Who is watching this backend when I am not, and what will it do without asking?',
  datePublished: '2026-08-29',
  dateModified: '2026-08-29',
  dateDisplay: 'Updated August 29, 2026',
  intro:
    'Generation is the first hour of a backend\'s life. This page is about the rest of it: what the loop checks, what it will change without asking, what it refuses to touch, how you take a change back, and the one condition under which it stops running against your project.',
  sections: [
    {
      heading: 'The dial, and the tiers it moves across',
      blocks: [
        {
          kind: 'p',
          text: 'Findings are graded by blast radius into four tiers, and the dial decides how far up that grade the loop may act without you. The grading is the part worth learning; the dial is just a pointer into it.',
        },
        {
          kind: 'table',
          columns: ['Tier', 'What it covers', 'Handling'],
          rows: [
            ['0 — silent', 'Purely additive and invisible to behaviour: a missing foreign-key index, a drifted or missing API surface.', 'Applied without announcement.'],
            ['1 — announced', 'Additive but user-visible: turning on row-level security, adding a foreign-key constraint.', 'Applied, then notified, with an undo.'],
            ['2 — approval', 'Auth, external credentials, anything destructive.', 'Never automatic. Queued for a human.'],
            ['3 — escalate', 'Irreversible: billing, data loss.', 'Alert only. The loop will not act at all.'],
          ],
        },
        {
          kind: 'table',
          columns: ['Level', 'Auto-applies', 'Action ceiling'],
          rows: [
            ['OFF', 'Nothing. Observes and reports only.', '—'],
            ['CONSERVATIVE', 'Tier 0 only', 'Tightened to half the base limit'],
            ['BALANCED', 'Tier 0 and 1', 'Base limit'],
            ['AGGRESSIVE (default)', 'Tier 0 and 1', 'Twice the base limit'],
          ],
        },
        {
          kind: 'note',
          text: 'BALANCED and AGGRESSIVE act on the same tiers. The difference between them is how many actions the circuit breaker permits per window, not what kinds of change are allowed. Tier 2 and above are hard-denied at every level including AGGRESSIVE — the check refuses them even if a caller passes the wrong level, so the floor is defence in depth rather than a setting anyone can move.',
        },
      ],
    },
    {
      heading: 'Cadence, and the one condition that stops it',
      blocks: [
        {
          kind: 'p',
          text: 'The loop runs at a one-minute cadence on every plan including Free, with no per-window cap and no monthly budget. That is possible because it runs no language model — it is probes and typed actions, so it costs no AI credits and there is nothing to ration. A backend that stops repairing itself when you hit a quota is the failure mode this feature exists to remove, so it is not a paywall on any plan. Plans differ on capacity — projects, users, storage, AI credits — not on whether the loop keeps working.',
        },
        {
          kind: 'p',
          text: 'There is one real bound worth knowing, and it is not a pricing lever. A project enters each pass only if it shows a sign of life in the last 30 days: end-user traffic, a governed change, a conversation with the brain, or simply having been created or modified recently. A project with tables but no signal for 30 days stops being swept until one arrives.',
        },
        {
          kind: 'p',
          text: 'That gate is deliberately generous — traffic alone qualifies, so a live backend nobody has talked about in a month keeps being healed. But it does mean a genuinely dormant project is not being checked, and it is more honest to say so than to imply a backend with no users and no changes is under continuous watch.',
        },
        {
          kind: 'p',
          text: 'One other bound exists and it is a safety limit, not a quota: a rolling ceiling of 500 autonomous data-mutating actions per hour. It is set far above any real workload — a project needing 500 repairs in an hour is broken, not busy — and exists so a flapping detector that "fixes" the same gap every minute cannot rewrite real user data indefinitely.',
        },
      ],
    },
    {
      heading: 'What it fixes alone, and what it queues',
      blocks: [
        {
          kind: 'steps',
          steps: [
            {
              label: 'Monitor',
              title: 'Telemetry from the running backend',
              body: 'Request logs, latency, error rates, and schema state.',
            },
            {
              label: 'Analyze',
              title: 'Probes look for specific conditions',
              body: 'Schema drift, missing indexes, slow queries, RLS gaps, broken triggers, stuck deployments. A probe that cannot run reports UNCHECKED rather than passing.',
            },
            {
              label: 'Plan',
              title: 'Findings become typed fix actions',
              body: 'The same vocabulary your agent uses. A finding with no safe inverse is not proposed as automatic.',
            },
            {
              label: 'Execute',
              title: 'The safe band is applied; the rest waits',
              body: 'Additive, snapshotted, reversible changes go through. Anything touching auth, credentials, or data destruction lands in the review queue.',
            },
            {
              label: 'Report',
              title: 'A receipt, not a checkmark',
              body: 'What was detected, what changed, how it was verified — in the Autonomy tab and the project journal.',
            },
          ],
        },
        {
          kind: 'p',
          text: 'Anything the loop will not apply lands in the Review Queue — the "Waiting on you" section of the Autonomy tab — with approve and reject, and the same receipt. Your agent can poll an escalated destructive operation with `check_approval` rather than sitting on an open call.',
        },
      ],
    },
    {
      heading: 'Taking a change back',
      blocks: [
        {
          kind: 'p',
          text: 'Changes the loop made on its own appear in an applied-changes panel with an Undo. The button is drawn only when the engine will actually honour it: eligibility comes from the same predicate the revert path gates on, so a fix whose pre-fix snapshot failed to capture shows the reason instead of a button that would error on click.',
        },
        {
          kind: 'p',
          text: 'Undoing a row-level security fix is treated differently, because it removes a protection rather than restoring a prior state. It takes a second explicit confirmation, enforced by the server independently of the UI.',
        },
        {
          kind: 'p',
          text: 'Three different mechanisms get called "rollback" and it is worth keeping them apart. Undo on the applied-changes panel reverts an autonomous fix from its pre-fix snapshot. Schema versions are separate: every schema-mutating action snapshots first, and you can list those versions and roll back to one. Deployment rollback is a third thing, and it is plan-gated — Free keeps no deployment history, so it is not available there. Check the pricing page for where your plan sits.',
        },
        {
          kind: 'note',
          text: 'Snapshot capture is deliberately non-fatal: if it fails, the change still proceeds rather than being blocked. That is the right trade for availability, but it means a snapshot is attempted rather than guaranteed — which is exactly why the Undo button checks whether one was actually captured instead of assuming it.',
        },
      ],
    },
    {
      heading: 'What monitoring measures',
      blocks: [
        {
          kind: 'p',
          text: 'Everything is computed from one request-log source of truth, so the dashboard and the loop cannot disagree about what happened. You get latency percentiles (p50/p95/p99), error rate, per-endpoint health, slow-query traces, anomaly detection, and incident history.',
        },
        {
          kind: 'p',
          text: 'Health findings surface where you can act on them — the dashboard\'s clear-up panel and the Autonomy tab — and deliberately not on the monitoring views themselves, which stay neutral. Monitoring is for reading what happened; the queue is for deciding what to do.',
        },
      ],
    },
    {
      heading: 'Publishing a change',
      blocks: [
        {
          kind: 'p',
          text: 'Going live runs a readiness scorecard first and reports blockers and warnings separately — blockers stop the deploy, warnings do not. Then it asks for an explicit typed confirmation before anything becomes publicly callable.',
        },
        {
          kind: 'note',
          text: 'Deploying is not something your agent can do for you. `trigger_deploy` is neither advertised on the MCP surface nor dispatchable, so publishing is a dashboard action by design. The readiness scorecard is reachable over MCP — ask for it through `backend_chat` rather than looking for a named tool — so an agent can tell you what is blocking before you go to the dashboard.',
        },
        {
          kind: 'responsibility',
          platform: [
            'Checks every minute on every plan, uncapped, without spending AI credits.',
            'Applies only reversible, snapshotted changes on its own.',
            'Queues everything touching auth, credentials, or destruction for a human.',
            'Writes a receipt for every action and offers undo where it can honour it.',
          ],
          you: [
            'Set the dial, and approve or reject what reaches the queue.',
            'Keep the project alive enough to be swept — 30 days of complete silence pauses it.',
            'Decide whether a proposed fix is the right answer for your product.',
            'Confirm deploys, and read the blockers rather than forcing past them.',
          ],
        },
      ],
    },
  ],
  conclusion:
    'The loop takes the operational half: it watches, it repairs what is reversible, and it hands you everything else with the evidence attached. It does not make product decisions, it will not touch auth or destroy data without you, and it pauses on a project that has gone completely quiet for a month. Those are the edges worth knowing before you rely on it.',
  relatedSlugs: ['how-backenly-works', 'access-control-and-rls', 'self-hosting'],
}
