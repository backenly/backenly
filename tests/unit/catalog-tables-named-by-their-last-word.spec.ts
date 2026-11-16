/**
 * Which tables Backenly treats as reference data (readable by every client,
 * written only with service-role keys) when it cannot find an owner.
 *
 * The last word of a snake_case table name says what one row is:
 * `product_categories` holds categories and `app_settings` holds settings. A
 * leading word only says what the rows are about: `product_views` holds views
 * of products, with the session and referrer of whoever viewed them. Matching
 * the leading word made such a table readable with the publishable key.
 *
 * Production QA re-test 2026-11-16, report #12.
 */

import { inferRlsPlanFromCatalog, type OwnershipCatalog } from '@/lib/services/rls-ownership'

function store(extra: Array<[string, string[]]>, fks: Array<[string, string, string]> = []): OwnershipCatalog {
  return {
    schemaName: 'workspace_test',
    columns: new Map<string, string[]>([
      ['users', ['id', 'email', 'password_hash']],
      ['products', ['id', 'name', 'price', 'slug']],
      ['categories', ['id', 'name', 'parent_id']],
      ...extra,
    ]),
    foreignKeys: fks.map(([childTable, childColumn, parentTable]) => ({
      childTable,
      childColumn,
      parentTable,
      parentColumn: 'id',
    })),
  }
}

const kindOf = (catalog: OwnershipCatalog, table: string) => inferRlsPlanFromCatalog(catalog, table).kind

describe('a table whose name only starts with a catalog word', () => {
  it('product_views (a view log of products) is not opened to everyone', () => {
    const c = store(
      [['product_views', ['id', 'product_id', 'session_id', 'referrer', 'viewed_at']]],
      [['product_views', 'product_id', 'products']],
    )
    expect(kindOf(c, 'product_views')).toBe('undecidable')
  })

  it('nor product_events, category_follows or settings_history', () => {
    const c = store(
      [
        ['product_events', ['id', 'product_id', 'kind', 'at']],
        ['category_follows', ['id', 'category_id', 'created_at']],
        ['settings_history', ['id', 'key', 'old_value', 'new_value']],
      ],
      [
        ['product_events', 'product_id', 'products'],
        ['category_follows', 'category_id', 'categories'],
      ],
    )
    expect(kindOf(c, 'product_events')).toBe('undecidable')
    expect(kindOf(c, 'category_follows')).toBe('undecidable')
    expect(kindOf(c, 'settings_history')).toBe('undecidable')
  })

  it('says why, so the agent can state the rule', () => {
    const c = store([['product_views', ['id', 'product_id', 'session_id']]], [['product_views', 'product_id', 'products']])
    const plan = inferRlsPlanFromCatalog(c, 'product_views')
    expect(plan.kind).toBe('undecidable')
    expect(plan.reason).toContain('product_views')
    expect(plan.reason).toContain('Say what the rule is')
  })
})

describe('a table whose name ends with a catalog word, or is one', () => {
  it('stays reference data: products, categories, product_categories, app_settings, tax_rates', () => {
    const c = store([
      ['product_categories', ['id', 'name']],
      ['app_settings', ['id', 'key', 'value']],
      ['tax_rates', ['id', 'country', 'rate']],
    ])
    for (const t of ['products', 'categories', 'product_categories', 'app_settings', 'tax_rates']) {
      expect([t, kindOf(c, t)]).toEqual([t, 'public_read'])
    }
  })

  it('and so do the parts of a catalog item: product_images, product_variants, product_options', () => {
    const c = store(
      [
        ['product_images', ['id', 'product_id', 'url', 'alt', 'position']],
        ['product_variants', ['id', 'product_id', 'sku', 'price']],
        ['product_options', ['id', 'product_id', 'name', 'value']],
      ],
      [
        ['product_images', 'product_id', 'products'],
        ['product_variants', 'product_id', 'products'],
        ['product_options', 'product_id', 'products'],
      ],
    )
    for (const t of ['product_images', 'product_variants', 'product_options']) {
      expect([t, kindOf(c, t)]).toEqual([t, 'public_read'])
    }
  })
})

describe('a table named like reference data whose columns record visitors or people', () => {
  it('is not opened to everyone, and the reason names those columns', () => {
    const c = store([
      ['banners', ['id', 'image_url', 'session_id']],
      ['brands', ['id', 'name', 'email']],
      ['announcements', ['id', 'body', 'ip_address', 'user_agent']],
    ])
    for (const t of ['banners', 'brands', 'announcements']) {
      expect([t, kindOf(c, t)]).toEqual([t, 'undecidable'])
    }
    const plan = inferRlsPlanFromCatalog(c, 'announcements')
    expect(plan.reason).toContain('ip_address')
    expect(plan.reason).toContain('user_agent')
  })

  it('a column that only mentions such a word is not one of them', () => {
    const c = store([['countries', ['id', 'name', 'phone_code', 'email_domain_hint']]])
    expect(kindOf(c, 'countries')).toBe('public_read')
  })
})
