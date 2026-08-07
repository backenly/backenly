/**
 * REQUEST TRACE — name the layer, not just the status code
 * ========================================================
 *
 * The complaint this answers, in the words of a developer who has run this
 * stack for years: "difficulty identifying whether an issue comes from the
 * frontend, API layer, authentication, database or hosting platform", and
 * "debugging feels fragmented because the information is spread across
 * application logs, the hosting dashboard, the database dashboard and Postgres".
 *
 * A status code does not answer that. 403 could be a missing grant, a revoked
 * key, or an RLS policy. 404 could be a dropped table, an unregistered schema,
 * or a typo. And the worst one is not an error at all.
 *
 * ── The case this exists for ────────────────────────────────────────────────
 *
 * A request arrives with a valid key but no end-user token. RLS evaluates
 * `user_id = current_user_id()` against an identity nobody set, matches zero
 * rows, and the API answers `200 []`. Every instrument reports health. The
 * developer sees an empty list and starts looking at the database, because that
 * is where the data is — and the data is fine. The fault is one layer up, in the
 * token their frontend did not send.
 *
 * That request is indistinguishable from "this user genuinely has no rows"
 * unless something records the identity the query actually ran under. This
 * module records it, and says so in a sentence.
 *
 * ── Why this is a pure function ─────────────────────────────────────────────
 *
 * Everything below is a decision about evidence the runtime already has by the
 * time it answers. Keeping it free of Express, Prisma and fetch means the
 * attribution rules are provable in a unit test rather than reproducible only by
 * staging a failure against a live backend, which is exactly the kind of thing
 * that never gets re-checked once written.
 */

import { randomUUID } from 'crypto'

/** Layers a request passes through, in the order it passes through them. */
export type Layer =
  | 'client'      // the caller's own request: bad filter, malformed body
  | 'auth'        // credential or end-user identity
  | 'api'         // Backenly's gateway: exposure rules, routing
  | 'database'    // Postgres: constraints, RLS, missing relations
  | 'platform'    // Backenly's own infrastructure: data plane down, timeouts

export interface RequestFacts {
  /** HTTP status Backenly is about to return. */
  status: number
  /** Rows returned, when the request succeeded and returned a collection. */
  rowCount?: number
  /** Did the caller present an end-user token (not just an API key)? */
  endUserIdentityPresent: boolean
  /** Was the caller a service-role credential (RLS bypassed)? */
  serviceRole: boolean
  /** Does the target table have row-level security enabled? */
  tableHasRls?: boolean
  /** PostgREST's own error code, when it returned one (PGRST106, PGRST205…). */
  upstreamCode?: string | null
  /** True when the upstream request never produced a response at all. */
  upstreamUnreachable?: boolean
  /** The table under request, for the explanation text. */
  table?: string
}

export interface RequestOutcome {
  /** Which layer is responsible. */
  layer: Layer
  /**
   * True when the response looks successful but is very likely not what the
   * developer wanted. This is the whole point of the module.
   */
  silentFailure: boolean
  /** One sentence naming the layer and what to check. */
  explanation: string
}

/**
 * Attribute a finished request to the layer that decided its outcome.
 *
 * Ordered most-specific first. The ordering is load-bearing: an unreachable data
 * plane also produces a 5xx, and a missing schema also produces a 404, so a
 * check that ran later would be shadowed by a coarser one and the explanation
 * would name the wrong layer.
 */
