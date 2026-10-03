/**
 * SELF-MAINTENANCE VALIDATION LAB — the schema scenario bank
 * ==========================================================
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The autonomous self-maintenance roadmap originally gated on production shadow
 * telemetry: ship the detector, watch real projects, decide whether the pattern
 * occurs often enough to justify building on it.
 *
 * That gate was invalid and had to be replaced. The accounts on production are
 * the founder's own plus a relative's — there is no independent user population,
 * so both outcomes of the shadow run would have been uninformative. A detector
 * that never fires proves nothing when nobody is generating real workloads, and
 * one that fires proves nothing when the person who wrote it caused the firing.
 *
 * So prevalence is not answerable yet and is deliberately NOT what this lab
 * measures. It answers the question that IS answerable now:
 *
 *     Given a backend in a known state, does the machinery reach the correct
 *     conclusion — and, just as importantly, stay silent when it should?
 *
 * ── What this is not ────────────────────────────────────────────────────────
 *
 * Not mocks. Every scenario is real DDL executed against a real PostgreSQL, so
 * the foreign keys, views, constraints and statistics under test are the ones
 * the catalog actually reports. AGENTS.md's rule is that the database is never
 * mocked, and the reason is written across this repo's history: `detectMissingRls`
 * sat dead for months behind a duplicate bind parameter while unit tests that
 * asserted the SHAPE of a result kept passing.
 *
 * Not a benchmark, and not evidence of commercial value. When real users exist,
 * a separate product-validation question can be asked. This one is engineering
 * correctness, and conflating the two is how a team convinces itself a feature
 * is valuable because its tests pass.
 */

/** One table in a seeded scenario. */
export interface LabTable {
  name: string
  /** Raw column DDL, minus the trailing comma. */
  columns: string[]
  /** `[column, referencedTable]` — emitted as real FOREIGN KEY constraints. */
  foreignKeys?: Array<[string, string]>
  /** Enable row-level security on this table after creation. */
  rls?: boolean
  /** Policies to create, as raw `CREATE POLICY` bodies. */
  policies?: string[]
  /** Rows to insert, so probes with statistics thresholds have something to see. */
  seedRows?: number
}

export interface LabView {
  name: string
  /** Body of `CREATE VIEW <name> AS <select>`. */
  select: string
  materialized?: boolean
}

export interface LabScenario {
  id: string
  /** What shape of real backend this imitates. */
  description: string
  tables: LabTable[]
  views?: LabView[]
  /**
   * What the subsystem clusterer should produce, as sorted membership lists,
   * for the CONSTRAINT-ONLY (skeleton) clustering.
   *
   * Stated per scenario rather than asserted generically, because a clusterer
   * that returns "some grouping" for every input is indistinguishable from one
   * that works. Singletons are omitted.
   */
  expectedSkeletonComponents: string[][]
}

// ── The bank ──────────────────────────────────────────────────────────────────

/**
 * Auth-heavy. The canonical target shape: several tables that are obviously one
 * subsystem to an engineer and four unrelated findings to the loop.
 */
const authHeavy: LabScenario = {
  id: 'auth-heavy',
  description: 'Session-based auth with verification tokens and an audit trail',
  tables: [
    { name: 'users', columns: ['id uuid PRIMARY KEY', 'email text', 'email_status text'], seedRows: 60 },
    {
      name: 'sessions',
      columns: ['id uuid PRIMARY KEY', 'user_id uuid', 'expires_at timestamptz'],
      foreignKeys: [['user_id', 'users']],
      seedRows: 60,
    },
    {
      name: 'verification_tokens',
      columns: ['id uuid PRIMARY KEY', 'user_id uuid', 'token text', 'consumed boolean'],
      foreignKeys: [['user_id', 'users']],
      seedRows: 60,
    },
    {
      name: 'password_resets',
      columns: ['id uuid PRIMARY KEY', 'user_id uuid', 'used_at timestamptz'],
      foreignKeys: [['user_id', 'users']],
      seedRows: 60,
    },
    // A second, genuinely unrelated area. Without it the auth component is the
    // whole schema and the breadth guard makes the scenario ineligible for
    // reasons that have nothing to do with what is being tested.
    { name: 'articles', columns: ['id uuid PRIMARY KEY', 'title text'], seedRows: 60 },
    {
      name: 'article_tags',
      columns: ['id uuid PRIMARY KEY', 'article_id uuid', 'tag text'],
      foreignKeys: [['article_id', 'articles']],
      seedRows: 60,
    },
  ],
  expectedSkeletonComponents: [
    ['article_tags', 'articles'],
    ['password_resets', 'sessions', 'users', 'verification_tokens'],
  ],
}

