export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'

/**
 * AI-powered recommendation for optimal auth setup
 * Analyzes current configuration and suggests improvements
 */
export async function POST(request: NextRequest) {
  try {
    await requireAuth(request)
    
    // Get current auth configuration
    const [providers, policies] = await Promise.all([
      prisma.authProvider.findMany(),
      prisma.authPolicy.findMany(),
    ])
    
    const recommendations: Array<{
      type: 'provider' | 'policy'
      priority: 'high' | 'medium' | 'low'
      title: string
      description: string
      action: string
      automated: boolean
    }> = []
    
    // Check if email provider is configured
    const emailProvider = providers.find(p => p.name === 'email')
    if (!emailProvider || !emailProvider.enabled) {
      recommendations.push({
        type: 'provider',
        priority: 'high',
        title: 'Enable Email Authentication',
        description: 'Email/password auth is the foundation of most applications. Enable it to allow users to sign up.',
        action: 'enable_email_provider',
        automated: true,
      })
    }
    
    // Check if at least one OAuth provider is enabled
    const oauthProviders = providers.filter(p => p.type === 'oauth' && p.enabled)
    if (oauthProviders.length === 0) {
      recommendations.push({
        type: 'provider',
        priority: 'medium',
        title: 'Add Social Login',
        description: 'OAuth providers like Google and GitHub improve user experience and increase conversion rates.',
        action: 'add_oauth_provider',
        automated: false,
      })
    }
    
    // Check password policy
    const passwordPolicy = policies.find(p => p.name.toLowerCase().includes('password'))
    if (!passwordPolicy || !passwordPolicy.enabled) {
      recommendations.push({
        type: 'policy',
        priority: 'high',
        title: 'Enable Password Strength Policy',
        description: 'Protect your users with strong password requirements (min 8 chars, mixed case, numbers).',
        action: 'enable_password_policy',
        automated: true,
      })
    }
    
    // Check email verification
    const emailVerificationPolicy = policies.find(p => p.name.toLowerCase().includes('email verification'))
    if (!emailVerificationPolicy || !emailVerificationPolicy.enabled) {
      recommendations.push({
        type: 'policy',
        priority: 'medium',
        title: 'Enable Email Verification',
        description: 'Verify user emails to reduce spam accounts and ensure communication reliability.',
        action: 'enable_email_verification',
        automated: true,
      })
    }
    
    // Check 2FA
    const twoFactorPolicy = policies.find(p => p.name.toLowerCase().includes('two-factor') || p.name.toLowerCase().includes('2fa'))
    if (!twoFactorPolicy || !twoFactorPolicy.enabled) {
      recommendations.push({
        type: 'policy',
        priority: 'high',
        title: 'Enable Two-Factor Authentication',
        description: 'Add an extra layer of security for sensitive applications. Highly recommended for production.',
        action: 'enable_2fa',
        automated: true,
      })
    }
    
    // Sort by priority
    const priorityOrder = { high: 1, medium: 2, low: 3 }
    recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
    
    return NextResponse.json({
      success: true,
      recommendations,
      summary: {
        total: recommendations.length,
        automated: recommendations.filter(r => r.automated).length,
        manual: recommendations.filter(r => !r.automated).length,
      }
    })
  } catch (error) {
    console.error('Recommend setup error:', error)
    return NextResponse.json(
      { error: 'Failed to generate recommendations' },
      { status: 500 }
    )
  }
}
