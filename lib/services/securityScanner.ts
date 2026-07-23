/**
 * Security Configuration Scanner
 * Scans for security misconfigurations and vulnerabilities
 */

import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export type SecurityIssueCategory = 
  | 'api_key' 
  | 'password_policy' 
  | 'cors' 
  | 'encryption' 
  | 'access_control' 
  | 'other'

export type SecurityIssueSeverity = 'high' | 'medium' | 'low'

export interface SecurityIssue {
  severity: SecurityIssueSeverity
  title: string
  description: string
  category: SecurityIssueCategory
  metadata?: Record<string, any>
  aiFixPreview?: {
    configChanges: string
    securityScoreImprovement: number
    estimatedTime: string
  }
}

/**
 * Scan for unencrypted API keys in environment
 */
async function scanApiKeys(projectId?: string): Promise<SecurityIssue[]> {
  const issues: SecurityIssue[] = []

  // Check if API keys are stored in plain text
  // In a real implementation, this would check environment variables or config files
  // For now, we'll check the database for API keys without proper encryption indicators
  
  const apiKeys = await prisma.apiKey.findMany({
    where: projectId ? { userId: projectId } : undefined,
    take: 10, // Sample check
  })

  // Check if keys are properly hashed (they should be)
  // If we can see the full key, it's a security issue
  // This is a simplified check - in reality, we'd check env files, config, etc.
  
  // For demonstration, we'll create an issue if there are many API keys
  // In production, this would scan actual configuration files
  if (apiKeys.length > 0) {
    // Check environment variables or configuration
    // This is a placeholder - real implementation would check actual env/config
    const hasUnencryptedKeys = process.env.DISPLAY_UNENCRYPTED_KEYS === 'true' // Placeholder
    
    if (hasUnencryptedKeys) {
      issues.push({
        severity: 'high',
        title: 'Unencrypted API keys in environment',
        description: 'API keys are stored in plain text in environment variables. Consider using secrets management.',
        category: 'api_key',
        metadata: {
          keyCount: apiKeys.length,
        },
        aiFixPreview: {
          configChanges: `// Before
API_KEY=sk_live_1234567890

// After
API_KEY=\${process.env.SECRET_API_KEY}
// Moved to secrets management`,
          securityScoreImprovement: 25,
          estimatedTime: '2 minutes',
        },
      })
    }
  }

  return issues
}

/**
 * Scan password policy
 */
async function scanPasswordPolicy(): Promise<SecurityIssue[]> {
  const issues: SecurityIssue[] = []

  // Check password requirements
  // In a real implementation, this would check the actual password policy configuration
  const minPasswordLength = 8 // This should come from config
  const requiresUppercase = true // This should come from config
  const requiresLowercase = true // This should come from config
  const requiresNumbers = true // This should come from config
  const requiresSpecialChars = false // This should come from config

  if (minPasswordLength < 12) {
    issues.push({
      severity: 'medium',
      title: 'Weak password policy',
      description: `Minimum password length is ${minPasswordLength} characters. Consider requiring at least 12 characters.`,
      category: 'password_policy',
      metadata: {
        currentLength: minPasswordLength,
        recommendedLength: 12,
      },
      aiFixPreview: {
        configChanges: `// Before
MIN_PASSWORD_LENGTH=${minPasswordLength}

// After
MIN_PASSWORD_LENGTH=12
REQUIRE_SPECIAL_CHARS=true`,
        securityScoreImprovement: 15,
        estimatedTime: '1 minute',
      },
    })
  }

  if (!requiresSpecialChars) {
    issues.push({
      severity: 'low',
      title: 'Password policy missing special character requirement',
      description: 'Consider requiring special characters in passwords for better security.',
      category: 'password_policy',
      metadata: {
        requiresSpecialChars: false,
      },
      aiFixPreview: {
        configChanges: `// Add to password policy
REQUIRE_SPECIAL_CHARS=true
ALLOWED_SPECIAL_CHARS=!@#$%^&*()_+-=[]{}|;:,.<>?`,
        securityScoreImprovement: 10,
        estimatedTime: '1 minute',
      },
    })
  }

  return issues
}

