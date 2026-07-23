/**
 * Subdomain Service
 * 
 * Manages subdomain generation and custom domain configuration for projects.
 * 
 * This solves BLOCKER #3: Independent URLs
 * 
 * URL Patterns:
 * - Default: project-slug.backenly.com
 * - Custom: api.mycompany.com (user-configured)
 * 
 * Architecture:
 * - Wildcard DNS: *.backenly.com → Load Balancer
 * - Middleware resolves subdomain → project
 * - Routes to project's dedicated worker container
 */

import { prisma } from '@/lib/db/postgres';
import { randomBytes } from 'crypto';

export interface SubdomainConfig {
  projectId: string;
  subdomain?: string; // Auto-generated if not provided
  customDomain?: string;
}

export interface DomainVerification {
  verified: boolean;
  token: string;
  dnsRecords: Array<{
    type: string;
    name: string;
    value: string;
    ttl: number;
  }>;
}

export class SubdomainService {
  private static readonly BASE_DOMAIN = process.env.BASE_DOMAIN || 'backenly.com';
  private static readonly ALLOWED_SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

  /**
   * Generate a subdomain from project slug
   */
  static generateSubdomain(projectSlug: string): string {
    // Clean and normalize slug for subdomain
    let subdomain = projectSlug
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-') // Replace non-alphanumeric with hyphens
      .replace(/--+/g, '-') // Replace multiple hyphens with single
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

    // Ensure it's within length limits
    if (subdomain.length > 63) {
      subdomain = subdomain.substring(0, 63);
    }

    // Ensure it matches pattern
    if (!this.ALLOWED_SUBDOMAIN_PATTERN.test(subdomain)) {
      throw new Error('Invalid subdomain format');
    }

    return subdomain;
  }

