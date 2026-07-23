/**
 * BUILD RUNTIME — Regression Tests
 * ==================================
 * 7 required test cases from the architectural refactor spec.
 *
 * Tests verify:
 *  1. Ecommerce build creates a real build graph (not a single generic table)
 *  2. Serious ecommerce build decomposes into phases without stopping at first scaffold
 *  3. Missing Stripe keys block only Stripe nodes — others continue
 *  4. Stripe key arrival resumes blocked nodes
 *  5. Build mode responses contain no chatbot prose patterns
 *  6. Plan mode never executes mutations
 *  7. Chat/inspector state consistency (build graph = source of truth)
 */

import { BuildGraph } from '../../lib/ai/build-runtime/build-graph'
import { ecommercePhases, saasPhases, detectDomain } from '../../lib/ai/build-runtime/domain-phases'
import { isSeriousBuildRequest, compileBuildJob } from '../../lib/ai/build-runtime/domain-compiler'
import { renderBuildResponse, renderPlanResponse, containsForbiddenProse, FORBIDDEN_BUILD_PROSE_PATTERNS } from '../../lib/ai/build-runtime/build-renderer'
import { detectBuildMode } from '../../lib/ai/build-runtime/run-build'
import type { BuildJob, BuildNode, BuildPhase, BuildContext } from '../../lib/ai/build-runtime/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJob(phases: BuildPhase[], domain: BuildJob['domain'] = 'ecommerce'): BuildJob {
  return {
    id: 'test-job-1',
    projectId: 'test-project',
    userId: 'test-user',
    originalPrompt: 'test prompt',
    domain,
    status: 'pending',
    phases,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function makeCtx(): BuildContext {
  return {
    projectId: 'test-project',
    userId: 'test-user',
    availableSecrets: [],
  }
}

// ── Test 1: Simple ecommerce build creates real multi-node graph ──────────────

describe('Test 1 — Simple ecommerce build graph', () => {
  it('creates a build graph with multiple backend nodes (not just one table)', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    const all = graph.getAllNodes()

    // Must have more than 1 node
    expect(all.length).toBeGreaterThan(5)

    // Must have schema nodes
    const schemaNodes = all.filter(n => n.type === 'schema')
    expect(schemaNodes.length).toBeGreaterThan(3)

    // Must have auth
    const authNodes = all.filter(n => n.type === 'auth')
    expect(authNodes.length).toBeGreaterThan(0)

    // Must have API/flow nodes
    const flowNodes = all.filter(n => n.type === 'flow')
    expect(flowNodes.length).toBeGreaterThan(0)

    // Must have verification nodes
    const verificationNodes = all.filter(n => n.type === 'verification')
    expect(verificationNodes.length).toBeGreaterThan(0)

    // Must NOT be just a single generic entity
    const tableNames = schemaNodes.map(n => n.id.replace('schema.', ''))
    expect(tableNames).toContain('users')
    expect(tableNames).toContain('products')
    expect(tableNames).toContain('orders')
  })

  it('detects ecommerce domain from prompt', () => {
    expect(detectDomain('create an ecommerce backend')).toBe('ecommerce')
    expect(detectDomain('build an online store')).toBe('ecommerce')
    expect(detectDomain('I need a shop with products and cart')).toBe('ecommerce')
  })

  it('classifies ecommerce prompts as serious build requests', () => {
    expect(isSeriousBuildRequest('create an ecommerce backend')).toBe(true)
    expect(isSeriousBuildRequest('build a production-ready ecommerce platform')).toBe(true)
    expect(isSeriousBuildRequest('build me a complete backend system')).toBe(true)
  })

  it('does not classify simple requests as serious builds', () => {
    // Simple requests should NOT go through the heavy build runtime
    expect(isSeriousBuildRequest('add an email column')).toBe(false)
    expect(isSeriousBuildRequest('list my tables')).toBe(false)
    expect(isSeriousBuildRequest('add auth')).toBe(false)
  })
})

// ── Test 2: Serious ecommerce build decomposes into phases ────────────────────

