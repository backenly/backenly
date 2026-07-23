/**
 * MARKETPLACE BUILD REGRESSION TESTS
 * ====================================
 * Locks in correct behavior for the multi-vendor marketplace build scenario
 * that previously: (1) returned Gap Analysis instead of building, (2) created
 * a single "items" table when the user sent "build everything I said".
 *
 * Test A — Marketplace prompt → build mode, correct entities
 * Test B — Continuation after plan → full prompt recovered
 * Test C — Deterministic entity parser for explicit lists
 * Test D — BuildJob validation blocks generic fallback entities
 * Test E — "build everything I said" classified as CONTINUATION
 * Test F — Exclusions ("do NOT create cart") respected end-to-end
 * Test G — isSeriousBuildRequest returns true for marketplace prompt
 * Test H — EVAL_FAST_RE guard: serious build never hijacked by evaluate fast-path
 * Test I — Storage buckets derived from "product image uploads" / "user avatar uploads"
 */

import { describe, it, expect } from '@jest/globals'
import { isSeriousBuildRequest, compileBuildJob, extractEntitiesFromExplicitList } from '../../lib/ai/build-runtime/domain-compiler'
import { classifyBuildSubBehavior, extractContinuationContext } from '../../lib/ai/build-mode-router'
import type { BuildContext } from '../../lib/ai/build-runtime/types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('@/lib/ai/openai-service', () => ({
  getOpenAIClient: () => ({
    chat: {
      completions: {
        create: jest.fn().mockImplementation(({ messages }: any) => {
          // Route mock responses based on prompt content
          const userMsg: string = messages.find((m: any) => m.role === 'user')?.content ?? ''

          // parseRequirementsFromPrompt — return marketplace entities
          if (userMsg.includes('marketplace') || userMsg.includes('multi-vendor')) {
            return Promise.resolve({
              choices: [{
                message: {
                  content: JSON.stringify({
                    requiredTables: ['users', 'stores', 'products', 'orders', 'order_items', 'reviews'],
                    requiredIntegrations: ['stripe'],
                    storageBucketCount: 0,
                    storageBucketNames: ['product_images', 'user_avatars'],
                    requiredFeatures: ['auth'],
                    excludedItems: ['cart', 'wishlist', 'coupons', 'subscriptions'],
                  }),
                },
              }],
            })
          }

          // extractEntities — return marketplace entities
          if (messages[0]?.content?.includes('Extract database table names')) {
            return Promise.resolve({
              choices: [{
                message: {
                  content: JSON.stringify({
                    tables: ['users', 'stores', 'products', 'orders', 'order_items', 'reviews'],
                  }),
                },
              }],
            })
          }

          // classifyDomainSemantically
          if (messages[0]?.content?.includes('domain classifier')) {
            return Promise.resolve({
              choices: [{ message: { content: JSON.stringify({ domain: 'marketplace', confidence: 0.95, signals: ['marketplace', 'seller'] }) } }],
            })
          }

          // analyzeAllTablePurposes
          if (messages[0]?.content?.includes('state machine')) {
            return Promise.resolve({
              choices: [{ message: { content: JSON.stringify({ purposes: {}, stateMachines: [] }) } }],
            })
          }

          // extractWorkflowsFromPrompt / extractBusinessRulesFromPrompt
          if (messages[0]?.content?.includes('workflow') || messages[0]?.content?.includes('business rule')) {
            return Promise.resolve({
              choices: [{ message: { content: JSON.stringify([]) } }],
            })
          }

          // LLM sub-behavior classifier
          return Promise.resolve({
            choices: [{ message: { content: JSON.stringify({ subBehavior: 'EXECUTION', reason: 'mock' }) } }],
          })
        }),
      },
    },
  }),
}))

jest.mock('@/lib/ai/model-router', () => ({
  getModel: () => 'gpt-4o-mini',
}))

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    projectPreference: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    table: {
      count: jest.fn().mockResolvedValue(0),
    },
  },
}))

jest.mock('@/lib/ai/semantic-domain-analyzer', () => ({
  classifyDomainSemantically: jest.fn().mockResolvedValue({ domain: 'marketplace', confidence: 0.95, signals: ['marketplace'] }),
  analyzeAllTablePurposes: jest.fn().mockResolvedValue({ purposes: {}, stateMachines: [] }),
  extractWorkflowsFromPrompt: jest.fn().mockResolvedValue([]),
  extractBusinessRulesFromPrompt: jest.fn().mockResolvedValue([]),
  buildSystemPromptEnrichment: jest.fn().mockReturnValue(''),
}))

