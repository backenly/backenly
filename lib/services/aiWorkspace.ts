import OpenAI from 'openai'
import { prisma } from '@/lib/db'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

export interface BackendChangePlan {
  id: string
  description: string
  changes: ChangeItem[]
  estimatedTime: string
  riskLevel: 'low' | 'medium' | 'high'
  createdAt: Date
  architecture?: {
    tier: string
    routeCount: number
    entityCount: number
    entities: string[]
    authStrategy: string
    domain: string | null
  }
}

export interface ChangeItem {
  type: 'endpoint' | 'migration' | 'index' | 'schema' | 'file' | 'config'
  action: 'create' | 'update' | 'delete'
  target: string
  description: string
  code?: string
  diff?: string
  dependencies?: string[]
}

export interface DiffPreview {
  file: string
  oldCode?: string
  newCode: string
  additions: number
  deletions: number
}

export interface ProjectContext {
  schema: {
    tables: Array<{
      name: string
      columns: Array<{ name: string; type: string; nullable: boolean }>
    }>
  }
  routes: Array<{
    method: string
    path: string
    description?: string
  }>
  indexes: Array<{
    table: string
    columns: string[]
  }>
  environment: string
}

/**
 * Fetch current project context (schema, routes, indexes)
 * Now includes ACTUAL workspace database tables, not just tracked ones
 */
export async function getProjectContext(projectId?: string): Promise<ProjectContext> {
  // Fetch database schema from ACTUAL workspace database
  const tables = await prisma.table.findMany({
    where: projectId ? { projectId } : undefined,
  })

  // Get workspace info to query actual database schema
  let schemaTables: Array<{ name: string; columns: Array<{ name: string; type: string; nullable: boolean }> }> = []
  
  if (projectId) {
    try {
      // Import workspace database utilities
      const { getWorkspaceDatabaseNames } = await import('./databaseProvisioning')
      const { HybridDatabase } = await import('../db/hybrid')
      
      const { postgresSchema } = getWorkspaceDatabaseNames(projectId)
      
      // Query ACTUAL tables from workspace schema
      const actualTables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = '${postgresSchema}' AND table_type = 'BASE TABLE' ORDER BY table_name`
      )
      
      // Fetch structure for each table
      schemaTables = await Promise.all(
        actualTables.map(async (table) => {
          try {
            const structure = await HybridDatabase.getStructure('postgresql', postgresSchema, table.table_name)
            return {
              name: table.table_name,
              columns: structure.map(col => ({
                name: col.name,
                type: col.type,
                nullable: col.nullable
              }))
            }
          } catch (error) {
            console.warn(`Failed to get structure for table ${table.table_name}:`, error)
            return {
              name: table.table_name,
              columns: []
            }
          }
        })
      )
      
      console.log(`[AI Context] Found ${schemaTables.length} tables in workspace schema ${postgresSchema}`)
      schemaTables.forEach(t => console.log(`  - ${t.name} (${t.columns.length} columns)`))
    } catch (error) {
      console.error('[AI Context] Failed to query workspace schema, falling back to tracked tables:', error)
      // Fallback to tracked tables only
      schemaTables = tables.map(table => ({
        name: table.name,
        columns: []
      }))
    }
  } else {
    // No projectId, use tracked tables
    schemaTables = tables.map(table => ({
      name: table.name,
      columns: []
    }))
  }

  // Fetch routes - these would come from workspace files or a routes registry
  // For now, return empty array
  const routes: Array<{ method: string; path: string; description?: string }> = []

  // Fetch indexes from database
  // In a real implementation, query the database for indexes
  const indexes: Array<{ table: string; columns: string[] }> = []

  // Get project environment
  const project = projectId
    ? await prisma.project.findUnique({ where: { id: projectId } })
    : null

  return {
    schema: {
      tables: schemaTables,
    },
    routes,
    indexes,
    environment: project?.environment || 'development',
  }
}

/**
 * Generate a demo backend change plan (without OpenAI)
 * Used when OPENAI_API_KEY is not configured
 */
export async function generateDemoBackendPlan(
  prompt: string,
  projectId?: string
): Promise<BackendChangePlan> {
  console.log('[DEMO MODE] Generating template backend plan for prompt:', prompt)
  
  // Analyze prompt to determine what to generate
  const isEcommerce = /e-?commerce|shop|store|product|cart|order/i.test(prompt)
  const isSocialMedia = /social|post|feed|comment|like|follow/i.test(prompt)
  const isAuth = /auth|login|sign.?up|register|user/i.test(prompt)
  
  let description = 'Backend API for: ' + prompt
  let changes: ChangeItem[] = []
  
  // Generate appropriate template based on prompt
  if (isEcommerce) {
    description = 'Complete e-commerce backend with products, cart, orders, and payments'
    changes = generateEcommerceTemplate()
  } else if (isSocialMedia) {
    description = 'Social media backend with posts, comments, likes, and follows'
    changes = generateSocialMediaTemplate()
  } else if (isAuth) {
    description = 'Authentication API with JWT tokens, user management'
    changes = generateAuthTemplate()
  } else {
    // Generic REST API template
    description = 'Generic REST API backend with CRUD operations'
    changes = generateGenericTemplate(prompt)
  }
  
  return {
    id: 'demo-plan-' + Date.now(),
    description,
    changes,
    estimatedTime: '10 minutes',
    riskLevel: 'low',
    createdAt: new Date(),
  }
}

function generateEcommerceTemplate(): ChangeItem[] {
  return [
    {
      type: 'file',
      action: 'create',
      target: 'package.json',
      description: 'Package configuration with dependencies',
      code: JSON.stringify({
        name: 'ecommerce-backend',
        version: '1.0.0',
        scripts: {
          dev: 'ts-node-dev --respawn src/server.ts',
          build: 'tsc',
          start: 'node dist/server.js'
        },
        dependencies: {
          express: '^4.18.2',
          '@prisma/client': '^5.0.0',
          zod: '^3.22.0',
          cors: '^2.8.5',
          dotenv: '^16.3.1'
        },
        devDependencies: {
          prisma: '^5.0.0',
          typescript: '^5.0.0',
          'ts-node-dev': '^2.0.0',
          '@types/express': '^4.17.21',
          '@types/node': '^20.10.0'
        }
      }, null, 2)
    },
    {
      type: 'file',
      action: 'create',
      target: 'src/server.ts',
      description: 'Main server file with Express setup',
      code: `import express from 'express';
import cors from 'cors';
import { router as productsRouter } from './routes/products';
import { router as ordersRouter } from './routes/orders';
import { router as healthRouter } from './routes/health';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/health', healthRouter);
app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
`
    },
    {
      type: 'file',
      action: 'create',
      target: 'routes/products.ts',
      description: 'Products API endpoints with CRUD operations',
      code: `import express, { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/db';

export const router = express.Router();

const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  price: z.number().positive(),
  stock: z.number().int().min(0),
  category: z.string().optional()
});

// GET /api/products - List all products
router.get('/', async (req: Request, res: Response) => {
  try {
    const products = await prisma.product.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.status(200).json({ data: products });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products - Create new product
router.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    }
    const product = await prisma.product.create({
      data: parsed.data
    });
    res.status(201).json({ data: product });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/:id - Get product by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: parseInt(req.params.id) }
    });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.status(200).json({ data: product });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
`
    },
    {
      type: 'file',
      action: 'create',
      target: 'routes/health.ts',
      description: 'Health check endpoint',
      code: `import express, { Request, Response } from 'express';

export const router = express.Router();

router.get('/', async (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});
`
    },
    {
      type: 'file',
      action: 'create',
      target: 'prisma/schema.prisma',
      description: 'Database schema with Product and Order models',
      code: `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Product {
  id          Int      @id @default(autoincrement())
  name        String
  description String?
  price       Float
  stock       Int      @default(0)
  category    String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model Order {
  id         Int      @id @default(autoincrement())
  userId     String
  total      Float
  status     String   @default("pending")
  items      Json
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}
`
    }
  ]
}

function generateSocialMediaTemplate(): ChangeItem[] {
  return [
    {
      type: 'file',
      action: 'create',
      target: 'package.json',
      description: 'Package configuration',
      code: JSON.stringify({
        name: 'social-media-backend',
        version: '1.0.0',
        scripts: { dev: 'ts-node-dev --respawn src/server.ts', build: 'tsc', start: 'node dist/server.js' },
        dependencies: { express: '^4.18.2', '@prisma/client': '^5.0.0', zod: '^3.22.0', cors: '^2.8.5' },
        devDependencies: { prisma: '^5.0.0', typescript: '^5.0.0', 'ts-node-dev': '^2.0.0', '@types/express': '^4.17.21' }
      }, null, 2)
    },
    {
      type: 'file',
      action: 'create',
      target: 'src/server.ts',
      description: 'Main server file',
      code: `import express from 'express';
import cors from 'cors';
import { router as postsRouter } from './routes/posts';
import { router as healthRouter } from './routes/health';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/health', healthRouter);
app.use('/api/posts', postsRouter);

app.listen(process.env.PORT || 3000);
`
    },
    {
      type: 'file',
      action: 'create',
      target: 'routes/posts.ts',
      description: 'Posts API with create, read, update, delete',
      code: `import express, { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/db';

export const router = express.Router();

router.get('/', async (req: Request, res: Response) => {
  const posts = await prisma.post.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ data: posts });
});

router.post('/', async (req: Request, res: Response) => {
  const post = await prisma.post.create({ data: req.body });
  res.status(201).json({ data: post });
});
`
    }
  ]
}

function generateAuthTemplate(): ChangeItem[] {
  return [
    {
      type: 'file',
      action: 'create',
      target: 'routes/auth.ts',
      description: 'Authentication endpoints with JWT',
      code: `import express, { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/db';

export const router = express.Router();

router.post('/register', async (req: Request, res: Response) => {
  const user = await prisma.user.create({ data: req.body });
  res.status(201).json({ data: user });
});

router.post('/login', async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: 'jwt-token-here', user });
});
`
    }
  ]
}

function generateGenericTemplate(prompt: string): ChangeItem[] {
  const resourceName = prompt.split(' ').find(w => w.length > 3) || 'items'
  return [
    {
      type: 'file',
      action: 'create',
      target: 'routes/' + resourceName + '.ts',
      description: 'REST API for ' + resourceName,
      code: `import express, { Request, Response } from 'express';
import prisma from '../lib/db';

