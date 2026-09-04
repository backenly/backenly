export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'
import { z } from 'zod'
import crypto from 'crypto'
import { maskFromPrefix, plaintextForStorage } from '@/lib/auth/api-key-plaintext'
import { canAdministerProject } from '@/lib/edition/guard'

const createApiKeySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  keyType: z.enum(['dashboard', 'public']).default('public'),
  role: z.enum(['admin', 'read-only', 'write', 'ai-only', 'client', 'service']).default('client'),
  permissions: z.array(z.string()).default([]),
  capabilities: z.array(z.enum(['database', 'auth', 'storage', 'functions', 'ai'])).default([]),
  serviceRole: z.boolean().default(false),
  // Bind this key to a preview branch. Omit for main.
  //
  // The environment is chosen HERE, at issuance, and never by the request:
  // PostgREST picks its schema from Accept-Profile, so a client-settable branch
  // selector would be a cross-tenant bypass (see profileForBranchSchema).
  branchId: z.string().uuid().optional(),
  expiresAt: z.string().datetime().optional(),
  rateLimit: z.number().int().positive().optional().default(1000),
  rateLimitWindow: z.number().int().positive().optional().default(3600), // seconds
})

function generateApiKey(prefix: string): string {
  const randomBytes = crypto.randomBytes(32).toString('hex')
  return `${prefix}${randomBytes}`
}

function getKeyPrefix(keyType: string, role: string): string {
  if (keyType === 'dashboard') {
    return 'dk_admin_' // Dashboard keys
  }
  
  // Public keys
  const prefixes: Record<string, string> = {
    'admin': 'sk_live_',
    'read-only': 'sk_read_',
    'write': 'sk_test_',
    'ai-only': 'sk_ai_',
    'client': 'sk_client_',
    'service': 'sk_service_',
  }
  return prefixes[role] || 'sk_'
}

/**
 * Built from keyPrefix, never from the secret.
 *
 * This used to take the plaintext key and render prefix + first4 … last4, so
 * the list endpoint could only mask a key the database was still storing in the
 * clear. The display was the last thing depending on that storage, and four
 * trailing characters are not worth keeping a live credential recoverable for.
 * Losing them is the whole user-visible cost of this change.
 */
const maskApiKey = maskFromPrefix

