/**
 * Database Health Check Script
 * 
 * Run this to verify your database setup is working correctly
 * Usage: npx tsx scripts/check-database-health.ts
 */

import { PrismaClient } from '@prisma/client'
import { PostgresService } from '../lib/db/hybrid'

const prisma = new PrismaClient()

interface HealthCheckResult {
  name: string
  status: 'PASS' | 'FAIL' | 'WARN'
  message: string
  details?: any
}

const results: HealthCheckResult[] = []

function logResult(result: HealthCheckResult) {
  const emoji = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⚠️'
  console.log(`${emoji} ${result.name}: ${result.message}`)
  if (result.details) {
    console.log(`   Details:`, result.details)
  }
  results.push(result)
}

async function checkDatabaseConnection() {
  try {
    await prisma.$connect()
    await prisma.$queryRaw`SELECT 1 as health_check`
    logResult({
      name: 'Database Connection',
      status: 'PASS',
      message: 'Successfully connected to PostgreSQL',
    })
  } catch (error: any) {
    logResult({
      name: 'Database Connection',
      status: 'FAIL',
      message: 'Failed to connect to database',
      details: error.message,
    })
  }
}

async function checkPlatformSchema() {
  try {
    const count = await prisma.project.count()
    logResult({
      name: 'Platform Schema',
      status: 'PASS',
      message: `Found ${count} projects in platform database`,
      details: { projectCount: count },
    })
  } catch (error: any) {
    logResult({
      name: 'Platform Schema',
      status: 'FAIL',
      message: 'Platform schema has issues',
      details: error.message,
    })
  }
}

async function checkWorkspaceSchemas() {
  try {
    const allSchemas = await PostgresService.listSchemas()
    const workspaceSchemas = allSchemas.filter(s => s.startsWith('workspace_'))
    
    logResult({
      name: 'Workspace Schemas',
      status: workspaceSchemas.length > 0 ? 'PASS' : 'WARN',
      message: `Found ${workspaceSchemas.length} workspace schemas`,
      details: { count: workspaceSchemas.length, schemas: workspaceSchemas.slice(0, 5) },
    })
  } catch (error: any) {
    logResult({
      name: 'Workspace Schemas',
      status: 'FAIL',
      message: 'Failed to list workspace schemas',
      details: error.message,
    })
  }
}

async function checkProjectsWithWorkspaces() {
  try {
    const projects = await prisma.project.findMany({
      include: {
        workspaces: {
          select: {
            id: true,
            postgresSchema: true,
            databaseProvisioned: true,
          },
        },
      },
      take: 10,
    })
    
    const provisionedCount = projects.filter(p => 
      p.workspaces.some(w => w.databaseProvisioned)
    ).length
    
    logResult({
      name: 'Projects with Workspaces',
      status: provisionedCount > 0 ? 'PASS' : 'WARN',
      message: `${provisionedCount}/${projects.length} projects have provisioned databases`,
      details: {
        total: projects.length,
        provisioned: provisionedCount,
      },
    })
  } catch (error: any) {
    logResult({
      name: 'Projects with Workspaces',
      status: 'FAIL',
      message: 'Failed to check project workspaces',
      details: error.message,
    })
  }
}

async function checkSessions() {
  try {
    const sessionCount = await prisma.session.count()
    const activeSessionCount = await prisma.session.count({
      where: {
        expiresAt: {
          gte: new Date(),
        },
      },
    })
    
    logResult({
      name: 'Sessions',
      status: 'PASS',
      message: `${activeSessionCount} active sessions (${sessionCount} total)`,
      details: { active: activeSessionCount, total: sessionCount },
    })
  } catch (error: any) {
    logResult({
      name: 'Sessions',
      status: 'FAIL',
      message: 'Session table has issues',
      details: error.message,
    })
  }
}

async function checkUsers() {
  try {
    const userCount = await prisma.user.count()
    logResult({
      name: 'Users',
      status: userCount > 0 ? 'PASS' : 'WARN',
      message: `Found ${userCount} users`,
      details: { count: userCount },
    })
  } catch (error: any) {
    logResult({
      name: 'Users',
      status: 'FAIL',
      message: 'User table has issues',
      details: error.message,
    })
  }
}

async function runHealthCheck() {
  console.log('\n🔍 Starting Database Health Check...\n')
  console.log('═'.repeat(60))
  
  await checkDatabaseConnection()
  await checkPlatformSchema()
  await checkWorkspaceSchemas()
  await checkProjectsWithWorkspaces()
  await checkSessions()
  await checkUsers()
  
  console.log('═'.repeat(60))
  
  const passCount = results.filter(r => r.status === 'PASS').length
  const failCount = results.filter(r => r.status === 'FAIL').length
  const warnCount = results.filter(r => r.status === 'WARN').length
  
  console.log(`\n📊 Summary: ${passCount} passed, ${failCount} failed, ${warnCount} warnings\n`)
  
  if (failCount === 0 && warnCount === 0) {
    console.log('🎉 All checks passed! Your database is healthy.\n')
  } else if (failCount === 0) {
    console.log('⚠️  All checks passed with warnings. Review the details above.\n')
  } else {
    console.log('❌ Some checks failed. Please fix the issues above.\n')
    process.exit(1)
  }
  
  await prisma.$disconnect()
}

runHealthCheck().catch((error) => {
  console.error('💥 Health check crashed:', error)
  process.exit(1)
})
