/**
 * SUBSYSTEM CLUSTERING (Phase 1)
 * ==============================
 * Groups a workspace schema into subsystems from the live foreign-key graph,
 * so the autonomy loop can ask "have I repaired four different things in the
 * same area?" — a question `gapIdentity` is deliberately too specific to answer.
 *
 * The two properties these tests exist to hold:
 *
 *   1. Inferred `*_id` edges ATTACH isolated tables and never MERGE two
 *      constraint-backed components. Without the asymmetry, one `user_id` edge
 *      fuses the whole schema into a blob and the feature does nothing.
 *
 *   2. The fingerprint is not treated as a durable identity. Membership is what
 *      callers key on, and a membership change is a reset.
 */

import {
  buildSchemaGraph,
  clusterSchemaGraph,
  subsystemOf,
  membershipHash,
  type SchemaGraph,
} from '@/lib/autonomy/subsystem'

/** Terse schema builder: `table: [[column, referencedTableOrNull], …]`. */
function schema(spec: Record<string, Array<[string, string | null]>>) {
  return {
    tables: Object.entries(spec).map(([tableName, cols]) => ({
      tableName,
      columns: cols.map(([columnName, ref]) => ({
        columnName,
        isForeignKey: ref !== null,
        referencedTable: ref ?? undefined,
      })),
    })),
  }
}

const cluster = (g: SchemaGraph, kind: 'skeleton' | 'attached' = 'attached') =>
  clusterSchemaGraph('p1', g, kind)

describe('buildSchemaGraph', () => {
  it('extracts constraint edges from the catalog shape', () => {
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        posts: [['id', null], ['user_id', 'users']],
      }),
    )
    expect(g.constraintEdges).toEqual([['posts', 'users']])
  })

  it('does not double-count a column that is both a constraint and a name match', () => {
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        posts: [['id', null], ['user_id', 'users']],
      }),
    )
    expect(g.inferredEdges).toEqual([])
  })

  it('infers user_id -> users by name when no constraint exists', () => {
    // The single most common convention in the wild. If this returns nothing,
    // the whole attachment pass is measuring a broken inference.
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        posts: [['id', null], ['user_id', null]],
      }),
    )
    expect(g.constraintEdges).toEqual([])
    expect(g.inferredEdges).toEqual([['posts', 'users']])
  })

  it('infers an -ies plural', () => {
    const g = buildSchemaGraph(
      schema({
        categories: [['id', null]],
        items: [['id', null], ['category_id', null]],
      }),
    )
    expect(g.inferredEdges).toEqual([['categories', 'items']])
  })

  it('ignores self-references', () => {
    const g = buildSchemaGraph(
      schema({ posts: [['id', null], ['parent_post_id', 'posts']] }),
    )
    expect(g.constraintEdges).toEqual([])
  })

  it('ignores references to tables outside the schema', () => {
    const g = buildSchemaGraph(
      schema({ posts: [['id', null], ['user_id', 'some_other_schema_table']] }),
    )
    expect(g.constraintEdges).toEqual([])
  })
})

describe('skeleton clustering', () => {
  it('groups a constraint-connected component', () => {
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        sessions: [['id', null], ['user_id', 'users']],
        tokens: [['id', null], ['session_id', 'sessions']],
        unrelated: [['id', null]],
      }),
    )
    const map = cluster(g, 'skeleton')
    const auth = map.subsystems.find(s => s.membership.includes('users'))!
    expect(auth.membership).toEqual(['sessions', 'tokens', 'users'])
    expect(auth.fingerprint).toBe('sessions')
    expect(auth.provenance).toBe('constraint')
    expect(auth.eligible).toBe(true)
  })

  it('marks a lone table ineligible', () => {
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        sessions: [['id', null], ['user_id', 'users']],
        orphan: [['id', null]],
      }),
    )
    const map = cluster(g, 'skeleton')
    const orphan = map.subsystems.find(s => s.membership.includes('orphan'))!
    expect(orphan.eligible).toBe(false)
    expect(orphan.ineligibleReason).toMatch(/single table/)
  })

  it('flags a schema with no constraints at all', () => {
    const g = buildSchemaGraph(schema({ a: [['id', null]], b: [['id', null]] }))
    expect(cluster(g, 'skeleton').noConstraintSkeleton).toBe(true)
  })

  it('does not flag a schema that has constraints', () => {
    // Guards the flag from being stuck true, which would make every project
    // ineligible and the whole feature silently inert.
    const g = buildSchemaGraph(
      schema({ users: [['id', null]], posts: [['id', null], ['user_id', 'users']] }),
    )
    expect(cluster(g, 'skeleton').noConstraintSkeleton).toBe(false)
  })
})

