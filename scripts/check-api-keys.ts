import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function checkApiKeys() {
  const projectId = process.argv[2]
  console.log(`\n🔍 Checking API Keys for Project: ${projectId || 'ALL'}\n`)
  
  try {
    const where: any = {}
    if (projectId) where.projectId = projectId

    const apiKeys = await prisma.apiKey.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
          }
        }
      }
    })
    
    console.log(`📋 Found ${apiKeys.length} API keys in database:\n`)
    
    for (const key of apiKeys) {
      console.log(`• Key ID: ${key.id}`)
      console.log(`  Name: ${key.name}`)
      console.log(`  Role: ${key.role}`)
      console.log(`  Has Key String: ${!!key.key}`)
      console.log(`  Project ID: ${key.projectId}`)
      console.log(`  User ID: ${key.userId}`)
      console.log(`  User Email: ${key.user?.email || 'N/A'}`)
      console.log(`  Created: ${key.createdAt}\n`)
    }
  } catch (error: any) {
    console.error('❌ Error checking API keys:', error.message)
  } finally {
    await prisma.$disconnect()
  }
}

checkApiKeys().catch(console.error)
