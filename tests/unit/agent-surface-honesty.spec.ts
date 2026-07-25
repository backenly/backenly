/**
 * The agent-facing surface must not tell an agent something untrue.
 *
 * Every case here is a real report from a session driving Backenly over MCP.
 * They look like unrelated bugs and share one shape: a surface stated something
 * about the platform that the platform did not do.
 *
 *   #26  a table owned through a foreign key was reported as unfixable
 *   #29  a working disconnect path reported as "no such tool exists"
 *   #30  preview branches, which exist, reported as unsupported
 *   #36  a plain storefront blocked on a `subscriptions` table it does not need
 *   #40  the docs and the runtime advertising different integration lists
 *   #43  an error message recommending a tool the manifest did not advertise
 *   #46  a public product catalog flagged `critical | missing_rls`
 *
 * These assert the behaviour, not the wording, so they survive copy edits and
 * still fail if the behaviour regresses.
 */

import {
  inferRlsPlanFromCatalog,
  severityForPlan,
  exposureReason,
  type OwnershipCatalog,
} from '@/lib/services/rls-ownership'
import { looksFabricated, verificationLabel } from '@/lib/integrations/key-verification'
import { buildCatalog, buildDispatchable } from '@/lib/mcp/catalog'

// ── #26 / #46 — ownership inference ──────────────────────────────────────────

/** The e-commerce schema from the report: users ← orders ← order_items. */
function ecommerceCatalog(): OwnershipCatalog {
  return {
    schemaName: 'workspace_test',
    columns: new Map<string, string[]>([
      ['users', ['id', 'email', 'password_hash']],
      ['orders', ['id', 'user_id', 'total', 'status']],
      ['order_items', ['id', 'order_id', 'product_id', 'quantity', 'price']],
      ['products', ['id', 'name', 'price', 'description']],
      ['shipping_addresses', ['id', 'order_id', 'line1', 'city', 'postcode']],
      ['audit_log', ['id', 'event', 'payload']],
    ]),
    foreignKeys: [
      { childTable: 'orders', childColumn: 'user_id', parentTable: 'users', parentColumn: 'id' },
      { childTable: 'order_items', childColumn: 'order_id', parentTable: 'orders', parentColumn: 'id' },
      { childTable: 'order_items', childColumn: 'product_id', parentTable: 'products', parentColumn: 'id' },
      { childTable: 'shipping_addresses', childColumn: 'order_id', parentTable: 'orders', parentColumn: 'id' },
    ],
  }
}