/**
 * Ecommerce. Two well-formed components plus `users` as a hub referenced by
 * both — the arrangement that fuses a schema into one blob under a naive
 * attachment rule.
 */
const ecommerce: LabScenario = {
  id: 'ecommerce',
  description: 'Orders and catalogue as separate components, users as a shared hub',
  tables: [
    { name: 'users', columns: ['id uuid PRIMARY KEY', 'email text'], seedRows: 60 },
    {
      name: 'orders',
      columns: ['id uuid PRIMARY KEY', 'user_id uuid', 'total numeric'],
      foreignKeys: [['user_id', 'users']],
      seedRows: 60,
    },
    {
      name: 'order_items',
      columns: ['id uuid PRIMARY KEY', 'order_id uuid', 'qty integer'],
      foreignKeys: [['order_id', 'orders']],
      seedRows: 60,
    },
    { name: 'products', columns: ['id uuid PRIMARY KEY', 'sku text'], seedRows: 60 },
    {
      name: 'product_images',
      columns: ['id uuid PRIMARY KEY', 'product_id uuid', 'url text'],
      foreignKeys: [['product_id', 'products']],
      seedRows: 60,
    },
    {
      name: 'reviews',
      columns: ['id uuid PRIMARY KEY', 'product_id uuid', 'user_id uuid', 'body text'],
      foreignKeys: [['product_id', 'products']],
      seedRows: 60,
    },
  ],
  expectedSkeletonComponents: [
    ['order_items', 'orders', 'users'],
    ['product_images', 'products', 'reviews'],
  ],
}

/**
 * Messy legacy. No foreign key constraints at all, only `*_id` naming.
 *
 * The uncomfortable case for this whole design: the backends most likely to have
 * structural problems are the ones least likely to have declared the constraints
 * the clusterer reads. The lab includes it so that fact is measured rather than
 * assumed away — a scenario the feature correctly refuses to reason about is a
 * result, not a gap.
 */
const messyLegacy: LabScenario = {
  id: 'messy-legacy',
  description: 'No FK constraints anywhere, relationships implied only by column names',
  tables: [
    { name: 'users', columns: ['id uuid PRIMARY KEY', 'email text'], seedRows: 60 },
    { name: 'orders', columns: ['id uuid PRIMARY KEY', 'user_id uuid'], seedRows: 60 },
    { name: 'order_items', columns: ['id uuid PRIMARY KEY', 'order_id uuid'], seedRows: 60 },
    { name: 'logs', columns: ['id uuid PRIMARY KEY', 'user_id uuid', 'message text'], seedRows: 60 },
  ],
  expectedSkeletonComponents: [],
}

/**
 * View-heavy reporting. Ten views and a materialized view over four base tables.
 *
 * Topology statistics must be identical to the same schema without them. Views
 * carry no foreign keys, so each one would otherwise land as a singleton and
 * distort both the singleton rate and the largest-component share.
 */
const viewHeavy: LabScenario = {
  id: 'view-heavy',
  description: 'Reporting layer of views stacked over a small physical model',
  tables: [
    { name: 'users', columns: ['id uuid PRIMARY KEY', 'email text'], seedRows: 60 },
    {
      name: 'sessions',
      columns: ['id uuid PRIMARY KEY', 'user_id uuid'],
      foreignKeys: [['user_id', 'users']],
      seedRows: 60,
    },
    { name: 'products', columns: ['id uuid PRIMARY KEY', 'sku text'], seedRows: 60 },
    {
      name: 'product_images',
      columns: ['id uuid PRIMARY KEY', 'product_id uuid'],
      foreignKeys: [['product_id', 'products']],
      seedRows: 60,
    },
  ],
  views: [
    ...Array.from({ length: 10 }, (_, i) => ({
      name: `v_report_${i}`,
      select: 'SELECT id AS id, user_id AS user_id FROM {schema}."sessions"',
    })),
    { name: 'mv_user_count', select: 'SELECT id AS id FROM {schema}."users"', materialized: true },
  ],
  expectedSkeletonComponents: [
    ['product_images', 'products'],
    ['sessions', 'users'],
  ],
}

