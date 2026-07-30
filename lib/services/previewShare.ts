/**
 * Preview Share Service
 * 
 * Manages shareable Cloud Preview tokens with access control.
 * Tokens are signed JWTs with expiration and permissions.
 */

import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { requirePreviewTokenSecret } from '@/lib/auth/jwt-secret';

const prisma = new PrismaClient();

// JWT secret for preview tokens (use dedicated secret in production)
// Resolved per call — see lib/auth/jwt-secret.ts (no published fallback).

export interface PreviewShareOptions {
  projectId: string;
  userId: string;
  accessLevel: 'read_only' | 'full_preview';
  allowAuth?: boolean;
  allowWrites?: boolean;
  expiresInHours?: number; // Default 24 hours
  label?: string;
}

export interface PreviewTokenPayload {
  shareId: string;
  projectId: string;
  userId: string; // Creator, not accessor
  accessLevel: 'read_only' | 'full_preview';
  allowAuth: boolean;
  allowWrites: boolean;
  exp: number;
}

export interface ShareValidationResult {
  valid: boolean;
  shareId?: string;
  projectId?: string;
  accessLevel?: 'read_only' | 'full_preview';
  allowAuth?: boolean;
  allowWrites?: boolean;
  error?: string;
}

/**
 * Generate a shareable preview link with token
 */
export async function createPreviewShare(options: PreviewShareOptions): Promise<{
  shareId: string;
  token: string;
  shareUrl: string;
  expiresAt: Date;
}> {
  const {
    projectId,
    userId,
    accessLevel,
    allowAuth = false,
    allowWrites = false,
    expiresInHours = 24,
    label,
  } = options;

  // Calculate expiration
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + expiresInHours);

  // Create share record first (to get ID)
  const share = await prisma.previewShare.create({
    data: {
      projectId,
      userId,
      token: crypto.randomBytes(32).toString('hex'), // Temporary, will be updated
      accessLevel,
      allowAuth,
      allowWrites,
      expiresAt,
      label,
    },
  });

  // Generate signed JWT token
  const tokenPayload: PreviewTokenPayload = {
    shareId: share.id,
    projectId,
    userId,
    accessLevel,
    allowAuth,
    allowWrites,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };

  const token = jwt.sign(tokenPayload, requirePreviewTokenSecret('sign a preview-share token'));

  // Update share with actual token
  await prisma.previewShare.update({
    where: { id: share.id },
    data: { token },
  });

  // Generate share URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const shareUrl = `${baseUrl}/preview/${projectId}?token=${token}`;

  return {
    shareId: share.id,
    token,
    shareUrl,
    expiresAt,
  };
}

/**
 * Validate a preview share token
 */
export async function validatePreviewToken(token: string): Promise<ShareValidationResult> {
  try {
    // Verify JWT signature and expiration
    const decoded = jwt.verify(token, requirePreviewTokenSecret('verify a preview-share token')) as PreviewTokenPayload;

    // Check if share exists and isn't revoked
    const share = await prisma.previewShare.findUnique({
      where: { token },
    });

    if (!share) {
      return { valid: false, error: 'Share not found' };
    }

    if (share.revoked) {
      return { valid: false, error: 'Share has been revoked' };
    }

    if (new Date() > share.expiresAt) {
      return { valid: false, error: 'Share has expired' };
    }

    // Update access tracking
    await prisma.previewShare.update({
      where: { id: share.id },
      data: {
        accessCount: { increment: 1 },
        lastAccessedAt: new Date(),
        // You can add IP tracking here if needed
      },
    });

    return {
      valid: true,
      shareId: decoded.shareId,
      projectId: decoded.projectId,
      accessLevel: decoded.accessLevel,
      allowAuth: decoded.allowAuth,
      allowWrites: decoded.allowWrites,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { valid: false, error: 'Token has expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { valid: false, error: 'Invalid token' };
    }
    return { valid: false, error: 'Token validation failed' };
  }
}

/**
 * Revoke a preview share
 */
export async function revokePreviewShare(shareId: string, userId: string): Promise<boolean> {
  try {
    await prisma.previewShare.update({
      where: { id: shareId },
      data: {
        revoked: true,
        revokedAt: new Date(),
        revokedBy: userId,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all shares for a project
 */
export async function listProjectShares(projectId: string) {
  return prisma.previewShare.findMany({
    where: {
      projectId,
      revoked: false,
    },
    orderBy: {
      createdAt: 'desc',
    },
    include: {
      user: {
        select: {
          email: true,
          name: true,
        },
      },
    },
  });
}

/**
 * Check if user can access a request based on share permissions
 */
export function canAccessEndpoint(
  method: string,
  path: string,
  shareValidation: ShareValidationResult
): { allowed: boolean; reason?: string } {
  if (!shareValidation.valid) {
    return { allowed: false, reason: shareValidation.error };
  }

  const { accessLevel, allowAuth, allowWrites } = shareValidation;

  // Check if it's an auth endpoint
  const isAuthEndpoint = path.includes('/auth') || path.includes('/login') || path.includes('/register');
  if (isAuthEndpoint && !allowAuth) {
    return { allowed: false, reason: 'Auth endpoints not allowed in this share' };
  }

  // Check write operations
  const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
  if (isWriteOperation && !allowWrites && accessLevel === 'read_only') {
    return { allowed: false, reason: 'Write operations not allowed in read-only mode' };
  }

  return { allowed: true };
}