jest.mock('@/lib/ai/build-runtime/domain-business-logic', () => ({
  shouldAutoGenerateCheckout: jest.fn().mockReturnValue(false),
  shouldAutoGenerateAdmin: jest.fn().mockReturnValue(false),
  shouldAutoGenerateAdminFromTables: jest.fn().mockReturnValue(false),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MARKETPLACE_PROMPT = `Build me a production-grade multi-vendor marketplace backend.

Roles: buyers and sellers

Core entities:
- users
- stores
- products
- orders
- order_items
- reviews

Business rules:
- sellers manage only their own stores/products
- buyers see only their own orders
- anyone can browse products
- reviews only by buyers who purchased the product
- order status state machine: pending, paid, shipped, delivered, cancelled

Integrations:
- Stripe payments should be blocked until API key is provided
- email notifications should be blocked until API key is provided

Storage:
- product image uploads
- user avatar uploads

Do NOT create cart, wishlist, coupons, subscriptions, or admin tables.

Verify auth, RLS, and APIs after building.
Show what is blocked and why.
Explain production readiness/missing parts.`

function makeCtx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    projectId: 'test-project',
    userId: 'test-user',
    availableSecrets: [],
    ...overrides,
  }
}

// ── Test G — isSeriousBuildRequest ────────────────────────────────────────────

describe('Test G — isSeriousBuildRequest', () => {
  it('returns true for the marketplace prompt', () => {
    expect(isSeriousBuildRequest(MARKETPLACE_PROMPT)).toBe(true)
  })

  it('returns true when prompt starts with "Build me a production-grade"', () => {
    expect(isSeriousBuildRequest('Build me a production-grade backend for a blog platform')).toBe(true)
  })

  it('returns true for "marketplace" keyword alone', () => {
    expect(isSeriousBuildRequest('Create a marketplace backend')).toBe(true)
  })

  it('returns false for a simple conversation question', () => {
    expect(isSeriousBuildRequest('What is missing from my project?')).toBe(false)
  })

  it('returns false for "is this production-ready?"', () => {
    expect(isSeriousBuildRequest('Is this production-ready?')).toBe(false)
  })
})

// ── Test C — Deterministic entity parser ─────────────────────────────────────

describe('Test C — extractEntitiesFromExplicitList', () => {
  it('extracts entities from a section-headed bullet list', () => {
    const prompt = `Core entities:
- users
- stores
- products
- orders
- order_items
- reviews`
    const entities = extractEntitiesFromExplicitList(prompt)
    expect(entities).toContain('users')
    expect(entities).toContain('stores')
    expect(entities).toContain('products')
    expect(entities).toContain('orders')
    expect(entities).toContain('order_items')
    expect(entities).toContain('reviews')
  })

  it('extracts entities from a numbered list', () => {
    const prompt = `Tables:
1. users
2. products
3. orders`
    const entities = extractEntitiesFromExplicitList(prompt)
    expect(entities).toContain('users')
    expect(entities).toContain('products')
    expect(entities).toContain('orders')
  })

  it('extracts entities from a bare bullet list (no heading)', () => {
    const prompt = `
- users
- stores
- products
- orders`
    const entities = extractEntitiesFromExplicitList(prompt)
    expect(entities).toContain('users')
    expect(entities).toContain('stores')
    expect(entities).toContain('products')
    expect(entities).toContain('orders')
  })

  it('returns empty array for a short vague prompt with no list', () => {
    const entities = extractEntitiesFromExplicitList('build everything I said')
    expect(entities).toHaveLength(0)
  })

  it('does NOT include noise words (jwt, rls, auth, api)', () => {
    const prompt = `Core entities:\n- users\n- jwt\n- rls\n- api\n- products`
    const entities = extractEntitiesFromExplicitList(prompt)
    expect(entities).not.toContain('jwt')
    expect(entities).not.toContain('rls')
    expect(entities).not.toContain('api')
    expect(entities).not.toContain('auth')
    expect(entities).toContain('users')
    expect(entities).toContain('products')
  })
})

// ── Test A — Full marketplace prompt → correct BuildJob ───────────────────────

describe('Test A — compileBuildJob for marketplace prompt', () => {
  it('creates schema nodes for all 6 explicitly requested tables', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const schemaNodeIds = job.phases.flatMap(p => p.nodes).filter(n => n.type === 'schema').map(n => n.id)
    expect(schemaNodeIds).toContain('schema.users')
    expect(schemaNodeIds).toContain('schema.stores')
    expect(schemaNodeIds).toContain('schema.products')
    expect(schemaNodeIds).toContain('schema.orders')
    expect(schemaNodeIds).toContain('schema.order_items')
    expect(schemaNodeIds).toContain('schema.reviews')
  })

  it('includes auth.jwt node', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const nodeIds = job.phases.flatMap(p => p.nodes).map(n => n.id)
    expect(nodeIds).toContain('auth.jwt')
  })

  it('includes permissions.rls node', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const nodeIds = job.phases.flatMap(p => p.nodes).map(n => n.id)
    expect(nodeIds).toContain('permissions.rls')
  })

  it('includes blocked Stripe integration node', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const integrationNodes = job.phases.flatMap(p => p.nodes).filter(n => n.type === 'integration')
    const stripeNode = integrationNodes.find(n => n.id.includes('stripe'))
    expect(stripeNode).toBeDefined()
    expect(stripeNode?.status).toBe('blocked')
  })

  it('does NOT contain excluded tables: cart, wishlist, coupons, subscriptions', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const schemaNodeIds = job.phases.flatMap(p => p.nodes).filter(n => n.type === 'schema').map(n => n.id)
    expect(schemaNodeIds).not.toContain('schema.cart')
    expect(schemaNodeIds).not.toContain('schema.carts')
    expect(schemaNodeIds).not.toContain('schema.wishlist')
    expect(schemaNodeIds).not.toContain('schema.wishlists')
    expect(schemaNodeIds).not.toContain('schema.coupons')
    expect(schemaNodeIds).not.toContain('schema.subscriptions')
  })

  it('does NOT contain "schema.items" (generic fallback sentinel)', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const schemaNodeIds = job.phases.flatMap(p => p.nodes).filter(n => n.type === 'schema').map(n => n.id)
    expect(schemaNodeIds).not.toContain('schema.items')
  })

  it('has more than 1 schema node (not a single generic entity)', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const schemaNodes = job.phases.flatMap(p => p.nodes).filter(n => n.type === 'schema')
    expect(schemaNodes.length).toBeGreaterThan(1)
  })

  it('domain is marketplace', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    expect(job.domain).toBe('marketplace')
  })

  it('buildMode is requirement-driven (not template)', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    expect(job.buildMode).toBe('requirement-driven')
  })
})