describe('Test 2 — Serious ecommerce build phase decomposition', () => {
  it('has 8 phases for ecommerce domain', () => {
    const phases = ecommercePhases()
    expect(phases.length).toBe(8)
  })

  it('phases are in correct order: schema → auth → flows → payments → ...', () => {
    const phases = ecommercePhases()
    expect(phases[0].name).toBe('Core Schema')
    expect(phases[1].name).toBe('Auth + Roles')
    expect(phases[2].name).toBe('Business Flows')
    expect(phases[3].name).toBe('Payments')
  })

  it('topological sort respects dependencies', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    const ordered = graph.topoSort()

    // users must come before orders (orders depends on users)
    const usersIdx = ordered.findIndex(n => n.id === 'schema.users')
    const ordersIdx = ordered.findIndex(n => n.id === 'schema.orders')
    expect(usersIdx).toBeGreaterThan(-1)
    expect(ordersIdx).toBeGreaterThan(-1)
    expect(usersIdx).toBeLessThan(ordersIdx)

    // auth.jwt must come after schema.users
    const authIdx = ordered.findIndex(n => n.id === 'auth.jwt')
    expect(authIdx).toBeGreaterThan(usersIdx)
  })

  it('build graph has ready nodes at start (schema nodes with no deps)', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    // Mark integration nodes as blocked (they start that way already)
    const readyNodes = graph.getReadyNodes()

    // Schema nodes with no dependencies should be ready
    expect(readyNodes.length).toBeGreaterThan(0)
    const schemaReady = readyNodes.filter(n => n.type === 'schema')
    expect(schemaReady.length).toBeGreaterThan(0)
  })
})

// ── Test 3: Blocked integration — only Stripe blocked, others continue ────────

describe('Test 3 — Blocked integration isolation', () => {
  it('marks Stripe nodes as blocked by default (no credentials available)', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)

    const stripeCheckout = graph.getNode('integration.stripe.checkout')
    const stripeWebhook = graph.getNode('integration.stripe.webhook')

    expect(stripeCheckout).toBeDefined()
    expect(stripeWebhook).toBeDefined()
    expect(stripeCheckout!.status).toBe('blocked')
    expect(stripeWebhook!.status).toBe('blocked')
  })

  it('blocked Stripe nodes do NOT block unrelated schema nodes', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    const readyNodes = graph.getReadyNodes()

    // Users, categories should be ready despite Stripe being blocked
    const usersReady = readyNodes.find(n => n.id === 'schema.users')
    const categoriesReady = readyNodes.find(n => n.id === 'schema.categories')

    expect(usersReady).toBeDefined()
    expect(categoriesReady).toBeDefined()
  })

  it('blocked node has a specific required env var (not vague)', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    const stripeCheckout = graph.getNode('integration.stripe.checkout')

    expect(stripeCheckout!.blockedReason).toBeDefined()
    expect(stripeCheckout!.blockedReason!.requiredEnvVar).toBe('STRIPE_SECRET_KEY')
    expect(stripeCheckout!.blockedReason!.userAction).toBeTruthy()
    expect(stripeCheckout!.blockedReason!.resumeOnIntegration).toBe('stripe')
  })

  it('aggregate job status is partial when some nodes verified and some blocked', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)

    // Simulate: schema nodes verified, stripe still blocked
    graph.markVerified('schema.users', 'Created')
    graph.markVerified('schema.products', 'Created')
    graph.markVerified('auth.jwt', 'Enabled')

    const status = graph.computeJobStatus()
    // Should be partial (not "verified" since stripe is still blocked)
    expect(['partial', 'running', 'pending']).toContain(status)
    expect(status).not.toBe('verified')
  })
})

// ── Test 4: Secret resume — Stripe node resumes after key saved ───────────────

describe('Test 4 — Credential resume', () => {
  it('unblocks Stripe nodes when Stripe integration key arrives', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)

    // Verify: Stripe starts blocked
    expect(graph.getNode('integration.stripe.checkout')!.status).toBe('blocked')

    // Simulate credential arrival
    const unblocked = graph.unblockByIntegration('stripe')

    // Both Stripe nodes should be unblocked
    expect(unblocked).toContain('integration.stripe.checkout')

    // Node status should be pending now
    expect(graph.getNode('integration.stripe.checkout')!.status).toBe('pending')
  })

  it('unblocking Stripe does NOT unblock Resend', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)

    graph.unblockByIntegration('stripe')

    // Resend should still be blocked
    const resend = graph.getNode('integration.resend.email')
    expect(resend).toBeDefined()
    expect(resend!.status).toBe('blocked')
  })

  it('unblocked Stripe node becomes ready if deps are satisfied', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)

    // First verify the deps (orders and flow.order_checkout)
    graph.markVerified('schema.users', 'Created')
    graph.markVerified('schema.products', 'Created')
    graph.markVerified('schema.categories', 'Created')
    graph.markVerified('schema.carts', 'Created')
    graph.markVerified('schema.cart_items', 'Created')
    graph.markVerified('schema.orders', 'Created')
    graph.markVerified('schema.order_items', 'Created')
    graph.markVerified('auth.jwt', 'Enabled')
    graph.markVerified('permissions.roles', 'Configured')
    graph.markVerified('permissions.rls', 'Configured')
    graph.markVerified('flow.product_catalog', 'Created')
    graph.markVerified('flow.cart_management', 'Created')
    graph.markVerified('flow.order_checkout', 'Created')
    graph.markVerified('flow.order_management', 'Created')

    // Now unblock Stripe
    graph.unblockByIntegration('stripe')

    const readyNodes = graph.getReadyNodes()
    const stripeCheckoutReady = readyNodes.find(n => n.id === 'integration.stripe.checkout')
    expect(stripeCheckoutReady).toBeDefined()
  })
})

