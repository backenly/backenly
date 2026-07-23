/**
 * Create demo project for Paddle verification
 * Usage: npx ts-node scripts/create-demo-project.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function createDemoProject() {
  try {
    const email = 'demo@backenly.com'

    // Find demo user
    const user = await prisma.user.findUnique({
      where: { email }
    })

    if (!user) {
      console.error('Demo user not found. Run create-demo-user.ts first.')
      process.exit(1)
    }

    // Check if demo project already exists
    const existingProject = await prisma.project.findFirst({
      where: {
        userId: user.id,
        name: 'Demo Todo App'
      }
    })

    if (existingProject) {
      console.log('✅ Demo project already exists')
      console.log(`Project ID: ${existingProject.id}`)
      return
    }

    // Create demo project
    const project = await prisma.project.create({
      data: {
        name: 'Demo Todo App',
        description: 'A sample todo list application',
        userId: user.id,
        environment: 'development'
      }
    })

    console.log('✅ Demo project created successfully')
    console.log(`Project ID: ${project.id}`)
    console.log(`Project Name: ${project.name}`)

  } catch (error) {
    console.error('Error creating demo project:', error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

createDemoProject()