// ── Test I — Storage buckets from image/avatar mentions ──────────────────────

describe('Test I — Storage bucket derivation', () => {
  it('includes storage bucket for product images', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const storageNodes = job.phases.flatMap(p => p.nodes).filter(n => n.type === 'storage')
    const hasProductImages = storageNodes.some(n => /product.image|listing.image|product_image/.test(n.id))
    expect(hasProductImages).toBe(true)
  })

  it('includes storage bucket for user avatars', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const storageNodes = job.phases.flatMap(p => p.nodes).filter(n => n.type === 'storage')
    const hasAvatars = storageNodes.some(n => /avatar/.test(n.id))
    expect(hasAvatars).toBe(true)
  })
})

// ── Test E — "build everything I said" classified as CONTINUATION ─────────────

describe('Test E — "build everything I said" CONTINUATION classification', () => {
  it('"build everything I said" → CONTINUATION sub-behavior', async () => {
    const result = await classifyBuildSubBehavior('build everything I said', '')
    expect(result.subBehavior).toBe('CONTINUATION')
  })

  it('"implement everything I described" → CONTINUATION', async () => {
    const result = await classifyBuildSubBehavior('implement everything I described', '')
    expect(result.subBehavior).toBe('CONTINUATION')
  })

  it('"build what I wrote above" → CONTINUATION', async () => {
    const result = await classifyBuildSubBehavior('build what I wrote above', '')
    expect(result.subBehavior).toBe('CONTINUATION')
  })

  it('"do everything I listed" → CONTINUATION', async () => {
    const result = await classifyBuildSubBehavior('do everything I listed', '')
    expect(result.subBehavior).toBe('CONTINUATION')
  })
})