export function classifyRequestOutcome(f: RequestFacts): RequestOutcome {
  const table = f.table ? `"${f.table}"` : 'this table'

  // ── Platform: our own infrastructure, before anything about the request ────
  if (f.upstreamUnreachable) {
    return {
      layer: 'platform',
      silentFailure: false,
      explanation:
        'Backenly\'s data plane did not answer. This is our infrastructure, not your code or ' +
        'your data. The autonomy loop detects and restarts it, and this request can be retried.',
    }
  }
  if (f.upstreamCode === 'PGRST106') {
    return {
      layer: 'platform',
      silentFailure: false,
      explanation:
        'Your project\'s schema is not registered with the REST data plane, so every table ' +
        'returns this error. It is a platform-side registration gap, not a missing table. ' +
        'Backenly repairs it automatically and retries.',
    }
  }
  if (f.upstreamCode === 'PGRST205') {
    return {
      layer: 'platform',
      silentFailure: false,
      explanation:
        `The data plane's schema cache does not yet know about ${table}. The table exists; the ` +
        'cache is stale. Backenly reloads it automatically.',
    }
  }
  if (f.status >= 500) {
    return {
      layer: 'platform',
      silentFailure: false,
      explanation:
        'Backenly failed to serve this request. This is ours, not yours. It is recorded and ' +
        'surfaced to the autonomy loop.',
    }
  }

  // ── The silent one, checked before the ordinary success path ──────────────
  //
  // A 200 with zero rows on an RLS-protected table, from a caller with no
  // end-user identity, is the failure that looks like health from every angle.
  // It is reported as an AUTH problem because that is where the fix is: the
  // frontend did not send a token.
  if (
    f.status >= 200 && f.status < 300 &&
    f.rowCount === 0 &&
    f.tableHasRls &&
    !f.serviceRole &&
    !f.endUserIdentityPresent
  ) {
    return {
      layer: 'auth',
      silentFailure: true,
      explanation:
        `This request succeeded and returned no rows, but it carried no end-user token, so ` +
        `row-level security on ${table} matched nothing. If you expected data here, the gap is ` +
        `in the token your client is sending, not in the database. Send the end-user's token ` +
        `as X-User-Token.`,
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (f.status === 401) {
    return {
      layer: 'auth',
      silentFailure: false,
      explanation:
        'The credential was rejected before the request reached your data. Check the API key, ' +
        'and whether it belongs to this project.',
    }
  }

  // ── API vs database on 403 ────────────────────────────────────────────────
  if (f.status === 403) {
    return {
      layer: f.tableHasRls ? 'database' : 'api',
      silentFailure: false,
      explanation: f.tableHasRls
        ? `Row-level security on ${table} refused this operation for the identity the request ` +
          `carried. The key is valid; the policy declined it.`
        : `Backenly's exposure rules refused this operation on ${table}. The table is internal, ` +
          `or the key lacks the capability for it.`,
    }
  }

  if (f.status === 404) {
    return {
      layer: 'api',
      silentFailure: false,
      explanation:
        `${table} is not reachable through the REST API. Either it does not exist, or it is not ` +
        `exposed. The database itself did not reject this.`,
    }
  }

  // ── Client ────────────────────────────────────────────────────────────────
  if (f.status === 400 || f.status === 422) {
    return {
      layer: 'client',
      silentFailure: false,
      explanation:
        'The request itself was malformed: an unknown column, an invalid filter, or a body that ' +
        'does not match the table. Nothing was changed.',
    }
  }
  if (f.status === 409) {
    return {
      layer: 'database',
      silentFailure: false,
      explanation:
        `A constraint on ${table} rejected this write, most often a unique or foreign key ` +
        `violation. The data plane worked correctly; the row was not acceptable.`,
    }
  }
  if (f.status === 429) {
    return {
      layer: 'api',
      silentFailure: false,
      explanation: 'This API key exceeded its rate limit. Nothing reached the database.',
    }
  }

  return {
    layer: 'api',
    silentFailure: false,
    explanation: 'Request completed.',
  }
}

/** Header carrying the id a developer can quote back to find this request. */
export const REQUEST_ID_HEADER = 'x-backenly-request-id'
/** Header naming the responsible layer, readable without parsing the body. */
export const LAYER_HEADER = 'x-backenly-layer'

/**
 * Reuse a caller-supplied id when it is well-formed, otherwise mint one.
 *
 * Accepting the caller's id is what lets a developer correlate their own
 * frontend log line with Backenly's record of the same request, which is the
 * whole "spread across four dashboards" complaint. It is only ever an opaque
 * label — it selects nothing and grants nothing — so accepting it carries none
 * of the risk that made the branch selector key-bound.
 *
 * Constrained anyway: it is echoed in a response header, so an unvalidated value
 * would be header injection.
 */
export function resolveRequestId(supplied: unknown): string {
  if (typeof supplied === 'string') {
    const trimmed = supplied.trim()
    if (/^[A-Za-z0-9._:-]{8,64}$/.test(trimmed)) return trimmed
  }
  return randomUUID()
}