export const router = express.Router();

router.get('/', async (req: Request, res: Response) => {
  res.json({ data: [] });
});
`
    }
  ]
}

/**
 * Domain-specific expansion hints for common app types
 */
const DOMAIN_HINTS: Record<string, string> = {
  saas: `
Domain Expectations for SAAS PLATFORMS (MANDATORY SUBSYSTEMS):

1️⃣ Identity & Auth (baseline):
- Users, Sessions, OAuth
- Password reset, Email verification
- Multi-factor auth (optional)

2️⃣ Organizations / Workspaces (THE SAAS DIFFERENTIATOR):
- Organizations/Teams table
- Organization members with roles
- Invites system (email invites, accept/decline)
- Role assignment per org (owner, admin, member)
- Ownership transfer
- Organization settings/preferences

3️⃣ Authorization (RBAC):
- Roles: owner, admin, member, viewer
- Permissions per resource
- Policy enforcement endpoints
- Role management APIs

4️⃣ Billing & Subscriptions (stub-ready, monetize when ready):
- Plans table (Free, Pro, Team, Enterprise)
- Subscriptions (orgId → planId)
- Status field (active | trial | disabled)
- Billing webhooks (Stripe/Paddle ready, but provider optional)
- Feature limits per plan
- Plan upgrade/downgrade

NOTE: Billing subsystem is REQUIRED, but payment provider integration is OPTIONAL.
Early-stage SaaS can use manual billing or trial-only mode.

5️⃣ Environment-aware Config:
- API keys per organization
- Rate limits
- Feature flags
- Environment separation (dev/staging/prod)

6️⃣ Audit & Activity Logs:
- Login events
- Billing changes (plan upgrades, cancellations)
- Role changes (member added/removed)
- Resource updates (who changed what, when)
- Security events

7️⃣ Admin & Internal APIs:
- Admin user management
- Plan enforcement
- Abuse control/moderation
- System metrics
- Support tools

8️⃣ Lifecycle & Compliance:
- Soft deletes (paranoid mode)
- Data export (GDPR)
- Account deletion workflow
- Data retention policies

CRITICAL: A SaaS backend without Organizations + Billing + Audit is just "an app with login".`,
  
  todo: `
Domain Expectations for TODO APPS:
- Organization: Lists/Projects, Labels/Tags, Priorities
- Collaboration: Sharing, Assignments, Comments
- Lifecycle: Archive, Soft delete, Restore, Activity log
- UX: Search, Filters (status, date, priority), Due date reminders, Bulk actions
- Analytics basics: Completion stats, Activity timeline`,
  
  ecommerce: `
Domain Expectations for ECOMMERCE:
- Catalog: Products, Categories, Variants, Inventory
- Shopping: Cart, Wishlist, Checkout flow
- Orders: Order management, Status tracking, Returns/Refunds
- Payments: Payment processing, Order history
- Admin: Product management, Order fulfillment, Inventory updates
- Customer: Reviews, Ratings, Order tracking
- Search: Product search, Filters (price, category, rating), Sort options`,
  
  social: `
Domain Expectations for SOCIAL MEDIA:
- Content: Posts, Comments, Replies, Media attachments
- Engagement: Likes, Reactions, Shares, Bookmarks
- Network: Follow/Unfollow, Friends, Followers/Following
- Discovery: Feed algorithm, Trending, Hashtags, Search
- Moderation: Report, Block, Hide, Content flags
- User: Profile, Settings, Activity history, Notifications`,
  
  blog: `
Domain Expectations for BLOG/CMS:
- Content: Posts, Pages, Categories, Tags
- Media: Image uploads, Media library, Attachments
- Publishing: Drafts, Publish, Schedule, Revisions
- Engagement: Comments, Likes, Shares
- SEO: Metadata, Slugs, Sitemap
- Admin: Content moderation, Analytics, User management`,
  
  booking: `
Domain Expectations for BOOKING/RESERVATION:
- Availability: Calendar, Time slots, Capacity
- Booking: Reservations, Cancellations, Rescheduling
- Resources: Rooms/Venues/Services, Resource management
- Customers: Customer info, Booking history, Preferences
- Notifications: Confirmations, Reminders, Updates
- Admin: Dashboard, Reports, Availability management`,
  
  marketplace: `
Domain Expectations for MARKETPLACE PLATFORMS:
- Multi-sided: Buyers, Sellers, Admin
- Listings: Products/Services, Categories, Search
- Transactions: Escrow, Payment splits, Disputes
- Trust: Reviews, Ratings, Verification badges
- Communication: Messaging, Notifications
- Commissions: Platform fees, Seller payouts
- Moderation: Listing approval, Content flags`,
  
  'internal-tool': `