describe('the attachment asymmetry', () => {
  /**
   * The rule the whole design turns on. Two healthy constraint-backed
   * components, plus a name-only `user_id` on each. If inferred edges merged
   * components, these become one blob.
   */
  it('an inferred edge NEVER merges two constraint-backed components', () => {
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        orders: [['id', null], ['user_id', null]],
        order_items: [['id', null], ['order_id', 'orders']],
        posts: [['id', null], ['user_id', null]],
        comments: [['id', null], ['post_id', 'posts']],
      }),
    )
    // Both `orders` and `posts` are already in skeleton components, so their
    // inferred user_id edges must be discarded.
    const map = cluster(g, 'attached')
    const orderSide = map.subsystems.find(s => s.membership.includes('orders'))!
    const postSide = map.subsystems.find(s => s.membership.includes('posts'))!

    expect(orderSide.membership).toEqual(['order_items', 'orders'])
    expect(postSide.membership).toEqual(['comments', 'posts'])
    expect(orderSide.fingerprint).not.toBe(postSide.fingerprint)
    // `users` stays on its own rather than gluing the two together.
    expect(orderSide.membership).not.toContain('users')
    expect(postSide.membership).not.toContain('users')
  })

  it('an inferred edge DOES attach an isolated table to a component', () => {
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        sessions: [['id', null], ['user_id', 'users']],
        // Isolated: no constraint anywhere, only a name match.
        audit_log: [['id', null], ['user_id', null]],
      }),
    )
    const attached = cluster(g, 'attached')
    const auth = attached.subsystems.find(s => s.membership.includes('users'))!
    expect(auth.membership).toEqual(['audit_log', 'sessions', 'users'])
    expect(auth.provenance).toBe('inferred')

    // ...and the skeleton clustering of the SAME graph leaves it out. Both
    // clusterings are computed in shadow precisely so this difference is
    // measured rather than assumed.
    const skel = cluster(g, 'skeleton')
    const authSkel = skel.subsystems.find(s => s.membership.includes('users'))!
    expect(authSkel.membership).toEqual(['sessions', 'users'])
    expect(authSkel.provenance).toBe('constraint')
  })

  /**
   * The hub case, and the reason attachment is decided per TABLE not per EDGE.
   *
   * `users` is isolated (nothing declares a constraint TO it), so an edge-at-a-
   * time rule attaches it to the order component on `orders -> users`, and then
   * `posts -> users` drags the post component along behind it. Every individual
   * attachment is legal and the result is the blob the asymmetry exists to
   * prevent. A table pointing into more than one component is a hub and joins
   * none of them.
   */
  it('leaves a hub table unattached rather than fusing components through it', () => {
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        orders: [['id', null], ['user_id', null]],
        order_items: [['id', null], ['order_id', 'orders']],
        posts: [['id', null], ['user_id', null]],
        comments: [['id', null], ['post_id', 'posts']],
      }),
    )
    const map = cluster(g, 'attached')
    const users = map.subsystems.find(s => s.membership.includes('users'))!
    expect(users.membership).toEqual(['users'])
    expect(map.subsystems.filter(s => s.eligible)).toHaveLength(2)
  })

  it('still attaches a loose table that points into exactly one component', () => {
    // The same rule must not become "never attach anything", which would make
    // the attached clustering identical to the skeleton and the comparison
    // meaningless.
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        sessions: [['id', null], ['user_id', 'users']],
        orders: [['id', null]],
        order_items: [['id', null], ['order_id', 'orders']],
        audit_log: [['id', null], ['session_id', null]],
      }),
    )
    const map = cluster(g, 'attached')
    const auth = map.subsystems.find(s => s.membership.includes('users'))!
    expect(auth.membership).toEqual(['audit_log', 'sessions', 'users'])
  })

  it('does not chain two isolated tables together on a name match', () => {
    // Both sides isolated: joining them starts the chain that ends in a blob.
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        a: [['id', null], ['user_id', null]],
        b: [['id', null], ['user_id', null]],
      }),
    )
    const map = cluster(g, 'attached')
    expect(map.subsystems.every(s => s.membership.length === 1)).toBe(true)
  })
})