function getDefaultPermissions(role: string, keyType: string): string[] {
  // Dashboard keys use legacy permissions
  if (keyType === 'dashboard') {
    const permissions: Record<string, string[]> = {
      'admin': ['read', 'write', 'delete', 'admin', 'manage-users'],
      'read-only': ['read'],
      'write': ['read', 'write'],
      'ai-only': ['ai-generate', 'ai-analyze'],
    }
    return permissions[role] || []
  }
  
  // Public keys use simplified permissions based on role
  const permissions: Record<string, string[]> = {
    'admin': ['read', 'write', 'admin'],
    'read-only': ['read'],
    'write': ['read', 'write'],
    'ai-only': ['ai-only'],
    'client': ['read', 'write'], // Client apps typically need read/write
    'service': ['read', 'write'], // Service roles typically need read/write
  }
  return permissions[role] || ['read']
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request)
    
    // Get projectId from request for tenant isolation
    const projectId = request.headers.get('x-project-id') || 
                      new URL(request.url).searchParams.get('projectId')
    
    if (!projectId) {
      return NextResponse.json(
        { error: 'Project ID is required' },
        { status: 400 }
      )
    }
    
    const apiKeys = await prisma.apiKey.findMany({
      where: { 
        userId: auth.userId,
        projectId, // Tenant isolation
      },
      orderBy: { createdAt: 'desc' },
    })
    
    return NextResponse.json({
      apiKeys: apiKeys.map(key => ({
        id: key.id,
        name: key.name,
        // Security: never return the full plaintext key on subsequent reads.
        // The plaintext key is returned ONCE — immediately after creation — and
        // must be stored by the client at that point. All subsequent reads
        // return only a mask derived from keyPrefix, which is non-secret
        // metadata, so this path no longer depends on the key being stored in
        // recoverable form at all.
        key: maskApiKey(key.keyPrefix),
        keyPrefix: key.keyPrefix,
        keyType: key.keyType,
        role: key.role,
        permissions: key.permissions,
        capabilities: key.capabilities,
        serviceRole: key.serviceRole,
        projectId: key.projectId,
        lastUsed: key.lastUsed,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
        rateLimit: key.rateLimit,
        rateLimitWindow: key.rateLimitWindow,
        requestCount: key.requestCount,
        resetAt: key.resetAt,
      })),
    })
  } catch (error) {
    console.error('Get API keys error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch API keys' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request)
    const body = await request.json()
    const data = createApiKeySchema.parse(body)
    
    // For public keys, projectId is required. For dashboard keys, it's optional
    const projectId = request.headers.get('x-project-id') || 
                      body.projectId ||
                      new URL(request.url).searchParams.get('projectId')
    
    if (data.keyType === 'public' && !projectId) {
      return NextResponse.json(
        { error: 'Project ID is required for public API keys' },
        { status: 400 }
      )
    }
    
    // Validate user has access to this project (if projectId provided)
    if (projectId) {
      // ADMIN: generateApiKey below mints a real credential granting access to
      // this project. Issuing one is administration, the same rule applied to
      // ai-functions admin-key, which is a GET that hands back a credential.
      if (!(await canAdministerProject(auth.userId, projectId))) {
        return NextResponse.json(
          { error: 'Project not found or access denied' },
          { status: 403 }
        )
      }
    }
    
    // ── Branch scoping ────────────────────────────────────────────────────
    //
    // Verified against THIS project rather than trusted from the body. The
    // resolved schema name eventually becomes the Accept-Profile header, so an
    // unchecked branchId here would let a caller mint themselves a key pointing
    // at another tenant's schema — the exact bypass the gateway strips headers
    // to prevent, re-entered through key issuance.
    if (data.branchId) {
      if (!projectId) {
        return NextResponse.json(
          { error: 'A branch-scoped key must be scoped to a project.' },
          { status: 400 },
        )
      }
      const branch = await prisma.workspaceBranch.findFirst({
        where: { id: data.branchId, projectId, status: 'active' },
        select: { id: true },
      })
      if (!branch) {
        return NextResponse.json(
          { error: 'Branch not found on this project, or it is no longer active.' },
          { status: 400 },
        )
      }
    }

    const keyPrefix = getKeyPrefix(data.keyType, data.role)
    const fullKey = generateApiKey(keyPrefix)
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex') // Hash for secure storage
    const permissions = data.permissions.length > 0 
      ? data.permissions 
      : getDefaultPermissions(data.role, data.keyType)
    
    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null
    const now = new Date()
    const resetAt = new Date(now.getTime() + data.rateLimitWindow * 1000)
    
    const apiKey = await prisma.apiKey.create({
      data: {
        name: data.name,
        // Plaintext is persisted ONLY for genuinely public keys.
        //
        // This line read `key: fullKey` unconditionally, commented "Development
        // only: store full key for API Tester", with no NODE_ENV gate anywhere
        // in the file — so every secret and service-role credential ever issued
        // was stored in the clear beside its hash. The stated reason was also
        // already gone: nothing in the tree consumes ApiKey.key for an API
        // Tester. A leaked backup therefore handed over working MCP keys, which
        // can create, alter and drop customer tables.
        //
        // Public keys keep their plaintext deliberately. They are designed to
        // be embedded in frontend code, and Project.anonKey stores one in the
        // clear for the same reason.
        // Never persisted. See lib/auth/api-key-plaintext.ts — in particular
        // why `keyType: 'public'` is NOT a safe exemption: every sk_* secret in
        // the system is a keyType 'public' row. The full key is returned to the
        // caller once, in the response below, and then it is unrecoverable.
        key: plaintextForStorage(),
        keyHash, // SECURE: SHA-256 hash for validation
        keyPrefix,
        keyType: data.keyType,
        role: data.role,
        permissions,
        capabilities: data.capabilities,
        serviceRole: data.serviceRole,
        branchId: data.branchId ?? null,
        userId: auth.userId,
        projectId: projectId || null, // Required for public, optional for dashboard
        expiresAt,
        rateLimit: data.rateLimit,
        rateLimitWindow: data.rateLimitWindow,
        resetAt,
      },
    })
    
    // Return the full plaintext key EXACTLY ONCE — immediately after creation.
    // Subsequent reads via GET return only the masked value. The caller must
    // copy and store this key now; it cannot be recovered later.
    return NextResponse.json({
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        key: fullKey,
        /** true = this is the only time the full key is returned; store it now */
        keyShownOnce: true,
        keyPrefix: apiKey.keyPrefix,
        keyType: apiKey.keyType,
        role: apiKey.role,
        permissions: apiKey.permissions,
        capabilities: apiKey.capabilities,
        serviceRole: apiKey.serviceRole,
        branchId: apiKey.branchId,
        projectId: apiKey.projectId,
        createdAt: apiKey.createdAt,
        expiresAt: apiKey.expiresAt,
      },
    }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Create API key error:', error)
    return NextResponse.json(
      { error: 'Failed to create API key' },
      { status: 500 }
    )
  }
}