// ── Test B — Continuation recovers full original prompt ──────────────────────

describe('Test B — extractContinuationContext recovers full prior prompt', () => {
  it('returns original marketplace prompt (not truncated at 400 chars) when user sends "build everything I said"', async () => {
    const history = [
      { role: 'user', content: MARKETPLACE_PROMPT },
      {
        role: 'assistant',
        content: `Here is my analysis of your current backend:\n\n**Gap Analysis**\n\nYour project currently has:\n- No tables\n- No APIs\n- No auth\n\nSay 'create users table' to begin.`,
      },
    ]

    const ctx = await extractContinuationContext('test-project', history, 'build everything I said')
    expect(ctx).not.toBeNull()
    // Should recover enough content to contain the explicit entities
    expect(ctx).toContain('users')
    expect(ctx).toContain('stores')
    expect(ctx).toContain('products')
    // Should NOT be truncated at 400 chars (the MARKETPLACE_PROMPT is ~1300+ chars)
    expect(ctx!.length).toBeGreaterThan(600)
  })

  it('does not return null when the prior user message is a long detailed build prompt', async () => {
    const history = [
      { role: 'user', content: MARKETPLACE_PROMPT },
      { role: 'assistant', content: 'Here is a gap analysis...' },
    ]
    const ctx = await extractContinuationContext('test-project', history, 'build it')
    expect(ctx).not.toBeNull()
  })
})

// ── Test D — BuildJob validation blocks generic fallback ─────────────────────

describe('Test D — BuildJob validation gate', () => {
  it('isSeriousBuildRequest returns false for "build everything I said" (short phrase, no entities)', () => {
    expect(isSeriousBuildRequest('build everything I said')).toBe(false)
  })

  it('extractEntitiesFromExplicitList returns empty for "build everything I said"', () => {
    const entities = extractEntitiesFromExplicitList('build everything I said')
    expect(entities).toHaveLength(0)
  })

  it('extractEntitiesFromExplicitList returns the 6 marketplace entities from explicit bullet list', () => {
    const entities = extractEntitiesFromExplicitList(`Core entities:
- users
- stores
- products
- orders
- order_items
- reviews`)
    expect(entities).toHaveLength(6)
    expect(entities).toContain('users')
    expect(entities).toContain('order_items')
  })
})

// ── Test F — Exclusions respected ────────────────────────────────────────────

describe('Test F — Excluded tables not included in BuildJob', () => {
  it('does not add cart even though marketplace domain template might include it', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const allNodeIds = job.phases.flatMap(p => p.nodes).map(n => n.id)
    const hasCart = allNodeIds.some(id => /\bcart/.test(id))
    expect(hasCart).toBe(false)
  })

  it('does not add wishlist', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const allNodeIds = job.phases.flatMap(p => p.nodes).map(n => n.id)
    expect(allNodeIds.some(id => /wishlist/.test(id))).toBe(false)
  })

  it('does not add coupons', async () => {
    const job = await compileBuildJob(MARKETPLACE_PROMPT, makeCtx())
    const allNodeIds = job.phases.flatMap(p => p.nodes).map(n => n.id)
    expect(allNodeIds.some(id => /coupon/.test(id))).toBe(false)
  })
})

// ── Test H — Scan fast-path regression: "audit" word must not hijack builds ──
//
// ROOT CAUSE (fixed): the scan fast-path regex /\baudit\b/ matched the word
// "audit" in "Audit logs for admin actions" inside a large build prompt. The
// guard regex did NOT include "build", so it failed to veto the false positive.
// Result: Project Status Report returned instead of triggering runBuild().
//
// These tests verify that isSeriousBuildRequest returns true for all affected
// prompt variants so callers can use it as the primary veto gate.

const FULL_MARKETPLACE_PROMPT = `Build me a production-grade multi-vendor marketplace backend for handmade products.

Requirements:
- Buyers and sellers
- Sellers can open stores
- Sellers can upload products with multiple images
- Buyers can search, wishlist, cart, and place orders
- Buyers can review products after delivery
- Real-time order updates
- Stripe payments
- Seller payouts
- Admin moderation system
- JWT auth with Google login
- Email notifications for order updates
- Storage for product images and store banners
- Role-based access control
- Soft deletes for products and stores
- Audit logs for admin actions
- API rate limiting
- Production-ready APIs with pagination and filtering`

