export const dynamic = 'force-dynamic'

/**
 * Domain Verification API
 * 
 * POST - Verify custom domain DNS configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { SubdomainService } from '@/lib/services/subdomain';
import { canWriteProject } from '@/lib/edition/guard'

/**
 * POST /api/projects/:id/domains/verify
 * Verify custom domain DNS records
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireAuth(request);
    const { id: projectId } = await params;

    // Verify project ownership
    if (!(await canWriteProject(user.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Verify domain
    const verified = await SubdomainService.verifyCustomDomain(projectId);

    if (verified) {
      return NextResponse.json({
        success: true,
        verified: true,
        message: 'Domain verified successfully! Your custom domain is now active.',
      });
    } else {
      return NextResponse.json({
        success: true,
        verified: false,
        message: 'Domain verification failed. Please check your DNS records and try again.',
        hint: 'DNS propagation can take up to 24-48 hours. Make sure both CNAME and TXT records are configured correctly.',
      });
    }
  } catch (error: any) {
    console.error('[Domains Verify API] POST error:', error);
    return NextResponse.json(
      { error: 'Failed to verify domain', message: error.message },
      { status: 500 }
    );
  }
}