describe('RLS ownership follows foreign keys, not column names', () => {
  const catalog = ecommerceCatalog()

  it('protects a table owned DIRECTLY by a user column', () => {
    const plan = inferRlsPlanFromCatalog(catalog, 'orders')
    expect(plan.kind).toBe('own_rows')
    if (plan.kind === 'own_rows') expect(plan.userIdColumn).toBe('user_id')
  })

  it('protects order_items, which is owned through orders (#26)', () => {
    // The original heuristic looked only for a literal user_id column, found
    // none, and left the table world-readable while reporting an unfixable
    // critical. Every customer's line items were readable by any API key.
    const plan = inferRlsPlanFromCatalog(catalog, 'order_items')
    expect(plan.kind).toBe('related_rows')
    if (plan.kind === 'related_rows') {
      expect(plan.via.localColumn).toBe('order_id')
      expect(plan.via.parentTable).toBe('orders')
      expect(plan.via.parentOwnerColumns).toEqual(['user_id'])
    }
  })

  it('generalises to every indirectly-owned table, not just line items', () => {
    const plan = inferRlsPlanFromCatalog(catalog, 'shipping_addresses')
    expect(plan.kind).toBe('related_rows')
  })

  it('a FK to users IS ownership even under a non-canonical name', () => {
    const c: OwnershipCatalog = {
      schemaName: 'workspace_test',
      columns: new Map([
        ['users', ['id', 'email']],
        ['invoices', ['id', 'customer_id', 'amount']],
      ]),
      foreignKeys: [
        { childTable: 'invoices', childColumn: 'customer_id', parentTable: 'users', parentColumn: 'id' },
      ],
    }
    const plan = inferRlsPlanFromCatalog(c, 'invoices')
    expect(plan.kind).toBe('own_rows')
    if (plan.kind === 'own_rows') {
      expect(plan.userIdColumn).toBe('customer_id')
      expect(plan.basis).toBe('foreign_key')
    }
  })

  it('treats a product catalog as public_read at warning severity (#46)', () => {
    // World-readable is CORRECT for a catalog. Flagging it `critical` next to a
    // table leaking customer orders is how a queue trains its reader to ignore
    // it — which is how the order_items exposure went unnoticed.
    const plan = inferRlsPlanFromCatalog(catalog, 'products')
    expect(plan.kind).toBe('public_read')
    expect(severityForPlan(plan)).toBe('warning')
  })

  it('still calls a user-owned table critical', () => {
    expect(severityForPlan(inferRlsPlanFromCatalog(catalog, 'orders'))).toBe('critical')
    expect(severityForPlan(inferRlsPlanFromCatalog(catalog, 'order_items'))).toBe('critical')
  })

  it('refuses to guess when ownership is genuinely undecidable', () => {
    // Enabling RLS with no derivable policy makes the table read EMPTY —
    // replacing a data exposure with an outage. Honest refusal, with the reason.
    const plan = inferRlsPlanFromCatalog(catalog, 'audit_log')
    expect(plan.kind).toBe('undecidable')
    expect(plan.template).toBeNull()
    expect(plan.reason.length).toBeGreaterThan(20)
  })

  it('never proposes a self-referencing ownership hop', () => {
    const c: OwnershipCatalog = {
      schemaName: 'workspace_test',
      columns: new Map([
        ['users', ['id']],
        ['categories', ['id', 'parent_id', 'name']],
      ]),
      foreignKeys: [
        { childTable: 'categories', childColumn: 'parent_id', parentTable: 'categories', parentColumn: 'id' },
      ],
    }
    // A policy that subqueries its own table recurses and takes every query on
    // it down. `categories` is reference data, so public_read is the answer.
    const plan = inferRlsPlanFromCatalog(c, 'categories')
    expect(plan.kind).not.toBe('related_rows')
  })

  it('refuses when two DIFFERENT owned parents make the choice ambiguous', () => {
    const c: OwnershipCatalog = {
      schemaName: 'workspace_test',
      columns: new Map([
        ['users', ['id']],
        ['orders', ['id', 'user_id']],
        ['carts', ['id', 'user_id']],
        ['transfers', ['id', 'order_id', 'cart_id']],
      ]),
      foreignKeys: [
        { childTable: 'orders', childColumn: 'user_id', parentTable: 'users', parentColumn: 'id' },
        { childTable: 'carts', childColumn: 'user_id', parentTable: 'users', parentColumn: 'id' },
        { childTable: 'transfers', childColumn: 'order_id', parentTable: 'orders', parentColumn: 'id' },
        { childTable: 'transfers', childColumn: 'cart_id', parentTable: 'carts', parentColumn: 'id' },
      ],
    }
    // Two defensible policies and no basis to choose. Installing one silently
    // would be a guess with security consequences.
    expect(inferRlsPlanFromCatalog(c, 'transfers').kind).toBe('undecidable')
  })
})

// ── #27 / #28 — credentials are verified, never invented ─────────────────────

describe('fabricated credentials are refused before they reach a provider', () => {
  it('rejects the exact placeholder from the report', () => {
    expect(looksFabricated('sk_test_FAKE0000000000000000000000')).toBeTruthy()
  })

  it('rejects common placeholder shapes', () => {
    for (const k of [
      'sk_live_YOUR_KEY_HERE',
      'whsec_xxxxxxxxxxxx',
      're_CHANGEME12345',
      'sk-ant-PLACEHOLDER',
      'sk_test_000000000000',
    ]) {
      expect(looksFabricated(k)).toBeTruthy()
    }
  })

  it('does not reject a realistic high-entropy key', () => {
    expect(looksFabricated('sk_live_51H8xQ2KzP9mWvR3tYbN7cLdF')).toBeNull()
  })

  it('never labels an unconfirmed credential as connected', () => {
    // "stored" and "working" are different facts. A UI that renders
    // unverifiable/unreachable as "connected" is the bug this exists to remove.
    expect(verificationLabel('verified')).toMatch(/confirmed/i)
    for (const s of ['unverifiable', 'unreachable', 'unchecked'] as const) {
      expect(verificationLabel(s)).not.toMatch(/^connected/i)
    }
    expect(verificationLabel('rejected')).toMatch(/rejected/i)
  })
})