Domain Expectations for INTERNAL TOOLS:
- Auth: SSO, LDAP/Active Directory
- Permissions: Role-based access, Department-based
- Workflows: Approval chains, Task assignments
- Audit: Full activity logs, Compliance reports
- Integration: REST APIs, Webhooks, Data imports
- Reporting: Dashboards, Exports, Scheduled reports`,
}

/**
 * Detect app domain from user prompt (with SaaS prioritization)
 */
function detectDomain(prompt: string): string | null {
  const lower = prompt.toLowerCase()
  
  // SaaS detection (HIGH PRIORITY - most common startup use case)
  if (lower.match(/\b(saas|subscription|b2b|startup|platform|workspace|tenant|org|organization|team|multi-tenant)\b/)) {
    return 'saas'
  }
  
  // Other domains
  if (lower.match(/\b(todo|task|checklist|reminder)\b/)) return 'todo'
  if (lower.match(/\b(ecommerce|shop|store|product|cart|checkout|order)\b/)) return 'ecommerce'
  if (lower.match(/\b(social|post|comment|follow|like|feed|timeline)\b/)) return 'social'
  if (lower.match(/\b(blog|cms|article|content|publish)\b/)) return 'blog'
  if (lower.match(/\b(booking|reservation|appointment|schedule|calendar)\b/)) return 'booking'
  if (lower.match(/\b(marketplace|seller|buyer|listing|vendor)\b/)) return 'marketplace'
  if (lower.match(/\b(internal|enterprise|admin-tool|dashboard)\b/)) return 'internal-tool'
  
  return null
}

/**
 * Validate architecture plan meets minimum quality standards
 */
function validateArchitecturePlan(architecture: any, retryCount: number = 0): {
  valid: boolean
  issues: string[]
  recommendations: string[]
} {
  const issues: string[] = []
  const recommendations: string[] = []
  
  // 1. Route count check (DOMAIN-AWARE)
  const routeCount = architecture.routes?.length || 0
  const domain = architecture.domain
  
  // 🔥 Domain-aware route limits
  let minRoutes = 18
  let maxRoutes = 30
  
  if (domain === 'saas') {
    minRoutes = 28 // SaaS needs 8 subsystems
    maxRoutes = 35 // More structure allowed
  }
  
  if (routeCount < minRoutes) {
    issues.push(`Only ${routeCount} routes planned (minimum: ${minRoutes} for ${domain || 'production-ready'})`)
    recommendations.push('Add search, filters, pagination, bulk operations, and lifecycle management')
    if (domain === 'saas') {
      recommendations.push('⚠️ SaaS backends require: Organizations, RBAC, Billing stub, Audit logs')
    }
  }
  
  // 2. Category coverage check (CRITICAL)
  const routes = architecture.routes || []
  const paths = routes.map((r: any) => r.path?.toLowerCase() || '')
  
  const categories = {
    core: paths.some(p => p.match(/\/(get|post|put|patch|delete)/)),
    auth: paths.some(p => p.includes('/auth')),
    search: paths.some(p => p.includes('search') || p.includes('filter')),
    bulk: paths.some(p => p.includes('bulk')),
    lifecycle: paths.some(p => p.match(/(archive|restore|soft-delete|trash)/)),
    profile: paths.some(p => p.includes('/me') || p.includes('/profile')),
    health: paths.some(p => p.includes('health') || p.includes('status')),
  }
  
  // 🔥 SaaS-specific validation (THE 8 MANDATORY SUBSYSTEMS)
  if (domain === 'saas') {
    const saasSubsystems = {
      organizations: paths.some(p => p.match(/(org|organization|workspace|team)(?!.*invite)/)),
      invites: paths.some(p => p.includes('invite')),
      roles: paths.some(p => p.includes('role') || p.includes('member') || p.includes('permission')),
      billing: paths.some(p => p.match(/(billing|subscription|plan|payment)/)),
      audit: paths.some(p => p.match(/(audit|activity|log|event)/)),
      apiKeys: paths.some(p => p.includes('api-key') || p.includes('apikey')),
      admin: paths.some(p => p.includes('admin') || p.includes('internal')),
    }
    
    if (!saasSubsystems.organizations) {
      issues.push('❌ CRITICAL: Missing Organizations/Workspaces - this is THE SaaS differentiator')
    }
    if (!saasSubsystems.roles) {
      issues.push('❌ Missing RBAC (roles, permissions) - required for multi-user SaaS')
    }
    if (!saasSubsystems.billing) {
      recommendations.push('💳 Add Billing subsystem (Plans + Subscriptions) - payment provider optional, monetize when ready')
    }
    if (!saasSubsystems.audit) {
      recommendations.push('Add audit logs for serious SaaS signal (login events, role changes)')
    }
    if (!saasSubsystems.invites) {
      recommendations.push('Add team invite system for organization collaboration')
    }
  }
  
  if (!categories.auth) {
    issues.push('Missing Auth endpoints (/auth/login, /auth/register, /auth/me)')
  }
  if (!categories.search) {
    issues.push('Missing Search/Filter capabilities')
    recommendations.push('Add /search endpoint or query parameters for filtering')
  }
  if (!categories.bulk && routeCount > 15) {
    recommendations.push('Consider bulk operations for better UX (/bulk endpoints)')
  }
  if (!categories.lifecycle && routeCount > 15) {
    recommendations.push('Add lifecycle management (archive/restore)')
  }
  if (!categories.profile) {
    issues.push('Missing user profile endpoint (/me or /profile)')
  }
  
  // 3. Entity coverage
  const entityCount = architecture.entities?.length || 0
  if (entityCount < 3) {
    issues.push(`Only ${entityCount} entities (minimum: 3 for production-ready)`)
    recommendations.push('Consider additional supporting entities')
  }
  
  // 4. Auth strategy check
  if (!architecture.authStrategy || architecture.authStrategy.toLowerCase().includes('none')) {
    issues.push('No authentication strategy defined')
  }
  
  // 5. Upper bound check (prevent overwhelming complexity) - DOMAIN-AWARE
  if (routeCount > maxRoutes) {
    if (domain === 'saas') {
      recommendations.push(`⚠️ Plan has ${routeCount} routes (SaaS sweet spot: 28-35)`)
      recommendations.push('SaaS backends need more structure, but keep it manageable')
    } else {
      recommendations.push(`⚠️ Plan has ${routeCount} routes (recommended: 18-30 for clarity)`)
      recommendations.push('Consider simplifying to focus on core features')
    }
  }
  
  const valid = issues.length === 0 && routeCount >= 18
  
  return { valid, issues, recommendations }
}

/**
 * Simplify over-complex architecture plans (domain-aware caps)
 */
function simplifyArchitecturePlan(architecture: any): any {
  const routes = [...(architecture.routes || [])]
  const domain = architecture.domain
  
  // Domain-aware target caps
  const targetRoutes = domain === 'saas' ? 35 : 30
  
  console.log(`[Plan Simplification] Reducing ${routes.length} routes to ${targetRoutes} (domain: ${domain || 'generic'})`)  
  console.log(`[Plan Simplification] SaaS backends need more structure - keeping comprehensive coverage`)
  
  // Prioritize routes by importance
  const priorityScore = (route: any) => {
    const path = route.path?.toLowerCase() || ''
    const method = route.method?.toUpperCase() || ''
    
    // Critical routes (keep always)
    if (path.includes('/auth')) return 100
    if (path.includes('/health')) return 100
    if (path.includes('/me') || path.includes('/profile')) return 95
    
    // Core CRUD
    if (method === 'GET' && !path.includes('/:id') && !path.includes('bulk')) return 90
    if (method === 'POST' && !path.includes('bulk')) return 85
    if (method === 'GET' && path.includes('/:id')) return 80
    if (method === 'PATCH' || method === 'PUT') return 75
    if (method === 'DELETE' && !path.includes('bulk')) return 70
    
    // Important features
    if (path.includes('search')) return 65
    if (path.includes('filter')) return 60
    
    // Nice-to-haves
    if (path.includes('bulk')) return 50
    if (path.includes('archive') || path.includes('restore')) return 45
    
    // Advanced features (can be cut)
    if (path.includes('export')) return 30
    if (path.includes('import')) return 30
    if (path.includes('analytics')) return 25
    if (path.includes('stats')) return 25
    if (path.includes('admin')) return 20
    
    return 40 // Default
  }
  
  // Sort by priority and take target routes (domain-aware)
  const sortedRoutes = routes
    .map(route => ({ route, priority: priorityScore(route) }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, targetRoutes)
    .map(item => item.route)
  
  console.log(`[Plan Simplification] Reduced to ${sortedRoutes.length} routes (removed ${routes.length - sortedRoutes.length})`)
  
  return {
    ...architecture,
    routes: sortedRoutes,
    tier: sortedRoutes.length >= 25 ? 'production-ready' : 'mvp',
  }
}

/**
 * Auto-expand weak architecture plans
 */
function expandArchitecturePlan(architecture: any): any {
  const routes = [...(architecture.routes || [])]
  const paths = new Set(routes.map((r: any) => r.path))
  
  // Add missing essentials
  const essentialRoutes = [
    { method: 'GET', path: '/health', description: 'Health check endpoint' },
    { method: 'GET', path: '/auth/me', description: 'Get current user profile' },
    { method: 'POST', path: '/auth/logout', description: 'Logout current user' },
  ]
  
  for (const route of essentialRoutes) {
    if (!paths.has(route.path)) {
      routes.push(route)
      console.log(`[Plan Expansion] Added missing: ${route.method} ${route.path}`)
    }
  }
  
  // Detect main entity from routes
  const mainEntity = detectMainEntity(routes)
  if (mainEntity) {
    // Add search if missing
    if (!paths.has(`/${mainEntity}/search`)) {
      routes.push({
        method: 'GET',
        path: `/${mainEntity}/search`,
        description: `Search ${mainEntity} with filters and pagination`
      })
      console.log(`[Plan Expansion] Added search: GET /${mainEntity}/search`)
    }
    
    // Add bulk operations if missing
    if (!paths.has(`/${mainEntity}/bulk`)) {
      routes.push(
        {
          method: 'POST',
          path: `/${mainEntity}/bulk`,
          description: `Bulk create ${mainEntity}`
        },
        {
          method: 'PATCH',
          path: `/${mainEntity}/bulk`,
          description: `Bulk update ${mainEntity}`
        },
        {
          method: 'DELETE',
          path: `/${mainEntity}/bulk`,
          description: `Bulk delete ${mainEntity}`
        }
      )
      console.log(`[Plan Expansion] Added bulk operations for ${mainEntity}`)
    }
    
    // Add archive/restore if missing
    if (!paths.has(`/${mainEntity}/:id/archive`)) {
      routes.push(
        {
          method: 'POST',
          path: `/${mainEntity}/:id/archive`,
          description: `Archive ${mainEntity}`
        },
        {
          method: 'POST',
          path: `/${mainEntity}/:id/restore`,
          description: `Restore archived ${mainEntity}`
        }
      )
      console.log(`[Plan Expansion] Added lifecycle management for ${mainEntity}`)
    }
  }
  
  return {
    ...architecture,
    routes,
    tier: routes.length >= 20 ? 'production-ready' : architecture.tier,
  }
}

function detectMainEntity(routes: any[]): string | null {
  const entityCounts: Record<string, number> = {}
  
  for (const route of routes) {
    const path = route.path?.toLowerCase() || ''
    const match = path.match(/^\/([a-z]+)/)
    if (match && match[1] !== 'auth' && match[1] !== 'health') {
      entityCounts[match[1]] = (entityCounts[match[1]] || 0) + 1
    }
  }
  
  let maxCount = 0
  let mainEntity: string | null = null
  for (const [entity, count] of Object.entries(entityCounts)) {
    if (count > maxCount) {
      maxCount = count
      mainEntity = entity
    }
  }
  
  return mainEntity
}

/**
 * STAGE 1: Generate Backend Architecture Plan (GPT-4o)
 * Creates a production-ready backend design with 20-30 routes
 */
async function generateBackendArchitecture(
  prompt: string,
  context: any
): Promise<{
  entities: string[]
  routes: { method: string; path: string; description: string }[]
  databaseSchema: string[]
  authStrategy: string
  tier: 'mvp' | 'production-ready' | 'enterprise'
  domain?: string | null
}> {
  // Detect domain and add expansion hints
  const domain = detectDomain(prompt)
  const domainHint = domain ? DOMAIN_HINTS[domain] : ''
  
  console.log('[Architecture] Detected domain:', domain || 'generic')
  if (domainHint) {
    console.log('[Architecture] Using domain-specific expansion hints')
  }

  const planningPrompt = `You are a Senior Backend Architect designing a PRODUCTION-READY backend system.

User Request: "${prompt}"
${domainHint}

Current Context:
- Existing tables: ${JSON.stringify(context.schema.tables, null, 2)}
- Existing routes: ${JSON.stringify(context.routes, null, 2)}

Your task is to design a COMPLETE, STARTUP-GRADE backend architecture. This should NOT be a toy/demo - it should be what a real startup would build.

BACKEND QUALITY TIERS:
- Toy (6-10 routes): Basic CRUD only
- MVP (10-15 routes): Core features + minimal support
- Production-Ready (20-30 routes): Core + UX + ops ✅ TARGET THIS
- Enterprise (40+ routes): Full-scale with advanced features

DEFAULT TARGET: Production-Ready (20-30 routes)

DESIGN PRINCIPLES:
1. Think like a startup backend engineer, not a tutorial writer
2. Include ALL features users expect (not just what they explicitly mention)
3. Add supporting APIs that make the core features actually usable
4. Include user experience APIs (search, filters, pagination, bulk actions)
5. Include operational APIs (status, health, analytics basics)

EXAMPLE - TODO APP:
❌ Basic (10 routes):
- POST /todos
- GET /todos
- PATCH /todos/:id
- DELETE /todos/:id
- POST /auth/login
- POST /auth/register

✅ Production-Ready (25 routes):
Core:
- POST /todos
- GET /todos (with filters, search, pagination)
- GET /todos/:id
- PATCH /todos/:id
- DELETE /todos/:id
- POST /todos/bulk (bulk create)
- PATCH /todos/bulk (bulk update)
- DELETE /todos/bulk (bulk delete)

Organization:
- GET /lists
- POST /lists
- GET /lists/:id/todos
- PATCH /lists/:id
- DELETE /lists/:id

Labels & Categories:
- GET /labels
- POST /labels
- PATCH /todos/:id/labels

User Experience:
- GET /todos/search
- GET /todos/due-today
- GET /todos/overdue
- POST /todos/:id/archive
- POST /todos/:id/restore

Sharing & Collaboration:
- POST /todos/:id/share
- GET /shared-todos
- PATCH /shared-todos/:id/permissions

Auth:
- POST /auth/register
- POST /auth/login
- POST /auth/logout
- GET /auth/me

