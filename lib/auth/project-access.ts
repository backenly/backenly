import { prisma } from '@/lib/db'
import type { ProjectRole } from '@/lib/edition/types'

/**
 * Verify user has access to a project
 * 
 * This function handles:
 * - Project existence check
 * - Ownership verification
 * - Legacy projects without userId (allows access)
 * 
 * @param projectId - The project ID to check
 * @param userId - The user ID requesting access
 * @returns Project data if access granted
 * @throws Error with specific message if access denied
 */
export async function verifyProjectAccess(projectId: string, userId: string) {
  const callId = Math.random().toString(36).substring(7);
  console.log(`[${callId}] 🔍 verifyProjectAccess() called`);
  console.log(`[${callId}] 📋 Input:`, { projectId, userId });
  
  console.log(`[${callId}] 🔄 Querying database for project...`);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      userId: true,
      organizationId: true,
      workspaces: {
        select: {
          id: true,
          postgresSchema: true,
          mongodbDatabase: true,
          databaseProvisioned: true,
        },
      },
    },
  })

  // 🚫 CRITICAL: Distinguish between "not exists" and "not owned"
  if (!project) {
    console.error(`[${callId}] ❌ Project does not exist in database:`, projectId);
    throw new Error('PROJECT_NOT_FOUND'); // 404
  }
  
  console.log(`[${callId}] ✅ Project found:`, {
    id: project.id,
    name: project.name,
    userId: project.userId,
    hasWorkspaces: project.workspaces.length > 0,
  });

  // Check access (handle legacy projects without userId)
  // If project.userId is null/undefined, allow access (legacy project)
  // If project.userId is set, the requester must be the owner OR a member of
  // the project's organization (Phase 6). Org check only runs for non-owners
  // and only when the project has an org, so it is strictly additive — it can
  // never deny access that the owner-only rule would have granted.
  let orgMember: { id: string; role: string; restricted: boolean } | null = null

  if (project.userId && project.userId !== userId) {
    orgMember = project.organizationId
      ? await prisma.organizationMember.findUnique({
          where: { orgId_userId: { orgId: project.organizationId, userId } },
          select: { id: true, role: true, restricted: true },
        })
      : null

    if (!orgMember) {
      console.error(`[${callId}] ❌ Project exists but user is neither owner nor org member:`, {
        projectId,
        projectUserId: project.userId,
        requestUserId: userId,
      });
      throw new Error('PROJECT_FORBIDDEN'); // 403 - different from not found!
    }

    // Project-scoped members (Pro+): a DEVELOPER/VIEWER marked `restricted` may
    // only reach projects explicitly granted to them. OWNER/ADMIN are never
    // scoped. This enforcement runs on EVERY plan — a downgrade must never
    // silently widen a restricted member's access.
    if (orgMember.restricted && orgMember.role !== 'OWNER' && orgMember.role !== 'ADMIN') {
      const grant = await prisma.projectMember.findUnique({
        where: { userId_projectId: { userId, projectId } },
        select: { id: true },
      })
      if (!grant) {
        console.error(`[${callId}] ❌ Restricted member not granted this project:`, { projectId, requestUserId: userId });
        throw new Error('PROJECT_FORBIDDEN'); // 403
      }
    }
  }
  
  if (!project.userId) {
    console.log(`[${callId}] ⚠️ Legacy project (no userId) - access granted`);
  }

  console.log(`[${callId}] ✅ Project Access granted:`, {
    projectId,
    userId,
    projectName: project.name,
  });

  // The caller's effective role, returned alongside the project so a route can
  // gate a WRITE without asking a second time. No extra query: the membership
  // row above is the same one this needs.
  //
  // Access and authority are not the same question, and conflating them is how
  // an organization VIEWER became able to delete a webhook. These routes had
  // only ever been owner-only, so the four roles had never had to constrain
  // project work at all, and "is a member" silently became "may do anything".
  //
  // The project's own userId outranks any org role. A legacy project with no
  // userId is owner-less by definition, and the code above already grants such
  // a caller access, so OWNER is the role that matches what actually happens.
  const callerRole: ProjectRole =
    !project.userId || project.userId === userId
      ? 'OWNER'
      : ((orgMember?.role as ProjectRole | undefined) ?? 'OWNER')

  return { ...project, callerRole };
}

/**
 * Check if user has access to a project (boolean return)
 */
export async function hasProjectAccess(projectId: string, userId: string): Promise<boolean> {
  try {
    await verifyProjectAccess(projectId, userId)
    return true
  } catch {
    return false
  }
}
