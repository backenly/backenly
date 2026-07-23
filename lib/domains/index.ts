/**
 * Custom Domain Library
 * 
 * Provides custom domain management with DNS TXT verification.
 * PRO plan feature only.
 */

import { prisma } from '@/lib/db/prisma'
import crypto from 'crypto'
import dns from 'dns/promises'

// ============================================================================
// TYPES
// ============================================================================

export interface DomainVerificationResult {
  verified: boolean
  message: string
  dnsRecord?: {
    type: string
    name: string
    value: string
  }
}

// ============================================================================
// DOMAIN MANAGEMENT
// ============================================================================

/**
 * Generate a unique verification token
 */
function generateVerificationToken(): string {
  return `backenly-verify-${crypto.randomBytes(16).toString('hex')}`
}

/**
 * Add a custom domain to a project
 */
export async function addCustomDomain(projectId: string, domain: string) {
  // Normalize domain (remove protocol, www, trailing slashes)
  const normalizedDomain = normalizeDomain(domain)
  
  // Check if domain is already in use
  const existing = await prisma.customDomain.findUnique({
    where: { domain: normalizedDomain }
  })
  
  if (existing && existing.projectId !== projectId) {
    throw new Error('Domain is already registered by another project')
  }
  
  if (existing) {
    throw new Error('Domain is already registered for this project')
  }
  
  // Generate verification token
  const verificationToken = generateVerificationToken()
  
  // Create DNS record value
  const dnsRecordValue = `backenly-domain-verification=${verificationToken}`
  
  return prisma.customDomain.create({
    data: {
      projectId,
      domain: normalizedDomain,
      verificationToken,
      dnsRecordValue
    }
  })
}

/**
 * Normalize domain name
 */
function normalizeDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .trim()
}

/**
 * Verify domain ownership via DNS TXT record
 */
export async function verifyDomain(domainId: string): Promise<DomainVerificationResult> {
  const domainRecord = await prisma.customDomain.findUnique({
    where: { id: domainId }
  })
  
  if (!domainRecord) {
    return { verified: false, message: 'Domain not found' }
  }
  
  if (domainRecord.verified) {
    return { verified: true, message: 'Domain is already verified' }
  }
  
  try {
    // Query DNS TXT records
    const txtRecords = await dns.resolveTxt(domainRecord.domain)
    
    // Flatten TXT records (they come as arrays of strings)
    const allRecords = txtRecords.flat()
    
    // Look for our verification record
    const expectedValue = domainRecord.dnsRecordValue
    const found = allRecords.some(record => record.includes(expectedValue))
    
    if (found) {
      // Mark as verified
      await prisma.customDomain.update({
        where: { id: domainId },
        data: {
          verified: true,
          verifiedAt: new Date(),
          active: true
        }
      })
      
      return {
        verified: true,
        message: 'Domain verified successfully',
        dnsRecord: {
          type: 'TXT',
          name: domainRecord.domain,
          value: expectedValue
        }
      }
    }
    
    return {
      verified: false,
      message: 'Verification record not found in DNS. Please add the TXT record and try again.',
      dnsRecord: {
        type: 'TXT',
        name: domainRecord.domain,
        value: expectedValue
      }
    }
    
  } catch (error: any) {
    return {
      verified: false,
      message: `DNS lookup failed: ${error.message}`,
      dnsRecord: {
        type: 'TXT',
        name: domainRecord.domain,
        value: domainRecord.dnsRecordValue
      }
    }
  }
}

/**
 * Get custom domains for a project
 */
export async function getProjectDomains(projectId: string) {
  return prisma.customDomain.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' }
  })
}

/**
 * Get a specific domain by ID
 */
export async function getDomainById(domainId: string) {
  return prisma.customDomain.findUnique({
    where: { id: domainId }
  })
}

/**
 * Delete a custom domain
 */
export async function deleteDomain(domainId: string, projectId: string) {
  return prisma.customDomain.deleteMany({
    where: {
      id: domainId,
      projectId
    }
  })
}

/**
 * Get domain by hostname (for reverse proxy)
 */
export async function getDomainByHostname(hostname: string) {
  const normalized = normalizeDomain(hostname)
  
  return prisma.customDomain.findFirst({
    where: {
      domain: normalized,
      verified: true,
      active: true
    },
    include: {
      project: {
        select: {
          id: true,
          userId: true,
          apiUrlProd: true,
          subdomain: true
        }
      }
    }
  })
}

// ============================================================================
// DOMAIN VALIDATION
// ============================================================================

/**
 * Validate domain format
 */
export function isValidDomain(domain: string): boolean {
  // Remove protocol if present
  const cleanDomain = domain.replace(/^https?:\/\//, '')
  
  // Basic domain validation regex
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/
  
  return domainRegex.test(cleanDomain)
}

/**
 * Check if domain is a reserved/internal domain
 */
export function isReservedDomain(domain: string): boolean {
  const reserved = [
    'backenly.com',
    'www.backenly.com',
    'api.backenly.com',
    'app.backenly.com',
    'admin.backenly.com',
    'localhost'
  ]
  
  const normalized = normalizeDomain(domain)
  return reserved.includes(normalized) || normalized.endsWith('.backenly.com')
}
