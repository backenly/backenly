/**
 * DOMAIN PHASE DEFINITIONS
 * ========================
 * Canonical phase decomposition for major backend domains.
 *
 * Each domain defines a structured set of phases + nodes.
 * The domain-compiler uses these templates to build the initial graph,
 * then customizes based on the actual user prompt.
 *
 * Rule: Every node here maps to real backend primitives.
 * No node is cosmetic. Every node executes or blocks honestly.
 */

import type { BuildPhase, BuildNode, Domain } from './types'

// ── Helper ────────────────────────────────────────────────────────────────────

function node(
  id: string,
  label: string,
  type: BuildNode['type'],
  phase: number,
  dependencies: string[] = [],
  opts: Partial<BuildNode> = {}
): BuildNode {
  return {
    id,
    label,
    type,
    phase,
    status: 'pending',
    dependencies,
    ...opts,
  }
}

// ── ECOMMERCE ─────────────────────────────────────────────────────────────────

export function ecommercePhases(): BuildPhase[] {
  return [
    {
      number: 1,
      name: 'Core Schema',
      description: 'Database tables for the ecommerce domain',
      nodes: [
        node('schema.users',       'Users table',       'schema', 1),
        node('schema.categories',  'Categories table',  'schema', 1),
        node('schema.products',    'Products table',    'schema', 1, ['schema.categories']),
        node('schema.carts',       'Carts table',       'schema', 1, ['schema.users']),
        node('schema.cart_items',  'Cart items table',  'schema', 1, ['schema.carts', 'schema.products']),
        node('schema.orders',      'Orders table',      'schema', 1, ['schema.users']),
        node('schema.order_items', 'Order items table', 'schema', 1, ['schema.orders', 'schema.products']),
        node('schema.payments',    'Payments table',    'schema', 1, ['schema.orders', 'schema.users']),
        node('schema.reviews',     'Reviews table',     'schema', 1, ['schema.orders', 'schema.users']),
      ],
    },
    {
      number: 2,
      name: 'Auth + Roles',
      description: 'Authentication system and role-based access control',
      nodes: [
        node('auth.jwt', 'JWT authentication', 'auth', 2, ['schema.users']),
        node(
          'permissions.roles',
          'Customer/Admin roles',
          'permissions',
          2,
          ['schema.users'],
          {
            executionParams: {
              // Ecommerce-aware role names and multi-table coverage
              roles: ['admin', 'customer'],
              tables: ['users', 'products', 'orders', 'carts', 'reviews'],
            },
          }
        ),
        node(
          'permissions.rls',
          'Row-level security (RLS)',
          'permissions',
          2,
          ['permissions.roles'],
          {
            executionParams: {
              // Apply RLS to all user-owned tables, not just 'users'
              tables: ['orders', 'carts', 'cart_items', 'payments', 'reviews'],
              condition: 'user_id = auth.uid()',
            },
          }
        ),
        node(
          'auth.google',
          'Google OAuth sign-in',
          'auth',
          2,
          ['auth.jwt'],
          {
            optional: true,
            status: 'blocked',
            blockedReason: {
              type: 'missing_credential',
              description: 'Google Client ID and Client Secret required to activate Google sign-in',
              requiredEnvVar: 'GOOGLE_CLIENT_ID',
              resumeOnIntegration: 'google',
              userAction: 'Go to console.cloud.google.com → Credentials → Create OAuth 2.0 Client, then paste: google_client_id: YOUR_ID\ngoogle_client_secret: YOUR_SECRET',
              manualSteps: [
                'Go to https://console.cloud.google.com/apis/credentials',
                'Create project → Enable OAuth 2.0 → Create OAuth client ID (Web application)',
                'Add authorized redirect URI: {your-domain}/api/v1/{projectId}/auth/google/callback',
                'Copy Client ID and Client Secret and paste them in chat',
              ],
            },
          }
        ),
      ],
    },
    {
      number: 3,
      name: 'Business Flows',
      description: 'Core ecommerce business logic and API endpoints',
      nodes: [
        node('flow.product_catalog',    'Product catalog APIs',     'flow', 3, ['schema.products', 'auth.jwt']),
        node('flow.category_management','Category APIs',           'flow', 3, ['schema.categories', 'auth.jwt']),
        node('flow.cart_management',   'Cart management APIs',     'flow', 3, ['schema.cart_items', 'auth.jwt']),
        node('flow.checkout',          'Cart → Order checkout',    'flow', 3, ['schema.orders', 'schema.order_items', 'auth.jwt']),
        node('flow.order_management',  'Order management APIs',    'flow', 3, ['schema.orders', 'auth.jwt']),
        node('flow.order_status',      'Order status endpoint',    'flow', 3, ['schema.orders', 'auth.jwt']),
        node('flow.reviews',           'Review APIs',              'flow', 3, ['schema.reviews', 'auth.jwt']),
        node('flow.stats',             'Aggregate stats endpoint', 'flow', 3, ['schema.orders', 'schema.products']),
        node('flow.healthz',           'Health check endpoint',    'flow', 3, []),
      ],
    },
    {
      number: 4,
      name: 'Payments',
      description: 'Stripe payment processing (requires credentials)',
      nodes: [
        node(
          'integration.stripe.checkout',
          'Stripe checkout endpoint',
          'integration',
          4,
          ['schema.orders', 'flow.order_management'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Stripe secret key required to activate payment processing',
              requiredEnvVar: 'STRIPE_SECRET_KEY',
              resumeOnIntegration: 'stripe',
              userAction: 'Paste your Stripe secret key (sk_live_... or sk_test_...) in the chat',
            },
            status: 'blocked',
          }
        ),
        node(
          'integration.stripe.webhook',
          'Stripe webhook handler',
          'integration',
          4,
          ['integration.stripe.checkout'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Stripe webhook secret required for signature verification',
              requiredEnvVar: 'STRIPE_WEBHOOK_SECRET',
              resumeOnIntegration: 'stripe_webhook',
              userAction: 'After creating webhook in Stripe dashboard, paste the webhook signing secret',
              manualSteps: [
                'Go to https://dashboard.stripe.com/webhooks',
                'Add endpoint: {your-domain}/api/v1/{projectId}/webhooks/stripe',
                'Select events: payment_intent.succeeded, payment_intent.payment_failed',
                'Copy the signing secret and paste it here',
              ],
            },
            status: 'blocked',
          }
        ),
      ],
    },
    {
      number: 5,
      name: 'Notifications',
      description: 'Email notifications for order events (requires Resend key)',
      nodes: [
        node(
          'integration.resend.email',
          'Order email notifications',
          'integration',
          5,
          ['schema.orders'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Resend API key required to activate email sending',
              requiredEnvVar: 'RESEND_API_KEY',
              resumeOnIntegration: 'resend',
              userAction: 'Paste your Resend API key (re_...) in the chat',
            },
            status: 'blocked',
          }
        ),
      ],
    },
    {
      number: 6,
      name: 'Functions + Automation',
      description: 'Serverless functions, database triggers, and realtime',
      nodes: [
        node('function.on_order_created',    'Order created function',     'function', 6, ['schema.orders']),
        node('function.on_payment_succeeded','Payment succeeded function',  'function', 6, ['schema.orders']),
        node('trigger.decrement_stock',      'Decrement stock on sale',    'trigger',  6, ['schema.products', 'schema.order_items']),
        node('realtime.orders',              'Realtime order updates',     'realtime', 6, ['schema.orders', 'auth.jwt']),
      ],
    },
    {
      number: 7,
      name: 'Storage',
      description: 'File storage buckets for product media',
      nodes: [
        node('storage.product_images', 'Product images bucket (public)',  'storage', 7, ['schema.products']),
        node('storage.store_assets',   'Store assets bucket (private)',   'storage', 7, ['schema.users']),
      ],
    },
    {
      number: 8,
      name: 'Verification',
      description: 'Post-build verification against real state',
      nodes: [
        node('verification.auth',      'Auth verification',    'verification', 8, ['auth.jwt']),
        node('verification.apis',      'REST API verification', 'verification', 8, ['flow.product_catalog']),
        node('verification.functions', 'Functions verification','verification', 8, ['function.on_order_created']),
      ],
    },
  ]
}