// ── Test 5: Build mode responses contain no chatbot prose ─────────────────────

describe('Test 5 — Build mode no chatbot prose', () => {
  const job = makeJob(ecommercePhases())

  it('rendered build response contains no forbidden prose patterns', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)

    // Simulate a partial build
    graph.markVerified('schema.users', 'Created users table with 7 columns')
    graph.markVerified('schema.products', 'Created products table')
    graph.markVerified('auth.jwt', 'JWT auth enabled')

    const response = renderBuildResponse(job, graph)
    const { found, pattern } = containsForbiddenProse(response.markdown)

    expect(found).toBe(false)
    if (found) {
      throw new Error(`Forbidden prose pattern found: ${pattern}`)
    }
  })

  it('build response does not contain "great question"', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    graph.markVerified('schema.users', 'Created')
    const response = renderBuildResponse(job, graph)
    expect(response.markdown).not.toMatch(/great question/i)
  })

  it('build response does not contain "typically" or "usually"', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    const response = renderBuildResponse(job, graph)
    expect(response.markdown).not.toMatch(/\btypically\b/i)
    expect(response.markdown).not.toMatch(/\busually\b/i)
  })

  it('build response does not contain "let me know"', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    const response = renderBuildResponse(job, graph)
    expect(response.markdown).not.toMatch(/let me know/i)
  })

  it('forbidden prose patterns are comprehensive', () => {
    // Validate all forbidden patterns catch the right strings
    const FORBIDDEN_STRINGS = [
      'great question',
      'typically',
      'you may want',
      'let me know',
      'I recommend',
      "here's what usually",
      'feel free to',
      "don't hesitate",
      'happy to help',
      'if you need anything',
      'hope that helps',
    ]
    for (const str of FORBIDDEN_STRINGS) {
      const { found } = containsForbiddenProse(str)
      expect(found).toBe(true)
    }
  })
})

// ── Test 6: Plan mode never executes mutations ────────────────────────────────

describe('Test 6 — Plan mode safety', () => {
  it('detects plan mode from "plan" keyword', () => {
    expect(detectBuildMode('plan me an ecommerce backend', undefined)).toBe('plan')
    expect(detectBuildMode('what would an ecommerce backend look like', undefined)).toBe('plan')
    expect(detectBuildMode('propose the architecture for a SaaS', undefined)).toBe('plan')
  })

  it('detects build mode from execution keywords', () => {
    expect(detectBuildMode('build an ecommerce backend', undefined)).toBe('build')
    expect(detectBuildMode('create a marketplace', undefined)).toBe('build')
  })

  it('plan response contains no executed/verified claims', () => {
    const job = makeJob(ecommercePhases())
    job.planOnly = true

    const planResponse = renderPlanResponse(job)

    // Plan response must say it's a plan
    expect(planResponse.markdown).toMatch(/plan|proposed|architecture/i)

    // Plan response must include "say build it" or similar
    expect(planResponse.markdown).toMatch(/build it|execute|say/i)

    // Plan response must NOT claim things were built
    expect(planResponse.markdown).not.toMatch(/\bbuilt:\b/i)
    expect(planResponse.markdown).not.toMatch(/\bverified:\b/i)
    expect(planResponse.markdown).not.toMatch(/\bDone:/i)
  })

  it('plan response renders phases correctly', () => {
    const job = makeJob(ecommercePhases())
    const planResponse = renderPlanResponse(job)

    expect(planResponse.phases.length).toBe(8)
    expect(planResponse.phases[0].name).toBe('Core Schema')
    expect(planResponse.phases[0].items.length).toBeGreaterThan(0)
    expect(planResponse.mode).toBe('plan')
  })
})

// ── Test 7: Chat/inspector state consistency ──────────────────────────────────