Your response must be valid JSON:
{
  "entities": ["Todo", "List", "Label", "User"],
  "routes": [
    { "method": "POST", "path": "/todos", "description": "Create new todo" },
    { "method": "GET", "path": "/todos", "description": "List todos with filters, search, pagination" }
  ],
  "databaseSchema": ["Todo", "List", "Label", "User", "SharedTodo"],
  "authStrategy": "JWT with session refresh",
  "tier": "production-ready"
}`

  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: planningPrompt },
      { role: 'user', content: `Design architecture for: ${prompt}` },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  })

  const architecture = JSON.parse(completion.choices[0].message.content || '{}')
  console.log('[Architecture Plan] Tier:', architecture.tier)
  console.log('[Architecture Plan] Entities:', architecture.entities?.length)
  console.log('[Architecture Plan] Routes:', architecture.routes?.length)
  
  // 🔥 UPPER BOUND: Prevent overwhelming complexity (domain-aware)
  let finalArchitecture = { ...architecture, domain } // Add domain before validation
  
  // Domain-aware upper bounds
  const upperBound = domain === 'saas' ? 35 : 30
  
  if (architecture.routes?.length > upperBound) {
    console.warn(`⚠️  [Architecture] Plan has ${architecture.routes.length} routes (${domain === 'saas' ? 'SaaS' : 'standard'} cap: ${upperBound})`)
    if (domain === 'saas') {
      console.log('[Architecture] SaaS backends need more structure - simplifying while keeping comprehensive coverage...')
    } else {
      console.log('[Architecture] Simplifying to prevent overwhelming complexity...')
    }
    finalArchitecture = { ...simplifyArchitecturePlan(architecture), domain }
    console.log(`[Architecture] Simplified to ${finalArchitecture.routes?.length} routes`)
  }
  
  // 🔥 VALIDATE ARCHITECTURE PLAN (CRITICAL)
  const validation = validateArchitecturePlan(finalArchitecture)
  
  if (!validation.valid) {
    console.warn('⚠️  [Architecture] Plan validation failed:')
    validation.issues.forEach(issue => console.warn(`   - ${issue}`))
    
    // Auto-expand weak plans
    console.log('[Architecture] Auto-expanding plan...')
    const expandedArchitecture = expandArchitecturePlan(finalArchitecture)
    
    // Re-validate after expansion
    const revalidation = validateArchitecturePlan(expandedArchitecture)
    console.log(`[Architecture] After expansion: ${expandedArchitecture.routes?.length} routes`)
    
    if (revalidation.valid) {
      console.log('✅ [Architecture] Plan now meets quality standards')
      return { ...expandedArchitecture, domain }
    } else {
      console.warn('⚠️  [Architecture] Plan still weak after expansion, but proceeding...')
      revalidation.recommendations.forEach(rec => console.warn(`   Suggestion: ${rec}`))
      return { ...expandedArchitecture, domain }
    }
  }
  
  // Show recommendations even if valid
  if (validation.recommendations.length > 0) {
    console.log('💡 [Architecture] Recommendations:')
    validation.recommendations.forEach(rec => console.log(`   - ${rec}`))
  }
  
  console.log('✅ [Architecture] Plan meets quality standards')
  return { ...finalArchitecture, domain }
}

/**
 * Generate a backend change plan using OpenAI (2-STAGE APPROACH)
 */
export async function generateBackendChangePlan(
  prompt: string,
  projectId?: string
): Promise<BackendChangePlan> {
  const context = await getProjectContext(projectId)

  // 🔥 STAGE 1: Generate Architecture (GPT-4o)
  console.log('\n========== 🏛️ STAGE 1: ARCHITECTURE PLANNING ==========')  
  console.log('[STAGE 1] Generating production-ready architecture with GPT-4o...')
  const architecture = await generateBackendArchitecture(prompt, context)
  console.log(`[STAGE 1] ✅ Architecture complete: ${architecture.routes?.length || 0} routes planned`)
  console.log('====================================================\n')

  // 🔥 STAGE 2: Generate Code (GPT-4o-mini)
  console.log('\n========== 💻 STAGE 2: CODE GENERATION ==========')  
  console.log('[STAGE 2] Generating code with GPT-4o-mini...')
  
  const codeGenStartTime = Date.now()

  const systemPrompt = `You are an expert backend developer assistant. You've been given a PRODUCTION-READY architecture plan. Your job is to generate ALL the code to implement this plan.

Architecture Plan:
- Entities: ${JSON.stringify(architecture.entities)}
- Routes (${architecture.routes?.length || 0} total): ${JSON.stringify(architecture.routes, null, 2)}
- Database Schema: ${JSON.stringify(architecture.databaseSchema)}
- Auth Strategy: ${architecture.authStrategy}
- Target Tier: ${architecture.tier}

Current Project Context:
- Environment: ${context.environment}
- Database Tables: ${JSON.stringify(context.schema.tables, null, 2)}
- Existing Routes: ${JSON.stringify(context.routes, null, 2)}
- Database Indexes: ${JSON.stringify(context.indexes, null, 2)}

BIDIRECTIONAL DATABASE SYNC (CRITICAL - AUTOMATIC TABLE CREATION):
When analyzing the user's request, you MUST intelligently detect if the feature requires database tables that don't exist yet.

1. ANALYZE USER REQUEST FOR TABLE REQUIREMENTS:
   - If user mentions features like "add to cart", "shopping cart", "wishlist", "orders", "products", etc.
   - Check if the required tables exist in the "Database Tables" context above
   - If tables are MISSING, you MUST automatically create them

2. AUTO-CREATE MISSING TABLES:
   - Add a "schema" type change to create the Prisma schema for the missing table
   - Example: If user says "create add to cart feature" but no cart table exists:
     {
       "type": "schema",
       "action": "create",
       "target": "schema.prisma",
       "description": "Create Cart and CartItem models for add-to-cart functionality",
       "code": "model Cart { id Int @id @default(autoincrement()) userId Int createdAt DateTime @default(now()) items CartItem[] } model CartItem { id Int @id @default(autoincrement()) cartId Int productId Int quantity Int cart Cart @relation(fields: [cartId], references: [id]) }"
     }

3. AUTHENTICATION SPECIAL CASE (CRITICAL - AUTO-CREATE USER MODEL):
   - If user requests authentication features (login, signup, OAuth, JWT, session, etc.)
   - Check if User model exists in "Database Tables" context
   - If User model is MISSING, you MUST automatically create it with:
     * id (Int or String based on provider choice)
     * email (String, unique)
     * password (String, nullable for OAuth-only users)
     * name (String, optional)
     * emailVerified (Boolean, default false)
     * OAuth provider fields (githubId, googleId, etc. - based on what user requested)
     * createdAt, updatedAt timestamps
   - Example: User says "Add GitHub OAuth login"
     {
       "type": "schema",
       "action": "update",
       "target": "prisma/schema.prisma",
       "description": "Add User model with GitHub OAuth support",
       "code": "model User {\n  id            Int       @id @default(autoincrement())\n  email         String    @unique\n  name          String?\n  password      String?\n  githubId      String?   @unique\n  emailVerified Boolean   @default(false)\n  createdAt     DateTime  @default(now())\n  updatedAt     DateTime  @updatedAt\n}\n"
     }
   - ALWAYS include User model for auth requests - this is NOT optional

4. REFERENCE EXISTING TABLES:
   - If user says "use the orders table I created" or mentions an existing table name
   - Check the "Database Tables" context to confirm it exists
   - Generate API endpoints that work with that existing table structure
   - DO NOT recreate tables that already exist

5. SMART TABLE DETECTION:
   - For e-commerce: Detect needs for products, cart, orders, users, payments, reviews, etc.
   - For social media: Detect needs for posts, comments, likes, follows, users, etc.
   - For authentication: ALWAYS detect need for User model with appropriate OAuth fields
   - For SaaS: Detect needs for users, subscriptions, billing, features, etc.
   - For file uploads: ALWAYS detect need for storage buckets with appropriate naming
   - Always create ALL necessary tables for the complete feature

6. FILE STORAGE AUTO-BUCKET CREATION (CRITICAL - AI-DRIVEN STORAGE):
   - If user mentions file uploads, images, attachments, media, documents, or any file storage
   - Automatically create storage buckets without requiring manual bucket creation
   - Bucket naming convention: {entity}-{type} (e.g., "book-covers", "user-avatars", "product-images")
   - Add database field for file URL: {entity}ImageUrl String? or {entity}FileUrl String?
   - Generate complete file upload API with validation, storage handling, and URL generation
   - Example: User says "Add book cover image upload for books"
     {
       "type": "schema",
       "action": "update",
       "target": "prisma/schema.prisma",
       "description": "Add coverImageUrl field to Book model",
       "code": "model Book {\n  id Int @id @default(autoincrement())\n  title String\n  author String\n  coverImageUrl String?  // File storage URL\n  createdAt DateTime @default(now())\n}\n"
     },
     {
       "type": "endpoint",
       "action": "create",
       "target": "routes/books/upload-cover.ts",
       "description": "API endpoint for uploading book cover images",
       "code": "// Full Express.js implementation with multer, file validation, storage bucket creation, and URL generation"
     }
   - Always include:
     * Automatic bucket creation if it doesn't exist
     * File type validation (MIME types)
     * File size limits
     * Secure URL generation
     * Database record update with file URL
   - Users never need to manually create buckets or think about storage infrastructure

EXAMPLE SCENARIOS:

Scenario 1 - User creates table first, then requests API:
User: "I created an 'orders' table in the database. Now generate a complete CRUD API for it."
Database Tables Context: [{ name: "orders", columns: [...] }]
Your Response: Generate API endpoints that use the EXISTING orders table. DO NOT create a new schema.

Scenario 2 - User requests feature, table doesn't exist:
User: "Create an add-to-cart feature for my e-commerce website"
Database Tables Context: [{ name: "products" }, { name: "users" }]  (no cart table!)
Your Response: 
1. Create schema change for Cart and CartItem tables
2. Create API endpoints: POST /api/cart/add, GET /api/cart, DELETE /api/cart/items/:id
3. Include all necessary relationships and validations

Scenario 3 - Hybrid approach:
User: "Create order management with the products table I already have"
Database Tables Context: [{ name: "products", columns: [...] }]
Your Response:
1. Create schema for Orders and OrderItems tables (missing)
2. Create API endpoints that JOIN with existing products table
3. Use Prisma relations: orders -> orderItems -> products

This ensures SEAMLESS bidirectional sync between Database Management and Workspace AI!

CRITICAL REQUIREMENTS - WORKER COMPATIBILITY (MUST FOLLOW):
The generated code will run in an isolated worker environment. You MUST follow these constraints:

1. IMPORTS - ONLY USE THESE PATTERNS:
   - Use: import express, { Request, Response } from 'express' - Supported
   - Use: import prisma from '../../utils/db' or import prisma from '@/lib/prisma' - Supported (use relative paths like ../../utils/db or @/lib/prisma)
   - Use: import { z } from 'zod' - Supported (but see Zod limitations below)
   - Use: import { authenticate } from '@/middleware/auth' - Supported
   - DO NOT use: @prisma/client directly (use utils/db or lib/prisma instead)
   - DO NOT use: Complex Zod features like .refine(), .transform(), .pipe() (use basic validation only)
   - DO NOT use: External npm packages that aren't polyfilled