describe('breadth guard', () => {
  it('marks an over-broad component ineligible', () => {
    // 5 of 6 tables in one component: "this subsystem" means "this backend".
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        a: [['id', null], ['user_id', 'users']],
        b: [['id', null], ['user_id', 'users']],
        c: [['id', null], ['user_id', 'users']],
        d: [['id', null], ['user_id', 'users']],
        lonely: [['id', null]],
      }),
    )
    const map = cluster(g, 'skeleton')
    const blob = map.subsystems.find(s => s.membership.includes('users'))!
    expect(blob.membership).toHaveLength(5)
    expect(blob.eligible).toBe(false)
    expect(blob.ineligibleReason).toMatch(/too broad/)
  })

  it('subsystemOf returns null for an ineligible component', () => {
    const g = buildSchemaGraph(schema({ solo: [['id', null]] }))
    expect(subsystemOf(cluster(g), 'solo')).toBeNull()
  })

  it('subsystemOf returns the record for an eligible one', () => {
    const g = buildSchemaGraph(
      schema({ users: [['id', null]], sessions: [['id', null], ['user_id', 'users']] }),
    )
    const s = subsystemOf(cluster(g), 'sessions')
    expect(s).not.toBeNull()
    expect(s!.membership).toEqual(['sessions', 'users'])
  })
})

describe('fingerprint and membership semantics', () => {
  it('is deterministic regardless of edge order', () => {
    const forward = buildSchemaGraph(
      schema({
        users: [['id', null]],
        sessions: [['id', null], ['user_id', 'users']],
        tokens: [['id', null], ['session_id', 'sessions']],
      }),
    )
    const reversed: SchemaGraph = {
      ...forward,
      constraintEdges: [...forward.constraintEdges].reverse(),
    }
    expect(cluster(reversed).subsystems).toEqual(cluster(forward).subsystems)
  })

  /**
   * The property the whole "fingerprint, not identity" rule exists for. A table
   * joining the component can change the fingerprint, so anything counting
   * recurrence must key on membership and reset when it moves.
   */
  it('adding a table that sorts first CHANGES the fingerprint', () => {
    const before = cluster(
      buildSchemaGraph(
        schema({ users: [['id', null]], sessions: [['id', null], ['user_id', 'users']] }),
      ),
    )
    const after = cluster(
      buildSchemaGraph(
        schema({
          users: [['id', null]],
          sessions: [['id', null], ['user_id', 'users']],
          accounts: [['id', null], ['user_id', 'users']],
        }),
      ),
    )
    const b = before.subsystems.find(s => s.membership.includes('users'))!
    const a = after.subsystems.find(s => s.membership.includes('users'))!

    expect(b.fingerprint).toBe('sessions')
    expect(a.fingerprint).toBe('accounts')
    expect(membershipHash(b.membership)).not.toBe(membershipHash(a.membership))
  })

  it('membershipHash is order-independent and stable', () => {
    expect(membershipHash(['b', 'a'])).toBe(membershipHash(['a', 'b']))
    expect(membershipHash(['a', 'b'])).toBe(membershipHash(['a', 'b']))
    expect(membershipHash(['a', 'b'])).not.toBe(membershipHash(['a', 'c']))
  })
})

describe('vacuous-pass guards', () => {
  /**
   * Every assertion above would still pass if the clusterer returned nothing
   * for a reason unrelated to the property under test. These pin the floor.
   */
  it('a non-trivial schema produces a non-trivial clustering', () => {
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        sessions: [['id', null], ['user_id', 'users']],
        orders: [['id', null]],
        order_items: [['id', null], ['order_id', 'orders']],
      }),
    )
    const map = cluster(g)
    expect(map.subsystems.length).toBeGreaterThan(1)
    expect(map.subsystems.filter(s => s.eligible).length).toBe(2)
    expect(map.tables).toEqual(['order_items', 'orders', 'sessions', 'users'])
  })

  it('every table appears in exactly one subsystem', () => {
    const g = buildSchemaGraph(
      schema({
        users: [['id', null]],
        sessions: [['id', null], ['user_id', 'users']],
        orders: [['id', null]],
        stray: [['id', null]],
      }),
    )
    const map = cluster(g)
    const seen = map.subsystems.flatMap(s => s.membership).sort()
    expect(seen).toEqual(map.tables)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('an empty schema yields no subsystems and is flagged, not silently clean', () => {
    const map = cluster(buildSchemaGraph(schema({})))
    expect(map.subsystems).toEqual([])
    expect(map.noConstraintSkeleton).toBe(true)
  })
})