// ── #30 — branches exist and are reachable ───────────────────────────────────

describe('preview branches are reachable from an agent (#30)', () => {
  const advertised = new Set(buildCatalog().map((t) => t.name))
  const dispatchable = new Set(buildDispatchable().map((t) => t.name))

  it('advertises a branch door', () => {
    // Reported as "Backenly does not currently support preview branches" while
    // the engine, the model, the API and the dashboard page all existed. The
    // only thing missing was a door.
    expect(advertised.has('branch')).toBe(true)
  })

  it('every advertised branch action dispatches to a real tool', async () => {
    const { BRANCH_ACTIONS } = await import('@/lib/mcp/catalog')
    const schema: any = buildCatalog().find((t) => t.name === 'branch')!.inputSchema
    expect(schema.properties.action.enum).toEqual(Object.keys(BRANCH_ACTIONS))
    for (const target of Object.values(BRANCH_ACTIONS)) {
      expect(dispatchable.has(target as string)).toBe(true)
    }
  })

  it('offers no discard action, and does not dispatch discard_branch', () => {
    // Dropping a branch schema is irreversible, so it routes through
    // backend_chat → the human Review Queue like every other destructive op.
    expect(dispatchable.has('discard_branch')).toBe(false)
  })

  it('keeps the catalog inside the tool-selection budget', () => {
    // Adding branches must not be paid for out of every other call's accuracy.
    expect(buildCatalog().length).toBeLessThanOrEqual(20)
  })
})

// ── #36 — readiness must not demand an architecture ──────────────────────────

describe('integration readiness does not require tables a product may not need (#36)', () => {
  it('does not block Stripe on subscriptions or payment_events', async () => {
    // A one-time-purchase shop could never reach "configured": it was blocked on
    // a subscriptions table it has no use for. A gate that demands tables the
    // product does not need is asserting an architecture, not measuring
    // readiness.
    const mod: any = await import('@/lib/integrations/readiness')
    const spec = mod.__DEPENDENCY_SPECS?.stripe
    expect(spec).toBeTruthy()
    expect(spec.requiredTables).not.toContain('subscriptions')
    expect(spec.requiredTables).not.toContain('payment_events')
    // Still offered, as a suggestion that says what it is FOR.
    const suggested = (spec.suggestedTables ?? []).map((s: any) => s.name)
    expect(suggested).toContain('subscriptions')
  })

  it('still blocks Stripe on the webhook signing secret', async () => {
    // This one IS a real broken state: without it the receiver rejects every
    // inbound event. The fix for a missing credential is to ask, never to
    // invent one.
    const mod: any = await import('@/lib/integrations/readiness')
    expect(mod.__DEPENDENCY_SPECS.stripe.requiredKeys).toContain('stripe_webhook_secret')
  })
})

// ── #40 — one integration list, not three ────────────────────────────────────

describe('the connector list has a single source (#40)', () => {
  it('reports every provider the runtime can actually wire', async () => {
    // The docs advertised OneSignal and omitted Resend/SendGrid/Twilio; the
    // runtime's hint listed those three and omitted OneSignal, Replicate,
    // Runway and Stability. Both were partial views of a correct registry.
    const { connectableProviderIds } = await import('@/lib/services/ai-functions/integration-registry')
    const ids = connectableProviderIds()
    for (const id of ['stripe', 'resend', 'sendgrid', 'openai', 'anthropic', 'twilio', 'posthog', 'onesignal']) {
      expect(ids).toContain(id)
    }
  })

  it('omits `email`, which is an alias rather than something you connect', async () => {
    const { connectableProviders } = await import('@/lib/services/ai-functions/integration-registry')
    expect(connectableProviders().some((p) => p.id === 'email')).toBe(false)
  })
})