const SAAS_PROMPT = `Build me a production-grade multi-tenant SaaS backend.

Requirements:
- Organizations and members
- Teams within organizations
- Role-based access (owner, admin, member)
- Invitations via email
- Subscription plans (free, pro, enterprise)
- Stripe billing with webhooks
- Audit logs for compliance
- Rate limiting per organization
- JWT auth with Google OAuth
- Email notifications for invites and billing
- Storage for org logos and attachments
- Soft deletes for organizations and members`

const FOOD_DELIVERY_PROMPT = `Build a production-ready food delivery platform backend.

Entities:
- users (customers and drivers)
- restaurants
- menus
- menu_items
- orders
- order_items
- deliveries
- ratings

Features:
- Real-time order tracking via SSE
- JWT auth with email and Google
- Stripe payments
- Driver payout system
- Push notifications for order status changes
- Storage for restaurant logos and food photos
- Row-level security for orders and deliveries
- Audit logs for dispute resolution`

const HEALTHCARE_PROMPT = `Create a comprehensive healthcare platform backend.

Core tables:
- patients
- doctors
- appointments
- medical_records
- prescriptions
- billing
- insurance_claims

Security requirements:
- HIPAA-compliant row-level security on all patient data
- JWT auth with MFA support
- Audit logs for all data access
- Role-based access: patient, doctor, nurse, admin, billing
- Encryption for sensitive fields

Integrations:
- Stripe for billing
- Email notifications for appointment reminders
- Storage for medical document uploads`

describe('Test H — Scan fast-path routing regression (audit word)', () => {
  // The key invariant: isSeriousBuildRequest must return true for ALL of these prompts.
  // Any caller using isSeriousBuildRequest as a veto gate will correctly skip the scan path.

  it('returns true for full marketplace prompt containing "Audit logs"', () => {
    expect(isSeriousBuildRequest(FULL_MARKETPLACE_PROMPT)).toBe(true)
  })

  it('returns true for SaaS prompt containing "Audit logs for compliance"', () => {
    expect(isSeriousBuildRequest(SAAS_PROMPT)).toBe(true)
  })

  it('returns true for food delivery prompt', () => {
    expect(isSeriousBuildRequest(FOOD_DELIVERY_PROMPT)).toBe(true)
  })

  it('returns true for healthcare platform prompt containing "Audit logs for all data access"', () => {
    expect(isSeriousBuildRequest(HEALTHCARE_PROMPT)).toBe(true)
  })

  // Verify the scan regex DOES match these prompts without the guard (documents the bug)
  it('scan regex matches "audit" in the marketplace prompt (confirms veto is needed)', () => {
    const SCAN_RE = /\b(scan|status|audit|health|overview|what.{0,20}built|show.{0,20}backend|project\s+report|what.{0,20}have|summarize|summary)\b/i
    expect(SCAN_RE.test(FULL_MARKETPLACE_PROMPT)).toBe(true)
    // And the action-word guard WITHOUT "build" would fail (old guard)
    const OLD_GUARD_RE = /\b(create|add|make|new|delete|remove|update|alter|drop|enable|disable|fix|generate)\b/i
    expect(OLD_GUARD_RE.test(FULL_MARKETPLACE_PROMPT)).toBe(false) // guard does NOT fire — bug confirmed
  })

  it('action-word guard WITH "build" correctly fires on marketplace prompt (confirms fix)', () => {
    const NEW_GUARD_RE = /\b(build|create|add|make|new|delete|remove|update|alter|drop|enable|disable|fix|generate)\b/i
    expect(NEW_GUARD_RE.test(FULL_MARKETPLACE_PROMPT)).toBe(true) // guard NOW fires — bug fixed
  })

  it('isSeriousBuildRequest returns false for genuine scan commands (must not over-veto)', () => {
    expect(isSeriousBuildRequest('scan project')).toBe(false)
    expect(isSeriousBuildRequest('what have I built?')).toBe(false)
    expect(isSeriousBuildRequest('show me my backend status')).toBe(false)
    expect(isSeriousBuildRequest('audit my backend')).toBe(false)
  })
})
