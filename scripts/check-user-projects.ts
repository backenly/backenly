/**
 * Check User Projects Script
 * 
 * This script helps verify if projects exist in the database for debugging
 * Usage: npx tsx scripts/check-user-projects.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function checkProjects() {
  console.log('\n🔍 Checking User Projects in Database...\n')
  
  try {
    // Get all projects
    const projects = await prisma.project.findMany({
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    })
    
    console.log(`📋 Found ${projects.length} projects in database:\n`)
    
    for (const project of projects) {
      console.log(`• Project ID: ${project.id}`)
      console.log(`  Name: ${project.name}`)
      console.log(`  User: ${project.user?.name || 'N/A'} (${project.user?.email || 'N/A'})`)
      console.log(`  Created: ${project.createdAt}`)
      console.log(`  User ID: ${project.userId || 'N/A'}\n`)
    }
    
    if (projects.length === 0) {
      console.log('⚠️  No projects found in database.')
      console.log('   You may need to create a project first.')
    } else {
      console.log('✅ Project check complete.')
      console.log('\n💡 If you are seeing "Project not found" errors,')
      console.log('   make sure you are using one of the project IDs above.')
    }
    
  } catch (error: any) {
    console.error('❌ Error checking projects:', error.message)
  } finally {
    await prisma.$disconnect()
  }
}

// Check a specific project ID
async function checkSpecificProject(projectId: string) {
  console.log(`\n🔍 Checking specific project: ${projectId}\n`)
  
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          }
        }
      }
    })
    
    if (project) {
      console.log(`✅ Project found:`)
      console.log(`   ID: ${project.id}`)
      console.log(`   Name: ${project.name}`)
      console.log(`   User: ${project.user?.name || 'N/A'} (${project.user?.email || 'N/A'})`)
      console.log(`   Created: ${project.createdAt}`)
      console.log(`   User ID: ${project.userId || 'N/A'}`)
    } else {
      console.log(`❌ Project with ID ${projectId} not found in database.`)
      console.log(`   This explains the "Project not found" error.`)
    }
  } catch (error: any) {
    console.error('❌ Error checking project:', error.message)
  } finally {
    await prisma.$disconnect()
  }
}

// Main execution
async function main() {
  const projectId = process.argv[2] // Allow passing specific project ID as argument
  
  if (projectId) {
    await checkSpecificProject(projectId)
  } else {
    await checkProjects()
  }
}

main().catch(console.error)
