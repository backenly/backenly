/**
 * SUBSYSTEM IDENTITY — a name for "the auth area", derived from the catalog
 * ========================================================================
 *
 * The self-healing loop reasons about one gap at a time. `gapIdentity` in
 * desired-state.ts is deliberately SPECIFIC (`type::location`, most-specific
 * locator first) because making it coarser caused a real incident: two unindexed
 * columns on one table collapsed into one identity, and a fix that genuinely
 * worked was escalated as "did not hold".
 *
 * So this module does not loosen `gapIdentity`. It adds a SECOND, coarser key
 * beside it, for the one question the loop cannot currently ask: "have I now
 * repaired four different things in the same area, and are those repairs not
 * holding?"
 *
 * ── Why the catalog, and not the event log ─────────────────────────────────
 *
 * Grouping is computed from live foreign keys read out of `information_schema`,
 * never from stored state. That is not a stylistic choice. Backenly hands out
 * READ_WRITE connection strings, so DDL arrives from psql with no Backenly
 * event attached — which is exactly why `SchemaDriftEvent` and drift-watch.ts
 * exist. A grouping projected from an event log would silently disagree with
 * the database the moment anyone used the connection string they were sold.
 * Reading the catalog per tick means external DDL is reflected for free.
 *
 * ── Fingerprint, not identity ──────────────────────────────────────────────
 *
 * A component's `fingerprint` is its lexicographically smallest member. It is
 * cheap to compare and it is NOT durable: adding one foreign key can merge two
 * components and change it. Callers must therefore store `membership` with any
 * evidence they record, and treat a membership change as a RESET of whatever
 * they were counting — never as continuity. There is deliberately no
 * `subsystemId` in this module: a name ending in `Id` invites exactly the
 * assumption the design cannot support.
 *
 * Read-only. Computes nothing persistent and mutates nothing.
 */

import { readWorkspaceSchema } from '@/lib/typegen/schema-reader'
import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { extractFkInferences } from '@/lib/memory/decision-memory'

/** How a component's edges were established. */
export type EdgeProvenance = 'constraint' | 'inferred'

export interface Subsystem {
  /**
   * Lexicographically smallest member. A cheap comparable handle, NOT a stable
   * identity — see the module header.
   */
  fingerprint: string
  /** Sorted member tables. This is what recurrence continuity keys on. */
  membership: string[]
  /**
   * 'constraint' when every member is joined by a real foreign key.
   * 'inferred' when at least one member was attached by a `*_id` name match.
   */
  provenance: EdgeProvenance
  /**
   * False when no claim may be filed against this component: it is so large
   * that "this subsystem" means "this backend" and carries no information.
   */
  eligible: boolean
  /** Present when `eligible` is false. */
  ineligibleReason?: string
}

export type ClusteringKind = 'skeleton' | 'attached'

export interface SubsystemMap {
  projectId: string
  kind: ClusteringKind
  subsystems: Subsystem[]
  /** Every non-internal base table seen, sorted. */
  tables: string[]
  /**
   * True when the schema declares no foreign-key constraints at all.
   *
   * Such a project gets no subsystem claims. Clustering a constraint-free
   * schema on name matching alone is a guess, and the finding policy does not
   * permit building claims on guesses. This is measured rather than worked
   * around: if most real projects land here, the addressable population for
   * subsystem-level maintenance is small, and that is a fact worth having
   * before anything expensive is built on top.
   */
  noConstraintSkeleton: boolean
}

/**
 * Share of the schema above which a component stops being a subsystem.
 *
 * A component spanning most of the backend is the "everything references
 * users" shape. It is real, it is common, and a finding filed against it says
 * nothing an owner can act on.
 */
const MAX_COMPONENT_SHARE = 0.6

/**
 * ...but share alone is the wrong test, and a small schema proves it.
 *
 * On a four-table backend a genuine three-table auth component is 75% of the
 * schema. Judged on ratio alone it is "too broad", so every small project
 * becomes permanently unclusterable — and small projects are most of them. The
 * blob this guard exists to catch is "everything references users" on a schema
 * with enough tables for that to be a real loss of information, so a component
 * must be broad AND absolutely large before it stops carrying signal.
 */
