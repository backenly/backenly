import { PrismaClient } from '@prisma/client'

// PrismaClient is attached to the `global` object in development to prevent
// exhausting your database connection limit.
// Learn more: https://pris.ly/d/help/nextjs-best-practices

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

// Always use singleton pattern in both dev and production to prevent connection exhaustion
if (!globalForPrisma.prisma) globalForPrisma.prisma = prisma

// Helper function to test connection
export async function testPostgresConnection(): Promise<boolean> {
  try {
    // Check if DATABASE_URL is set
    if (!process.env.DATABASE_URL) {
      console.error('❌ DATABASE_URL is not set in environment variables')
      return false
    }

    // Validate DATABASE_URL format
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
      console.error(`❌ Invalid DATABASE_URL format. Must start with "postgresql://" or "postgres://". Got: ${dbUrl.substring(0, 50)}...`)
      return false
    }

    await prisma.$connect()
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch (error: any) {
    console.error('PostgreSQL connection error:', error.message || error)
    if (error.code === 'P1012') {
      console.error('❌ Prisma Error: Invalid database URL format')
    } else if (error.code === 'P1001') {
      console.error('❌ Prisma Error: Cannot reach database server. Check your connection string and network.')
    } else if (error.code === 'P1000') {
      console.error('❌ Prisma Error: Authentication failed. Check your database credentials.')
    }
    return false
  }
}

// Helper function to disconnect
export async function disconnectPostgres(): Promise<void> {
  await prisma.$disconnect()
}

