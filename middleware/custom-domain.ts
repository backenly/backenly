/**
 * Custom Domain Middleware
 * 
 * Handles reverse proxy for custom domains.
 * Routes requests from custom domains to the appropriate project.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDomainByHostname } from '@/lib/domains'

/**
 * Check if request is from a custom domain
 * and route to the appropriate project
 */
export async function handleCustomDomain(request: NextRequest): Promise<NextResponse | null> {
  const hostname = request.headers.get('host') || request.nextUrl.hostname
  
  // Skip if it's the main domain or localhost
  if (
    hostname === 'backenly.com' ||
    hostname === 'www.backenly.com' ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.vercel.app')
  ) {
    return null
  }
  
  try {
    // Look up custom domain
    const customDomain = await getDomainByHostname(hostname)
    
    if (!customDomain) {
      // Domain not found or not verified
      return new NextResponse(
        JSON.stringify({
          error: 'Domain not configured',
          message: 'This domain is not registered or not yet verified. Please check your domain settings.'
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    }
    
    // Rewrite URL to project API
    const { project } = customDomain
    const url = request.nextUrl.clone()
    
    // Route to project's API
    if (project.apiUrlProd) {
      // Use production API URL if deployed
      url.hostname = new URL(project.apiUrlProd).hostname
    } else {
      // Route to project's API endpoint
      url.pathname = `/api/projects/${project.id}/public${url.pathname}`
    }
    
    // Add custom domain headers
    const headers = new Headers(request.headers)
    headers.set('x-custom-domain', hostname)
    headers.set('x-project-id', project.id)
    
    return NextResponse.rewrite(url, {
      headers,
      request: {
        headers
      }
    })
    
  } catch (error) {
    console.error('[Custom Domain Middleware] Error:', error)
    return new NextResponse(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
