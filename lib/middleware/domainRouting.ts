import { NextRequest, NextResponse } from 'next/server';

/**
 * Domain Routing Middleware
 * 
 * Resolves incoming requests from subdomains or custom domains to projects.
 * This is the core of BLOCKER #3: Independent URLs
 * 
 * Architecture:
 * 1. Extract hostname from request
 * 2. Resolve hostname → projectId (database lookup)
 * 3. Forward to project's dedicated worker container
 * 4. Return response
 * 
 * Note: Edge-compatible - no Node.js modules
 */

export async function domainRoutingMiddleware(request: NextRequest): Promise<NextResponse | null> {
  const hostname = request.headers.get('host') || '';
  
  // Skip for main domain (dashboard) and Vercel deployment URLs
  const isMainDomain = hostname === process.env.NEXT_PUBLIC_APP_URL?.replace(/^https?:\/\//, '') ||
                       hostname.startsWith('localhost') ||
                       hostname.startsWith('127.0.0.1') ||
                       hostname.includes('.vercel.app'); // Vercel deployment URLs

  if (isMainDomain) {
    // Check for X-Project-ID header (development mode)
    const projectIdHeader = request.headers.get('x-project-id');
    if (projectIdHeader) {
      return await forwardToWorker(request, projectIdHeader);
    }
    
    // Let Next.js handle dashboard routes
    return null;
  }

  // Resolve project from subdomain or custom domain
  const projectId = await resolveProjectFromHost(hostname);

  if (!projectId) {
    return NextResponse.json(
      {
        error: 'Project not found',
        message: `No project found for domain: ${hostname}`,
        hint: 'Check if the domain is correctly configured in your project settings',
      },
      { status: 404 }
    );
  }

  // Forward to project's worker
  return await forwardToWorker(request, projectId);
}

/**
 * Resolve project from hostname (Edge-compatible)
 * Note: Moved database lookups to API route layer to maintain Edge Runtime compatibility
 */
async function resolveProjectFromHost(hostname: string): Promise<string | null> {
  // For IP address access (development), use the first project
  // This allows testing via IP address during development
  if (/^\d+\.\d+\.\d+\.\d+/.test(hostname)) {
    try {
      const { prisma } = await import('@/lib/db/postgres');
      const project = await prisma.project.findFirst({
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (project) {
        console.log(`[Domain Routing] IP access (${hostname}) routed to project ${project.id}`);
        return project.id;
      }
    } catch (error) {
      console.error('[Domain Routing] Error resolving IP to project:', error);
    }
  }

  // For now, domain routing is disabled in middleware to maintain Edge Runtime compatibility
  // Database lookups must happen in API routes (Node.js runtime)
  // TODO: Implement domain routing via API route proxy or use Edge-compatible KV store
  return null;
}

/**
 * Forward request to project's dedicated worker container
 * For now, we inject the project ID into headers and let Next.js routing handle it
 */
async function forwardToWorker(request: NextRequest, projectId: string): Promise<NextResponse> {
  // Add project ID to headers for downstream handlers
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-project-id', projectId);

  // Let the request continue through Next.js routing with project context
  // This allows /api/v1/[projectId]/* routes to handle the request
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  console.log(`[Domain Routing] Forwarded request to project ${projectId}: ${request.nextUrl.pathname}`);
  return response;
}

/**
 * Check if a request should be handled by domain routing
 */
export function shouldUseDomainRouting(request: NextRequest): boolean {
  const hostname = request.headers.get('host') || '';
  const baseDomain = process.env.BASE_DOMAIN || 'backenly.com';

  // Skip for:
  // - Main domain (dashboard)
  // - Vercel deployment URLs
  // - API routes (handled by Next.js)
  // - Static files
  // - _next/* (Next.js internals)

  const pathname = request.nextUrl.pathname;

  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/static/') ||
    pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/)
  ) {
    return false;
  }

  // Use domain routing if:
  // 1. It's a subdomain (*.backenly.com)
  // 2. It's not the main domain
  // 3. It's a custom domain
  // 4. It's an IP address (development access)
  // BUT NOT Vercel deployment URLs

  const isSubdomain = hostname.endsWith(`.${baseDomain}`) &&
                     hostname !== baseDomain &&
                     hostname !== `www.${baseDomain}`;

  const isIPAddress = /^\d+\.\d+\.\d+\.\d+/.test(hostname);

  const isMainDomain = hostname === baseDomain ||
                      hostname === `www.${baseDomain}` ||
                      hostname.startsWith('localhost') ||
                      hostname.startsWith('127.0.0.1') ||
                      hostname.includes('.vercel.app'); // Vercel deployments

  return isSubdomain || isIPAddress || (!isMainDomain && !hostname.startsWith('localhost') && !hostname.startsWith('127.0.0.1'));
}