/**
 * Scan CORS configuration
 */
async function scanCORS(projectId?: string): Promise<SecurityIssue[]> {
  const issues: SecurityIssue[] = []

  // Check CORS configuration
  // In a real implementation, this would check actual CORS settings
  const corsEnabled = process.env.CORS_ENABLED !== 'false'
  const corsOrigin = process.env.CORS_ORIGIN || '*'

  if (!corsEnabled) {
    issues.push({
      severity: 'medium',
      title: 'CORS not configured',
      description: 'CORS is not properly configured. This may prevent your frontend from accessing the API.',
      category: 'cors',
      metadata: {
        enabled: false,
      },
      aiFixPreview: {
        configChanges: `// Add CORS configuration
CORS_ENABLED=true
CORS_ORIGIN=https://yourdomain.com
CORS_CREDENTIALS=true`,
        securityScoreImprovement: 10,
        estimatedTime: '2 minutes',
      },
    })
  } else if (corsOrigin === '*') {
    issues.push({
      severity: 'high',
      title: 'CORS allows all origins',
      description: 'CORS is configured to allow all origins (*). This is a security risk.',
      category: 'cors',
      metadata: {
        origin: '*',
      },
      aiFixPreview: {
        configChanges: `// Before
CORS_ORIGIN=*

// After
CORS_ORIGIN=https://yourdomain.com,https://www.yourdomain.com`,
        securityScoreImprovement: 20,
        estimatedTime: '2 minutes',
      },
    })
  }

  return issues
}

/**
 * Scan encryption settings
 */
async function scanEncryption(): Promise<SecurityIssue[]> {
  const issues: SecurityIssue[] = []

  // Check if HTTPS is enforced
  const httpsEnforced = process.env.FORCE_HTTPS === 'true'
  
  if (!httpsEnforced) {
    issues.push({
      severity: 'high',
      title: 'HTTPS not enforced',
      description: 'HTTPS is not enforced. All API communications should use HTTPS.',
      category: 'encryption',
      metadata: {
        httpsEnforced: false,
      },
      aiFixPreview: {
        configChanges: `// Add to configuration
FORCE_HTTPS=true
HTTPS_REDIRECT=true`,
        securityScoreImprovement: 30,
        estimatedTime: '5 minutes',
      },
    })
  }

  return issues
}

/**
 * Run a full security scan
 */
export async function runSecurityScan(
  scanType: 'configuration' | 'vulnerability' | 'compliance',
  projectId?: string
): Promise<{
  issues: SecurityIssue[]
  score: number
}> {
  const allIssues: SecurityIssue[] = []

  // Run different scans based on type
  if (scanType === 'configuration' || scanType === 'vulnerability') {
    allIssues.push(...(await scanApiKeys(projectId)))
    allIssues.push(...(await scanPasswordPolicy()))
    allIssues.push(...(await scanCORS(projectId)))
  }

  if (scanType === 'configuration' || scanType === 'compliance') {
    allIssues.push(...(await scanEncryption()))
  }

  // Calculate security score (100 - points deducted for issues)
  let score = 100
  allIssues.forEach((issue) => {
    if (issue.severity === 'high') score -= 10
    else if (issue.severity === 'medium') score -= 5
    else if (issue.severity === 'low') score -= 2
  })
  score = Math.max(0, score)

  return {
    issues: allIssues,
    score,
  }
}

/**
 * Create security issues in database
 */
export async function createSecurityIssues(
  issues: SecurityIssue[],
  projectId?: string
) {
  const created = await Promise.all(
    issues.map((issue) =>
      prisma.securityIssue.create({
        data: {
          severity: issue.severity,
          title: issue.title,
          description: issue.description,
          category: issue.category,
          projectId,
          metadata: issue.metadata ? (issue.metadata as Prisma.InputJsonValue) : null,
          aiFixPreview: issue.aiFixPreview ? (issue.aiFixPreview as Prisma.InputJsonValue) : null,
        },
      })
    )
  )
  return created
}