// ── SAAS ──────────────────────────────────────────────────────────────────────

export function saasPhases(): BuildPhase[] {
  return [
    {
      number: 1,
      name: 'Core Schema',
      description: 'Multi-tenant SaaS data model',
      nodes: [
        node('schema.users',              'Users table',              'schema', 1),
        node('schema.workspaces',         'Workspaces table',         'schema', 1),
        node('schema.workspace_members',  'Workspace members table',  'schema', 1, ['schema.users', 'schema.workspaces']),
        node('schema.plans',              'Plans/tiers table',        'schema', 1),
        node('schema.subscriptions',      'Subscriptions table',      'schema', 1, ['schema.users', 'schema.plans']),
      ],
    },
    {
      number: 2,
      name: 'Auth + Team Roles',
      description: 'Authentication and workspace-scoped RBAC',
      nodes: [
        node('auth.jwt',               'JWT authentication',           'auth',        2, ['schema.users']),
        node('permissions.roles',      'Owner/Admin/Member roles',     'permissions', 2, ['schema.workspace_members']),
        node('permissions.rls',        'Workspace-scoped RLS',         'permissions', 2, ['permissions.roles']),
      ],
    },
    {
      number: 3,
      name: 'Business Flows',
      description: 'Workspace management and team operations',
      nodes: [
        node('flow.workspace_ops',     'Workspace CRUD endpoints',     'flow', 3, ['schema.workspaces', 'auth.jwt']),
        node('flow.team_management',   'Team invite/remove endpoints', 'flow', 3, ['schema.workspace_members', 'auth.jwt']),
        node('flow.plan_management',   'Plan upgrade/downgrade APIs',  'flow', 3, ['schema.subscriptions', 'auth.jwt']),
      ],
    },
    {
      number: 4,
      name: 'Billing',
      description: 'Stripe subscription billing (requires credentials)',
      nodes: [
        node(
          'integration.stripe.subscription',
          'Stripe subscription checkout',
          'integration',
          4,
          ['schema.subscriptions', 'flow.plan_management'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Stripe secret key required for subscription billing',
              requiredEnvVar: 'STRIPE_SECRET_KEY',
              resumeOnIntegration: 'stripe',
              userAction: 'Paste your Stripe secret key (sk_live_... or sk_test_...) in the chat',
            },
            status: 'blocked',
          }
        ),
        node(
          'integration.stripe.webhook',
          'Stripe billing webhook',
          'integration',
          4,
          ['integration.stripe.subscription'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Webhook for subscription lifecycle events (invoice paid, trial ending)',
              requiredEnvVar: 'STRIPE_WEBHOOK_SECRET',
              resumeOnIntegration: 'stripe_webhook',
              userAction: 'Paste your Stripe webhook signing secret',
            },
            status: 'blocked',
          }
        ),
      ],
    },
    {
      number: 5,
      name: 'Notifications',
      description: 'Transactional emails for workspace events',
      nodes: [
        node(
          'integration.resend.email',
          'Workspace email notifications',
          'integration',
          5,
          ['schema.workspace_members'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Resend API key required to send invitation and notification emails',
              requiredEnvVar: 'RESEND_API_KEY',
              resumeOnIntegration: 'resend',
              userAction: 'Paste your Resend API key (re_...) in the chat',
            },
            status: 'blocked',
          }
        ),
        node('function.trial_ending',    'Trial-ending reminder function', 'function', 5, ['schema.subscriptions']),
        node('function.member_invited',  'Member invite email function',   'function', 5, ['schema.workspace_members']),
      ],
    },
    {
      number: 6,
      name: 'Storage',
      description: 'File storage for workspace attachments and assets',
      nodes: [
        node('storage.attachments', 'Attachments bucket (private)', 'storage', 6, ['schema.workspaces']),
      ],
    },
    {
      number: 7,
      name: 'Verification',
      description: 'Post-build verification',
      nodes: [
        node('verification.auth',   'Auth verification',   'verification', 7, ['auth.jwt']),
        node('verification.apis',   'API verification',    'verification', 7, ['flow.workspace_ops']),
      ],
    },
  ]
}