const MIN_BLOB_MEMBERS = 5

/** Components smaller than this cannot carry a multi-gap recurrence claim. */
const MIN_ELIGIBLE_MEMBERS = 2

// ── Union-find ────────────────────────────────────────────────────────────────

class DisjointSet {
  private parent = new Map<string, string>()

  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x)
  }

  find(x: string): string {
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    // Path compression, so repeated lookups during the attachment pass stay flat.
    let cur = x
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    this.add(a)
    this.add(b)
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    // Smaller root wins so the representative is deterministic regardless of
    // the order edges arrive in. Without this the same schema could produce
    // different fingerprints between two runs.
    if (ra < rb) this.parent.set(rb, ra)
    else this.parent.set(ra, rb)
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const x of this.parent.keys()) {
      const r = this.find(x)
      const list = out.get(r)
      if (list) list.push(x)
      else out.set(r, [x])
    }
    return out
  }
}

// ── Graph construction ────────────────────────────────────────────────────────

export interface SchemaGraph {
  tables: string[]
  /** Real foreign-key edges, deduplicated, each as a sorted pair. */
  constraintEdges: Array<[string, string]>
  /** `*_id` name-match edges that have no constraint behind them. */
  inferredEdges: Array<[string, string]>
}

/**
 * Build the edge sets from a workspace schema snapshot.
 *
 * Separated from clustering so the hard part is testable without a database.
 */
export function buildSchemaGraph(
  schema: {
    tables: Array<{
      tableName: string
      columns: Array<{
        columnName: string
        isForeignKey?: boolean
        referencedTable?: string
      }>
    }>
  },
  /**
   * Physical tables, when the caller knows them. Everything else in the schema
   * is excluded from the graph entirely.
   *
   * `readWorkspaceSchema` reads `information_schema.columns`, which describes
   * VIEWS as well as tables. Views carry no foreign keys, so every one of them
   * lands as a singleton component — and the shadow run's whole purpose is to
   * report component counts, singleton ratio and largest-component share so a
   * human can decide whether this roadmap continues.
   *
   * A project with 12 base tables and 20 views would report as overwhelmingly
   * singleton, and a genuinely over-broad component would look narrow because
   * the views inflated the denominator. Those are precisely the two numbers the
   * GO/MODIFY/STOP gate turns on, so this is not cosmetic noise: it would bias
   * the decision in both directions at once.
   *
   * Omit it and every relation in the snapshot is treated as a table, which is
   * correct for the pure unit tests that construct their own fixtures.
   */
  baseTables?: ReadonlySet<string>,
): SchemaGraph {
  const relations = baseTables
    ? schema.tables.filter(t => baseTables.has(t.tableName))
    : schema.tables
  const tables = relations.map(t => t.tableName).sort()
  const known = new Set(tables)

  const constraint = new Set<string>()
  const inferred = new Set<string>()

  for (const t of relations) {
    for (const c of t.columns) {
      if (!c.isForeignKey || !c.referencedTable) continue
      if (!known.has(c.referencedTable)) continue
      if (c.referencedTable === t.tableName) continue // self-reference is not an edge
      constraint.add(pairKey(t.tableName, c.referencedTable))
    }
  }

  for (const t of relations) {
    const guesses = extractFkInferences(
      t.columns.map(c => ({ name: c.columnName })),
      tables,
    )
    for (const g of guesses) {
      const target = g.references.split('.')[0]
      if (!known.has(target) || target === t.tableName) continue
      const key = pairKey(t.tableName, target)
      // A name match that a real constraint already covers is not "inferred".
      if (constraint.has(key)) continue
      inferred.add(key)
    }
  }

  return {
    tables,
    constraintEdges: [...constraint].sort().map(unpairKey),
    inferredEdges: [...inferred].sort().map(unpairKey),
  }
}

