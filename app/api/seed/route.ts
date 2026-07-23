export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAdmin } from '@/lib/auth/middleware'

/**
 * Seed endpoint to initialize default auth providers and policies.
 *
 * SECURITY: founder/admin only — this mutates platform-level config (would
 * otherwise let any authed user reset providers/policies). Previously there
 * was NO auth check at all. Either ramp this through requireAdmin or run
 * `scripts/seed-billing.ts` from a privileged shell.
 */
export async function POST(request: NextRequest) {
  const adminError = await requireAdmin(request)
  if (adminError) return adminError

  try {
    let rolesCount = 0
    let providersCount = 0
    let policiesCount = 0
    
    // Skip roles seeding for now - focus on auth providers and policies
    // Roles can be created manually or via a separate endpoint
    
    // Create default auth providers
    const providers = [
      {
        name: 'email',
        enabled: true,
        configured: true,
        type: 'email' as const,
        icon: 'Mail',
      },
      {
        name: 'google',
        enabled: false,
        configured: false,
        type: 'oauth' as const,
        icon: 'Chrome',
      },
      {
        name: 'github',
        enabled: false,
        configured: false,
        type: 'oauth' as const,
        icon: 'Github',
      },
      {
        name: 'microsoft',
        enabled: false,
        configured: false,
        type: 'oauth' as const,
        icon: 'Building2',
        warning: 'Email verification is disabled. This may reduce security.',
      },
    ]
    
    for (const providerData of providers) {
      await prisma.authProvider.upsert({
        where: { name: providerData.name },
        update: providerData,
        create: providerData,
      })
      providersCount++
    }
    
    // Create default auth policies
    const policies = [
      {
        name: 'Email Verification Required',
        description: 'Users must verify their email before accessing the app',
        enabled: true,
        codeGenerated: false,
      },
      {
        name: 'Password Strength Policy',
        description: 'Minimum 8 characters with uppercase, lowercase, and numbers',
        enabled: true,
        codeGenerated: true,
      },
      {
        name: 'Two-Factor Authentication',
        description: 'Optional 2FA for enhanced security',
        enabled: false,
        warning: '2FA is recommended for production apps',
        codeGenerated: false,
      },
      {
        name: 'Session Timeout',
        description: 'Sessions expire after 7 days of inactivity',
        enabled: true,
        codeGenerated: false,
      },
    ]
    
    for (const policyData of policies) {
      // @ts-ignore - Prisma client will be regenerated on next restart
      await prisma.authPolicy.upsert({
        where: { name: policyData.name },
        update: policyData,
        create: policyData,
      })
      policiesCount++
    }
    
    return NextResponse.json({ 
      message: 'Database seeded successfully',
      roles: rolesCount,
      providers: providersCount,
      policies: policiesCount,
    })
  } catch (error) {
    console.error('Seed error:', error)
    return NextResponse.json(
      { error: 'Failed to seed database' },
      { status: 500 }
    )
  }
}