// ── MARKETPLACE ───────────────────────────────────────────────────────────────

export function marketplacePhases(): BuildPhase[] {
  return [
    {
      number: 1,
      name: 'Core Schema',
      description: 'Marketplace data model: users, stores, listings, orders',
      nodes: [
        node('schema.users',       'Users table',       'schema', 1),
        node('schema.stores',      'Stores table',      'schema', 1, ['schema.users']),
        node('schema.listings',    'Listings table',    'schema', 1, ['schema.stores']),
        node('schema.orders',      'Orders table',      'schema', 1, ['schema.users', 'schema.listings']),
        node('schema.order_items', 'Order items table', 'schema', 1, ['schema.orders', 'schema.listings']),
        node('schema.reviews',     'Reviews table',     'schema', 1, ['schema.orders', 'schema.users']),
        node('schema.messages',    'Messages table',    'schema', 1, ['schema.users', 'schema.stores']),
        node('schema.disputes',    'Disputes table',    'schema', 1, ['schema.orders']),
      ],
    },
    {
      number: 2,
      name: 'Auth + Roles',
      description: 'Seller / Customer / Admin roles with workspace-scoped RLS',
      nodes: [
        node('auth.jwt',           'JWT authentication',             'auth',        2, ['schema.users']),
        node('permissions.roles',  'Seller/Customer/Admin roles',    'permissions', 2, ['schema.users']),
        node('permissions.rls',    'Store-scoped RLS',               'permissions', 2, ['permissions.roles']),
      ],
    },
    {
      number: 3,
      name: 'Business Flows',
      description: 'Listing management, order processing, messaging',
      nodes: [
        node('flow.store_management',   'Store CRUD endpoints',    'flow', 3, ['schema.stores', 'auth.jwt']),
        node('flow.listing_management', 'Listing CRUD endpoints',  'flow', 3, ['schema.listings', 'auth.jwt']),
        node('flow.order_processing',   'Order checkout + status', 'flow', 3, ['schema.orders', 'auth.jwt']),
        node('flow.messaging',          'In-app messaging',        'flow', 3, ['schema.messages', 'auth.jwt']),
        node('flow.reviews',            'Review submission',       'flow', 3, ['schema.reviews', 'auth.jwt']),
      ],
    },
    {
      number: 4,
      name: 'Payments',
      description: 'Stripe marketplace payments with connect (requires credentials)',
      nodes: [
        node(
          'integration.stripe.checkout',
          'Stripe marketplace checkout',
          'integration',
          4,
          ['schema.orders', 'flow.order_processing'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Stripe secret key required for marketplace payment processing',
              requiredEnvVar: 'STRIPE_SECRET_KEY',
              resumeOnIntegration: 'stripe',
              userAction: 'Paste your Stripe secret key (sk_live_... or sk_test_...) in the chat',
            },
            status: 'blocked',
          }
        ),
        node(
          'integration.stripe.webhook',
          'Stripe payment webhook',
          'integration',
          4,
          ['integration.stripe.checkout'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Webhook for payment events and payout notifications',
              requiredEnvVar: 'STRIPE_WEBHOOK_SECRET',
              resumeOnIntegration: 'stripe_webhook',
              userAction: 'Paste your Stripe webhook signing secret',
            },
            status: 'blocked',
          }
        ),
      ],
    },
    {
      number: 5,
      name: 'Notifications',
      description: 'Seller and buyer notifications',
      nodes: [
        node(
          'integration.resend.email',
          'Marketplace email notifications',
          'integration',
          5,
          ['schema.orders'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Resend API key required to send order and message notifications',
              requiredEnvVar: 'RESEND_API_KEY',
              resumeOnIntegration: 'resend',
              userAction: 'Paste your Resend API key (re_...) in the chat',
            },
            status: 'blocked',
          }
        ),
        node('function.on_order_created',  'Order created notification',    'function', 5, ['schema.orders']),
        node('function.on_message',        'New message notification',       'function', 5, ['schema.messages']),
      ],
    },
    {
      number: 6,
      name: 'Dispute + Refund Flows',
      description: 'Dispute creation, admin resolution, refund processing',
      nodes: [
        node('flow.dispute_management', 'Dispute/refund endpoints', 'flow', 6, ['schema.disputes', 'auth.jwt']),
        node('function.refund_issued',  'Refund issued function',   'function', 6, ['schema.disputes']),
      ],
    },
    {
      number: 7,
      name: 'Storage',
      description: 'Product and store media storage',
      nodes: [
        node('storage.product_images', 'Product images bucket (public)',  'storage', 7, ['schema.listings']),
        node('storage.store_banners',  'Store banners bucket (public)',   'storage', 7, ['schema.stores']),
      ],
    },
    {
      number: 8,
      name: 'Verification',
      description: 'Post-build verification',
      nodes: [
        node('verification.auth',  'Auth verification',  'verification', 8, ['auth.jwt']),
        node('verification.apis',  'API verification',   'verification', 8, ['flow.store_management']),
      ],
    },
  ]
}

