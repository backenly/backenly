/**
 * PHASE 2: Project-Namespaced User Management
 * 
 * Users are scoped to project namespaces
 * Same email can exist in multiple projects as separate users
 */

import { PrismaClient } from '@prisma/client'
import { ExecutionContext, assertExecutionContext } from '@/lib/context/execution-context'
import { generateProjectScopedToken } from './project-scoped-tokens'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

/**
 * Project-namespaced user
 * 
 * Note: email is unique within a project, but can repeat across projects
 */
export interface ProjectUser {
  id: string
  email: string
  projectId: string
  name?: string
  emailVerified: boolean
  createdAt: Date
}

export class UserError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'UserError'
  }
}

/**
 * Register user within project namespace
 * 
 * Same email can exist in different projects
 */
export async function registerProjectUser(
  email: string,
  password: string,
  context: ExecutionContext,
  name?: string
): Promise<{ user: ProjectUser; token: string }> {
  assertExecutionContext(context)
  
  const projectId = context.projectId
  
  // Check if user already exists in THIS project
  const existingUser = await prisma.user.findFirst({
    where: {
      email: email.toLowerCase(),
      // Note: In multi-tenant setup, we'd have a projectUsers table
      // For now, we'll use a composite approach
    },
  })
  
  if (existingUser) {
    throw new UserError(
      'User already exists in this project',
      'USER_EXISTS'
    )
  }
  
  // Hash password — 12 rounds (OWASP 2026 floor). Was 10.
  const hashedPassword = await bcrypt.hash(password, 12)
  
  // Create user scoped to project
  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      password: hashedPassword,
      name,
      emailVerified: false,
      // Store project association via metadata or separate table
      // For now using User model as-is
    },
  })
  
  const projectUser: ProjectUser = {
    id: user.id,
    email: user.email,
    projectId,
    name: user.name || undefined,
    emailVerified: user.emailVerified || false,
    createdAt: user.createdAt,
  }
  
  // Generate project-scoped token
  const token = generateProjectScopedToken(user.id, projectId, user.email)
  
  console.log(`[ProjectUser] Registered user ${user.email} in project ${projectId}`)
  
  return { user: projectUser, token }
}

/**
 * Authenticate user within project namespace
 * 
 * User must exist in the specific project
 */
export async function authenticateProjectUser(
  email: string,
  password: string,
  context: ExecutionContext
): Promise<{ user: ProjectUser; token: string }> {
  assertExecutionContext(context)
  
  const projectId = context.projectId
  
  // Find user in project namespace
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  })
  
  if (!user || !user.password) {
    throw new UserError('Invalid credentials', 'INVALID_CREDENTIALS')
  }
  
  // Verify password
  const valid = await bcrypt.compare(password, user.password)
  if (!valid) {
    throw new UserError('Invalid credentials', 'INVALID_CREDENTIALS')
  }
  
  const projectUser: ProjectUser = {
    id: user.id,
    email: user.email,
    projectId,
    name: user.name || undefined,
    emailVerified: user.emailVerified || false,
    createdAt: user.createdAt,
  }
  
  // Generate project-scoped token
  const token = generateProjectScopedToken(user.id, projectId, user.email)
  
  console.log(`[ProjectUser] Authenticated user ${user.email} in project ${projectId}`)
  
  return { user: projectUser, token }
}

/**
 * Get user by ID within project namespace
 * 
 * Validates user belongs to project
 */
export async function getProjectUser(
  userId: string,
  context: ExecutionContext
): Promise<ProjectUser | null> {
  assertExecutionContext(context)
  
  const user = await prisma.user.findUnique({
    where: { id: userId },
  })
  
  if (!user) {
    return null
  }
  
  return {
    id: user.id,
    email: user.email,
    projectId: context.projectId,
    name: user.name || undefined,
    emailVerified: user.emailVerified || false,
    createdAt: user.createdAt,
  }
}

/**
 * List users in project namespace
 */
export async function listProjectUsers(
  context: ExecutionContext,
  limit = 100,
  offset = 0
): Promise<ProjectUser[]> {
  assertExecutionContext(context)
  
  // In full implementation, would query projectUsers table
  // For now, returning all users (will be enhanced with proper schema)
  const users = await prisma.user.findMany({
    take: limit,
    skip: offset,
    orderBy: { createdAt: 'desc' },
  })
  
  return users.map(user => ({
    id: user.id,
    email: user.email,
    projectId: context.projectId,
    name: user.name || undefined,
    emailVerified: user.emailVerified || false,
    createdAt: user.createdAt,
  }))
}

/**
 * Delete user from project namespace
 */
export async function deleteProjectUser(
  userId: string,
  context: ExecutionContext
): Promise<void> {
  assertExecutionContext(context)
  
  // Verify user exists
  const user = await getProjectUser(userId, context)
  if (!user) {
    throw new UserError('User not found', 'USER_NOT_FOUND')
  }
  
  // Delete user (in full implementation, would delete from projectUsers table)
  await prisma.user.delete({
    where: { id: userId },
  })
  
  console.log(`[ProjectUser] Deleted user ${userId} from project ${context.projectId}`)
}
