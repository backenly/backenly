export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/postgres'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import { canWriteProject } from '@/lib/edition/guard'

/**
 * Add missing columns to login table
 * POST /api/database/migrate-login-table
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const { projectId } = await request.json()

    if (!projectId) {
      return NextResponse.json({ error: 'Project ID is required' }, { status: 400 })
    }

    // 🔒 IDOR fix — verify the caller owns the project. Previously any logged-in
    // user could ALTER any project's `login` table.
    if (!(await canWriteProject(user.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 })
    }

    const postgresSchema = workspaceSchemaName(projectId)

    console.log(`🔧 Adding email and password columns to ${postgresSchema}.login...`)

    // Add columns if they don't exist
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${postgresSchema}"."login"
      ADD COLUMN IF NOT EXISTS "email" VARCHAR(255),
      ADD COLUMN IF NOT EXISTS "password" VARCHAR(255);
    `)

    // Add unique constraint on email
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'login_email_key'
        ) THEN
          ALTER TABLE "${postgresSchema}"."login"
          ADD CONSTRAINT "login_email_key" UNIQUE ("email");
        END IF;
      END $$;
    `)

    console.log(`✅ Columns added successfully to ${postgresSchema}.login`)

    return NextResponse.json({
      success: true,
      message: 'Login table updated with email and password columns',
      schema: postgresSchema,
    })
  } catch (error: any) {
    console.error('Migration error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to migrate login table' },
      { status: 500 }
    )
  }
}