// ── #43 / #45 — no surface may name a tool an agent cannot call ──────────────

describe('agent-facing text never recommends an unadvertised tool (#43)', () => {
  const advertised = new Set(buildCatalog().map((t) => t.name))

  it('advertises get_table_schema, which the error text recommends', () => {
    // A run_query guard told the agent to "use get_table_schema" while the
    // manifest did not list it — advice that could not be followed, inside the
    // message explaining what went wrong.
    expect(advertised.has('get_table_schema')).toBe(true)
  })

  it('advertises every tool the read-query guard tells an agent to use', async () => {
    const raw = await import('fs/promises').then((fs) =>
      fs.readFile(require.resolve('@/lib/mcp/read-query'), 'utf8').catch(() => ''),
    )
    expect(raw.length).toBeGreaterThan(0)

    // Comments explain the design to US and routinely name unadvertised-but-
    // dispatchable tools on purpose (`db_query` is discussed at length as the
    // thing run_query replaced). Only text that REACHES AN AGENT is in scope.
    const agentFacing = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    // Bare, not backticked: the guard's hint reads "use read_backend_state
    // {section:"tables"} or get_table_schema {tableName}" in plain prose.
    const dispatchable = new Set(buildDispatchable().map((t) => t.name))
    const named = new Set<string>()
    for (const m of agentFacing.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
      if (dispatchable.has(m[1])) named.add(m[1])
    }

    // The guard does recommend tools — if this is empty the test is vacuous.
    expect(named.size).toBeGreaterThan(0)
    expect([...named].filter((t) => !advertised.has(t))).toEqual([])
  })
})

/**
 * ── #12 — two-party tables ───────────────────────────────────────────────────
 *
 * `own_rows` compares ONE column to the caller. On a table where a row belongs to
 * two users it does not degrade gracefully; it picks a side. The inference took
 * whichever foreign key the catalog listed first, so on
 *
 *     connections(requester_id → users, addressee_id → users)
 *
 * it installed `requester_id = auth.uid()` and the ADDRESSEE could not read the
 * connection request addressed to them. Same for conversations(user_a, user_b)
 * and messages(sender_id, recipient_id).
 *
 * Reported as defect #12, and it is the gap that made owner-only RLS unable to
 * express any social, messaging or marketplace schema. The related escalation —
 * "Cannot apply own_rows to connections — it has no ownership column" — was the
 * same schema hitting the OTHER owner detector, which read column names only.
 */
function socialCatalog(): OwnershipCatalog {
  return {
    schemaName: 'workspace_test',
    columns: new Map<string, string[]>([
      ['users', ['id', 'email', 'password_hash']],
      ['profiles', ['id', 'user_id', 'headline', 'is_public']],
      ['connections', ['id', 'requester_id', 'addressee_id', 'status']],
      ['conversations', ['id', 'user_a', 'user_b', 'last_message_at']],
      ['messages', ['id', 'conversation_id', 'sender_id', 'body']],
      ['follows', ['id', 'follower_id', 'following_id']],
      ['profile_views', ['id', 'viewer_id', 'viewed_profile_id']],
    ]),
    foreignKeys: [
      { childTable: 'profiles', childColumn: 'user_id', parentTable: 'users', parentColumn: 'id' },
      { childTable: 'connections', childColumn: 'requester_id', parentTable: 'users', parentColumn: 'id' },
      { childTable: 'connections', childColumn: 'addressee_id', parentTable: 'users', parentColumn: 'id' },
      { childTable: 'conversations', childColumn: 'user_a', parentTable: 'users', parentColumn: 'id' },
      { childTable: 'conversations', childColumn: 'user_b', parentTable: 'users', parentColumn: 'id' },
      { childTable: 'messages', childColumn: 'conversation_id', parentTable: 'conversations', parentColumn: 'id' },
      { childTable: 'messages', childColumn: 'sender_id', parentTable: 'users', parentColumn: 'id' },
    ],
  }
}

