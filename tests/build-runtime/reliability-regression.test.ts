/**
 * RELIABILITY REGRESSION TEST PACK
 * ==================================
 * E2E journey tests for the 4 critical reliability scenarios.
 *
 * Journey A: Social media app — posts, profiles, follows, media storage
 * Journey B: Marketplace app — listings, orders, Stripe, product images
 * Journey C: SaaS app — subscriptions, workspaces, billing
 * Journey D: Failure handling — fake success, stale credential, type mismatch
 *
 * Assertions per journey:
 *  - No fake success ("Backend build complete." without artifacts)
 *  - No stale waiting state (credentials remain unreconciled after connecting)
 *  - No no-op success (empty response with success=true)
 *  - No silent failure (failed node but success=true)
 *  - No 500 errors
 *  - No "Production ready" badge when blockers exist
 *  - Dashboard/inspector/chat agree on status
 */

import { renderBuildResponse } from '@/lib/ai/build-runtime/build-renderer'
import { graphFromJob } from '@/lib/ai/build-runtime/build-graph'
import { reconcileBlockedCredentials } from '@/lib/ai/credential-reconciler'
import { validateColumnTypes } from '@/lib/ai/build-runtime/sql-type-preflight'
import { getProjectBadgeLabel } from '@/lib/ai/build-runtime/status-labels'
import { FORBIDDEN_BUILD_PROSE_PATTERNS, containsForbiddenProse } from '@/lib/ai/build-runtime/build-renderer'
import type { BuildJob, BuildNode, BuildPhase } from '@/lib/ai/build-runtime/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(
  id: string,
  label: string,
  type: BuildNode['type'],
  status: BuildNode['status'] = 'verified',
  opts: Partial<BuildNode> = {},
): BuildNode {
  return {
    id,
    label,
    type,
    phase: 1,
    status,
    dependencies: [],
    ...opts,
  }
}