/**
 * Order-independent key for an edge between two tables.
 *
 * NUL separates the halves because it is the one byte a PostgreSQL identifier
 * cannot contain, so no table name can forge a pair boundary. It is spelled as
 * a unicode escape rather than written as a literal control byte: an invisible
 * byte in source makes the whole file read as binary to grep, which costs more
 * in lost searchability than the separator is worth.
 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

function unpairKey(k: string): [string, string] {
  const [a, b] = k.split('\u0000')
  return [a, b]
}

// ── Clustering ────────────────────────────────────────────────────────────────

/**
 * Cluster a schema graph into subsystems.
 *
 * Two passes, and the asymmetry between them is the whole design:
 *
 *   1. SKELETON — components joined by real foreign-key constraints.
 *
 *   2. ATTACHMENT — an inferred `*_id` edge may pull an ISOLATED table into an
 *      existing skeleton component. It may NEVER merge two skeleton components.
 *
 * Without that restriction the feature collapses on contact with a real schema.
 * `users` is a universal hub, so a single inferred `user_id` edge would fuse
 * `orders`+`order_items` with `posts`+`comments` into one blob, the blob would
 * exceed MAX_COMPONENT_SHARE, and the whole project would report as
 * unclustered. Attachment buys coverage; merging buys a blob.
 */
export function clusterSchemaGraph(
  projectId: string,
  graph: SchemaGraph,
  kind: ClusteringKind,
): SubsystemMap {
  const ds = new DisjointSet()
  for (const t of graph.tables) ds.add(t)
  for (const [a, b] of graph.constraintEdges) ds.union(a, b)

  // Which tables the constraint skeleton already placed in a real component.
  const skeletonSize = new Map<string, number>()
  for (const [root, members] of ds.groups()) skeletonSize.set(root, members.length)
  const inSkeletonComponent = new Set<string>()
  for (const t of graph.tables) {
    if ((skeletonSize.get(ds.find(t)) ?? 1) > 1) inSkeletonComponent.add(t)
  }

  const attachedTables = new Set<string>()
  if (kind === 'attached') {
    // Which skeleton components each isolated table has a name match into.
    //
    // Attaching edge-by-edge is not enough, and the failure is the central case
    // rather than a corner: `users` is often isolated (nothing declares a
    // constraint TO it), so the `orders -> users` edge attaches it to the order
    // component, and the `posts -> users` edge then drags the post component in
    // behind it. One hub silently reassembles the blob the asymmetry exists to
    // prevent, through a sequence of individually legal attachments.
    //
    // Deciding per TABLE instead of per EDGE fixes it without an arbitrary
    // tie-break: a loose table that points into exactly one component belongs
    // to that component; one that points into several is a hub and belongs to
    // none of them. Picking the first would be assigning `users` to whichever
    // component happened to sort first, which is not a fact about the schema.
    const targets = new Map<string, Set<string>>()
    for (const [a, b] of graph.inferredEdges) {
      const aPlaced = inSkeletonComponent.has(a)
      const bPlaced = inSkeletonComponent.has(b)
      // Both placed is the forbidden merge. Neither placed means two loose
      // tables, and joining those on a name match starts the same chain.
      if (aPlaced === bPlaced) continue
      const loose = aPlaced ? b : a
      const anchor = aPlaced ? a : b
      const set = targets.get(loose)
      if (set) set.add(ds.find(anchor))
      else targets.set(loose, new Set([ds.find(anchor)]))
    }

    for (const [loose, roots] of [...targets].sort(([x], [y]) => x.localeCompare(y))) {
      if (roots.size !== 1) continue // hub table: ambiguous, so left on its own
      ds.union(loose, [...roots][0])
      attachedTables.add(loose)
    }
  }

  const total = graph.tables.length
  const subsystems: Subsystem[] = []

  for (const [, members] of ds.groups()) {
    const membership = [...members].sort()
    const fingerprint = membership[0]
    const provenance: EdgeProvenance = membership.some(m => attachedTables.has(m))
      ? 'inferred'
      : 'constraint'

    let eligible = true
    let ineligibleReason: string | undefined

    if (membership.length < MIN_ELIGIBLE_MEMBERS) {
      eligible = false
      ineligibleReason = 'single table, not a subsystem'
    } else if (
      total > 0 &&
      membership.length >= MIN_BLOB_MEMBERS &&
      membership.length / total > MAX_COMPONENT_SHARE
    ) {
      eligible = false
      ineligibleReason = `spans ${membership.length}/${total} tables, too broad to be actionable`
    }

    subsystems.push({ fingerprint, membership, provenance, eligible, ineligibleReason })
  }

  subsystems.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))

  return {
    projectId,
    kind,
    subsystems,
    tables: graph.tables,
    noConstraintSkeleton: graph.constraintEdges.length === 0,
  }
}

