/**
 * FIX ACTIONS — the single answer to "can this finding actually be repaired?"
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * This mapping used to live inside `auto-fix-engine.ts`, which imports prisma
 * and therefore cannot be imported by a client component. So the Autonomy queue
 * rendered its "Approve & fix" button without ever being able to ask whether a
 * fix existed — and rendered it for EVERY row, including the ones the engine
 * would answer with "Backenly flagged this but has no automatic repair for it
 * yet". A user clicked a button the code already knew would fail.
 *
 * Splitting the mapping out (pure: no prisma, no server-only imports, the same
 * contract as `finding-summaries` and `finding-groups`) means the button and the
 * engine read the SAME function. The UI cannot promise a repair the executor
 * does not have, because both sides compute it from one switch.
 *
 * `auto-fix-engine` re-exports `buildFixAction` / `getManualRemediationHint` so
 * every existing import keeps working — this is a move, not a fork. Do not
 * re-add a copy of the switch anywhere else; a second copy drifts, and the drift
 * is invisible until it reaches a user as a dead button.
 */

import { normalizeFindingType } from './types'
import type { AIAction } from '@/lib/ai/minimal-executor'

// ── Data-plane outage discrimination ─────────────────────────────────────────

/**
 * Is this `contract_surface_broken` finding a DATA-PLANE outage (PostgREST down
 * or wedged) rather than some other probe failure?
 *
 * The distinction decides whether an executable repair exists, so it is made on
 * evidence rather than on the surface name alone:
 *
 *   • `db` is the only surface PostgREST serves. `auth`/`functions` run on the
 *     Express runtime and `storage`/`healthz` on the Next app — both are the
 *     processes executing this code, and a process cannot autonomously restart
 *     itself mid-request without dropping the very request doing the healing.
 *   • Only upstream-failure statuses qualify. A 404 from `/db/x` means no API
 *     definition; a 403 means RLS. Restarting the data plane for either would
 *     be a guess dressed up as a repair.
 *
 * `httpStatus: null` DOES qualify — the probe's fetch threw before any response
 * (connection refused / DNS / socket hangup), which is the most common shape of
 * a genuinely dead PostgREST.
 */
export function isDataPlaneOutage(details: Record<string, unknown> | null | undefined): boolean {
  const d = (details ?? {}) as Record<string, unknown>
  if (d.surface !== 'db') return false

  const status = d.httpStatus
  if (status === null || status === undefined) return true
  const code = Number(status)
  return code === 502 || code === 503 || code === 504
}

// ── Fix action mapping ────────────────────────────────────────────────────────

/**
 * Maps a FindingType + its details to the concrete AIAction(s) that repair it.
 * Returns null only when there is genuinely no executable repair (e.g. the
 * remediation requires user input that we surface elsewhere — Stripe webhook
 * secret modal, OAuth credentials flow, etc.).
 *
 * Goal: every detected finding either flows through an executable action or
 * has a clearly documented manual remediation path. No silent dead ends.
 */