// ── GENERIC ───────────────────────────────────────────────────────────────────

/**
 * Generic phases for unknown domains.
 * The domain-compiler customizes these with actual tables from the prompt.
 */
export function genericPhases(tables: string[]): BuildPhase[] {
  const tableNodes: BuildNode[] = tables.map(t =>
    node(`schema.${t}`, `${t} table`, 'schema', 1)
  )

  // Add dependencies for common patterns (users first)
  if (tableNodes.length > 1) {
    const userNode = tableNodes.find(n => n.id === 'schema.users')
    if (userNode) {
      for (const n of tableNodes) {
        if (n.id !== 'schema.users' && !n.dependencies.includes('schema.users')) {
          // Don't auto-add — let domain-compiler handle deps
        }
      }
    }
  }

  return [
    {
      number: 1,
      name: 'Core Schema',
      nodes: tableNodes,
    },
    {
      number: 2,
      name: 'Auth',
      nodes: [
        node('auth.jwt', 'JWT authentication', 'auth', 2,
          tableNodes.some(n => n.id === 'schema.users') ? ['schema.users'] : []
        ),
      ],
    },
    {
      number: 3,
      name: 'API Layer',
      nodes: tables.map(t =>
        node(
          `flow.${t}_apis`,
          `${t} REST endpoints`,
          'flow',
          3,
          [`schema.${t}`, 'auth.jwt'],
          { executionParams: { tableName: t } }
        )
      ),
    },
    {
      number: 4,
      name: 'Verification',
      nodes: [
        node('verification.auth', 'Auth verification', 'verification', 4, ['auth.jwt']),
        node('verification.apis', 'API verification',  'verification', 4, [`flow.${tables[0]}_apis`]),
      ],
    },
  ]
}