// ── Physical relations ────────────────────────────────────────────────────────

/**
 * The tables in a workspace schema that are actually tables.
 *
 * `relkind` from `pg_class` rather than `information_schema.tables.table_type`:
 * it distinguishes ordinary ('r') and partitioned ('p') tables from views ('v'),
 * materialized views ('m'), foreign tables ('f') and sequences ('S') in one
 * cheap indexed read, and it is the same catalog the rest of the loop trusts.
 *
 * Kept here rather than pushed into `readWorkspaceSchema`, because other
 * consumers of that reader legitimately want views — a generated TypeScript
 * type for a view is useful, a view in a foreign-key clustering is not.
 */
async function readBaseTableNames(projectId: string): Promise<Set<string>> {
  const rows = await queryWorkspaceSchema(
    projectId,
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')`,
    `workspace_${projectId}`,
  )
  const list: Array<{ relname: string }> = rows?.rows ?? rows ?? []
  return new Set(list.map(r => r.relname))
}

// ── Per-tick cache ────────────────────────────────────────────────────────────

interface CacheEntry {
  at: number
  graph: SchemaGraph
}

const CACHE_TTL_MS = 30_000
const cache = new Map<string, CacheEntry>()

/** Drop a project's cached graph. Exported for tests and for adoption paths. */
export function invalidateSubsystemCache(projectId?: string): void {
  if (projectId) cache.delete(projectId)
  else cache.clear()
}

/**
 * Read the catalog and build both clusterings for a project.
 *
 * The reconciler runs every minute and several consumers want this in one tick,
 * so the underlying catalog read is memoised briefly. The TTL is short on
 * purpose: this is a projection of live state and a stale projection is the
 * failure this module was designed to avoid.
 */
export async function computeSubsystems(
  projectId: string,
  kind: ClusteringKind = 'attached',
): Promise<SubsystemMap> {
  const hit = cache.get(projectId)
  let graph: SchemaGraph
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    graph = hit.graph
  } else {
    // Deliberately unguarded: a failed catalog read must propagate. Returning
    // an empty clustering here would be indistinguishable from a flat backend,
    // which is the exact shape of the detectMissingRls defect that left a
    // security probe dead for months while the dashboard rendered green.
    const [schema, baseTables] = await Promise.all([
      readWorkspaceSchema(projectId),
      readBaseTableNames(projectId),
    ])
    graph = buildSchemaGraph(schema, baseTables)
    cache.set(projectId, { at: Date.now(), graph })
  }
  return clusterSchemaGraph(projectId, graph, kind)
}

/**
 * Which subsystem a table belongs to, or null when it is not in an eligible one.
 *
 * Returns the whole record rather than a bare handle so callers are pushed
 * toward storing `membership` alongside whatever they record. A caller that
 * keeps only the fingerprint has built the durable-identity assumption this
 * module exists to prevent.
 */
export function subsystemOf(map: SubsystemMap, tableName: string): Subsystem | null {
  const s = map.subsystems.find(x => x.membership.includes(tableName))
  if (!s || !s.eligible) return null
  return s
}

/**
 * Stable digest of a membership list, for use as a dedupe key.
 *
 * Short on purpose: it is a cache key, not a security primitive. Including it
 * in a finding's identity is what makes recurrence continuity reset when the
 * component's membership changes, with no separate reset bookkeeping.
 */
export function membershipHash(membership: readonly string[]): string {
  const joined = [...membership].sort().join(',')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < joined.length; i++) {
    const c = joined.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 12)
}
