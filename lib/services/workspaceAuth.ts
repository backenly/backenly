/**
 * Workspace Auth Service
 * Lists a project's end users from its own workspace schema.
 *
 * End-user sign-up, sign-in and their password rules live in the project's
 * auth routes (app/api/v1/[projectId]/auth, lib/services/end-user-auth-flows.ts).
 */

import { projectWorkspaceDir } from '@/lib/workspace/paths';
import fs from 'fs';
import path from 'path';

/**
 * Check if workspace has User model in schema.prisma
 */
export function hasUserModel(workspacePath: string): boolean {
  const schemaPath = path.join(workspacePath, 'schema.prisma');

  if (!fs.existsSync(schemaPath)) {
    return false;
  }

  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  return /model\s+User\s*\{/.test(schemaContent);
}

/**
 * The END USERS of one project.
 *
 * ── This returned every PLATFORM account ────────────────────────────────────
 *
 * It took a projectId, ignored it, and ran
 *
 *     SELECT id, email, name, "createdAt" FROM users
 *
 * on the PLATFORM connection. `users` is unqualified, so it resolved through
 * search_path to `public.users` - and the platform User model is
 * `@@map("users")`. The function therefore returned every account on the
 * deployment, with emails, to whoever asked, for any projectId at all.
 *
 * The projectId parameter made it look tenant-scoped. It was never used in the
 * predicate, which is exactly the shape that route-level review cannot catch:
 * the caller passes the right argument and the service throws it away.
 *
 * Now goes through queryWorkspace*, which pins search_path to this project's
 * own schema, so the tenant boundary is in the connection rather than in a
 * string. Owner context because this is the operator listing THEIR end users:
 * workspace tables are FORCE RLS, and a plain read would return nothing.
 */
export async function getWorkspaceUsers(projectId: string): Promise<any[]> {
  try {
    const workspacePath = projectWorkspaceDir(projectId);

    // Check if User model exists
    if (!hasUserModel(workspacePath)) {
      return [];
    }

    const { queryWorkspaceAsOwner } = await import('./workspace-pool');
    const users = await queryWorkspaceAsOwner<any>(
      projectId,
      `SELECT id, email, name, "createdAt"
         FROM users
        ORDER BY "createdAt" DESC`,
    );

    return users;
  } catch (error: any) {
    console.error('Get users error:', error);
    return [];
  }
}