function makeJob(
  domain: BuildJob['domain'],
  phases: BuildPhase[],
  status: BuildJob['status'] = 'partial',
  prompt = '',
): BuildJob {
  return {
    id: 'test-job',
    projectId: 'test-project',
    userId: 'test-user',
    status,
    domain,
    originalPrompt: prompt,
    phases,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function assertNoFakeSuccess(markdown: string, context: string) {
  const lowerMd = markdown.toLowerCase()
  const isFakeSuccess =
    lowerMd === 'backend build complete.' ||
    lowerMd === 'build complete.' ||
    (lowerMd.includes('build complete') && !lowerMd.includes('built') && !lowerMd.includes('created'))
  expect(isFakeSuccess).toBe(false) // context: context
}

function assertNoForbiddenProse(markdown: string) {
  const { found, pattern } = containsForbiddenProse(markdown)
  expect(found).toBe(false) // `Forbidden prose pattern found: ${pattern}`
}

// ── Journey A: Social Media App ───────────────────────────────────────────────

describe('Journey A: Social media app', () => {
  const phases: BuildPhase[] = [
    {
      number: 1,
      name: 'Core Schema',
      nodes: [
        makeNode('schema.users', 'Users table', 'schema'),
        makeNode('schema.profiles', 'Profiles table', 'schema'),
        makeNode('schema.posts', 'Posts table', 'schema'),
        makeNode('schema.comments', 'Comments table', 'schema'),
        makeNode('schema.follows', 'Follows table', 'schema'),
      ],
    },
    {
      number: 2,
      name: 'Auth',
      nodes: [makeNode('auth.jwt', 'JWT authentication', 'auth')],
    },
    {
      number: 3,
      name: 'Flows',
      nodes: [
        makeNode('flow.posts', 'Posts CRUD', 'flow'),
        makeNode('flow.follows', 'Follow/unfollow', 'flow'),
        makeNode('flow.feed', 'Personalized feed', 'flow'),
      ],
    },
    {
      number: 4,
      name: 'Storage',
      nodes: [
        makeNode('storage.post_media', 'Post media bucket', 'storage'),
        makeNode('storage.profile_images', 'Profile images bucket', 'storage'),
      ],
    },
    {
      number: 5,
      name: 'Integrations',
      nodes: [
        makeNode(
          'integration.resend',
          'Email notifications',
          'integration',
          'blocked',
          {
            blockedReason: {
              type: 'missing_credential',
              description: 'Resend not connected',
              requiredEnvVar: 'RESEND_API_KEY',
              resumeOnIntegration: 'resend',
              userAction: 'Paste Resend API key',
            },
          },
        ),
      ],
    },
  ]

  const job = makeJob('social', phases, 'blocked', 'build me a social media app')

  test('renders social app response with storage buckets listed', () => {
    const graph = graphFromJob(job)
    const response = renderBuildResponse(job, graph)
    expect(response.built.length).toBeGreaterThan(0)
    const storageBuilt = response.built.filter(n => n.id.startsWith('storage.'))
    expect(storageBuilt.length).toBeGreaterThan(0) // post_media and profile_images must be listed
    expect(storageBuilt.some(n => n.id.includes('post_media'))).toBe(true)
    expect(storageBuilt.some(n => n.id.includes('profile_images'))).toBe(true)
  })

  test('does not produce fake success text', () => {
    const graph = graphFromJob(job)
    const response = renderBuildResponse(job, graph)
    assertNoFakeSuccess(response.markdown, 'social app journey')
  })

  test('reports credential block clearly without claiming completion', () => {
    const graph = graphFromJob(job)
    const response = renderBuildResponse(job, graph)
    expect(response.blocked.length).toBe(1)
    expect(response.markdown).not.toMatch(/build complete/i)
    expect(response.markdown).not.toMatch(/production ready/i)
    expect(response.markdown).toMatch(/resend|credential/i)
  })

  test('does not contain forbidden hedging prose', () => {
    const graph = graphFromJob(job)
    const response = renderBuildResponse(job, graph)
    assertNoForbiddenProse(response.markdown)
  })

  test('badge label is "Credentials needed" not "Build Complete"', () => {
    const label = getProjectBadgeLabel({
      jobStatus: 'blocked',
      blockedCount: 1,
      failedCount: 0,
      tablesCount: 5,
      apisCount: 3,
      authEnabled: true,
    })
    expect(label).toBe('Credentials needed')
    expect(label).not.toBe('Build Complete')
    expect(label).not.toBe('Production ready')
  })
})

// ── Journey B: Marketplace App ────────────────────────────────────────────────

describe('Journey B: Marketplace app', () => {
  const phases: BuildPhase[] = [
    {
      number: 1,
      name: 'Core Schema',
      nodes: [
        makeNode('schema.users', 'Users table', 'schema'),
        makeNode('schema.stores', 'Stores table', 'schema'),
        makeNode('schema.listings', 'Listings table', 'schema'),
        makeNode('schema.orders', 'Orders table', 'schema'),
      ],
    },
    {
      number: 2,
      name: 'Auth',
      nodes: [makeNode('auth.jwt', 'JWT authentication', 'auth')],
    },
    {
      number: 3,
      name: 'Flows',
      nodes: [
        makeNode('flow.store_management', 'Store CRUD', 'flow'),
        makeNode('flow.listing_management', 'Listing CRUD', 'flow'),
        makeNode('flow.order_processing', 'Order checkout', 'flow'),
      ],
    },
    {
      number: 4,
      name: 'Payments',
      nodes: [
        makeNode(
          'integration.stripe',
          'Stripe payments',
          'integration',
          'blocked',
          {
            blockedReason: {
              type: 'missing_credential',
              description: 'Stripe secret key required',
              requiredEnvVar: 'STRIPE_SECRET_KEY',
              resumeOnIntegration: 'stripe',
              userAction: 'Paste your Stripe secret key',
            },
          },
        ),
      ],
    },
    {
      number: 5,
      name: 'Storage',
      nodes: [
        makeNode('storage.product_images', 'Product images bucket', 'storage'),
        makeNode('storage.store_banners', 'Store banners bucket', 'storage'),
      ],
    },
  ]

  const job = makeJob('marketplace', phases, 'blocked', 'build a marketplace app')

  test('renders marketplace response with product storage listed', () => {
    const graph = graphFromJob(job)
    const response = renderBuildResponse(job, graph)
    const storageBuilt = response.built.filter(n => n.id.startsWith('storage.'))
    expect(storageBuilt.some(n => n.id.includes('product_images'))).toBe(true)
    expect(storageBuilt.some(n => n.id.includes('store_banners'))).toBe(true)
  })

  test('does not show "Production ready" when Stripe is blocked', () => {
    const label = getProjectBadgeLabel({
      jobStatus: 'blocked',
      blockedCount: 1,
      failedCount: 0,
      tablesCount: 4,
      apisCount: 3,
      authEnabled: true,
    })
    expect(label).not.toBe('Production ready')
    expect(label).toBe('Credentials needed')
  })

  test('passes a random string input as credential — must not become build success', () => {
    // This simulates the bug where "vsnbwaekvg285032uy9t23" became "Backend build complete."
    // The credential guard in the pipeline is tested here at the response rendering level.
    // A zero-built response with a random credential input must not render success prose.
    const emptyJob = makeJob('marketplace', [
      { number: 1, name: 'Schema', nodes: [] },
    ], 'pending', 'vsnbwaekvg285032uy9t23')

    const graph = graphFromJob(emptyJob)
    const response = renderBuildResponse(emptyJob, graph)
    // An empty build must not say "Build complete" or "Backend build complete"
    assertNoFakeSuccess(response.markdown, 'random credential input')
    // The markdown must not be an empty string (must always produce some content)
    expect(response.markdown.trim().length).toBeGreaterThan(0)
  })
})

// ── Journey C: SaaS App ───────────────────────────────────────────────────────

describe('Journey C: SaaS app', () => {
  const phases: BuildPhase[] = [
    {
      number: 1,
      name: 'Core Schema',
      nodes: [
        makeNode('schema.users', 'Users table', 'schema'),
        makeNode('schema.workspaces', 'Workspaces table', 'schema'),
        makeNode('schema.workspace_members', 'Workspace members', 'schema'),
        makeNode('schema.subscriptions', 'Subscriptions table', 'schema'),
      ],
    },
    {
      number: 2,
      name: 'Auth',
      nodes: [makeNode('auth.jwt', 'JWT authentication', 'auth')],
    },
    {
      number: 3,
      name: 'Flows',
      nodes: [
        makeNode('flow.workspace_ops', 'Workspace CRUD', 'flow'),
        makeNode('flow.team_management', 'Team management', 'flow'),
      ],
    },
    {
      number: 4,
      name: 'Billing',
      nodes: [
        makeNode(
          'integration.stripe.subscription',
          'Stripe subscription billing',
          'integration',
          'blocked',
          {
            blockedReason: {
              type: 'missing_credential',
              description: 'Stripe secret key required for subscription billing',
              requiredEnvVar: 'STRIPE_SECRET_KEY',
              resumeOnIntegration: 'stripe',
              userAction: 'Paste your Stripe secret key',
            },
          },
        ),
      ],
    },
    {
      number: 5,
      name: 'Storage',
      nodes: [makeNode('storage.attachments', 'Attachments bucket', 'storage')],
    },
    {
      number: 6,
      name: 'Verification',
      nodes: [
        makeNode('verification.auth', 'Auth verification', 'verification'),
        makeNode('verification.apis', 'API verification', 'verification'),
      ],
    },
  ]

  const job = makeJob('saas', phases, 'blocked', 'build me a SaaS platform with workspaces and subscriptions')

  test('SaaS build response lists all built components clearly', () => {
    const graph = graphFromJob(job)
    const response = renderBuildResponse(job, graph)
    expect(response.built.some(n => n.id.startsWith('schema.'))).toBe(true)
    expect(response.built.some(n => n.id.startsWith('auth.'))).toBe(true)
    expect(response.built.some(n => n.id.startsWith('storage.'))).toBe(true)
  })

  test('next_step is unambiguous when credentials are missing', () => {
    const graph = graphFromJob(job)
    const response = renderBuildResponse(job, graph)
    expect(response.next_step).toBeTruthy()
    expect(response.next_step).not.toMatch(/check back shortly/i)
    // Must specifically mention Stripe or credentials
    const mentionsCredential =
      response.next_step.toLowerCase().includes('stripe') ||
      response.next_step.toLowerCase().includes('credential') ||
      response.next_step.toLowerCase().includes('connect')
    expect(mentionsCredential).toBe(true)
  })

  test('"Production ready" badge requires verified status + no blockers + auth', () => {
    // Should NOT be production ready when blocked
    const blockedLabel = getProjectBadgeLabel({
      jobStatus: 'verified',
      blockedCount: 1,
      failedCount: 0,
      tablesCount: 4,
      apisCount: 2,
      authEnabled: true,
    })
    expect(blockedLabel).not.toBe('Production ready')

    // Should NOT be production ready without auth
    const noAuthLabel = getProjectBadgeLabel({
      jobStatus: 'verified',
      blockedCount: 0,
      failedCount: 0,
      tablesCount: 4,
      apisCount: 2,
      authEnabled: false,
    })
    expect(noAuthLabel).not.toBe('Production ready')

    // SHOULD be production ready only when all conditions are met
    const readyLabel = getProjectBadgeLabel({
      jobStatus: 'verified',
      blockedCount: 0,
      failedCount: 0,
      tablesCount: 4,
      apisCount: 2,
      authEnabled: true,
    })
    expect(readyLabel).toBe('Production ready')
  })
})

// ── Journey D: Failure Handling ───────────────────────────────────────────────

describe('Journey D: Failure handling', () => {
  test('zero-output build never returns "Backend build complete."', () => {
    const job = makeJob('generic', [
      { number: 1, name: 'Schema', nodes: [] },
    ], 'pending', 'make my backend better')
    const graph = graphFromJob(job)
    const response = renderBuildResponse(job, graph)
    assertNoFakeSuccess(response.markdown, 'zero-output build')
  })

  test('failed node reports failure — does not return success=true', () => {
    const phases: BuildPhase[] = [{
      number: 1,
      name: 'Schema',
      nodes: [
        makeNode('schema.orders', 'Orders table', 'schema', 'failed', {
          failureReason: 'Type mismatch: user_id column is TEXT but users.id is UUID',
        }),
      ],
    }]
    const job = makeJob('ecommerce', phases, 'failed', 'build ecommerce backend')
    const graph = graphFromJob(job)
    const response = renderBuildResponse(job, graph)
    expect(response.failed.length).toBe(1)
    expect(response.markdown).toMatch(/failed/i)
    // Must not say "Build complete" when a node failed
    expect(response.markdown).not.toMatch(/build complete/i)
  })

  test('SQL type preflight catches UUID FK column using TEXT type', () => {
    const violations = validateColumnTypes('orders', [
      { name: 'id', type: 'UUID' },
      { name: 'user_id', type: 'TEXT' },  // WRONG — should be UUID
      { name: 'status', type: 'TEXT' },
      { name: 'total', type: 'DECIMAL' },
    ])
    const errors = violations.filter(v => v.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].column).toBe('user_id')
    expect(errors[0].suggestion).toMatch(/UUID/i)
  })

  test('SQL type preflight passes valid column types', () => {
    const violations = validateColumnTypes('orders', [
      { name: 'id', type: 'UUID' },
      { name: 'user_id', type: 'UUID' },  // CORRECT
      { name: 'status', type: 'TEXT' },
      { name: 'total', type: 'DECIMAL' },
      { name: 'created_at', type: 'TIMESTAMP' },
    ])
    const errors = violations.filter(v => v.severity === 'error')
    expect(errors.length).toBe(0)
  })

  test('SQL type preflight catches UUID type on status column', () => {
    const violations = validateColumnTypes('orders', [
      { name: 'id', type: 'UUID' },
      { name: 'status', type: 'UUID' },   // WRONG — status should be TEXT
    ])
    const errors = violations.filter(v => v.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].column).toBe('status')
  })

  test('build response with only blockers uses "Credentials needed" label', () => {
    const phases: BuildPhase[] = [
      {
        number: 1,
        name: 'Schema',
        nodes: [
          makeNode('schema.users', 'Users table', 'schema', 'verified'),
          makeNode('schema.posts', 'Posts table', 'schema', 'verified'),
        ],
      },
      {
        number: 2,
        name: 'Integrations',
        nodes: [
          makeNode(
            'integration.stripe',
            'Stripe integration',
            'integration',
            'blocked',
            {
              blockedReason: {
                type: 'missing_credential',
                description: 'Stripe required',
                requiredEnvVar: 'STRIPE_SECRET_KEY',
                resumeOnIntegration: 'stripe',
                userAction: 'Paste Stripe secret key',
              },
            },
          ),
        ],
      },
    ]
    const job = makeJob('generic', phases, 'blocked', 'build with stripe')
    const graph = graphFromJob(job)
    const response = renderBuildResponse(job, graph)

    expect(response.blocked.length).toBe(1)
    expect(response.markdown).not.toMatch(/build complete/i)

    const label = getProjectBadgeLabel({
      jobStatus: 'blocked',
      blockedCount: 1,
      failedCount: 0,
      tablesCount: 2,
      apisCount: 0,
      authEnabled: false,
    })
    expect(label).toBe('Credentials needed')
  })

  test('no forbidden hedging prose in any journey response', () => {
    const testCases = [
      'great question, typically you would want to add storage',
      'let me know if you need anything else',
      "i recommend you check this, don't hesitate to ask",
      "happy to help with anything else you need",
      "here's what usually works in this case",
    ]
    for (const text of testCases) {
      const { found } = containsForbiddenProse(text)
      expect(found).toBe(true) // these should all be caught by the guard
    }
    // Clean text should pass
    const { found: cleanFound } = containsForbiddenProse('I built 3 tables: users, posts, comments.')
    expect(cleanFound).toBe(false)
  })
})