export function buildFixAction(
  type: string,
  rawDetails: Record<string, unknown>,
): Pick<AIAction, 'action' | 'params'> | null {
  const norm = normalizeFindingType(type, rawDetails)
  if (!norm) return null

  // Resolve the target table from explicit details first, then the table
  // recovered from a `${category}_${location}` dynamic type.
  const details: Record<string, unknown> = {
    ...rawDetails,
    tableName: rawDetails.tableName ?? norm.tableName,
  }

  switch (norm.base) {
    // ── RLS / Permissions ───────────────────────────────────────────────────
    case 'missing_rls':
    case 'rls_denies_everything':
    case 'unprotected_user_data':
    case 'rls_expression_invalid':
      // `'auto'` resolves against the live schema at execution time rather than
      // asserting a policy here. The previous hardcoded
      // `own_rows` + `userIdColumn: 'user_id'` was correct only for tables that
      // happened to carry that exact column: on `order_items` (owned through
      // `orders`) it failed with `column "user_id" does not exist`, and on a
      // public catalog it would have locked reads that are meant to be open.
      // Both surfaced to the user as an escalated, un-repaired critical.
      //
      // `details.rlsTemplate` is what the detector already inferred; honouring it
      // keeps the approve modal's description and the executed repair identical.
      // Anything else falls through to inference. See lib/services/rls-ownership.ts.
      //
      // Except when the inference already answered "undecidable". Returning an
      // action here produced a "Fix now" button whose only possible outcome was
      // applyPermissionPolicy refusing — the dead-end button shape this file
      // exists to prevent. getManualRemediationHint carries the real deliverable
      // for this case: the question, with the columns already checked named.
      if (details.rlsBasis === 'undecidable') return null
      return {
        action: 'SET_PERMISSION',
        params: {
          tableName: details.tableName,
          template: (typeof details.rlsTemplate === 'string' && details.rlsTemplate) || 'auto',
          ...(details.userIdColumn ? { userIdColumn: details.userIdColumn } : {}),
        },
      }

    // ── API coverage ────────────────────────────────────────────────────────
    case 'api_drift':
    case 'missing_api_definition':
    case 'missing_api_crud':
    case 'dead_api_endpoint':
      return {
        action: 'FIX_API',
        params: { tableName: details.tableName },
      }

    // ── Schema integrity ────────────────────────────────────────────────────
    case 'missing_fk':
      return {
        action: 'ADD_CONSTRAINT',
        params: {
          tableName: details.tableName,
          columnName: details.columnName,
          referencedTable: details.referencedTable,
          referencedColumn: details.referencedColumn ?? 'id',
        },
      }

    case 'missing_fk_index':
      return {
        action: 'CREATE_INDEX',
        params: {
          tableName: details.tableName,
          // executeCreateIndex reads `columnName` — emitting `columns: [...]`
          // here silently failed every FK-index fix with "Missing parameters".
          columnName: details.columnName,
        },
      }

    // Same repair as missing_fk_index, reached from measured latency instead of
    // schema shape. Both fields are already verified by the probe (the column
    // exists on the table and no index leads with it), but they are re-checked
    // here rather than assumed: this function is the last gate before DDL, and
    // an undefined columnName would reach executeCreateIndex as "Missing
    // parameters" — a failure the user sees as a dead "Fix now" button.
    case 'slow_query_missing_index':
      if (!details.tableName || !details.columnName) return null
      return {
        action: 'CREATE_INDEX',
        params: {
          tableName: details.tableName,
          columnName: details.columnName,
        },
      }

    // Rebuild a btree that is mostly empty space. Needs the index NAME for the
    // same reason the drop does — a table normally has several.
    case 'index_bloat': {
      const table = details.tableName ?? details.table
      if (!table || !details.indexName) return null
      return {
        action: 'REINDEX_INDEX',
        params: { tableName: table, indexName: details.indexName },
      }
    }

    // The inverse repair: remove an index the database has measurably never
    // used. Gated on `approval` by the classifier, so this only ever builds
    // after a human said yes. `indexName` is the required key — never derived
    // from the table, because two indexes on one table are the normal case and
    // guessing would drop the wrong one.
    case 'unused_index': {
      const table = details.tableName ?? details.table
      if (!table || !details.indexName) return null
      return {
        action: 'DROP_INDEX',
        params: { tableName: table, indexName: details.indexName },
      }
    }

    // A hot table is repairable only when the detector could name a column that
    // actually exists to index. When it could not, returning null here is the
    // honest answer and getManualRemediationHint explains it — emitting
    // CREATE_INDEX with an undefined columnName would fail in the executor with
    // "Missing parameters", which is the dead-end shape this file exists to
    // prevent. Never reconstruct the column from the type suffix: the whole
    // production bug was SQL naming a column the table does not have.
    case 'infra_hot_table': {
      const table = details.tableName ?? details.table
      if (!table || !details.columnName) return null
      return {
        action: 'CREATE_INDEX',
        params: { tableName: table, columnName: details.columnName },
      }
    }

    // Dead-tuple bloat. Unlike infra_hot_table this needs no column — the whole
    // table is the target — so it is always repairable and never dead-ends.
    case 'infra_table_bloat': {
      const table = details.tableName ?? details.table
      if (!table) return null
      return {
        action: 'VACUUM_TABLE',
        params: { tableName: table },
      }
    }

    case 'missing_rate_limit':
      return {
        action: 'SET_RATE_LIMIT',
        params: { tableName: details.tableName },
      }

    case 'shadow_mutation':
      // Schema was edited outside the AI — re-run API generation to reconcile.
      return {
        action: 'FIX_API',
        params: { tableName: details.tableName },
      }

    // ── PostgREST registration ──────────────────────────────────────────────
    // The detector self-heals this at detection time via its own `fix` closure
    // (lib/autonomy/schema-registration.ts). That closure can FAIL — PostgREST
    // unreachable, the SQL function erroring — and a failed detector fix demotes
    // the finding to `pending_approval`, which puts it in front of the user with
    // an approve button. Without this case that button hit `default: return
    // null` and answered "this issue needs your manual review" for a repair the
    // platform performs automatically everywhere else. The classifier has rated
    // it AUTO since it shipped; this is the executable action that rating always
    // implied. Idempotent and additive — see lib/postgrest/registration.ts.
    case 'schema_not_registered':
      return {
        action: 'REGISTER_SCHEMA',
        params: {},
      }

    // ── Runtime contract — a live probe of an advertised surface failed ─────
    // Only the data-plane outage shape has an executable repair; see
    // `isDataPlaneOutage` for why the other surfaces deliberately do not.
    case 'contract_surface_broken':
      return isDataPlaneOutage(rawDetails)
        ? { action: 'HEAL_DATA_PLANE', params: { surface: 'db' } }
        : null

    // ── Realtime ────────────────────────────────────────────────────────────
    case 'realtime_gap':
      return {
        action: 'FIX_REALTIME',
        params: { tableName: details.tableName },
      }

    // ── Auth ────────────────────────────────────────────────────────────────
    case 'auth_jwt_missing':
    case 'auth_users_table_missing':
    case 'broken_auth':
      return {
        action: 'FIX_AUTH',
        params: { issue: type },
      }

    case 'oauth_config_invalid':
    case 'oauth_redirect_uri_missing':
      return {
        action: 'FIX_AUTH',
        params: { issue: type, provider: details.provider },
      }

    case 'auth_spike':
      // Auth-spike anomalies are diagnostic, not actionable — but FIX_AUTH at
      // minimum re-validates the auth subsystem (jwtSecret, users table, etc.)
      // so any concurrent corruption gets repaired. We still surface the anomaly.
      return {
        action: 'FIX_AUTH',
        params: { issue: 'auth_spike' },
      }

    // ── Integrations ────────────────────────────────────────────────────────
    case 'integration_key_invalid':
    case 'integration_webhook_failing':
    case 'integration_smtp_unreachable':
    case 'broken_webhook':
      return {
        action: 'FIX_INTEGRATION',
        params: {
          integrationId: details.integration ?? details.integrationId,
          host: details.host,
          port: details.port,
        },
      }

    // ── Workflow ────────────────────────────────────────────────────────────
    case 'workflow_broken':
    case 'verification_failed':
      return {
        action: 'FIX_WORKFLOW',
        params: {
          workflow: details.workflow,
          missingComponents: details.missingComponents ?? [],
          details,
        },
      }

    // ── Deploy ──────────────────────────────────────────────────────────────
    case 'deploy_failure':
      return {
        action: 'FIX_DEPLOY',
        params: { reason: details.reason },
      }

    // ── Orphan / cleanup ────────────────────────────────────────────────────
    case 'orphan_table':
      // The safe, non-destructive repair is to ADOPT the table: register its
      // platform metadata + generate its REST API + protect it with RLS. This
      // never touches the table's data. (Dropping it is the destructive path and
      // stays a manual action in the Database section.)
      return {
        action: 'REGISTER_TABLE',
        params: { tableName: details.tableName },
      }

    // ── Open loop — DDL observed over a direct database connection ──────────
    case 'external_schema_change':
      // Bookkeeping-only reconciliation (register/refresh/prune metadata,
      // re-baseline snapshot, re-sync grants). Never executes DDL — see
      // lib/autonomy/drift-watch.ts.
      return {
        action: 'ADOPT_EXTERNAL_SCHEMA',
        params: {},
      }

    // ── Phase 4 — risk-flagged action queued from AI chat / orchestration ───
    // Unlike every other case, this one carries the exact already-decided
    // AIAction to re-run once approved — there is nothing to infer from type.
    //
    // CRITICAL: inject `confirmed: true`. buildFixAction is only ever reached
    // on a human-approved path (dashboard approve, or resolve-from-chat), and
    // the executor's medium/high-risk gate (executeSingleAction) re-fires on
    // `!params.confirmed`. Without this flag, approving a gated finding would
    // re-trip the gate, fail with APPROVAL_REQUIRED, and spawn a duplicate
    // pending finding on every attempt — i.e. the action could never actually
    // be approved. The approval IS the confirmation.
    case 'ai_action_pending': {
      const executorAction = rawDetails.executorAction as string | undefined
      if (!executorAction) return null
      const executorParams = (rawDetails.executorParams as Record<string, unknown>) ?? {}
      return {
        action: executorAction as AIAction['action'],
        params: { ...executorParams, confirmed: true },
      }
    }

    default:
      return null
  }
}