// ── AI-SAAS ───────────────────────────────────────────────────────────────────

/**
 * AI SaaS — platforms built around AI generation (video, image, text) with
 * async job queues and a credit/wallet system.
 * Directly addresses #46 (generation_jobs, credit_wallets table purposes)
 * and #47 (job status state machine).
 */
export function aiSaasPhases(): BuildPhase[] {
  return [
    {
      number: 1,
      name: 'Core Schema',
      description: 'AI SaaS data model: users, credit wallets, job queue, transactions',
      nodes: [
        node('schema.users',               'Users table',                'schema', 1),
        node('schema.credit_wallets',      'Credit wallets table',       'schema', 1, ['schema.users']),
        node('schema.generation_jobs',     'Generation jobs table',      'schema', 1, ['schema.users']),
        node('schema.credit_transactions', 'Credit transactions table',  'schema', 1, ['schema.users', 'schema.credit_wallets']),
      ],
    },
    {
      number: 2,
      name: 'Auth + Roles',
      description: 'JWT authentication with user-scoped data isolation',
      nodes: [
        node('auth.jwt',          'JWT authentication',          'auth',        2, ['schema.users']),
        node('permissions.rls',   'User-scoped RLS policies',    'permissions', 2, ['auth.jwt', 'schema.generation_jobs']),
      ],
    },
    {
      number: 3,
      name: 'Job Queue State Machine',
      description: 'Credit-gated job submission and status transition endpoints',
      nodes: [
        node(
          'flow.job_submit',
          'Job submit endpoint (credit check + atomic reserve)',
          'flow',
          3,
          ['schema.generation_jobs', 'schema.credit_wallets', 'auth.jwt'],
          {
            executionParams: {
              description:
                'POST /generation-jobs/submit — (1) SELECT FOR UPDATE on credit_wallets WHERE user_id=$1, ' +
                '(2) if (balance-reserved) < cost → 402 { error, available, required }, ' +
                '(3) UPDATE credit_wallets SET reserved = reserved + cost, ' +
                '(4) INSERT INTO generation_jobs (user_id, status, cost, payload) VALUES ($1, \'queued\', $2, $3), ' +
                '(5) return { jobId, status: \'queued\' }',
            },
          }
        ),
        node(
          'flow.job_status',
          'Job status endpoint (GET /:id/status)',
          'flow',
          3,
          ['schema.generation_jobs', 'auth.jwt'],
          {
            executionParams: {
              description: 'GET /generation-jobs/:id/status — return { id, status, progress_pct, result_url, error_message }. If status=processing, poll provider for updates.',
            },
          }
        ),
        node(
          'flow.job_cancel',
          'Job cancel endpoint (POST /:id/cancel)',
          'flow',
          3,
          ['schema.generation_jobs', 'schema.credit_wallets', 'auth.jwt'],
          {
            executionParams: {
              description: 'POST /generation-jobs/:id/cancel — only when status IN (queued, processing). Release reserved credits: UPDATE credit_wallets SET reserved = reserved - job.cost. Set status=cancelled.',
            },
          }
        ),
        node(
          'flow.job_retry',
          'Job retry endpoint (POST /:id/retry)',
          'flow',
          3,
          ['schema.generation_jobs', 'schema.credit_wallets', 'auth.jwt'],
          {
            executionParams: {
              description: 'POST /generation-jobs/:id/retry — only when status=failed. Increment attempts (reject if >= max_attempts). Re-reserve credits. Reset status to queued.',
            },
          }
        ),
        node(
          'flow.credits',
          'Credit balance + purchase endpoints',
          'flow',
          3,
          ['schema.credit_wallets', 'auth.jwt'],
          {
            executionParams: {
              description:
                'GET /credits/balance → { balance, reserved, available: balance-reserved, lifetime_purchased }. ' +
                'POST /credits/purchase → create Stripe PaymentIntent, on success: UPDATE credit_wallets SET balance = balance + amount; INSERT credit_transactions.',
            },
          }
        ),
      ],
    },
    {
      number: 4,
      name: 'AI Provider Integration',
      description: 'External AI generation provider (requires API key)',
      nodes: [
        node(
          'integration.ai_provider',
          'AI generation provider',
          'integration',
          4,
          ['flow.job_submit'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'AI provider API key required to submit generation requests',
              requiredEnvVar: 'AI_PROVIDER_API_KEY',
              resumeOnIntegration: 'ai_provider',
              userAction: 'Paste your AI provider API key (Runway, Stability AI, OpenAI, etc.) in the chat',
            },
            status: 'blocked',
          }
        ),
        node(
          'integration.stripe.credits',
          'Stripe credit purchase',
          'integration',
          4,
          ['flow.credits'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Stripe secret key required for credit purchase payments',
              requiredEnvVar: 'STRIPE_SECRET_KEY',
              resumeOnIntegration: 'stripe',
              userAction: 'Paste your Stripe secret key (sk_live_... or sk_test_...) in the chat',
            },
            status: 'blocked',
          }
        ),
      ],
    },
    {
      number: 5,
      name: 'Storage',
      description: 'Storage buckets for generated assets',
      nodes: [
        node('storage.outputs',       'Generated outputs bucket (private)',  'storage', 5, ['flow.job_submit']),
        node('storage.thumbnails',    'Thumbnails bucket (public)',          'storage', 5),
        node('storage.source_assets', 'Source assets bucket (private)',      'storage', 5),
      ],
    },
    {
      number: 6,
      name: 'Notifications + Admin',
      description: 'Job completion notifications and admin endpoints',
      nodes: [
        node(
          'integration.resend.email',
          'Job completion email notifications',
          'integration',
          6,
          ['schema.generation_jobs'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Resend API key required to email users when jobs complete or fail',
              requiredEnvVar: 'RESEND_API_KEY',
              resumeOnIntegration: 'resend',
              userAction: 'Paste your Resend API key (re_...) in the chat',
            },
            status: 'blocked',
          }
        ),
        node('flow.admin', 'Admin endpoints (users, stats, payments)', 'flow', 6, ['auth.jwt']),
      ],
    },
    {
      number: 7,
      name: 'Verification',
      description: 'Post-build verification against real state',
      nodes: [
        node('verification.auth', 'Auth verification',       'verification', 7, ['auth.jwt']),
        node('verification.apis', 'Job API verification',    'verification', 7, ['flow.job_submit']),
        node('verification.rls',  'Credit wallet RLS check', 'verification', 7, ['permissions.rls']),
      ],
    },
  ]
}

