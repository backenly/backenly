/**
 * Workspace Auth Service
 * Handles authentication for workspace-specific user tables.
 * Automatically creates User model and runs migrations when Auth is enabled.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { requireJwtSecret } from '@/lib/auth/jwt-secret';

const execAsync = promisify(exec);
const prisma = new PrismaClient();

// Resolved per call — see lib/auth/jwt-secret.ts (no published fallback).

// 🚨 SECURITY: Single-flight migration lock to prevent concurrent migrations
const migrationLocks = new Map<string, Promise<any>>();

/**
 * Password policy requirements
 */
export const PASSWORD_POLICY = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: false, // Optional for now
};

/**
 * Validate password against policy
 */
export function validatePassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (password.length < PASSWORD_POLICY.minLength) {
    errors.push(`Password must be at least ${PASSWORD_POLICY.minLength} characters`);
  }
  
  if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  
  if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  
  if (PASSWORD_POLICY.requireNumber && !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  if (PASSWORD_POLICY.requireSpecial && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

interface RegisterData {
  email: string;
  password: string;
  name?: string;
}

interface LoginData {
  email: string;
  password: string;
}

interface AuthResponse {
  success: boolean;
  token?: string;
  user?: {
    id: string;
    email: string;
    name?: string;
  };
  error?: string;
}

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
 * Auto-generate User model in workspace schema.prisma
 * 
 * ⚠️ AUTH BETA: Auto-migration is production-ready for early-stage projects.
 * For high-scale production, consider manual migration workflows.
 */
export async function enableAuth(projectId: string): Promise<{ success: boolean; message: string }> {
  // 🚨 SECURITY: Single-flight lock - prevent concurrent migrations
  const existing = migrationLocks.get(projectId);
  if (existing) {
    console.log(`⏳ Migration already in progress for project ${projectId}, waiting...`);
    return existing;
  }
  
  // Create migration promise
  const migrationPromise = (async () => {
    try {
      const workspacePath = path.join(process.cwd(), 'workspace', projectId);
      const schemaPath = path.join(workspacePath, 'schema.prisma');
      
      // Check if schema exists
      if (!fs.existsSync(schemaPath)) {
        return {
          success: false,
          message: 'schema.prisma not found in workspace'
        };
      }
      
      // Check if User model already exists
      if (hasUserModel(workspacePath)) {
        return {
          success: true,
          message: 'User model already exists'
        };
      }
      
      // Read current schema
      let schemaContent = fs.readFileSync(schemaPath, 'utf-8');
      
      // Add User model
      const userModel = `

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  password  String
  name      String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@map("users")
}
`;
      
      // Append User model to schema
      schemaContent += userModel;
      fs.writeFileSync(schemaPath, schemaContent);
      
      console.log('✅ User model added to schema.prisma');
      
      // Run Prisma migration (single-flight guaranteed)
      try {
        const { stdout, stderr } = await execAsync('npx prisma db push', {
          cwd: workspacePath,
          env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }
        });
        
        console.log('Migration output:', stdout);
        if (stderr) console.error('Migration stderr:', stderr);
        
        // Update project to mark auth as enabled
        await prisma.project.update({
          where: { id: projectId },
          data: {
            authManifest: {
              enabled: true,
              provider: 'email',
              userTableCreated: true,
              betaFeature: true // Mark as beta
            }
          }
        });
        
        return {
          success: true,
          message: '✅ Auth Beta enabled! User model created and database migrated.'
        };
      } catch (migrationError: any) {
        console.error('Migration error:', migrationError);
        return {
          success: false,
          message: `Migration failed: ${migrationError.message}`
        };
      }
    } catch (error: any) {
      console.error('Enable auth error:', error);
      return {
        success: false,
        message: `Failed to enable auth: ${error.message}`
      };
    } finally {
      // Always remove lock when done
      migrationLocks.delete(projectId);
    }
  })();
  
  // Store promise to prevent concurrent runs
  migrationLocks.set(projectId, migrationPromise);
  
  return migrationPromise;
}

/**
 * Register a new user in workspace database
 */
export async function registerUser(
  projectId: string,
  data: RegisterData
): Promise<AuthResponse> {
  try {
    // 🚨 SECURITY: Validate password policy
    const passwordValidation = validatePassword(data.password);
    if (!passwordValidation.valid) {
      return {
        success: false,
        error: passwordValidation.errors.join('. ')
      };
    }
    
    const workspacePath = path.join(process.cwd(), 'workspace', projectId);
    
    // Ensure User model exists
    if (!hasUserModel(workspacePath)) {
      const enableResult = await enableAuth(projectId);
      if (!enableResult.success) {
        return {
          success: false,
          error: enableResult.message
        };
      }
    }
    
    // Hash password — 12 rounds (OWASP 2026 floor). Was 10.
    const hashedPassword = await bcrypt.hash(data.password, 12);
    
    // Get workspace Prisma client (dynamic)
    const workspaceDbUrl = process.env.DATABASE_URL; // In production, use workspace-specific DB
    
    // For now, we'll use the main Prisma client with dynamic model access
    // In production, you'd create a separate Prisma client for each workspace
    const users: any[] = await prisma.$queryRawUnsafe(`
      INSERT INTO users (id, email, password, name, "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
      RETURNING id, email, name, "createdAt"
    `, data.email, hashedPassword, data.name || null);
    
    if (users.length === 0) {
      return {
        success: false,
        error: 'Failed to create user'
      };
    }
    
    const user = users[0];
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      requireJwtSecret('sign a workspace token'),
      { expiresIn: '7d' }
    );
    
    return {
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    };
  } catch (error: any) {
    console.error('Register error:', error);
    return {
      success: false,
      error: error.message || 'Registration failed'
    };
  }
}

/**
 * Login existing user from workspace database
 */
export async function loginUser(
  projectId: string,
  data: LoginData
): Promise<AuthResponse> {
  try {
    const workspacePath = path.join(process.cwd(), 'workspace', projectId);
    
    // Ensure User model exists
    if (!hasUserModel(workspacePath)) {
      return {
        success: false,
        error: 'Authentication not enabled for this project'
      };
    }
    
    // Get user from database
    const users: any[] = await prisma.$queryRawUnsafe(`
      SELECT id, email, password, name, "createdAt"
      FROM users
      WHERE email = $1
      LIMIT 1
    `, data.email);
    
    if (users.length === 0) {
      return {
        success: false,
        error: 'Invalid email or password'
      };
    }
    
    const user = users[0];
    
    // Verify password
    const isValidPassword = await bcrypt.compare(data.password, user.password);
    
    if (!isValidPassword) {
      return {
        success: false,
        error: 'Invalid email or password'
      };
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      requireJwtSecret('sign a workspace token'),
      { expiresIn: '7d' }
    );
    
    return {
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    };
  } catch (error: any) {
    console.error('Login error:', error);
    return {
      success: false,
      error: error.message || 'Login failed'
    };
  }
}

/**
 * Get all users for dashboard display
 */
export async function getWorkspaceUsers(projectId: string): Promise<any[]> {
  try {
    const workspacePath = path.join(process.cwd(), 'workspace', projectId);
    
    // Check if User model exists
    if (!hasUserModel(workspacePath)) {
      return [];
    }
    
    // Get users from database
    const users: any[] = await prisma.$queryRawUnsafe(`
      SELECT id, email, name, "createdAt"
      FROM users
      ORDER BY "createdAt" DESC
    `);
    
    return users;
  } catch (error: any) {
    console.error('Get users error:', error);
    return [];
  }
}
