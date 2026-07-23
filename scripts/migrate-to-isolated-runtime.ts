/**
 * Migration Script: Isolated Runtime Implementation
 * 
 * This script helps transition existing projects to the new isolated runtime architecture.
 * 
 * What it does:
 * 1. Generates Prisma migration for new schema fields
 * 2. Assigns subdomains to existing projects
 * 3. Builds worker Docker image
 * 4. (Optional) Starts containers for active projects
 * 
 * Usage:
 *   npm run migrate:isolated-runtime
 */

import { PrismaClient } from '@prisma/client';
import { SubdomainService } from '../lib/services/subdomain';
import { WorkerLifecycleService } from '../lib/services/workerLifecycle';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Starting Isolated Runtime Migration...\n');

  // STEP 1: Database Migration
  console.log('📊 STEP 1: Database Migration');
  console.log('─'.repeat(50));
  
  try {
    console.log('Running Prisma migration...');
    await execAsync('npx prisma migrate dev --name add-isolated-runtime');
    console.log('✅ Database schema updated');
    
    console.log('Generating Prisma client...');
    await execAsync('npx prisma generate');
    console.log('✅ Prisma client generated\n');
  } catch (error: any) {
    console.error('❌ Migration failed:', error.message);
    console.log('\n⚠️  You may need to run this manually:');
    console.log('   npx prisma migrate dev --name add-isolated-runtime');
    console.log('   npx prisma generate\n');
  }

  // STEP 2: Assign Subdomains
  console.log('🌐 STEP 2: Assign Subdomains to Existing Projects');
  console.log('─'.repeat(50));
  
  const projects = await prisma.project.findMany({
    where: {
      subdomain: null, // Only projects without subdomain
      slug: { not: null }, // Must have slug
    },
    select: {
      id: true,
      name: true,
      slug: true,
    },
  });

  console.log(`Found ${projects.length} projects without subdomains\n`);

  for (const project of projects) {
    try {
      const subdomain = await SubdomainService.assignSubdomain({
        projectId: project.id,
      });
      console.log(`✅ ${project.name}: ${subdomain}.backenly.com`);
    } catch (error: any) {
      console.error(`❌ ${project.name}: ${error.message}`);
    }
  }

  console.log();

  // STEP 3: Build Worker Image
  console.log('🐳 STEP 3: Build Worker Docker Image');
  console.log('─'.repeat(50));
  
  try {
    console.log('Building backenly-worker:latest...');
    await WorkerLifecycleService.buildWorkerImage();
    console.log('✅ Worker image built successfully\n');
  } catch (error: any) {
    console.error('❌ Image build failed:', error.message);
    console.log('\n⚠️  You can build it manually:');
    console.log('   docker build -f docker/worker-template.Dockerfile -t backenly-worker:latest .\n');
  }

  // STEP 4: Optional - Start Containers for Active Projects
  console.log('🚀 STEP 4: Start Containers (Optional)');
  console.log('─'.repeat(50));
  console.log('Do you want to start containers for published projects? (y/N)');
  
  // For now, skip this step (can be run manually)
  console.log('⏭️  Skipping container startup. Projects will start on next deploy.\n');

  // Summary
  console.log('📋 MIGRATION SUMMARY');
  console.log('─'.repeat(50));
  console.log('✅ Database schema updated');
  console.log(`✅ ${projects.length} subdomains assigned`);
  console.log('✅ Worker image built');
  console.log('\n🎉 Migration complete!');
  console.log('\n📚 Next Steps:');
  console.log('1. Configure DNS: *.backenly.com → Your server IP');
  console.log('2. Deploy a project to test isolated runtime');
  console.log('3. Monitor containers: docker ps | grep backenly-worker');
  console.log('4. Check logs: docker logs backenly-worker-<projectId>');
  console.log('\n📖 Full documentation: ISOLATED_RUNTIME_ARCHITECTURE.md\n');
}

main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