// ── SOCIAL ────────────────────────────────────────────────────────────────────

/**
 * Social media / community platform — users, posts, comments, likes, follows.
 */
export function socialPhases(): BuildPhase[] {
  return [
    {
      number: 1,
      name: 'Core Schema',
      description: 'Social platform data model: users, content, interactions',
      nodes: [
        node('schema.users',         'Users table',         'schema', 1),
        node('schema.profiles',      'Profiles table',      'schema', 1, ['schema.users']),
        node('schema.posts',         'Posts table',         'schema', 1, ['schema.users']),
        node('schema.comments',      'Comments table',      'schema', 1, ['schema.posts', 'schema.users']),
        node('schema.likes',         'Likes table',         'schema', 1, ['schema.posts', 'schema.users']),
        node('schema.follows',       'Follows table',       'schema', 1, ['schema.users']),
        node('schema.notifications', 'Notifications table', 'schema', 1, ['schema.users']),
      ],
    },
    {
      number: 2,
      name: 'Auth + Roles',
      description: 'JWT authentication with user + moderator roles',
      nodes: [
        node('auth.jwt',          'JWT authentication',      'auth',        2, ['schema.users']),
        node('permissions.roles', 'User/Moderator/Admin roles','permissions', 2, ['schema.users']),
        node('permissions.rls',   'Author-scoped RLS',       'permissions', 2, ['permissions.roles']),
      ],
    },
    {
      number: 3,
      name: 'Social Business Flows',
      description: 'Action-based endpoints for social interactions',
      nodes: [
        node('flow.posts',    'Posts CRUD + publish/archive endpoints', 'flow', 3, ['schema.posts',    'auth.jwt']),
        node('flow.comments', 'Comment thread endpoints',               'flow', 3, ['schema.comments', 'auth.jwt']),
        node('flow.likes',    'Like/unlike action endpoints',           'flow', 3, ['schema.likes',    'auth.jwt']),
        node('flow.follows',  'Follow/unfollow action endpoints',       'flow', 3, ['schema.follows',  'auth.jwt']),
        node('flow.feed',     'Personalized feed endpoint',             'flow', 3, ['schema.posts', 'schema.follows', 'auth.jwt']),
      ],
    },
    {
      number: 4,
      name: 'Realtime',
      description: 'Live notifications and feed updates',
      nodes: [
        node('realtime.notifications', 'Realtime notification stream', 'realtime', 4, ['schema.notifications', 'auth.jwt']),
        node('realtime.feed',          'Realtime feed updates',        'realtime', 4, ['schema.posts', 'auth.jwt']),
      ],
    },
    {
      number: 5,
      name: 'Notifications',
      description: 'Email notifications for social events',
      nodes: [
        node(
          'integration.resend.email',
          'Social email notifications',
          'integration',
          5,
          ['schema.notifications'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Resend API key required to send notification emails',
              requiredEnvVar: 'RESEND_API_KEY',
              resumeOnIntegration: 'resend',
              userAction: 'Paste your Resend API key (re_...) in the chat',
            },
            status: 'blocked',
          }
        ),
        node('function.on_follow',   'New follower notification function', 'function', 5, ['schema.follows']),
        node('function.on_like',     'Post liked notification function',   'function', 5, ['schema.likes']),
        node('function.on_comment',  'New comment notification function',  'function', 5, ['schema.comments']),
      ],
    },
    {
      number: 6,
      name: 'Storage',
      description: 'Media storage for posts and user profiles',
      nodes: [
        node('storage.post_media',      'Post media bucket (public)',     'storage', 6, ['schema.posts']),
        node('storage.profile_images',  'Profile images bucket (public)', 'storage', 6, ['schema.profiles']),
      ],
    },
    {
      number: 7,
      name: 'Verification',
      description: 'Post-build verification',
      nodes: [
        node('verification.auth', 'Auth verification', 'verification', 7, ['auth.jwt']),
        node('verification.apis', 'API verification',  'verification', 7, ['flow.posts']),
      ],
    },
  ]
}