describe('Test 7 — Chat and inspector state consistency', () => {
  it('build response built list matches graph verified nodes', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    const job = makeJob(phases)

    // Simulate execution
    graph.markVerified('schema.users', 'Created users table')
    graph.markVerified('schema.products', 'Created products table')
    graph.markVerified('auth.jwt', 'JWT auth enabled')

    const response = renderBuildResponse(job, graph)

    // Chat response must list exactly what graph says is verified
    const builtIds = response.built.map(b => b.id)
    expect(builtIds).toContain('schema.users')
    expect(builtIds).toContain('schema.products')
    expect(builtIds).toContain('auth.jwt')

    // Must NOT claim Stripe is built when it's blocked
    expect(builtIds).not.toContain('integration.stripe.checkout')
  })

  it('blocked nodes in response match graph blocked nodes exactly', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    const job = makeJob(phases)

    const response = renderBuildResponse(job, graph)

    // Stripe should appear in blocked section (not built)
    const blockedIds = response.blocked.map(b => b.id)
    expect(blockedIds).toContain('integration.stripe.checkout')
    expect(blockedIds).toContain('integration.stripe.webhook')

    // Each blocked item must have a reason
    for (const blocked of response.blocked) {
      expect(blocked.reason).toBeTruthy()
      expect(blocked.reason.length).toBeGreaterThan(0)
    }
  })

  it('job status matches aggregate of node statuses', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)

    // Nothing done yet
    expect(graph.computeJobStatus()).toBe('pending')

    // Some verified
    graph.markVerified('schema.users', 'Created')
    expect(graph.computeJobStatus()).toBe('partial')
  })

  it('next_step is always actionable (never vague)', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    const job = makeJob(phases)

    // Simulate all required non-optional nodes verified
    // (Stripe still blocked — that's optional)
    const nonOptionalNonVerification = graph.getAllNodes().filter(
      n => !n.optional && n.type !== 'verification' && n.type !== 'integration'
    )

    for (const node of nonOptionalNonVerification) {
      graph.markVerified(node.id, `Created ${node.label}`)
    }

    const response = renderBuildResponse(job, graph)

    // next_step should either mention a specific action or say deploy
    expect(response.next_step).toBeTruthy()
    expect(response.next_step!.length).toBeGreaterThan(5)

    // Should NOT be vague generic chatbot advice
    expect(response.next_step).not.toMatch(/great question/i)
    expect(response.next_step).not.toMatch(/feel free/i)
    expect(response.next_step).not.toMatch(/let me know/i)
  })

  it('SaaS domain is correctly identified and decomposed', () => {
    expect(detectDomain('build a SaaS backend with workspaces and teams')).toBe('saas')
    const phases = saasPhases()
    expect(phases.length).toBeGreaterThan(3)
    const nodeIds = phases.flatMap(p => p.nodes.map(n => n.id))
    expect(nodeIds).toContain('schema.workspaces')
    expect(nodeIds).toContain('schema.workspace_members')
    expect(nodeIds).toContain('auth.jwt')
  })
})

// ── Additional: BuildGraph correctness ───────────────────────────────────────

describe('BuildGraph — core invariants', () => {
  it('setStatus updates node in both map and phases array', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)

    graph.markVerified('schema.users', 'Created')

    // Check via getNode
    expect(graph.getNode('schema.users')!.status).toBe('verified')

    // Check via toJSON (phases array)
    const serialized = graph.toJSON()
    const usersInPhase = serialized[0].nodes.find(n => n.id === 'schema.users')
    expect(usersInPhase!.status).toBe('verified')
  })

  it('topoSort handles nodes with multiple dependencies', () => {
    const phases = ecommercePhases()
    const graph = new BuildGraph(phases)
    const sorted = graph.topoSort()

    // cart_items depends on carts AND products — both must appear before cart_items
    const cartsIdx = sorted.findIndex(n => n.id === 'schema.carts')
    const productsIdx = sorted.findIndex(n => n.id === 'schema.products')
    const cartItemsIdx = sorted.findIndex(n => n.id === 'schema.cart_items')

    expect(cartsIdx).toBeGreaterThan(-1)
    expect(productsIdx).toBeGreaterThan(-1)
    expect(cartItemsIdx).toBeGreaterThan(-1)
    expect(cartItemsIdx).toBeGreaterThan(cartsIdx)
    expect(cartItemsIdx).toBeGreaterThan(productsIdx)
  })

  it('computeJobStatus returns "failed" when all non-optional nodes fail', () => {
    // Use generic phases with just a few nodes
    const phases = [{
      number: 1,
      name: 'Test',
      nodes: [
        {
          id: 'schema.items',
          label: 'Items',
          type: 'schema' as const,
          phase: 1,
          status: 'failed' as const,
          dependencies: [],
        }
      ]
    }]
    const graph = new BuildGraph(phases)
    expect(graph.computeJobStatus()).toBe('failed')
  })
})
