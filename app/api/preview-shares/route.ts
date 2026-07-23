export const dynamic = 'force-dynamic'

/**
 * Preview Share API Endpoints
 * 
 * POST /api/preview-shares - Create a new share
 * GET /api/preview-shares?projectId=<id> - List shares for a project
 * DELETE /api/preview-shares/<id> - Revoke a share (not implemented in route params yet)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createPreviewShare, listProjectShares, revokePreviewShare, PreviewShareOptions } from '@/lib/services/previewShare';
import { z } from 'zod';
import { withProjectAccess, withAuth } from '@/lib/auth/route-protection';

const createShareSchema = z.object({
  accessLevel: z.enum(['read_only', 'full_preview']),
  allowAuth: z.boolean().default(false),
  allowWrites: z.boolean().default(false),
  expiresInHours: z.number().int().min(1).max(72 * 7).default(24), // Max 7 days
  label: z.string().optional(),
});

export const POST = withProjectAccess(async (request: NextRequest, { projectId, user }) => {
  try {
    const body = await request.json();
    const data = createShareSchema.parse(body);

    const share = await createPreviewShare({
      ...data,
      projectId,
      userId: user.userId,
    } as PreviewShareOptions);

    return NextResponse.json({
      success: true,
      share: {
        id: share.shareId,
        shareUrl: share.shareUrl,
        expiresAt: share.expiresAt.toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.errors }, { status: 400 });
    }
    console.error('Create share error:', error);
    return NextResponse.json({ error: 'Failed to create share' }, { status: 500 });
  }
});

export const GET = withProjectAccess(async (request: NextRequest, { projectId, user }) => {
  try {
    const shares = await listProjectShares(projectId);

    return NextResponse.json({
      success: true,
      shares: shares.map((share: any) => ({
        id: share.id,
        label: share.label,
        accessLevel: share.accessLevel,
        allowAuth: share.allowAuth,
        allowWrites: share.allowWrites,
        expiresAt: share.expiresAt.toISOString(),
        accessCount: share.accessCount,
        lastAccessedAt: share.lastAccessedAt?.toISOString(),
        createdAt: share.createdAt.toISOString(),
        createdBy: {
          email: share.user.email,
          name: share.user.name,
        },
      })),
    });
  } catch (error) {
    console.error('List shares error:', error);
    return NextResponse.json({ error: 'Failed to list shares' }, { status: 500 });
  }
});

// DELETE endpoint would need to be in a dynamic route: /api/preview-shares/[id]/route.ts
// For now, keeping the placeholder here
export const DELETE = withAuth(async (request: NextRequest, { user }) => {
  try {
    // This needs to be moved to [id]/route.ts for proper route param support
    const { searchParams } = new URL(request.url);
    const shareId = searchParams.get('id');

    if (!shareId) {
      return NextResponse.json({ error: 'Share ID required' }, { status: 400 });
    }

    const success = await revokePreviewShare(shareId, user.userId);

    if (!success) {
      return NextResponse.json({ error: 'Share not found or already revoked' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Revoke share error:', error);
    return NextResponse.json({ error: 'Failed to revoke share' }, { status: 500 });
  }
});