// ── FINTECH ───────────────────────────────────────────────────────────────────

/**
 * Fintech — financial services, wallets, transactions, payments processing.
 */
export function fintechPhases(): BuildPhase[] {
  return [
    {
      number: 1,
      name: 'Core Schema',
      description: 'Financial data model: accounts, transactions, ledger',
      nodes: [
        node('schema.users',           'Users table',           'schema', 1),
        node('schema.accounts',        'Accounts table',        'schema', 1, ['schema.users']),
        node('schema.transactions',    'Transactions table',    'schema', 1, ['schema.accounts']),
        node('schema.payment_methods', 'Payment methods table', 'schema', 1, ['schema.users']),
        node('schema.beneficiaries',   'Beneficiaries table',   'schema', 1, ['schema.users']),
      ],
    },
    {
      number: 2,
      name: 'Auth + Compliance',
      description: 'Secure auth with account-scoped isolation',
      nodes: [
        node('auth.jwt',        'JWT authentication',         'auth',        2, ['schema.users']),
        node('permissions.rls', 'Account-owner-scoped RLS',   'permissions', 2, ['auth.jwt', 'schema.accounts']),
      ],
    },
    {
      number: 3,
      name: 'Financial Business Flows',
      description: 'Transfer, deposit, withdrawal, and balance endpoints',
      nodes: [
        node('flow.balance',    'Balance inquiry endpoint',    'flow', 3, ['schema.accounts',  'auth.jwt']),
        node('flow.transfer',   'Fund transfer endpoint',      'flow', 3, ['schema.accounts',  'schema.transactions', 'auth.jwt']),
        node('flow.deposit',    'Deposit endpoint',            'flow', 3, ['schema.accounts',  'schema.transactions', 'auth.jwt']),
        node('flow.withdrawal', 'Withdrawal endpoint',         'flow', 3, ['schema.accounts',  'schema.transactions', 'auth.jwt']),
        node('flow.history',    'Transaction history endpoint','flow', 3, ['schema.transactions','auth.jwt']),
      ],
    },
    {
      number: 4,
      name: 'Payment Processing',
      description: 'Stripe or provider integration (requires credentials)',
      nodes: [
        node(
          'integration.stripe.payments',
          'Stripe payment processing',
          'integration',
          4,
          ['flow.deposit', 'flow.transfer'],
          {
            optional: true,
            blockedReason: {
              type: 'missing_credential',
              description: 'Stripe secret key required for payment processing',
              requiredEnvVar: 'STRIPE_SECRET_KEY',
              resumeOnIntegration: 'stripe',
              userAction: 'Paste your Stripe secret key (sk_live_... or sk_test_...) in the chat',
            },
            status: 'blocked',
          }
        ),
      ],
    },
    {
      number: 5,
      name: 'Verification',
      description: 'Post-build verification',
      nodes: [
        node('verification.auth', 'Auth verification',    'verification', 5, ['auth.jwt']),
        node('verification.apis', 'Balance API check',    'verification', 5, ['flow.balance']),
        node('verification.rls',  'Account isolation RLS','verification', 5, ['permissions.rls']),
      ],
    },
  ]
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function phasesForDomain(domain: Domain, tables: string[] = []): BuildPhase[] {
  switch (domain) {
    case 'ecommerce':   return ecommercePhases()
    case 'saas':        return saasPhases()
    case 'marketplace': return marketplacePhases()
    case 'social':      return socialPhases()
    case 'ai-saas':     return aiSaasPhases()
    case 'fintech':     return fintechPhases()
    // New domains without dedicated templates fall back to generic for now.
    // The semantic enrichment in the system prompt provides domain-specific context.
    case 'media':
    case 'messaging':
    case 'gaming':
    case 'generic':
      return genericPhases(tables)
  }
}

// ── Domain detection ──────────────────────────────────────────────────────────

/**
 * Fast synchronous domain detection using pattern matching.
 * Handles the full extended Domain type including new domains.
 *
 * #50 partial fix: extended regex to handle semantic synonyms so "account",
 * "identity", "member" are not mistakenly treated as domain signals. The LLM
 * fallback (classifyDomainSemantically in semantic-domain-analyzer.ts) is used
 * by domain-compiler when this function returns 'generic'.
 */
export function detectDomain(prompt: string): Domain {
  const lower = prompt.toLowerCase()

  // ── AI-SaaS (must check before generic SaaS) ───────────────────────────────
  // Signals: generation jobs, credit systems, AI provider vocabulary
  if (/\b(generation[_\s]?jobs?|render[_\s]?jobs?|ai[_\s]?generation|text[_\s]?to[_\s]?(video|image|3d)|image[_\s]?generation|video[_\s]?generation|stable[_\s]?diffusion|runway|dall-?e|midjourney|sora|kling|pika)\b/.test(lower)) {
    return 'ai-saas'
  }
  if (/\b(credit[_\s]?wallet|credit[_\s]?balance|generate.*video|generate.*image|ai.*generate|generate.*ai)\b/.test(lower)) {
    return 'ai-saas'
  }
  // "credits" + job/generation context → ai-saas
  if (/\bcredits?\b/.test(lower) && /\b(generat|render|process|queue|job|task)\b/.test(lower)) {
    return 'ai-saas'
  }

  // ── Ecommerce ──────────────────────────────────────────────────────────────
  if (/\b(ecommerce|e-commerce|shopify|product\s+catalog|shopping\s+cart|storefront|online\s+shop|online\s+store)\b/.test(lower)) {
    return 'ecommerce'
  }
  if (/\b(shop|store)\b/.test(lower) && /\b(product|order|checkout|purchase|buy|sell|cart)\b/.test(lower)) {
    return 'ecommerce'
  }

  // ── Marketplace ────────────────────────────────────────────────────────────
  if (/\b(marketplace|listing|seller|buyer|vendor|two.sided|multi.vendor|auction|gig\s+economy|freelance\s+platform)\b/.test(lower)) {
    return 'marketplace'
  }

  // ── Fintech ────────────────────────────────────────────────────────────────
  if (/\b(fintech|banking|lending|borrow|loan|interest\s+rate|crypto|defi|trading|portfolio|investment|wealth\s+management|money\s+transfer|remittance|insurance\s+platform)\b/.test(lower)) {
    return 'fintech'
  }

  // ── Social ─────────────────────────────────────────────────────────────────
  // Social as PRIMARY use case — not just "social features"
  if (/\b(social\s+media|social\s+network|community\s+platform|forum\s+platform|reddit.like|twitter.like|instagram.like|tiktok.like|user\s+feed|activity\s+feed)\b/.test(lower)) {
    return 'social'
  }
  // Posts + likes/follows/comments as core (not secondary)
  if (/\b(posts?|articles?)\b/.test(lower) && /\b(likes?|follows?|comments?|reactions?)\b/.test(lower) && !/\b(saas|b2b|workspace|tenant)\b/.test(lower)) {
    return 'social'
  }

  // ── Media ──────────────────────────────────────────────────────────────────
  if (/\b(video\s+streaming|audio\s+streaming|podcast\s+platform|vod|live\s+streaming|media\s+platform|content\s+delivery|youtube.like|netflix.like|spotify.like)\b/.test(lower)) {
    return 'media'
  }

  // ── Messaging ─────────────────────────────────────────────────────────────
  if (/\b(chat\s+app|messaging\s+app|slack.like|discord.like|real.?time\s+chat|instant\s+messaging|direct\s+message|dm\s+platform|communication\s+platform)\b/.test(lower)) {
    return 'messaging'
  }

  // ── Gaming ────────────────────────────────────────────────────────────────
  if (/\b(game\s+backend|gaming\s+platform|leaderboard|player\s+progression|virtual\s+goods|in.game|guild|clan|quest|achievement|game\s+server)\b/.test(lower)) {
    return 'gaming'
  }

  // ── SaaS ──────────────────────────────────────────────────────────────────
  if (/\bsaas\b/.test(lower)) return 'saas'
  if (/\b(workspace|multi.tenant|organization\s+management|team\s+collaboration)\b/.test(lower)) return 'saas'
  if (/\b(subscription|plan|tier)\b/.test(lower) && /\b(workspace|team|tenant|org|member|invite)\b/.test(lower)) {
    return 'saas'
  }

  // ── Generic (LLM semantic fallback used by domain-compiler) ───────────────
  return 'generic'
}