/**
 * Multi-tenant SaaS. A wide organisation hub, which is the realistic way a
 * schema ends up with one component spanning most of it.
 */
const multiTenant: LabScenario = {
  id: 'multi-tenant-saas',
  description: 'Organisation-scoped SaaS where most tables hang off one hub',
  tables: [
    { name: 'organizations', columns: ['id uuid PRIMARY KEY', 'name text'], seedRows: 60 },
    {
      name: 'memberships',
      columns: ['id uuid PRIMARY KEY', 'organization_id uuid', 'role text'],
      foreignKeys: [['organization_id', 'organizations']],
      seedRows: 60,
    },
    {
      name: 'projects',
      columns: ['id uuid PRIMARY KEY', 'organization_id uuid'],
      foreignKeys: [['organization_id', 'organizations']],
      seedRows: 60,
    },
    {
      name: 'invoices',
      columns: ['id uuid PRIMARY KEY', 'organization_id uuid', 'amount numeric'],
      foreignKeys: [['organization_id', 'organizations']],
      seedRows: 60,
    },
    {
      name: 'api_tokens',
      columns: ['id uuid PRIMARY KEY', 'organization_id uuid'],
      foreignKeys: [['organization_id', 'organizations']],
      seedRows: 60,
    },
    { name: 'changelog', columns: ['id uuid PRIMARY KEY', 'body text'], seedRows: 60 },
  ],
  // Five of six tables in one component: the blob shape the breadth guard exists
  // to refuse. Expected here so the refusal is tested rather than incidental.
  expectedSkeletonComponents: [
    ['api_tokens', 'invoices', 'memberships', 'organizations', 'projects'],
  ],
}

/**
 * Content / community. Deliberately ordinary and healthy — the control.
 *
 * Every negative assertion in the phase suites needs a backend where nothing is
 * wrong. Without one, "stays quiet" is satisfied by machinery that is simply
 * broken.
 */
const contentCommunity: LabScenario = {
  id: 'content-community',
  description: 'Healthy posts/comments/likes model with RLS in place',
  tables: [
    { name: 'users', columns: ['id uuid PRIMARY KEY', 'email text'], rls: true, seedRows: 60 },
    {
      name: 'posts',
      columns: ['id uuid PRIMARY KEY', 'user_id uuid', 'body text'],
      foreignKeys: [['user_id', 'users']],
      rls: true,
      seedRows: 60,
    },
    {
      name: 'comments',
      columns: ['id uuid PRIMARY KEY', 'post_id uuid', 'body text'],
      foreignKeys: [['post_id', 'posts']],
      rls: true,
      seedRows: 60,
    },
    { name: 'tags', columns: ['id uuid PRIMARY KEY', 'label text'], rls: true, seedRows: 60 },
    {
      name: 'post_tags',
      columns: ['id uuid PRIMARY KEY', 'post_id uuid', 'tag_id uuid'],
      foreignKeys: [['post_id', 'posts'], ['tag_id', 'tags']],
      rls: true,
      seedRows: 60,
    },
  ],
  expectedSkeletonComponents: [['comments', 'post_tags', 'posts', 'tags', 'users']],
}

export const SCENARIOS: readonly LabScenario[] = [
  authHeavy,
  ecommerce,
  messyLegacy,
  viewHeavy,
  multiTenant,
  contentCommunity,
]

export function scenario(id: string): LabScenario {
  const s = SCENARIOS.find(x => x.id === id)
  if (!s) throw new Error(`unknown lab scenario: ${id}`)
  return s
}