describe('two-party tables get a two-party policy (#12)', () => {
  const catalog = socialCatalog()

  it('connections is owned by BOTH the requester and the addressee', () => {
    const plan = inferRlsPlanFromCatalog(catalog, 'connections')
    expect(plan.kind).toBe('party_rows')
    if (plan.kind === 'party_rows') {
      expect(plan.partyColumns).toEqual(['requester_id', 'addressee_id'])
      expect(plan.basis).toBe('foreign_key')
    }
  })

  it('conversations is owned by both participants', () => {
    const plan = inferRlsPlanFromCatalog(catalog, 'conversations')
    expect(plan.kind).toBe('party_rows')
    if (plan.kind === 'party_rows') expect(plan.partyColumns).toEqual(['user_a', 'user_b'])
  })

  it('never resolves a two-party table to own_rows on one side', () => {
    for (const table of ['connections', 'conversations']) {
      const plan = inferRlsPlanFromCatalog(catalog, table)
      expect(plan.kind).not.toBe('own_rows')
    }
  })

  it('a one-owner table is still own_rows — the fix does not widen access', () => {
    const plan = inferRlsPlanFromCatalog(catalog, 'profiles')
    expect(plan.kind).toBe('own_rows')
    if (plan.kind === 'own_rows') expect(plan.userIdColumn).toBe('user_id')
  })

  it('messages inherit BOTH participants of their conversation', () => {
    // messages has FKs to users(sender_id) AND conversations. Ownership through
    // the conversation must carry both parties, or the recipient cannot read a
    // message sent to them — defect #12 one hop further out.
    const plan = inferRlsPlanFromCatalog(catalog, 'messages')
    if (plan.kind === 'related_rows') {
      expect(plan.via.parentTable).toBe('conversations')
      expect(plan.via.parentOwnerColumns).toEqual(expect.arrayContaining(['user_a', 'user_b']))
    } else {
      // Resolving via the sender FK is also acceptable ONLY if it names both
      // parties — never a single side.
      expect(plan.kind).toBe('party_rows')
    }
  })

  it('recognises a two-party table with no declared foreign keys', () => {
    const c: OwnershipCatalog = {
      schemaName: 'workspace_test',
      columns: new Map([
        ['users', ['id']],
        ['follows', ['id', 'follower_id', 'following_id']],
      ]),
      foreignKeys: [],
    }
    const plan = inferRlsPlanFromCatalog(c, 'follows')
    expect(plan.kind).toBe('party_rows')
    if (plan.kind === 'party_rows') {
      expect(plan.partyColumns).toEqual(expect.arrayContaining(['follower_id', 'following_id']))
    }
  })

  it('treats a declared owner plus a named counterparty as two-party', () => {
    // Only the sender FK was declared; the recipient is named by convention.
    // owner-only RLS here hides a message from the person it was sent to.
    const c: OwnershipCatalog = {
      schemaName: 'workspace_test',
      columns: new Map([
        ['users', ['id']],
        ['dms', ['id', 'sender_id', 'recipient_id', 'body']],
      ]),
      foreignKeys: [
        { childTable: 'dms', childColumn: 'sender_id', parentTable: 'users', parentColumn: 'id' },
      ],
    }
    const plan = inferRlsPlanFromCatalog(c, 'dms')
    expect(plan.kind).toBe('party_rows')
    if (plan.kind === 'party_rows') {
      expect(plan.partyColumns).toEqual(expect.arrayContaining(['sender_id', 'recipient_id']))
    }
  })

  it('a two-party table with RLS off is still critical', () => {
    expect(severityForPlan(inferRlsPlanFromCatalog(catalog, 'connections'))).toBe('critical')
  })

  it('names both parties in the exposure reason, not just one', () => {
    const plan = inferRlsPlanFromCatalog(catalog, 'connections')
    const why = exposureReason('connections', plan)
    expect(why).toMatch(/requester_id/)
    expect(why).toMatch(/addressee_id/)
  })
})