2. ZOD VALIDATION - USE ONLY THESE METHODS:
   - Use: z.string().min().max().email().optional()
   - Use: z.number().int().positive().min().max().optional()
   - Use: z.boolean().optional()
   - Use: z.array(z.string()).min(1) for non-empty arrays (NOT .nonempty() - that's deprecated)
   - Use: z.object({ ... }).parse() or .safeParse()
   - DO NOT use: .refine(), .transform(), .pipe(), .superRefine(), .or(), .and(), .nonempty() (use .min(1) instead)

3. PRISMA USAGE:
   - Always import from relative path: import prisma from '../../utils/db' or import prisma from '@/lib/prisma'
   - Use: prisma.modelName.findMany(), prisma.modelName.findUnique(), prisma.modelName.create(), prisma.modelName.update(), prisma.modelName.delete()
   - Use: include: { relation: true } for relations
   - Use: where: { field: value } for filtering
   - DO NOT use: @prisma/client import directly

4. EXPRESS.JS ROUTE HANDLER SIGNATURES:
   - Use: export const router = express.Router() - Create Express router
   - Use: router.get('/', async (req: Request, res: Response) => { ... }) - GET handler
   - Use: router.post('/', async (req: Request, res: Response) => { ... }) - POST handler
   - Use: router.put('/:id', async (req: Request, res: Response) => { ... }) - PUT handler
   - Use: router.delete('/:id', async (req: Request, res: Response) => { ... }) - DELETE handler
   - Use: router.patch('/:id', async (req: Request, res: Response) => { ... }) - PATCH handler
   - Access params: req.params.id, req.params.slug, etc.
   - Access query: req.query.page, req.query.search, etc.
   - Access body: req.body (ensure express.json() middleware is used)
   - Return responses: res.status(200).json({ data: ... }) or res.status(400).json({ error: ... })

5. ERROR HANDLING:
   - Always wrap Prisma operations in try-catch
   - Return proper error responses: res.status(400).json({ error: 'message' })
   - Handle validation errors from Zod: parsed.error.errors
   - Use Express error handling middleware pattern

6. CODE GENERATION RULES:
   - Generate REAL, COMPLETE, WORKING CODE - NO placeholders
   - Each API endpoint should be 50-150+ lines with full implementation
   - Include proper error handling, validation, and security measures
   - Use Prisma for database operations if tables exist
   - DO NOT use '@backenly/core' or any non-existent packages

7. CODE MUST BE COMPREHENSIVE: Each API endpoint should be 50-150+ lines with:
   - Complete validation schemas (Zod) with all field validations
   - Full error handling for all edge cases
   - Business logic implementation (not just CRUD)
   - Database transactions where needed
   - Proper logging and error messages
   - Type safety throughout
   - Multiple HTTP methods (GET, POST, PUT, DELETE, PATCH) when appropriate
   - Query parameter handling (pagination, filtering, sorting, search)
   - Relationship handling (includes, nested queries)
   - Input sanitization and security checks
8. For e-commerce or complex applications, generate a COMPLETE project structure including:
   - API routes organized by feature (products, orders, payments, auth, etc.)
   - Database schema with all necessary models and relationships
   - Middleware for authentication, validation, error handling
   - Utility functions and helpers
   - Type definitions
   - Configuration files
   - Proper folder structure (lib/, middleware/, utils/, types/, etc.)

PROJECT STRUCTURE GUIDELINES:
- Organize code in a scalable, maintainable structure
- Use lib/ for shared utilities, database client, etc.
- Use middleware/ for authentication, validation, rate limiting
- Use utils/ for helper functions
- Use types/ for TypeScript type definitions
- Group API routes by feature in routes/ folder (Express.js routes only - NO api/ folder)
- Include proper error handling utilities
- Add validation schemas (using Zod or similar)
- Include authentication middleware and JWT handling
- Add proper logging and monitoring hooks

DEPLOYMENT READINESS REQUIREMENTS (CRITICAL - MUST INCLUDE):
Every generated project MUST include these files for successful deployment:

1. package.json (REQUIRED):
   - Must include "scripts" section with:
     * "build": "tsc" or "tsc --build" for TypeScript compilation
     * "start": "node dist/server.js" or "node src/server.js" (Express.js server)
     * "dev": "ts-node-dev --respawn --transpile-only src/server.ts" or "nodemon src/server.ts"
   - Must list all dependencies (express, @prisma/client, zod, cors, etc.)
   - Must specify Node.js version (e.g., "engines": { "node": ">=18.0.0" })
   - Example structure:
     {
       "name": "project-name",
       "version": "1.0.0",
       "scripts": {
         "build": "tsc",
         "start": "node dist/server.js",
         "dev": "ts-node-dev --respawn --transpile-only src/server.ts",
         "prisma:generate": "prisma generate",
         "prisma:migrate": "prisma migrate deploy"
       },
       "dependencies": {
         "express": "^4.18.2",
         "@prisma/client": "^5.0.0",
         "zod": "^3.22.0",
         "cors": "^2.8.5",
         "dotenv": "^16.3.1"
       },
       "devDependencies": {
         "prisma": "^5.0.0",
         "typescript": "^5.0.0",
         "ts-node-dev": "^2.0.0",
         "@types/express": "^4.17.21",
         "@types/cors": "^2.8.17",
         "@types/node": "^20.10.0"
       },
       "engines": {
         "node": ">=18.0.0"
       }
     }

2. Main Server File (REQUIRED):
   - MUST create src/server.ts (or server.js) - Express.js application entry point
   - Must set up Express app, middleware (json, cors), routes, error handling
   - Must listen on PORT environment variable (default 3000)
   - Example structure:
     import express from 'express';
     import cors from 'cors';
     import { router as healthRouter } from './routes/health';
     import { router as apiRouter } from './routes';
     
     const app = express();
     const PORT = process.env.PORT || 3000;
     
     app.use(cors());
     app.use(express.json());
     app.use('/api/health', healthRouter);
     app.use('/api', apiRouter);
     
     app.listen(PORT, () => {
       console.log('Server running on port ' + PORT);
     });

3. Health Endpoint (REQUIRED):
   - MUST create routes/health.ts (or routes/health.js)
   - Must return 200 status with JSON: { "status": "ok", "timestamp": "..." }
   - Used by deployment platforms for health checks
   - Example:
     import express, { Request, Response } from 'express';
     export const router = express.Router();
     
     router.get('/', async (req: Request, res: Response) => {
       res.status(200).json({ 
         status: 'ok', 
         timestamp: new Date().toISOString() 
       });
     });

3. Environment Variables Documentation (REQUIRED):
   - Create .env.example file listing all required environment variables
   - Include DATABASE_URL, API keys, secrets, etc.
   - Document what each variable is for
   - Example:
     DATABASE_URL=postgresql://user:password@localhost:5432/dbname
     NODE_ENV=production
     JWT_SECRET=your-secret-key
     API_KEY=your-api-key

4. Prisma Setup (REQUIRED if using database):
   - prisma/schema.prisma with complete schema
   - Include generator and datasource blocks
   - For HYBRID DATABASE (PostgreSQL + MongoDB): Include BOTH datasources:
     * datasource postgres { provider = "postgresql" url = env("POSTGRES_URL") }
     * datasource mongodb { provider = "mongodb" url = env("MONGODB_URL") }
   - Models using PostgreSQL: Use standard Prisma types (Int, String, DateTime, etc.)
   - Models using MongoDB: Use String @id @default(auto()) @map("_id") @db.ObjectId for IDs, and include @@schema("mongodb") or use MongoDB-specific types
   - Example hybrid schema:
     datasource postgres { provider = "postgresql" url = env("POSTGRES_URL") }
     datasource mongodb { provider = "mongodb" url = env("MONGODB_URL") }
     
     model User {
       id    Int    @id @default(autoincrement())
       email String @unique
       // PostgreSQL model
     }
     
     model Analytics {
       id        String   @id @default(auto()) @map("_id") @db.ObjectId
       event     String
       timestamp DateTime @default(now())
       // MongoDB model - use @@schema("mongodb") or MongoDB datasource
     }
   - Add "prisma:generate" script to package.json
   - Add "prisma:migrate" script for migrations
   - Ensure DATABASE_URL (or POSTGRES_URL and MONGODB_URL) is in .env.example

5. Dockerfile (OPTIONAL but recommended):
   - Multi-stage build for production
   - Install dependencies, build TypeScript, and run
   - Example structure:
     FROM node:18-alpine AS builder
     WORKDIR /app
     COPY package*.json ./
     RUN npm ci
     COPY . .
     RUN npm run build
     FROM node:18-alpine AS runner
     WORKDIR /app
     COPY --from=builder /app/dist ./dist
     COPY --from=builder /app/node_modules ./node_modules
     COPY --from=builder /app/package.json ./
     COPY --from=builder /app/prisma ./prisma
     CMD ["npm", "start"]

6. Platform Manifests (OPTIONAL):
   - render.yaml for Render.com deployments
   - vercel.json for Vercel deployments
   - .github/workflows/deploy.yml for GitHub Actions

7. CORS Configuration (REQUIRED):
   - Configure CORS headers in middleware or API routes
   - Allow appropriate origins for preview/production
   - Include Access-Control-Allow-Origin, Access-Control-Allow-Methods, etc.

8. Build Output Configuration:
   - Ensure dist/ folder is in .gitignore (TypeScript build output)
   - Configure tsconfig.json with proper outDir (e.g., "outDir": "./dist")

9. TypeScript Configuration (if using TypeScript):
   - tsconfig.json with proper compiler options
   - Include type definitions

10. Tests (OPTIONAL but recommended):
    - Add test scripts to package.json
    - Include test files if applicable

IMPORTANT: When generating a new project, ALWAYS include these files in your changes array:
- type: "file", target: "package.json", action: "create"
- type: "file", target: "src/server.ts", action: "create" (Express.js main server file)
- type: "file", target: "routes/health.ts", action: "create" (Health check endpoint)
- type: "file", target: ".env.example", action: "create"
- type: "file", target: "prisma/schema.prisma", action: "create" (if using database)
- type: "file", target: "tsconfig.json", action: "create" (TypeScript configuration)
- type: "file", target: "Dockerfile", action: "create" (optional but recommended)

When generating a plan, you should:
1. Understand the user's intent from their natural language description
2. Identify ALL components needed for a production-ready backend:
   - Database models and relationships
   - API endpoints (CRUD + business logic)
   - Authentication and authorization
   - Validation schemas
   - Error handling utilities
   - Middleware functions
   - Type definitions
   - Configuration files
3. Consider dependencies between changes and generate them in the correct order
4. Suggest appropriate database indexes for performance
5. Generate ACTUAL, WORKING CODE (not placeholders) for ALL changes
6. For e-commerce: include products, categories, cart, orders, payments, users, reviews, inventory, shipping, etc.
7. Estimate the time and risk level

CODE LENGTH REQUIREMENTS:
- Simple utility files: 30-50+ lines
- Basic API endpoints: 50-100+ lines
- Complex API endpoints (with multiple methods, validation, business logic): 100-200+ lines
- Middleware files: 50-150+ lines
- Database schema files: 100-300+ lines (all models, relationships, indexes)
- Error handling utilities: 100-200+ lines
- Authentication utilities: 80-150+ lines

DO NOT generate minimal/skeleton code. Every file should be COMPLETE and PRODUCTION-READY with:
- Full implementations (not stubs)
- Comprehensive error handling
- Complete validation
- Business logic
- Proper TypeScript types
- Comments where helpful
- All edge cases handled

Return your response as a JSON object with this structure:
{
  "description": "A clear description of what will be changed",
  "changes": [
    {
      "type": "endpoint" | "migration" | "index" | "schema" | "file" | "config",
      "action": "create" | "update" | "delete",
      "target": "The target resource (e.g., '/api/todos', 'todos table', 'index_todos_title')",
      "description": "What this change does",
      "code": "COMPLETE, WORKING CODE - NO PLACEHOLDERS. For endpoints: full Express.js route file with express.Router(), Prisma queries, error handling, validation. For migrations: complete SQL DDL. For schema: complete Prisma model definitions. For server: complete Express.js server setup with middleware and route mounting.",
      "dependencies": ["List of other changes this depends on"]
    }
  ],
  "estimatedTime": "e.g., '15 minutes' or '1 hour'",
  "riskLevel": "low" | "medium" | "high"
}

EXAMPLE for a complete e-commerce backend structure:
When user requests "e-commerce API", generate ALL of these files:

1. Database Schema (schema.prisma):
   - User, Product, Category, Cart, CartItem, Order, OrderItem, Payment, Review, Address models
   - All relationships and indexes

2. API Routes (in routes/ folder):
   - routes/auth.ts - /api/auth/register, /api/auth/login, /api/auth/me
   - routes/products.ts - /api/products (GET, POST), /api/products/:id (GET, PUT, DELETE)
   - routes/categories.ts - /api/categories (GET, POST)
   - routes/cart.ts - /api/cart (GET, POST, DELETE), /api/cart/items/:id
   - routes/orders.ts - /api/orders (GET, POST), /api/orders/:id
   - routes/payments.ts - /api/payments (POST), /api/payments/:id
   - routes/reviews.ts - /api/reviews (GET, POST), /api/reviews/:id
   - routes/index.ts - Main router that combines all route modules

3. Middleware (middleware/ folder):
   - auth.ts - JWT authentication middleware
   - validate.ts - Request validation middleware
   - errorHandler.ts - Centralized error handling

4. Utilities (lib/ or utils/ folder):
   - db.ts or prisma.ts - Prisma client instance
   - jwt.ts - JWT token utilities
   - validation.ts - Zod schemas
   - errors.ts - Custom error classes

5. Types (types/ folder):
   - index.ts - TypeScript type definitions

EXAMPLE for COMPREHENSIVE API endpoint (/api/products):
This example shows what a FULL, PRODUCTION-READY endpoint should look like (100+ lines):

For /api/products endpoint (routes/products.ts), the code field should contain COMPLETE implementation with:
- Multiple Zod validation schemas (createProductSchema, updateProductSchema, querySchema)
- GET handler with: query parameter parsing (req.query), validation, advanced filtering (category, search, price range, stock status), sorting, pagination, parallel queries, comprehensive error handling
- POST handler with: body validation (req.body), business logic (SKU uniqueness check, category existence verification), database transactions, proper error handling for Prisma errors (P2002, P2003), Zod errors
- PUT/DELETE handlers for updating and deleting products
- All imports (express, Request, Response, prisma, z, Prisma types)
- Type safety throughout
- Proper logging
- Complete error messages
- Express router export: export const router = express.Router()

The code should be 100-200+ lines, NOT 20-30 lines. Include ALL business logic, validation, error handling, and edge cases.

IMPORTANT CODE GENERATION RULES:
- Generate REAL, COMPREHENSIVE code - NOT minimal/skeleton code
- Each API route file should be 50-150+ lines with FULL implementation
- Include ALL of these in every route file:
  * Complete Zod validation schemas with all field rules
  * Full error handling for all edge cases (Prisma errors, validation errors, etc.)
  * Business logic (not just basic CRUD - include checks, validations, transactions)
  * Query parameter parsing and validation (req.query for pagination, filtering, sorting, search)
  * Route parameters (req.params.id, req.params.slug, etc.)
  * Request body parsing (req.body)
  * Relationship handling (includes, nested queries, joins)
  * Proper logging and error messages
  * Type safety throughout (TypeScript types, Prisma types)
  * Multiple HTTP methods when appropriate (router.get, router.post, router.put, router.delete, router.patch)
  * Input sanitization and security checks
  * Database transactions for multi-step operations
- Use Express.js format for API routes (express.Router())
- Include proper imports (express, Request, Response from express)
- Use res.status(200).json(data) for responses, res.status(400).json({ error: ... }) for errors
- Use Prisma for database operations with proper error handling
- Generate COMPLETE project structures, not just basic CRUD
- Organize code in proper folders (routes/, lib/, middleware/, utils/, types/)
- Include authentication, validation, and error handling utilities
- NO '@backenly/core' or fake packages
- For e-commerce: generate ALL necessary files (products, orders, cart, payments, auth, etc.)
- Each file should be production-ready and comprehensive, not minimal examples
- Always export router: export const router = express.Router()

IMPORTANT: You MUST implement ALL ${architecture.routes?.length || 0} routes from the architecture plan. Do not skip any routes.`

  console.log('[AI Generation] Starting GPT-4o-mini code generation for ' + (architecture.routes?.length || 0) + ' routes...') 
  console.log('[AI Generation] User prompt: "' + prompt.substring(0, 100) + '..."')
  const startTime = Date.now()

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: systemPrompt },
        { 
          role: 'user', 
          content: `User request: "${prompt}"\n\nGenerate ALL code to implement the ${architecture.routes?.length || 0}-route architecture plan above. Include all database models, API routes, middleware, and utilities.` 
        },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }, {
      timeout: 180000, // 3 minutes timeout
    })

    const elapsed = Date.now() - startTime
    console.log('[STAGE 2] ✅ Code generation completed in ' + (elapsed / 1000).toFixed(2) + 's')
    console.log('[STAGE 2] Total time (both stages): ' + ((Date.now() - startTime) / 1000).toFixed(2) + 's')

    const responseText = completion.choices[0].message.content || '{}'
    const response = JSON.parse(responseText)

    // Log the raw response for debugging
    console.log('OpenAI Response:', JSON.stringify(response, null, 2))

    // Validate that changes have code
    const validatedChanges = (response.changes || []).map((change: any, index: number) => {
      if (!change.code || change.code.trim().length === 0) {
        console.error('[ERROR] Change ' + index + ' (' + change.target + ') has NO CODE!')
        console.error('   Change object:', JSON.stringify(change, null, 2))
      } else {
        console.log('[SUCCESS] Change ' + index + ' (' + change.target + ') has code (' + change.code.length + ' chars)')
        // Log first 200 chars of code to verify it's real
        console.log('   Code preview:', change.code.substring(0, 200))
      }
      // Ensure code is a string - DO NOT use empty string as fallback
      if (!change.code || change.code.trim().length === 0) {
        throw new Error('Change ' + index + ' (' + change.target + ') has no code. OpenAI must generate code for each change.')
      }
      return {
        ...change,
        code: change.code,
      }
    })

    // Validate code compatibility with worker
    const compatibilityValidatedChanges = validatedChanges.map((change: any) => {
      if (change.code && (change.type === 'endpoint' || change.type === 'file')) {
        const validation = validateCodeCompatibility(change.code)
        if (!validation.valid) {
          console.warn('[WARNING] Code compatibility issues in ' + change.target + ':', validation.issues)
          // Auto-fix common issues
          if (validation.fixes && validation.fixes.length > 0) {
            console.log('[AUTO-FIX] Fixing ' + validation.fixes.length + ' issues in ' + change.target)
            change.code = applyCodeFixes(change.code, validation.fixes)
          }
        }
      }
      return change
    })

    // Ensure deployment-ready files are included
    const deploymentFiles = ensureDeploymentFiles(compatibilityValidatedChanges, projectId)
    const allChanges = [...compatibilityValidatedChanges, ...deploymentFiles]

    // 🎉 Final Summary
    const codeGenTime = ((Date.now() - codeGenStartTime) / 1000).toFixed(2)
    console.log('\n========== ✅ GENERATION COMPLETE ==========')  
    console.log(`Architecture: ${architecture.tier} tier`)
    console.log(`Routes: ${architecture.routes?.length || 0} planned`)
    console.log(`Entities: ${architecture.entities?.length || 0} (${architecture.entities?.join(', ')})`)  
    console.log(`Generated: ${allChanges.length} files`)  
    console.log(`Auth: ${architecture.authStrategy}`)
    if (architecture.domain) {
      console.log(`Domain: ${architecture.domain}`)
    }
    console.log(`Code generation time: ${codeGenTime}s`)
    console.log('================================================\n')

    return {
      id: 'plan-' + Date.now(),
      description: response.description || prompt,
      changes: allChanges,
      estimatedTime: response.estimatedTime || 'Unknown',
      riskLevel: response.riskLevel || 'medium',
      createdAt: new Date(),
      // 🎉 NEW: Architecture transparency for UI
      architecture: {
        tier: architecture.tier,
        routeCount: architecture.routes?.length || 0,
        entityCount: architecture.entities?.length || 0,
        entities: architecture.entities || [],
        authStrategy: architecture.authStrategy,
        domain: detectDomain(prompt),
      },
    }
  } catch (error: any) {
    console.error('OpenAI API error:', error)
    throw new Error('Failed to generate plan: ' + error.message)
  }
}

/**
 * Validate code compatibility with worker environment
 */
function validateCodeCompatibility(code: string): {
  valid: boolean
  issues: string[]
  fixes: Array<{ pattern: RegExp; replacement: string; description: string }>
} {
  const issues: string[] = []
  const fixes: Array<{ pattern: RegExp; replacement: string; description: string }> = []

  // Check for unsupported imports
  if (code.includes("import { PrismaClient } from '@prisma/client'")) {
    issues.push("Direct @prisma/client import - should use utils/db or lib/prisma")
    fixes.push({
      pattern: /import\s+{\s*PrismaClient\s*}\s+from\s+['"]@prisma\/client['"]/g,
      replacement: "import prisma from '../../utils/db'",
      description: "Replace @prisma/client with utils/db import"
    })
  }

  if (code.includes("from '@prisma/client'") && !code.includes("//")) {
    issues.push("Direct @prisma/client import detected")
    fixes.push({
      pattern: /from\s+['"]@prisma\/client['"]/g,
      replacement: "from '../../utils/db'",
      description: "Replace @prisma/client with utils/db"
    })
  }

  // Check for unsupported Zod methods
  const unsupportedZodMethods = [
    '.refine(',
    '.transform(',
    '.pipe(',
    '.superRefine(',
    '.or(',
    '.and(',
  ]
  
  for (const method of unsupportedZodMethods) {
    if (code.includes(method)) {
      issues.push('Unsupported Zod method: ' + method)
    }
  }

  // Check for missing imports (common patterns)
  if (code.includes('createPostSchema') && !code.includes('import') && !code.includes('createPostSchema')) {
    // This is handled by ensuring imports exist
  }

  return {
    valid: issues.length === 0,
    issues,
    fixes,
  }
}

/**
 * Apply automatic code fixes
 */
function applyCodeFixes(code: string, fixes: Array<{ pattern: RegExp; replacement: string; description: string }>): string {
  let fixedCode = code
  for (const fix of fixes) {
    fixedCode = fixedCode.replace(fix.pattern, fix.replacement)
  }
  return fixedCode
}

/**
 * Ensure essential deployment files are included in the plan
 * This function adds missing deployment-critical files
 */
function ensureDeploymentFiles(
  existingChanges: ChangeItem[],
  projectId?: string
): ChangeItem[] {
  const requiredFiles: ChangeItem[] = []
  const existingTargets = new Set(existingChanges.map(c => c.target.toLowerCase()))

  // Check for package.json
  if (!existingTargets.has('package.json')) {
    requiredFiles.push({
      type: 'file',
      action: 'create',
      target: 'package.json',
      description: 'Package.json with build and start scripts for deployment',
      code: JSON.stringify({
        name: projectId || 'backenly-project',
        version: '1.0.0',
        private: true,
        scripts: {
          dev: 'next dev',
          build: 'next build',
          start: 'next start',
          'prisma:generate': 'prisma generate',
          'prisma:migrate': 'prisma migrate deploy',
        },
        dependencies: {
          next: '^14.0.0',
          react: '^18.0.0',
          'react-dom': '^18.0.0',
          '@prisma/client': '^5.0.0',
          zod: '^3.22.0',
        },
        devDependencies: {
          prisma: '^5.0.0',
          typescript: '^5.0.0',
          '@types/node': '^20.0.0',
          '@types/react': '^18.0.0',
          '@types/react-dom': '^18.0.0',
        },
        engines: {
          node: '>=18.0.0',
        },
      }, null, 2),
    })
  }

  // Check for health endpoint
  if (!existingTargets.has('/api/health') && !existingTargets.has('api/health')) {
    requiredFiles.push({
      type: 'endpoint',
      action: 'create',
      target: '/api/health',
      description: 'Health check endpoint for deployment platforms',
      code: `import express, { Request, Response } from 'express';

export const router = express.Router();

router.get('/', async (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});
`,
    })
  }

  // Check for .env.example
  if (!existingTargets.has('.env.example') && !existingTargets.has('env.example')) {
    requiredFiles.push({
      type: 'file',
      action: 'create',
      target: '.env.example',
      description: 'Environment variables template',
      code: `# Database
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# Environment
NODE_ENV=production

# JWT Secret (generate a secure random string)
JWT_SECRET=your-secret-key-here

# API Keys (add as needed)
# API_KEY=your-api-key-here
`,
    })
  }

  // Check for .gitignore
  if (!existingTargets.has('.gitignore')) {
    requiredFiles.push({
      type: 'file',
      action: 'create',
      target: '.gitignore',
      description: 'Git ignore file for build outputs and secrets',
      code: `# Dependencies
node_modules/
/.pnp
.pnp.js

# Testing
/coverage

# Next.js
/.next/
/out/
/build
dist/

# Production
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# Vercel
.vercel

# TypeScript
*.tsbuildinfo
next-env.d.ts

# Prisma
prisma/migrations/
`,
    })
  }

  // Check for tsconfig.json if TypeScript is used
  if (!existingTargets.has('tsconfig.json')) {
    requiredFiles.push({
      type: 'file',
      action: 'create',
      target: 'tsconfig.json',
      description: 'TypeScript configuration',
      code: JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          forceConsistentCasingInFileNames: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'preserve',
          incremental: true,
          plugins: [
            {
              name: 'next',
            },
          ],
          paths: {
            '@/*': ['./*'],
          },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      }, null, 2),
    })
  }

  // Check for utils/db.ts stub file (for TypeScript compatibility with worker polyfills)
  if (!existingTargets.has('utils/db.ts') && !existingTargets.has('utils/db')) {
    requiredFiles.push({
      type: 'file',
      action: 'create',
      target: 'utils/db.ts',
      description: 'Database client stub for TypeScript (runtime provided by worker polyfills)',
      code: `/**
 * Database client stub for TypeScript
 * 
 * This file provides type definitions for the Prisma client.
 * At runtime, the worker polyfills will provide the actual implementation.
 */

// Type definitions for Prisma client methods
type PrismaModel = {
  findMany: (args?: any) => Promise<any[]>;
  findUnique: (args: { where: Record<string, any> }) => Promise<any | null>;
  findFirst: (args?: any) => Promise<any | null>;
  create: (args: { data: any }) => Promise<any>;
  update: (args: { where: Record<string, any>; data: any }) => Promise<any>;
  delete: (args: { where: Record<string, any> }) => Promise<any>;
  count: (args?: any) => Promise<number>;
  upsert: (args: { where: Record<string, any>; create: any; update: any }) => Promise<any>;
};

type PrismaClient = {
  $transaction: (fn: (tx: any) => Promise<any>) => Promise<any>;
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  [key: string]: PrismaModel | any;
};

// Export a default Prisma client instance
// At runtime, this will be replaced by the worker's polyfill
const prisma: PrismaClient = {} as PrismaClient;

export default prisma;
`,
    })
  }

  // Check for lib/prisma.ts or lib/db.ts stub file (alternative import path)
  if (!existingTargets.has('lib/prisma.ts') && !existingTargets.has('lib/db.ts') && 
      !existingTargets.has('lib/prisma') && !existingTargets.has('lib/db')) {
    // Only create if routes are using @/lib/prisma or @/lib/db imports
    const hasLibImport = existingChanges.some(change => 
      change.code?.includes('@/lib/prisma') || change.code?.includes('@/lib/db')
    )
    if (hasLibImport) {
      requiredFiles.push({
        type: 'file',
        action: 'create',
        target: 'lib/db.ts',
        description: 'Database client stub for TypeScript (runtime provided by worker polyfills)',
        code: `/**
 * Database client stub for TypeScript
 * 
 * This file provides type definitions for the Prisma client.
 * At runtime, the worker polyfills will provide the actual implementation.
 */

// Type definitions for Prisma client methods
type PrismaModel = {
  findMany: (args?: any) => Promise<any[]>;
  findUnique: (args: { where: Record<string, any> }) => Promise<any | null>;
  findFirst: (args?: any) => Promise<any | null>;
  create: (args: { data: any }) => Promise<any>;
  update: (args: { where: Record<string, any>; data: any }) => Promise<any>;
  delete: (args: { where: Record<string, any> }) => Promise<any>;
  count: (args?: any) => Promise<number>;
  upsert: (args: { where: Record<string, any>; create: any; update: any }) => Promise<any>;
};

type PrismaClient = {
  $transaction: (fn: (tx: any) => Promise<any>) => Promise<any>;
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  [key: string]: PrismaModel | any;
};

// Export a default Prisma client instance
// At runtime, this will be replaced by the worker's polyfill
const prisma: PrismaClient = {} as PrismaClient;

export default prisma;
`,
      })
    }
  }

  return requiredFiles
}

/**
 * Generate diff previews for a change plan
 */
export async function generateDiffPreview(
  plan: BackendChangePlan,
  projectId?: string
): Promise<DiffPreview[]> {
  const context = await getProjectContext(projectId)
  const diffs: DiffPreview[] = []

  for (const change of plan.changes) {
    if (change.type === 'file' || change.type === 'endpoint') {
      // For file/endpoint changes, generate a diff
      const filePath = change.target.startsWith('/')
        ? 'app/api' + change.target.replace(/^\/api/, '') + '/route.ts'
        : change.target

      // In a real implementation, we'd read the existing file
      const oldCode = '' // Would read from filesystem
      const newCode = change.code || ''

      // Simple diff calculation (in production, use a proper diff library)
      const oldLines = oldCode.split('\n').length
      const newLines = newCode.split('\n').length
      const additions = Math.max(0, newLines - oldLines)
      const deletions = Math.max(0, oldLines - newLines)

      diffs.push({
        file: filePath,
        oldCode: oldCode || undefined,
        newCode,
        additions,
        deletions,
      })
    } else if (change.type === 'migration') {
      // For migrations, generate SQL diff
      diffs.push({
        file: 'prisma/migrations/' + change.target + '/migration.sql',
        oldCode: undefined,
        newCode: change.code || '',
        additions: (change.code || '').split('\n').length,
        deletions: 0,
      })
    }
  }

  return diffs
}

/**
 * Apply changes from a plan
 */
export async function applyChanges(
  planId: string,
  selectedChanges: string[], // IDs of changes to apply
  projectId?: string
): Promise<{ success: boolean; applied: string[]; errors: Array<{ change: string; error: string }> }> {
  const applied: string[] = []
  const errors: Array<{ change: string; error: string }> = []

  // Get the plan - in a real implementation, this would be stored in database
  // For now, we'll need to pass the plan itself
  // This function signature needs to be updated to accept the plan

  return {
    success: errors.length === 0,
    applied,
    errors,
  }
}

/**
 * Apply changes from a plan (with plan data)
 */
export async function applyChangesFromPlan(
  plan: BackendChangePlan,
  selectedChangeIndices: number[], // Indices of changes to apply
  projectId?: string
): Promise<{ success: boolean; applied: string[]; errors: Array<{ change: string; error: string }> }> {
  const applied: string[] = []
  const errors: Array<{ change: string; error: string }> = []
  const fs = await import('fs/promises')
  const path = await import('path')

  try {
    for (const index of selectedChangeIndices) {
      const change = plan.changes[index]
      if (!change) continue

      try {
        if (change.type === 'endpoint' || change.type === 'file') {
          // Determine file path - all files go into project-scoped workspace directory
          if (!projectId) {
            throw new Error('Project ID is required to apply changes')
          }
          
          let filePath: string
          const workspaceBase = path.join(process.cwd(), 'workspace', projectId)
          
          // Handle different file types and folder structures
          if (change.target.startsWith('/api/')) {
            // Express.js API route - create in workspace/{projectId}/routes directory
            // Convert /api/products/:id to routes/products.ts (Express.js format)
            const routePath = change.target.replace('/api/', '').replace(/\/$/, '')
            const parts = routePath.split('/').filter(p => p)
            
            if (parts.length > 0) {
              // Extract route name (first part) and handle dynamic params
              // /api/products/:id -> routes/products.ts (Express handles :id in code)
              // /api/users/:userId/posts -> routes/users.ts (or routes/users-posts.ts)
              const routeName = parts[0] // Use first segment as route name
              filePath = path.join(workspaceBase, 'routes', routeName + '.ts')
            } else {
              // Root /api route -> routes/index.ts
              filePath = path.join(workspaceBase, 'routes', 'index.ts')
            }
          } else if (change.target.startsWith('/lib/') || change.target.startsWith('lib/')) {
            // Library utilities - create in workspace/{projectId}/lib directory
            const libPath = change.target.replace(/^\/?lib\//, '').replace(/\/$/, '')
            const parts = libPath.split('/').filter(p => p)
            const fileName = parts.length > 0 ? parts[parts.length - 1] : 'index.ts'
            const dirParts = parts.length > 1 ? parts.slice(0, -1) : []
            const finalFileName = fileName.endsWith('.ts') || fileName.endsWith('.tsx') ? fileName : fileName + '.ts'
            filePath = path.join(workspaceBase, 'lib', ...dirParts, finalFileName)
          } else if (change.target.startsWith('/middleware/') || change.target.startsWith('middleware/')) {
            // Middleware - create in workspace/{projectId}/middleware directory
            const middlewarePath = change.target.replace(/^\/?middleware\//, '').replace(/\/$/, '')
            const parts = middlewarePath.split('/').filter(p => p)
            const fileName = parts.length > 0 ? parts[parts.length - 1] : 'index.ts'
            const dirParts = parts.length > 1 ? parts.slice(0, -1) : []
            const finalFileName = fileName.endsWith('.ts') || fileName.endsWith('.tsx') ? fileName : fileName + '.ts'
            filePath = path.join(workspaceBase, 'middleware', ...dirParts, finalFileName)
          } else if (change.target.startsWith('/utils/') || change.target.startsWith('utils/')) {
            // Utils - create in workspace/{projectId}/utils directory
            const utilsPath = change.target.replace(/^\/?utils\//, '').replace(/\/$/, '')
            const parts = utilsPath.split('/').filter(p => p)
            const fileName = parts.length > 0 ? parts[parts.length - 1] : 'index.ts'
            const dirParts = parts.length > 1 ? parts.slice(0, -1) : []
            const finalFileName = fileName.endsWith('.ts') || fileName.endsWith('.tsx') ? fileName : fileName + '.ts'
            filePath = path.join(workspaceBase, 'utils', ...dirParts, finalFileName)
          } else if (change.target.startsWith('/types/') || change.target.startsWith('types/')) {
            // Types - create in workspace/{projectId}/types directory
            const typesPath = change.target.replace(/^\/?types\//, '').replace(/\/$/, '')
            const parts = typesPath.split('/').filter(p => p)
            const fileName = parts.length > 0 ? parts[parts.length - 1] : 'index.ts'
            const dirParts = parts.length > 1 ? parts.slice(0, -1) : []
            const finalFileName = fileName.endsWith('.ts') || fileName.endsWith('.tsx') ? fileName : fileName + '.ts'
            filePath = path.join(workspaceBase, 'types', ...dirParts, finalFileName)
          } else if (change.target.startsWith('/config/') || change.target.startsWith('config/')) {
            // Config - create in workspace/{projectId}/config directory
            const configPath = change.target.replace(/^\/?config\//, '').replace(/\/$/, '')
            const parts = configPath.split('/').filter(p => p)
            const fileName = parts.length > 0 ? parts[parts.length - 1] : 'index.ts'
            const dirParts = parts.length > 1 ? parts.slice(0, -1) : []
            const finalFileName = fileName.endsWith('.ts') || fileName.endsWith('.tsx') || fileName.endsWith('.json') ? fileName : fileName + '.ts'
            filePath = path.join(workspaceBase, 'config', ...dirParts, finalFileName)
          } else if (change.target.startsWith('.') || change.target.includes('package.json') || change.target.includes('tsconfig.json')) {
            // Root-level config files (.env.example, .gitignore, package.json, tsconfig.json)
            filePath = path.join(workspaceBase, change.target)
          } else {
            // Other file path - try to preserve folder structure
            const targetPath = change.target.startsWith('/') ? change.target.slice(1) : change.target
            const parts = targetPath.split('/').filter(p => p)
            if (parts.length > 1) {
              // Has folder structure, preserve it
              filePath = path.join(workspaceBase, ...parts)
            } else {
              // Single file - put in workspace/{projectId} root
              const fileName = parts[0] || change.target
              filePath = path.join(workspaceBase, fileName)
            }
          }

          // Ensure directory exists
          const dir = path.dirname(filePath)
          await fs.mkdir(dir, { recursive: true })

          // Write file
          if (change.code) {
            await fs.writeFile(filePath, change.code, 'utf-8')
            applied.push(change.target)
            console.log('[SUCCESS] Applied: ' + change.type + ' ' + change.action + ' ' + change.target)
            console.log('   -> ' + filePath)
          } else {
            console.warn('[WARNING] No code for: ' + change.target)
            errors.push({
              change: change.target,
              error: 'No code provided in change',
            })
          }
        } else if (change.type === 'migration') {
          // Create migration file in project-scoped workspace
          if (!projectId) {
            throw new Error('Project ID is required to apply changes')
          }
          const workspaceBase = path.join(process.cwd(), 'workspace', projectId)
          const migrationDir = path.join(workspaceBase, 'migrations')
          await fs.mkdir(migrationDir, { recursive: true })
          
          const migrationName = 'migration_' + Date.now() + '.sql'
          const migrationPath = path.join(migrationDir, migrationName)
          
          if (change.code) {
            await fs.writeFile(migrationPath, change.code, 'utf-8')
            applied.push(change.target)
            console.log('[SUCCESS] Applied: ' + change.type + ' ' + change.action + ' ' + change.target)
            console.log('   -> ' + migrationPath)
          }
        } else if (change.type === 'schema') {
          // Create schema file in project-scoped workspace
          if (!projectId) {
            throw new Error('Project ID is required to apply changes')
          }
          const workspaceBase = path.join(process.cwd(), 'workspace', projectId)
          const schemaPath = path.join(workspaceBase, 'prisma', 'schema.prisma')
          
          // Ensure prisma directory exists
          await fs.mkdir(path.dirname(schemaPath), { recursive: true })
          
          if (change.code) {
            // Read existing if it exists, otherwise start fresh
            const existingSchema = await fs.readFile(schemaPath, 'utf-8').catch(() => '')
            const newSchema = existingSchema ? existingSchema + '\n\n' + change.code : change.code
            await fs.writeFile(schemaPath, newSchema, 'utf-8')
            applied.push(change.target)
            console.log('[SUCCESS] Applied: ' + change.type + ' ' + change.action + ' ' + change.target)
            console.log('   -> ' + schemaPath)
            
            // 🚀 AUTOMATIC DATABASE SETUP: After schema is written, automatically set up database
            try {
              const { setupWorkspaceDatabaseFromSchema } = await import('./workspaceDatabaseSetup')
              const { prisma } = await import('@/lib/db')
              
              // Get workspace for this project
              const workspace = await prisma.workspace.findFirst({
                where: { projectId },
                select: { id: true },
              })
              
              if (workspace) {
                console.log('[AUTO-SETUP] Automatically setting up database from schema...')
                const setupResult = await setupWorkspaceDatabaseFromSchema(
                  projectId,
                  workspace.id,
                  schemaPath
                )
                
                if (setupResult.success) {
                  console.log('[SUCCESS] Database setup complete!')
                  console.log('   PostgreSQL schema: ' + setupResult.postgresSchema)
                  console.log('   MongoDB database: ' + setupResult.mongodbDatabase)
                  console.log('   Tables created: ' + (setupResult.tablesCreated?.length || 0))
                  console.log('   Collections created: ' + (setupResult.collectionsCreated?.length || 0))
                } else {
                  console.warn('[WARNING] Database setup had issues: ' + setupResult.error)
                  // Don't fail the whole operation, just log the warning
                }
              } else {
                console.warn('[WARNING] No workspace found for project ' + projectId + ', skipping automatic database setup')
              }
            } catch (dbSetupError: any) {
              console.error('[ERROR] Error during automatic database setup:', dbSetupError)
              // Don't fail the whole operation, just log the error
              // The user can manually set up the database later if needed
            }
          }
        } else if (change.type === 'index') {
          // Create database index - would need to execute SQL
          // For now, just mark as applied
          applied.push(change.target)
        } else if (change.type === 'config') {
          // Update config file
          const configPath = path.join(process.cwd(), change.target)
          if (change.code) {
            await fs.writeFile(configPath, change.code, 'utf-8')
            applied.push(change.target)
          }
        }
      } catch (error: any) {
        errors.push({
          change: change.target,
          error: error.message || 'Failed to apply change',
        })
      }
    }
  } catch (error: any) {
    console.error('Error applying changes:', error)
    errors.push({
      change: 'general',
      error: error.message || 'Failed to apply changes',
    })
  }

  return {
    success: errors.length === 0,
    applied,
    errors,
  }
}