  /**
   * Assign a subdomain to a project
   */
  static async assignSubdomain(config: SubdomainConfig): Promise<string> {
    const { projectId, subdomain: requestedSubdomain } = config;

    // Get project to generate subdomain from slug
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { slug: true, subdomain: true },
    });

    if (!project) {
      throw new Error('Project not found');
    }

    // Return existing subdomain if already assigned
    if (project.subdomain) {
      return project.subdomain;
    }

    // Use requested subdomain or generate from slug
    let subdomain: string;
    if (requestedSubdomain) {
      // Validate requested subdomain
      if (!this.ALLOWED_SUBDOMAIN_PATTERN.test(requestedSubdomain)) {
        throw new Error('Invalid subdomain format');
      }
      subdomain = requestedSubdomain;
    } else {
      if (!project.slug) {
        throw new Error('Project must have a slug to generate subdomain');
      }
      subdomain = this.generateSubdomain(project.slug);
    }

    // Check if subdomain is already taken
    const existing = await prisma.project.findUnique({
      where: { subdomain },
    });

    if (existing) {
      // Add random suffix if taken
      const suffix = randomBytes(3).toString('hex');
      subdomain = `${subdomain}-${suffix}`;
    }

    // Update project with subdomain
    await prisma.project.update({
      where: { id: projectId },
      data: { subdomain },
    });

    return subdomain;
  }

  /**
   * Get full URL for a project
   */
  static async getProjectUrl(projectId: string): Promise<string> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        subdomain: true,
        customDomain: true,
        domainVerified: true,
      },
    });

    if (!project) {
      throw new Error('Project not found');
    }

    // Use custom domain if verified
    if (project.customDomain && project.domainVerified) {
      return `https://${project.customDomain}`;
    }

    // Use subdomain
    if (project.subdomain) {
      return `https://${project.subdomain}.${this.BASE_DOMAIN}`;
    }

    throw new Error('Project has no URL assigned');
  }

  /**
   * Initiate custom domain verification
   */
  static async initiateCustomDomain(
    projectId: string,
    customDomain: string
  ): Promise<DomainVerification> {
    // Validate domain format
    if (!this.isValidDomain(customDomain)) {
      throw new Error('Invalid domain format');
    }

    // Check if domain is already used
    const existing = await prisma.project.findFirst({
      where: {
        customDomain,
        id: { not: projectId },
        domainVerified: true,
      },
    });

    if (existing) {
      throw new Error('Domain already in use');
    }

    // Generate verification token
    const token = randomBytes(32).toString('hex');

    // Update project
    await prisma.project.update({
      where: { id: projectId },
      data: {
        customDomain,
        domainVerified: false,
        domainVerificationToken: token,
      },
    });

    // Get project subdomain for CNAME
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { subdomain: true },
    });

    const targetSubdomain = project?.subdomain || 'verify';

    return {
      verified: false,
      token,
      dnsRecords: [
        {
          type: 'CNAME',
          name: customDomain,
          value: `${targetSubdomain}.${this.BASE_DOMAIN}`,
          ttl: 3600,
        },
        {
          type: 'TXT',
          name: `_backenly-verify.${customDomain}`,
          value: token,
          ttl: 3600,
        },
      ],
    };
  }

  /**
   * Verify custom domain by checking DNS records
   */
  static async verifyCustomDomain(projectId: string): Promise<boolean> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        customDomain: true,
        domainVerificationToken: true,
        subdomain: true,
      },
    });

    if (!project?.customDomain || !project.domainVerificationToken) {
      throw new Error('No custom domain verification in progress');
    }

    try {
      // Check TXT record for verification token
      const dns = require('dns').promises;
      const txtRecords = await dns.resolveTxt(`_backenly-verify.${project.customDomain}`);
      const txtValue = txtRecords.flat().find((record) =>
        record.includes(project.domainVerificationToken!)
      );

      if (!txtValue) {
        return false;
      }

      // Check CNAME record points to our subdomain
      try {
        const cnameRecords = await dns.resolveCname(project.customDomain);
        const expectedCname = `${project.subdomain}.${this.BASE_DOMAIN}`;
        
        const cnameMatch = cnameRecords.some((record) =>
          record.toLowerCase() === expectedCname.toLowerCase()
        );

        if (!cnameMatch) {
          return false;
        }
      } catch {
        // CNAME not set yet
        return false;
      }

      // Mark domain as verified
      await prisma.project.update({
        where: { id: projectId },
        data: {
          domainVerified: true,
          domainVerificationToken: null, // Clear token after verification
        },
      });

      return true;
    } catch (error) {
      console.error('[SubdomainService] Domain verification error:', error);
      return false;
    }
  }

  /**
   * Remove custom domain
   */
  static async removeCustomDomain(projectId: string): Promise<void> {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        customDomain: null,
        domainVerified: false,
        domainVerificationToken: null,
      },
    });
  }

  /**
   * Resolve project from subdomain or custom domain
   */
  static async resolveProjectFromHost(hostname: string): Promise<string | null> {
    // Remove port if present
    const host = hostname.split(':')[0].toLowerCase();

    // Check if it's a custom domain
    let project = await prisma.project.findFirst({
      where: {
        customDomain: host,
        domainVerified: true,
      },
      select: { id: true },
    });

    if (project) {
      return project.id;
    }

    // Check if it's a subdomain
    if (host.endsWith(`.${this.BASE_DOMAIN}`)) {
      const subdomain = host.replace(`.${this.BASE_DOMAIN}`, '');
      
      project = await prisma.project.findFirst({
        where: { subdomain },
        select: { id: true },
      });

      if (project) {
        return project.id;
      }
    }

    return null;
  }

  /**
   * Validate domain format
   */
  private static isValidDomain(domain: string): boolean {
    const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i;
    return domainPattern.test(domain);
  }

  /**
   * Get all domains for a project
   */
  static async getProjectDomains(projectId: string): Promise<{
    subdomain: string | null;
    customDomain: string | null;
    domainVerified: boolean;
    urls: string[];
  }> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        subdomain: true,
        customDomain: true,
        domainVerified: true,
      },
    });

    if (!project) {
      throw new Error('Project not found');
    }

    const urls: string[] = [];

    if (project.subdomain) {
      urls.push(`https://${project.subdomain}.${this.BASE_DOMAIN}`);
    }

    if (project.customDomain && project.domainVerified) {
      urls.push(`https://${project.customDomain}`);
    }

    return {
      subdomain: project.subdomain,
      customDomain: project.customDomain,
      domainVerified: project.domainVerified,
      urls,
    };
  }
}