// ── Friendly remediation hints for findings without an executable fix ─────────

/**
 * Returns a human-readable next-step hint for findings that can't be auto-fixed
 * because they require user input or external action. Surfaced in the approve
 * modal so the user knows what to do instead of seeing a generic error.
 */
export function getManualRemediationHint(
  type: string,
  details?: Record<string, unknown> | null,
): string | null {
  const norm = normalizeFindingType(type, details ?? null)
  switch (norm?.base) {
    case 'orphan_table':
      // Registration is handled by buildFixAction (REGISTER_TABLE), so this hint
      // is only a fallback. It describes the safe path, not dropping.
      return 'This table exists in your database but is not yet managed by the platform. Click Register to generate its REST API and adopt it — your data is untouched. (To remove it instead, drop it from the Database section.)'
    // Only reached when the detector found no indexable column, since
    // buildFixAction handles the repairable case. Names the real numbers so the
    // owner can judge it, and asks for the column instead of guessing one — an
    // index on the wrong column costs write throughput permanently.
    case 'infra_hot_table': {
      const t = (details?.tableName ?? details?.table ?? 'this table') as string
      const scans = details?.seqScans as number | undefined
      const pct = details?.idxHitPct as number | undefined
      const measured = scans !== undefined && pct !== undefined
        ? ` It was read ${scans.toLocaleString()}× with ${pct}% index coverage.`
        : ''
      return `"${t}" is taking heavy sequential scans and Backenly could not find a column it is safe to index automatically.${measured} Add an index on whichever column your queries filter or sort by — in the AI chat, say "add an index on <table>.<column>".`
    }

    // The hint is the investigation, not a repair — there is no repair that
    // follows from a deviation alone. What it can do is hand over the specific
    // numbers and the specific changes, which is what the developer was about
    // to go and look up.
    case 'behavioural_regression': {
      const measure = String(details?.measure ?? 'this measure').replace(/_/g, ' ')
      const ratio = details?.ratio ? `${details.ratio}x` : 'well above'
      const changes = Array.isArray(details?.changesBefore)
        ? (details!.changesBefore as Array<{ summary: string; minutesBefore: number }>)
        : []
      const list = changes.length > 0
        ? `\n\nWhat landed beforehand:\n${changes
            .map(c => `  · ${c.minutesBefore} min before — ${c.summary}`)
            .join('\n')}`
        : '\n\nNothing Backenly records changed on this backend beforehand, so look at your own ' +
          'application code and traffic for the same window.'
      const sql = typeof details?.sql === 'string' ? `\n\nThe statement:\n  ${details.sql}` : ''
      return (
        `${measure} is ${ratio} this backend's own normal, measured across ` +
        `${details?.observedHours ?? 'several'} hours of history.${sql}${list}` +
        `\n\nBackenly is not claiming any of these caused it.`
      )
    }

    // The hint IS the deliverable, same as schema_design_defect: the probe has
    // already derived the exact statement, so printing it beats describing it.
    case 'intent_drift': {
      const t = (details?.tableName ?? 'this table') as string
      const col = (details?.columnName ?? 'the column') as string
      const migration = typeof details?.migration === 'string' ? `

${details.migration}` : ''
      return (
        `"${t}"."${col}" was asked for as ${details?.requested ?? 'one type'} and the database ` +
        `has ${details?.actual ?? 'another'}. If the request is still what you want, run:${migration}` +
        `

If the column is deliberately different now, tell your coding agent to rebuild it ` +
        `through Backenly so the recorded intent matches what you actually have.`
      )
    }

    // No repair exists and none should. Terminating a backend rolls back
    // whatever that session was doing, which Backenly cannot see and did not
    // start. The hint gives the owner the exact query to find it themselves.
    case 'idle_in_transaction': {
      const n = (details?.sessions as number | undefined) ?? 1
      const secs = (details?.maxIdleSeconds as number | undefined) ?? 0
      const mins = Math.max(1, Math.round(secs / 60))
      return (
        `${n} of your direct database connection${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} ` +
        `been inside an open transaction for ${mins} minute${mins === 1 ? '' : 's'}. Commit or close ` +
        `it — usually a psql window, a notebook, or a migration tool that ran BEGIN and stopped. ` +
        `To find it: SELECT pid, usename, state_change, query FROM pg_stat_activity WHERE state = ` +
        `'idle in transaction'; then COMMIT in that session, or pg_terminate_backend(pid) if you ` +
        `are certain its work can be discarded. Backenly will not terminate it for you — it cannot ` +
        `see what would be rolled back.`
      )
    }

    // Reached when the ownership inference answered "undecidable". The hint IS
    // the deliverable: there is no repair to run, only a question to answer, and
    // the probe already recorded exactly which columns it checked. Repeating
    // that back is what makes the request answerable instead of accusatory.
    case 'missing_rls':
    case 'unprotected_user_data':
    case 'rls_expression_invalid':
    case 'rls_denies_everything': {
      if (details?.rlsBasis !== 'undecidable') return null
      const t = (details?.tableName ?? details?.table ?? 'this table') as string
      const rationale = typeof details?.rlsRationale === 'string' ? ` ${details.rlsRationale}` : ''
      return (
        `Backenly will not enable row-level security on "${t}" until it knows who owns a row, ` +
        `because a policy that matches nothing makes the table read empty for every user.${rationale} ` +
        `Tell it the rule and it will install and verify the policy — in your coding agent, ` +
        `something like: set_rls on ${t} so a row is visible when <column> equals the signed-in ` +
        `user, or when it belongs to a <parent table> row that does.`
      )
    }

    // Only reached when the finding arrived without the index name — an older
    // row, or a hand-written one. buildFixAction refuses to derive it from the
    // table, because two indexes on one table is the normal case and guessing
    // would drop the wrong one; a wrong DROP INDEX is a rebuild on a table that
    // may be very large. Ask for the name instead.
    case 'unused_index': {
      const t = (details?.tableName ?? details?.table ?? 'this table') as string
      const idx = details?.indexName as string | undefined
      const days = details?.observedDays as number | undefined
      const window = days ? ` across ${days} days of observation` : ''
      return idx
        ? `PostgreSQL never used "${idx}" on "${t}"${window}, so it is being maintained on every write for nothing. Approve the drop above, or run it yourself: DROP INDEX CONCURRENTLY "${idx}";`
        : `An index on "${t}" has gone unused${window}, but this finding does not name which one — Backenly will not guess, because dropping the wrong index means rebuilding it. Check pg_stat_user_indexes for "${t}" and drop the one with no scans.`
    }

    // Already contained by the runtime — every one of these requests was refused
    // before it reached the database, so this hint describes cleanup, not an
    // emergency. It still has to be explicit about rotation: refusing the browser
    // calls stops Backenly serving the data, but the key itself is sitting in a
    // shipped bundle where anyone can read it, and it will keep working from any
    // non-browser client until it is revoked.
    case 'service_role_key_exposed': {
      const name = (details?.keyName as string | undefined) ?? 'this key'
      const origins = Array.isArray(details?.origins) ? (details!.origins as string[]) : []
      const where = origins.length > 0 ? ` It was called from ${origins.slice(0, 3).join(', ')}.` : ''
      return (
        `"${name}" is a service-role key and it is being called from a browser.${where} ` +
        `Backenly refused those requests, so no rows were served — but the key is readable by ` +
        `anyone who views your site's source, and it still works from curl or any server. ` +
        `Three steps: swap the browser code to a client key (Project → API keys), move this key ` +
        `to a server route or a Backenly function, then revoke and reissue it.`
      )
    }

    // The hint IS the deliverable for this family: the probe already measured
    // the defect against live statistics and derived the migration, so the only
    // thing left to hand over is the SQL itself. Printing it beats describing it.
    // Only reached when the probe raised a finding without a verified column,
    // which its own filters should prevent. Kept because a notify_only path with
    // no hint is the dead end this function exists to close, and "should not
    // happen" is not a reason to render an empty row.
    case 'slow_query_missing_index': {
      const t = (details?.tableName as string | undefined) ?? 'a table'
      const ms = details?.avgMs as number | undefined
      const timing = typeof ms === 'number' ? ` averaging ${ms}ms` : ''
      return (
        `Queries against "${t}"${timing} are scanning rather than using an index, and Backenly ` +
        `could not confirm which column to index safely. Add an index on the column your ` +
        `queries filter by, or say "add an index on ${t}.<column>" in the AI chat.`
      )
    }

    case 'schema_design_defect': {
      const sql = details?.sql as string | undefined
      const problem = details?.reason as string | undefined
      // Must never answer null. A notify_only finding with no hint is the exact
      // dead end this function exists to prevent ("No fix action mapped for
      // finding type"), and the probe is not the only caller — the conformance
      // guards ask for a hint with no details at all.
      if (!sql && !problem) {
        return (
          'Backenly compared this column against your live data and found the declaration ' +
          'does not match it. Open the finding for the measurement and the exact migration ' +
          'to run. These change an existing column, so apply them during a quiet window.'
        )
      }
      if (!sql) return problem!
      return `${problem ? problem + ' ' : ''}Run this when you are ready:\n\n${sql}`
    }

    case 'missing_archival_job':
      return 'This table will keep growing without bound. In the AI chat, say "schedule a nightly cleanup on <table> older than 90 days" — Backenly will create the cron + the cleanup function with the retention you pick.'
    case 'missing_token_cleanup_cron':
      return 'Expired tokens are accumulating. In the AI chat, say "schedule a daily cron to delete expired rows from <table>" — Backenly will create the cleanup job.'

    // Informational by design: an integration you connected has no code path
    // using it yet. There is nothing to repair — the finding exists so a
    // half-finished setup does not sit forgotten.
    case 'integration_connected_unused':
      return 'This integration is connected but nothing calls it yet. Use it from a function (ctx.integrations), or disconnect it in Integrations if it was set up by mistake.'

    // The one fault that is invisible to every other instrument, so the hint has
    // to carry the whole explanation. A policy written against the legacy app.*
    // GUCs evaluates against an identity PostgREST never sets: it matches no
    // rows, the API answers 200 with an empty array, and nothing errors or logs.
    // Monitoring sees healthy traffic while the customer sees their data gone.
    //
    // Deliberately NOT auto-fixed: rewriting a live RLS policy is a security
    // mutation on the exact code path that decides who can read what, and
    // getting it wrong the other way exposes rows. It states the repair
    // precisely instead, so the user (or their coding agent) can apply it.
    case 'runtime_engine_mismatch':
      return 'One or more RLS policies on this project read the legacy app.* session variables, which the current data plane never sets — so those policies match no rows and the API returns an empty list instead of an error. Nothing looks broken from the outside, which is why this is flagged rather than waited on. Ask your coding agent to rewrite the affected policies to the claim form (current_setting(\'request.jwt.claims\', true)::json ->> \'sub\'), or say "fix my RLS identity" in the AI chat. Backenly does not rewrite live policies on its own.'

    // A gated action re-runs from the exact AIAction recorded in its details.
    // Without that payload there is nothing to re-run, and inventing one from
    // the type would execute something the user never approved.
    case 'ai_action_pending':
      return 'The details of this queued change were not recorded, so it cannot be replayed automatically. Dismiss it and ask the AI chat to make the change again — it will re-queue with a full record.'

    // Surface probes that are NOT a data-plane outage. Named per surface,
    // because "check your dashboard" is useless for a fault whose cause is in
    // the serving chain rather than in the user's backend. The data-plane shape
    // never reaches here — it maps to HEAL_DATA_PLANE above.
    case 'contract_surface_broken': {
      const surface = (details ?? {})['surface']
      switch (surface) {
        case 'auth':
          return 'The live signup → signin round-trip is failing. Open Auth & Users and confirm a provider is enabled and the JWT secret is set. This is a runtime fault, not a schema one — Backenly does not change auth configuration on its own.'
        case 'storage':
          return 'The storage endpoints are not answering. Backenly has detected this and is monitoring it; storage is served by the platform, so there is nothing to change in your project. It will clear automatically once the surface recovers.'
        case 'functions':
          return 'The functions dispatcher did not answer as expected. Open Functions and re-deploy the most recently changed function — a failed deploy is the usual cause.'
        default:
          return 'A live probe of this API surface failed. Backenly re-checks every reconcile pass and will clear this automatically the moment the surface answers correctly again.'
      }
    }

    default:
      // Unrecognized type with no executable fix — give a generic, non-dev
      // friendly next step instead of a silent dead end.
      if (!norm) {
        return 'Backenly flagged this but has no automatic repair for it yet. Open the relevant section of your dashboard, or describe the problem in the AI chat and it will help you resolve it.'
      }
      return null
  }
}

// ── The predicate the UI reads ────────────────────────────────────────────────

/**
 * Does this finding have a repair the executor can actually run?
 *
 * The ONE question the Autonomy queue must ask before rendering a fix button.
 * Pure and side-effect free, so the client can call it per row on every render.
 *
 * Deliberately derived from `buildFixAction` rather than from a parallel list of
 * types: a list would be a second copy of the switch, and the whole reason this
 * module exists is that a second copy is how the button and the engine came to
 * disagree in the first place.
 */
export function hasExecutableFix(
  type: string,
  details: Record<string, unknown> | null | undefined,
): boolean {
  return buildFixAction(type, (details ?? {}) as Record<string, unknown>) !== null
}
